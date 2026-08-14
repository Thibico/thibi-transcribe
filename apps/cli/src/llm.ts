import {
  ProviderUnavailableError,
  RateLimitedError,
  RETRY_POLICIES,
  systemClock,
  withRetry,
} from '@thibi/engine';
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

  const clock = systemClock();

  const once = async (system: string, user: string, model: string): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }> => {
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
    if (response.status === 429) {
      const wait = retryAfterMs(response, text);
      throw new RateLimitedError(
        `rate limited: ${text.slice(0, 300)}`,
        wait === undefined ? undefined : { retryAfterMs: wait },
      );
    }
    if (response.status >= 500) throw new ProviderUnavailableError(`HTTP ${response.status}: ${text.slice(0, 300)}`);
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

  /**
   * Retry on 429 and 5xx, with the engine's own ladder.
   *
   * Measured 2026-08-14 and not a hypothetical: a 6-language n=30 run against Groq's
   * on-demand tier hit `tokens per minute (TPM): Limit 8000` on the fifth call and lost
   * **five of six languages** to a single 429 each, because nothing retried. The eval is
   * one sequential process, so the thing it needs is not a token bucket but the patience to
   * wait out a window the provider tells it the length of.
   *
   * `editorial.pass` is the right policy by name and by shape: four attempts, 5 s base,
   * 30 s cap — and `Retry-After` overrides the curve whenever the provider supplied one,
   * because it knows when its window resets and we do not.
   */
  return async ({ system, user, model }) =>
    withRetry(() => once(system, user, model), {
      policy: RETRY_POLICIES['editorial.pass'],
      clock,
      onRetry: ({ attempt, delayMs }) =>
        process.stderr.write(`\n  rate limited; waiting ${Math.round(delayMs / 1000)}s (attempt ${attempt})\n`),
    });
}

/**
 * How long to wait, in the provider's own words.
 *
 * `Retry-After` first, then Groq's `retry-after` variant, then the number in the message
 * body — `Please try again in 9.2625s` — because Groq's 429 does not always carry a header
 * and the body is the only place the window length appears. Falling through to `undefined`
 * lets the jittered curve take over rather than guessing.
 */
function retryAfterMs(response: Response, body: string): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }
  const inBody = /try again in ([\d.]+)s/iu.exec(body);
  if (inBody?.[1]) return Math.ceil(Number(inBody[1]) * 1000);
  return undefined;
}
