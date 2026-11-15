/**
 * LLM port. Providers are interchangeable: Workers AI, an OpenAI-compatible
 * BYOK endpoint, or the deterministic local provider used by the seed mode.
 */
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmReply {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: 'stop' | 'tool_calls';
}

export interface LlmProvider {
  readonly id: 'fake' | 'workers-ai' | 'byok';
  chat(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmReply>;
}
