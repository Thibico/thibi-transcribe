import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { IngestError } from '../errors.js';

/**
 * yt-dlp hardening flags, as one shared constant so no call site can forget them.
 *
 * Every entry closes something yt-dlp does by default that we do not want a remote URL to be
 * able to reach: reading operator config files, loading plugins from disk, running `--exec`
 * hooks, or expanding one link into a 400-video channel. A test asserts the whole array
 * appears in the argv of both the resolve and the download call, because the failure mode of
 * a forgotten flag is silent.
 */
export const HARDENING: readonly string[] = Object.freeze([
  '--ignore-config',
  '--no-plugin-dirs',
  '--no-exec',
  '--no-playlist',
  '--no-mtime',
  '--restrict-filenames',
  '--socket-timeout',
  '30',
  '--retries',
  '3',
]);

export interface UrlPolicy {
  /** Empty means allow any host. Matched against the submitted URL and the resolved page. */
  allowedHosts: readonly string[];
  maxDurationSeconds: number;
  maxFilesizeBytes: number;
  resolveTimeoutMs: number;
  downloadTimeoutMs: number;
  /** Off disables URL import entirely — routes, CLI flag and all. */
  enabled: boolean;
}

export const DEFAULT_URL_POLICY: UrlPolicy = Object.freeze({
  allowedHosts: Object.freeze([]),
  maxDurationSeconds: 4 * 60 * 60,
  maxFilesizeBytes: 2 * 1024 * 1024 * 1024,
  resolveTimeoutMs: 30_000,
  downloadTimeoutMs: 60 * 60 * 1000,
  enabled: true,
});

/** Hosts that resolve to these are never fetched. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, and AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — RFC6598
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const ip = address.toLowerCase().split('%')[0] ?? '';
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(ip)) return true; // unique local, fc00::/7
  if (ip.startsWith('ff')) return true; // multicast
  // IPv4-mapped addresses carry a v4 address inside a v6 one, so they must be unwrapped and
  // re-checked or `::ffff:10.0.0.1` reaches the private network through the v6 arm.
  //
  // Both spellings are handled because the input is not the one that arrives here: WHATWG URL
  // parsing normalises `::ffff:10.0.0.1` to the **hex** form `::ffff:a00:1`, so a dotted-quad
  // pattern alone matches nothing in practice and the address is allowed. That was a real
  // bypass in the first version of this function, caught by the test below it.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted?.[1]) return isPrivateAddress(dotted[1], 4);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return isPrivateAddress(v4, 4);
  }
  return false;
}

/**
 * Reject a URL before anything is spawned.
 *
 * **This is defence in depth and does not close the hole.** yt-dlp follows its own redirects
 * with its own resolver, so a host that passes here can still redirect into the private
 * network afterwards. What this buys is that the obvious attempts — `file://`, `http://localhost`,
 * `http://169.254.169.254/` — never reach a subprocess at all, and that an operator who sets
 * an allowlist gets one. The real containment is that the download runs in the worker, as a
 * non-root user, with no shell.
 *
 * Ordering is deliberate: scheme, then allowlist, then DNS. The first two are free and the
 * third is a network round trip, and a `file://` URL should not cost a DNS lookup to refuse.
 */
export async function assertUrlAllowed(url: string, policy: UrlPolicy): Promise<URL> {
  if (!policy.enabled) {
    throw new IngestError('url_not_allowed', 'URL import is disabled on this instance.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IngestError('url_not_allowed', `Not a valid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IngestError(
      'url_not_allowed',
      `Only http and https URLs can be imported, not ${parsed.protocol.replace(':', '')}.`,
    );
  }

  if (policy.allowedHosts.length > 0 && !hostAllowed(parsed.hostname, policy.allowedHosts)) {
    throw new IngestError(
      'url_not_allowed',
      `${parsed.hostname} is not in this instance's allowed import hosts.`,
    );
  }

  // `URL.hostname` keeps the brackets on an IPv6 literal — `[::1]`, not `::1` — and `isIP`
  // returns 0 for the bracketed form. Without stripping them, every IPv6 literal skipped the
  // private-address check below and fell through to a DNS lookup that cannot resolve a
  // bracketed string. That failed closed, so it was not exploitable, but the check the
  // comment claimed to perform was not running at all. Found by the test for
  // `http://[::ffff:10.0.0.1]/`, which reported "could not resolve" instead of refusing it.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // A literal IP skips DNS but still gets checked — otherwise http://127.0.0.1/ walks through
  // the gap between "not a hostname" and "not resolved".
  const literal = isIP(host);
  if (literal) {
    if (isPrivateAddress(host, literal)) {
      throw new IngestError('url_not_allowed', 'That address is not reachable for import.');
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new IngestError('url_not_allowed', `Could not resolve ${host}.`);
  }
  // Every answer, not just the first: a host with one public and one private A record would
  // otherwise pass on the strength of whichever the resolver happened to order first.
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new IngestError('url_not_allowed', 'That address is not reachable for import.');
    }
  }
  return parsed;
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    // A bare entry covers its subdomains, so `youtube.com` admits `www.youtube.com` without
    // an operator having to enumerate them — but `notyoutube.com` must not match, which is
    // why this is a dot-boundary check rather than `endsWith`.
    return host === a || host.endsWith(`.${a}`);
  });
}

/**
 * The `--match-filter` expression for the download.
 *
 * `duration<?N` uses yt-dlp's `<?` operator, which **passes when the field is missing**. That
 * is deliberate in yt-dlp and a footgun here, so it is never the only duration check:
 * `resolveUrl` rejects a null duration outright, and the download re-checks the duration
 * carried by the signed token. Three independent guards, because this one silently admits
 * exactly the case it appears to exclude.
 */
export function matchFilter(maxDurationSeconds: number): string {
  return `duration<?${maxDurationSeconds} & !is_live`;
}
