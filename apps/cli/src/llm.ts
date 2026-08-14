import type { LlmComplete } from '@thibi/eval';
import { TEMPERATURE } from '@thibi/eval';
import type { EnvKey } from './context.js';

/**
 * The chat-completions client the LLM evals call, and the reason it lives in `apps/cli`.
 *
 * This is the environment reader. `packages/eval` takes the call as an injected dependency
 * and never builds one, so nothing below the CLI reads a key, and a test runs the whole
 * harness against scripted responses.
 *
 * **This is not Phase 6's gateway.** §6.1 specifies `generateObject` from the `ai` SDK across
 * Anthropic, OpenAI and OpenRouter, because three genuinely divergent structured-output
 * mechanisms behind one call site is what that abstraction is for. What Phase 5 needs is one
 * HTTP call to something that can follow a JSON contract, and the two providers whose keys
 * this repo already carries — OpenAI and Groq — speak the same chat-completions API. Adding
 * the SDK and two more key names here would be building Phase 6 in the wrong package.
 */

export type LlmProviderId = 'openai' | 'groq';

const BASE_URL: Record<LlmProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};

const KEY_FOR: Record<LlmProviderId, EnvKey> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export function isLlmProvider(id: string): id is LlmProviderId {
  return id === 'openai' || id === 'groq';
}

export interface BuildLlmOptions {
  provider: LlmProviderId;
  env: Partial<Record<EnvKey, string>>;
  /**
   * USD per input and output token, from the `rates` table.
   *
   * Null when no row exists, which is the state this repo is in: `rates` carries per-minute
   * audio SKUs read from a billing catalogue and nothing for LLM tokens. A run then reports
   * `$0.0000` and says the spend is unmeasured rather than quoting a price from memory —
   * and `--budget-usd` degrades with it, which the caller is told.
   */
  usdPerInputToken?: number | null;
  usdPerOutputToken?: number | null;
  fetchImpl?: typeof fetch;
}

export class LlmCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LLM call failed: HTTP ${status} — ${body.slice(0, 400)}`);
    this.name = 'LlmCallError';
  }
}

export function buildLlmComplete(options: BuildLlmOptions): LlmComplete {
  const key = options.env[KEY_FOR[options.provider]];
  if (!key) {
    throw new Error(
      `${KEY_FOR[options.provider]} is not set. Export it, or run with a provider whose key is:\n` +
        '  set -a && source .env && set +a',
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const inRate = options.usdPerInputToken ?? 0;
  const outRate = options.usdPerOutputToken ?? 0;

  return async ({ system, user, model }) => {
    const response = await fetchImpl(`${BASE_URL[options.provider]}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: TEMPERATURE,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // The prompts already specify the envelope and say "return the JSON only". This is
        // the provider-side belt: a reply wrapped in prose is a parse failure the harness
        // counts, and counting them is honest but not useful.
        response_format: { type: 'json_object' },
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new LlmCallError(response.status, text);

    const body = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      inputTokens,
      outputTokens,
      costUsd: inputTokens * inRate + outputTokens * outRate,
    };
  };
}
