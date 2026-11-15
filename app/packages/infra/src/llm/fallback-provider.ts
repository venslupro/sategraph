/** Falls back to the deterministic provider when a model call fails. */
import type {
  LlmMessage,
  LlmProvider,
  LlmReply,
  LlmToolDefinition,
} from './provider';

export class FallbackLlmProvider implements LlmProvider {
  constructor(
    readonly id: LlmProvider['id'],
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {}

  async chat(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmReply> {
    try {
      const reply = await this.primary.chat(messages, tools);
      if (reply.content || reply.toolCalls.length > 0) {
        return reply;
      }
    } catch {
      // Model unavailable: degrade to the deterministic provider.
    }
    return this.fallback.chat(messages, tools);
  }
}
