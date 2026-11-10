/**
 * Deterministic provider used when no model credentials are configured. It
 * selects a real tool from the same tool registry as the model, then answers
 * using the tool summary. This keeps the agent demo functional offline and
 * makes the grounding check meaningful.
 */
import type {
  LlmMessage,
  LlmProvider,
  LlmReply,
  LlmToolCall,
  LlmToolDefinition,
} from './provider';

interface ToolPayload {
  ok?: boolean;
  summary?: string;
  data?: unknown;
}

const CONSTELLATION_ALIASES: { pattern: RegExp; id: string }[] = [
  { pattern: /beidou|bds/i, id: 'bds' },
  { pattern: /galileo/i, id: 'galileo' },
  { pattern: /glonass/i, id: 'glonass' },
  { pattern: /iridium/i, id: 'iridium' },
  { pattern: /starlink/i, id: 'starlink' },
  { pattern: /oneweb/i, id: 'oneweb' },
  { pattern: /gps/i, id: 'gps' },
];

const STOPWORDS = new Set([
  'what', 'which', 'who', 'show', 'tell', 'me', 'about', 'the', 'of', 'in',
  'is', 'are', 'does', 'do', 'how', 'many', 'satellites', 'satellite', 'please',
  'can', 'you', 'a', 'an', 'to', 'for', 'and', 'with', 'list', 'give',
  'explain', 'describe', 'current', 'currently', 'there', 'on', 'at', 'by',
]);

function userQuestion(messages: readonly LlmMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === 'user');
  return user?.content ?? '';
}

function toolMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.filter((message) => message.role === 'tool');
}

function parsePayload(message: LlmMessage): ToolPayload | null {
  try {
    return JSON.parse(message.content) as ToolPayload;
  } catch {
    return null;
  }
}

function extractQuery(question: string): string {
  const words = question
    .replace(/[?.!,;:]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word.toLowerCase()));
  return words.slice(0, 4).join(' ') || 'ISS';
}

function detectConstellation(question: string): string | null {
  for (const alias of CONSTELLATION_ALIASES) {
    if (alias.pattern.test(question)) {
      return alias.id;
    }
  }
  return null;
}

function firstToolCall(
  question: string,
  tools: readonly LlmToolDefinition[],
): LlmToolCall | null {
  const available = new Set(tools.map((tool) => tool.name));
  const constellationId = detectConstellation(question);
  const lower = question.toLowerCase();

  if (available.has('get_constellation') && constellationId) {
    return call('get_constellation', { constellationId });
  }
  if (
    available.has('layer_stats') &&
    /(how many|count|statistics|breakdown|distribution|per layer|layers)/.test(lower)
  ) {
    return call('layer_stats', {});
  }
  if (
    available.has('get_recent_events') &&
    /(event|recent|changed|change|activity)/.test(lower)
  ) {
    return call('get_recent_events', { sinceHours: 48, limit: 8 });
  }
  if (available.has('search_satellites')) {
    return call('search_satellites', { query: extractQuery(question), limit: 8 });
  }
  return null;
}

function call(name: string, args: Record<string, unknown>): LlmToolCall {
  return { id: `call_${name}_${Math.random().toString(36).slice(2, 9)}`, name, arguments: args };
}

export class FakeLlmProvider implements LlmProvider {
  readonly id = 'fake' as const;

  async chat(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmReply> {
    const question = userQuestion(messages);
    const results = toolMessages(messages);

    if (results.length === 0) {
      const toolCall = firstToolCall(question, tools);
      if (!toolCall) {
        return {
          content: 'I can search satellites, inspect constellations, and explain relations in the graph.',
          toolCalls: [],
          finishReason: 'stop',
        };
      }
      return { content: '', toolCalls: [toolCall], finishReason: 'tool_calls' };
    }

    const firstTool = results[0].name ?? '';
    const lastPayload = parsePayload(results[results.length - 1]);
    const lower = question.toLowerCase();

    if (results.length === 1 && firstTool === 'search_satellites') {
      const data = Array.isArray(lastPayload?.data)
        ? (lastPayload?.data as { id: string; name: string }[])
        : [];
      const target = data[0];
      if (target && /relay|serve|support/.test(lower)) {
        return {
          content: '',
          toolCalls: [call('get_relations', { satelliteId: target.id, types: ['RELAY_SERVES'] })],
          finishReason: 'tool_calls',
        };
      }
      if (target && /(orbit|altitude|inclination|detail|about|element)/.test(lower)) {
        return {
          content: '',
          toolCalls: [call('get_satellite', { satelliteId: target.id })],
          finishReason: 'tool_calls',
        };
      }
    }

    if (!lastPayload) {
      return {
        content: 'The lookup returned an unreadable result. Please try a narrower question.',
        toolCalls: [],
        finishReason: 'stop',
      };
    }
    if (lastPayload.ok === false) {
      return {
        content: `I could not complete that lookup. ${lastPayload.summary ?? 'No matching data.'}`,
        toolCalls: [],
        finishReason: 'stop',
      };
    }

    const summary = lastPayload.summary ?? 'The graph returned no matching records.';
    const modeledNote =
      firstTool === 'get_constellation' && /link|isl/i.test(question)
        ? ' Inter-satellite links for this constellation are MODELED from its public architecture; they are not measured operational links.'
        : '';
    return {
      content: `${summary}${modeledNote}\n\nThese figures come directly from the SatGraph knowledge graph.`,
      toolCalls: [],
      finishReason: 'stop',
    };
  }
}
