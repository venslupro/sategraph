/**
 * Workers AI adapter. Model output is normalised because Workers AI supports
 * both the classic `response` field and OpenAI-style tool calls.
 */
import type {
  LlmMessage,
  LlmProvider,
  LlmReply,
  LlmToolCall,
  LlmToolDefinition,
} from './provider';

interface WorkersAiToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

interface WorkersAiResult {
  response?: string;
  tool_calls?: WorkersAiToolCall[];
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? message.name ?? 'tool',
      name: message.name,
    };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export class WorkersAiProvider implements LlmProvider {
  readonly id = 'workers-ai' as const;

  constructor(
    private readonly ai: Ai,
    private readonly model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ) {}

  async chat(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmReply> {
    const payload = {
      messages: messages.map(toOpenAiMessage),
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: 'auto',
      max_tokens: 900,
    };
    const raw = (await this.ai.run(
      this.model as never,
      payload as never,
    )) as WorkersAiResult;
    const toolCalls: LlmToolCall[] = (raw.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `tool_${index}`,
      name: call.name ?? call.function?.name ?? 'unknown',
      arguments: parseArguments(call.arguments ?? call.function?.arguments),
    }));
    return {
      content: raw.response ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}
