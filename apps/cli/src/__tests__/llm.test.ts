import { describe, expect, it } from 'vitest';
import { buildLlmComplete, retryAfterMs } from '../llm.js';

/**
 * The chat-completions client.
 *
 * Two of the three cases here are regressions from a CI run that sat for three hours with no
 * output, which is the shape of failure this file now exists to prevent: a sleep looks exactly
 * like a hang from outside the process.
 */

const res = (headers: Record<string, string> = {}): Response =>
  new Response('', { status: 429, headers });

describe('retryAfterMs', () => {
  it('believes a short wait, from the header or the body', () => {
    expect(retryAfterMs(res({ 'retry-after': '12' }), '')).toBe(12_000);
    // Groq states the window in the message and not always in a header.
    expect(retryAfterMs(res(), 'Please try again in 9.2625s. Need more tokens?')).toBe(9263);
  });

  it('refuses to believe a wait longer than a minute', () => {
    // A daily-quota 429 reporting a 40-minute reset would otherwise sleep 40 minutes, three
    // times over, with no output — and a CI job gets killed at six hours having measured
    // nothing. Dropping the wait spends the retry budget in under two minutes and records the
    // segment as failed with the provider's own message attached.
    expect(retryAfterMs(res({ 'retry-after': '2400' }), '')).toBeUndefined();
    expect(retryAfterMs(res(), 'try again in 3600s')).toBeUndefined();
    // The boundary itself is still honoured.
    expect(retryAfterMs(res({ 'retry-after': '60' }), '')).toBe(60_000);
  });

  it('reports nothing when the provider said nothing', () => {
    expect(retryAfterMs(res(), 'rate limited')).toBeUndefined();
    // Groq's long-window format is not seconds and must not be misread as `2` seconds.
    expect(retryAfterMs(res(), 'try again in 2h30m12.5s')).toBeUndefined();
  });
});

describe('buildLlmComplete', () => {
  it('caps the output, because the default model is a reasoning model', () => {
    // Unbounded, `openai/gpt-oss-20b` spends an unbounded number of reasoning tokens before
    // writing the JSON — slow, and the documented cause of Groq's "max completion tokens
    // reached before generating a valid document" 400.
    let sent: Record<string, unknown> = {};
    const complete = buildLlmComplete({
      provider: 'groq',
      env: { GROQ_API_KEY: 'k' },
      fetchImpl: (async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: {} }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    return complete({ system: 's', user: 'u', model: 'm' }).then(() => {
      expect(sent['max_completion_tokens']).toBe(4000);
      expect(sent['temperature']).toBe(0);
    });
  });

  it('refuses to run without a key rather than failing on the first call', () => {
    expect(() => buildLlmComplete({ provider: 'groq', env: {} })).toThrow(/GROQ_API_KEY/u);
  });
});
