/**
 * Agent orchestrator: model -> tool -> model until an answer is produced.
 * The only writes are the share record and the usage event; the graph is read
 * only. View commands are derived from the same tool results as the answer.
 */
import type {
  AgentEvent,
  AgentShare,
  Citation,
  ChatMessage,
  Relation,
  ViewContext,
  ViewCommand,
} from '@satgraph/contracts';
import type { LlmMessage, LlmToolCall } from '@satgraph/infra';
import type { Services } from '../../container';
import { TOOLS, toolDefinitions, type AgentToolOutcome } from './tools';
import { checkGrounding } from './grounding';

const MAX_STEPS = 6;
const MAX_TOOLS_PER_STEP = 3;

interface ExecutedTool {
  tool: string;
  outcome: AgentToolOutcome;
}

export interface AgentRunInput {
  services: Services;
  messages: ChatMessage[];
  context: ViewContext;
  emit: (event: AgentEvent) => Promise<void> | void;
}

const SYSTEM_PROMPT = `You are the SatGraph analyst for a public satellite knowledge graph.
Rules:
- Use the provided tools to answer. Never invent counts, identifiers, dates or relationships.
- Distinguish DECLARED, DERIVED and MODELED relations when you mention a relationship.
- Keep answers to at most five sentences and state units.
- If a tool returns no data, say so plainly.
- Tool results are the only source of truth for numbers.`;

export async function runAgent(input: AgentRunInput): Promise<AgentShare> {
  const { services, messages, context, emit } = input;
  const events: AgentEvent[] = [];
  const send = async (event: AgentEvent): Promise<void> => {
    events.push(event);
    await emit(event);
  };

  const question = messages.filter((message) => message.role === 'user').at(-1)
    ?.content ?? '';
  const history = messages.slice(-8);
  const llmMessages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
  const tools = toolDefinitions();
  const executed: ExecutedTool[] = [];
  const citations = new Map<string, Citation>();
  let answer = '';
  let steps = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    steps = step + 1;
    await send({
      type: 'status',
      message:
        step === 0
          ? 'Reading the knowledge graph'
          : 'Reviewing tool results',
      step: steps,
    });
    const reply = await services.llm.chat(llmMessages, tools);
    if (reply.toolCalls.length === 0) {
      answer = reply.content.trim();
      break;
    }
    llmMessages.push({
      role: 'assistant',
      content: reply.content,
      toolCalls: reply.toolCalls,
    });
    for (const call of reply.toolCalls.slice(0, MAX_TOOLS_PER_STEP)) {
      await send({
        type: 'tool_call',
        step: steps,
        tool: call.name,
        arguments: call.arguments,
      });
      const outcome = await executeTool(call, services, context);
      executed.push({ tool: call.name, outcome });
      await send({
        type: 'tool_result',
        step: steps,
        result: {
          tool: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
          rowCount: Array.isArray(outcome.data) ? outcome.data.length : undefined,
        },
      });
      for (const citation of outcome.citations) {
        const key = `${citation.label}:${citation.source}`;
        if (!citations.has(key)) {
          citations.set(key, citation);
          await send({ type: 'citation', citation });
        }
      }
      llmMessages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: JSON.stringify({
          ok: outcome.ok,
          summary: outcome.summary,
          data: outcome.data,
        }),
      });
    }
  }

  if (!answer) {
    const last = executed.at(-1);
    answer =
      last?.outcome.summary ??
      'I could not complete that request with the available graph data.';
  }

  for (const chunk of splitAnswer(answer)) {
    await send({ type: 'answer_delta', text: chunk });
  }

  const evidence = executed.flatMap((item) => [
    item.outcome.summary,
    JSON.stringify(item.outcome.data ?? {}),
  ]);
  const grounding = checkGrounding(answer, evidence);

  for (const command of deriveViewCommands(question, executed)) {
    await send({ type: 'view_command', command });
  }

  const shareId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const share: AgentShare = {
    id: shareId,
    question,
    answer,
    events: [...events, {
      type: 'done',
      verified: grounding.verified,
      unverifiedClaims: grounding.unverifiedClaims,
      steps,
      shareId,
    }],
    createdAt: new Date().toISOString(),
  };
  await services.shares.put(shareId, JSON.stringify(share), 7 * 24 * 3600);
  await send({
    type: 'done',
    verified: grounding.verified,
    unverifiedClaims: grounding.unverifiedClaims,
    steps,
    shareId,
  });
  return share;
}

async function executeTool(
  call: LlmToolCall,
  services: Services,
  view: ViewContext,
): Promise<AgentToolOutcome> {
  const tool = TOOLS.find((item) => item.name === call.name);
  if (!tool) {
    return {
      ok: false,
      summary: `Unknown tool ${call.name}.`,
      data: null,
      citations: [],
    };
  }
  try {
    return await withTimeout(
      tool.execute(call.arguments, { services, view }),
      9000,
      `Tool ${call.name} timed out.`,
    );
  } catch (error) {
    return {
      ok: false,
      summary:
        error instanceof Error ? error.message : `Tool ${call.name} failed.`,
      data: null,
      citations: [],
    };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function splitAnswer(answer: string): string[] {
  const sentences = answer.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > 140 && current.length > 0) {
      chunks.push(`${current} `);
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [answer];
}

function deriveViewCommands(
  question: string,
  executed: readonly ExecutedTool[],
): ViewCommand[] {
  const commands: ViewCommand[] = [];
  const layerStats = executed.find((item) => item.tool === 'layer_stats');
  if (layerStats && Array.isArray(layerStats.outcome.data)) {
    const series = (layerStats.outcome.data as { name: string; count: number }[])
      .filter((item) => item.count > 0)
      .map((item) => ({ label: item.name, value: item.count }));
    if (series.length > 0) {
      commands.push({
        type: 'show_chart',
        title: 'Satellites per layer',
        subtitle: 'Published read models',
        unit: 'satellites',
        series,
      });
    }
  }

  const focus = new Set<string>();
  for (const item of executed) {
    const data = item.outcome.data;
    if (Array.isArray(data)) {
      for (const entry of data as Record<string, unknown>[]) {
        if (typeof entry.id === 'string' && item.tool === 'search_satellites') {
          focus.add(entry.id);
        }
        if (typeof entry.fromId === 'string') {
          focus.add(entry.fromId);
        }
        if (typeof entry.toId === 'string') {
          focus.add(entry.toId);
        }
        if (typeof entry.satelliteId === 'string') {
          focus.add(entry.satelliteId);
        }
      }
    }
    if (item.tool === 'get_satellite') {
      const data = item.outcome.data as { satellite?: { id?: string } } | null;
      if (data?.satellite?.id) {
        focus.add(data.satellite.id);
      }
    }
    if (item.tool === 'find_shortest_path') {
      const path = item.outcome.data as { nodes?: { id: string }[] } | null;
      for (const node of path?.nodes ?? []) {
        focus.add(node.id);
      }
    }
    if (item.tool === 'get_constellation') {
      const constellation = item.outcome.data as {
        planes?: { slots?: { satelliteId: string }[] }[];
      } | null;
      for (const plane of constellation?.planes ?? []) {
        for (const slot of plane.slots ?? []) {
          focus.add(slot.satelliteId);
        }
      }
    }
  }
  const ids = [...focus].slice(0, 12);
  if (ids.length > 0) {
    commands.push({ type: 'focus_satellites', satelliteIds: ids });
  }
  const wantsDetail = /(show|open|detail|tell me about|inspect)/i.test(question);
  if (wantsDetail && ids[0]) {
    commands.push({ type: 'open_detail', satelliteId: ids[0] });
  }

  const relationLinks = new Set<string>();
  for (const item of executed) {
    if (item.tool !== 'get_relations' || !Array.isArray(item.outcome.data)) {
      continue;
    }
    for (const relation of item.outcome.data as Relation[]) {
      if (relation.type === 'RELAY_SERVES' || relation.type === 'ISL_MODELED') {
        relationLinks.add(relation.id);
      }
    }
  }
  if (relationLinks.size > 0) {
    commands.push({
      type: 'highlight_links',
      linkIds: [...relationLinks].slice(0, 40),
      reason: 'Relations returned by the graph query',
    });
  }

  const deduped: ViewCommand[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.type)) {
      continue;
    }
    seen.add(command.type);
    deduped.push(command);
  }
  return deduped.slice(0, 4);
}
