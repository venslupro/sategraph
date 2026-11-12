/** Builds the configured provider chain. */
import type { Env } from '../env';
import { FakeLlmProvider } from './fake-provider';
import { FallbackLlmProvider } from './fallback-provider';
import { OpenAiCompatibleProvider } from './openai-provider';
import type { LlmProvider } from './provider';
import { WorkersAiProvider } from './workers-ai-provider';

export interface LlmSelection {
  provider: LlmProvider;
  mode: 'fake' | 'workers-ai' | 'byok';
}

export function createLlmProvider(env: Env): LlmSelection {
  const fake = new FakeLlmProvider();
  const requested = env.AGENT_MODE;

  if (requested === 'byok' && env.BYOK_BASE_URL && env.BYOK_API_KEY) {
    return {
      provider: new FallbackLlmProvider(
        'byok',
        new OpenAiCompatibleProvider(
          env.BYOK_BASE_URL,
          env.BYOK_API_KEY,
          env.BYOK_MODEL ?? 'gpt-4.1-mini',
        ),
        fake,
      ),
      mode: 'byok',
    };
  }

  if (requested !== 'fake' && env.AI) {
    return {
      provider: new FallbackLlmProvider(
        'workers-ai',
        new WorkersAiProvider(env.AI, env.AI_MODEL),
        fake,
      ),
      mode: 'workers-ai',
    };
  }

  return { provider: fake, mode: 'fake' };
}
