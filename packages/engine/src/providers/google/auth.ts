import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type { Clock } from '../../context.js';
import { NotConfiguredError } from '../../errors.js';

/**
 * Access-token cache.
 *
 * A long file is many chunks, and each would otherwise pay for a fresh JWT exchange. Ported
 * from `lib/providers/google.ts:96-129` with three changes:
 *
 *  - **Off the module global.** A module-level `let tokenCache` is shared by every context
 *    in the process, which makes it untestable and, in a worker serving two newsrooms'
 *    credentials, wrong. It is now per-instance and the caller decides the lifetime.
 *  - **Keyed by sha256 of the service-account JSON**, not by the 2 KB blob itself. The key
 *    is never loggable and comparisons are cheap.
 *  - **In-flight coalescing.** Eight parallel chunks on a cold cache would otherwise mint
 *    eight JWTs for the same credentials.
 *
 * `resolveServiceAccountJson` is deliberately absent: turning
 * `GOOGLE_APPLICATION_CREDENTIALS` into a JSON string is a CLI concern, and the engine
 * reads no ambient configuration.
 */

export interface TokenCache {
  get(serviceAccountJson: string): Promise<string>;
}

export interface TokenCacheOptions {
  clock: Clock;
  /** Injectable so tests can assert the coalescing without a network. */
  mint?: (serviceAccountJson: string) => Promise<string>;
}

async function defaultMint(serviceAccountJson: string): Promise<string> {
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
  } catch {
    // A real usability win, kept verbatim: this is the mistake people actually make.
    throw new NotConfiguredError(
      'Google service-account JSON is not valid JSON — paste the whole file, including the ' +
        'outer braces',
    );
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new NotConfiguredError('Google returned no access token for this service account');
  }
  return token;
}

export function createTokenCache(options: TokenCacheOptions): TokenCache {
  const mint = options.mint ?? defaultMint;
  const entries = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();

  return {
    async get(serviceAccountJson: string): Promise<string> {
      const key = createHash('sha256').update(serviceAccountJson).digest('hex');
      const now = options.clock.now().getTime();

      const hit = entries.get(key);
      if (hit && hit.expiresAt > now + 60_000) return hit.token;

      let pending = inflight.get(key);
      if (!pending) {
        pending = mint(serviceAccountJson).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const token = await pending;

      // getAccessToken() doesn't surface expiry; assume the standard 1h and renew early.
      entries.set(key, { token, expiresAt: now + 45 * 60_000 });
      return token;
    },
  };
}

/** Pure helper. The CLI uses it to default the project id from the key. */
export function projectIdFrom(serviceAccountJson: string): string | null {
  try {
    const parsed = JSON.parse(serviceAccountJson) as { project_id?: string };
    return parsed.project_id ?? null;
  } catch {
    return null;
  }
}
