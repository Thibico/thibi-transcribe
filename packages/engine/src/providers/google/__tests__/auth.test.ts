import { describe, expect, it, vi } from 'vitest';
import { createTokenCache, projectIdFrom } from '../auth.js';
import type { Clock } from '../../../context.js';

/** A settable clock: sleep resolves immediately, now() is whatever the test says. */
function fakeClock(startMs = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    async sleep() {},
    advance(ms: number) {
      now += ms;
    },
  };
}

const SA = JSON.stringify({ project_id: 'thibi-test', client_email: 'x@y.iam.gserviceaccount.com' });

describe('createTokenCache', () => {
  it('mints once and serves the rest from cache', async () => {
    const clock = fakeClock();
    const mint = vi.fn(async () => 'token-1');
    const cache = createTokenCache({ clock, mint });

    expect(await cache.get(SA)).toBe('token-1');
    expect(await cache.get(SA)).toBe('token-1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  /**
   * Eight parallel chunks on a cold cache would otherwise mint eight JWTs for the same
   * credentials. The in-flight map is what stops that, and it is invisible without a test
   * because the result is correct either way.
   */
  it('coalesces concurrent misses into a single mint', async () => {
    const clock = fakeClock();
    let resolveMint: (value: string) => void = () => {};
    const mint = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const cache = createTokenCache({ clock, mint });

    const requests = Array.from({ length: 8 }, () => cache.get(SA));
    await Promise.resolve();
    resolveMint('token-1');

    expect(await Promise.all(requests)).toEqual(Array(8).fill('token-1'));
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('renews early rather than at expiry', async () => {
    // getAccessToken() does not surface expiry, so we assume the standard hour and record
    // a 45-minute lifetime. A further 60-second guard means the effective renewal point is
    // 44 minutes: a token that expires mid-flight fails a chunk for no reason, and the
    // guard is what keeps a request that starts just under the wire from being the one
    // that does.
    const clock = fakeClock();
    const mint = vi.fn(async () => `token-${mint.mock.calls.length}`);
    const cache = createTokenCache({ clock, mint });

    await cache.get(SA);
    clock.advance(43 * 60_000);
    await cache.get(SA);
    expect(mint).toHaveBeenCalledTimes(1);

    clock.advance(2 * 60_000);
    await cache.get(SA);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('keys by credential content, so a different key mints a different token', async () => {
    const clock = fakeClock();
    const mint = vi.fn(async (sa: string) => `token-for-${JSON.parse(sa).project_id}`);
    const cache = createTokenCache({ clock, mint });

    expect(await cache.get(SA)).toBe('token-for-thibi-test');
    expect(await cache.get(JSON.stringify({ project_id: 'other' }))).toBe('token-for-other');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('does not share state between cache instances', async () => {
    // The old implementation was a module-level `let`, shared by every context in the
    // process — untestable, and wrong in a worker holding two newsrooms' credentials.
    const clock = fakeClock();
    const mintA = vi.fn(async () => 'a');
    const mintB = vi.fn(async () => 'b');
    expect(await createTokenCache({ clock, mint: mintA }).get(SA)).toBe('a');
    expect(await createTokenCache({ clock, mint: mintB }).get(SA)).toBe('b');
  });

  it('explains the mistake people actually make with malformed JSON', async () => {
    const cache = createTokenCache({ clock: fakeClock() });
    await expect(cache.get('not json at all')).rejects.toThrow(/including the outer braces/);
  });
});

describe('projectIdFrom', () => {
  it('reads the project id from a service-account key', () => {
    expect(projectIdFrom(SA)).toBe('thibi-test');
  });

  it('returns null rather than throwing on junk', () => {
    expect(projectIdFrom('{')).toBeNull();
    expect(projectIdFrom('{}')).toBeNull();
  });
});
