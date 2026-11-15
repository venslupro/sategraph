/** OpenAI-compatible BYOK endpoint (OpenAI, OpenRouter, self-hosted gateway). */
import type {
  LlmMessage,
  LlmProvider,
  LlmReply,
  LlmToolCall,
  LlmToolDefinition,
} from './provider';

interface ChatCompletionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
    finish_reason?: string;
  }[];
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'byok' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmReply> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map((message) => {
            if (message.role === 'tool') {
              return {
                role: 'tool',
                content: message.content,
                tool_call_id: message.toolCallId ?? message.name ?? 'tool',
              };
            }
            if (message.role === 'assistant' && message.toolCalls?.length) {
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
          }),
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: 'auto',
          temperature: 0.1,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status})`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).map(
      (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: call.id, name: call.function.name, arguments: args };
      },
    );
    return {
      content: choice?.message?.content ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}
