import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IngestError } from '../../errors.js';
import { assertUrlAllowed, DEFAULT_URL_POLICY, HARDENING, matchFilter } from '../policy.js';
import { signResolveToken, verifyResolveToken } from '../token.js';
import { resolveUrl, type YtDlpPort } from '../resolve.js';
import { Semaphore } from '../download.js';

const SECRET = 'x'.repeat(48);
const NOW = 1_760_000_000_000;
const clock = { now: () => new Date(NOW) };

const INFO = {
  webpage_url: 'https://www.youtube.com/watch?v=abc',
  extractor: 'youtube',
  id: 'abc',
  title: 'ရွေးကောက်ပွဲ ဆွေးနွေးပွဲ',
  uploader: 'DVB TVnews',
  upload_date: '20260714',
  duration: 6442,
  _version: { version: '2026.07.21' },
};

/** Records every argv it is handed, so the guardrails can be asserted rather than assumed. */
function fakeYtDlp(info: unknown = INFO): YtDlpPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      return { stdout: JSON.stringify(info), stderr: '' };
    },
    spawn(args) {
      calls.push(args);
      return { stdout: Readable.from([]), stderr: Readable.from([]), done: Promise.resolve() };
    },
  };
}

describe('assertUrlAllowed', () => {
  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['an ftp URL', 'ftp://example.com/a.mp3'],
    ['a data URL', 'data:audio/mp3;base64,AAAA'],
    ['nonsense', 'not a url'],
  ])('rejects %s', async (_label, url) => {
    await expect(assertUrlAllowed(url, DEFAULT_URL_POLICY)).rejects.toThrow(IngestError);
  });

  it.each([
    ['loopback', 'http://127.0.0.1/a.mp3'],
    ['loopback v6', 'http://[::1]/a.mp3'],
    ['RFC1918 10/8', 'http://10.0.0.5/a.mp3'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/a.mp3'],
    ['RFC1918 172.16/12', 'http://172.20.0.1/a.mp3'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['CGNAT', 'http://100.64.0.1/a.mp3'],
    ['this-network', 'http://0.0.0.0/a.mp3'],
    ['IPv6 ULA', 'http://[fd00::1]/a.mp3'],
    ['IPv4-mapped private v6', 'http://[::ffff:10.0.0.1]/a.mp3'],
  ])('rejects a literal %s address without a DNS lookup', async (_label, url) => {
    await expect(assertUrlAllowed(url, DEFAULT_URL_POLICY)).rejects.toThrow(
      /not reachable for import/,
    );
  });

  it('still admits a public IPv4-mapped address', async () => {
    // The mapped-address unwrap must reject what is private inside the wrapper, not the
    // wrapper itself — otherwise the fix for the bypass becomes an outage for a legal host.
    await expect(assertUrlAllowed('http://[::ffff:8.8.8.8]/a.mp3', DEFAULT_URL_POLICY)).resolves
      .toBeInstanceOf(URL);
  });

  it('enforces an allowlist on a dot boundary', async () => {
    const policy = { ...DEFAULT_URL_POLICY, allowedHosts: ['youtube.com'] };
    // A bare entry covers subdomains…
    await expect(
      assertUrlAllowed('https://www.youtube.com/watch?v=abc', policy),
    ).resolves.toBeInstanceOf(URL);
    // …but must not be a suffix match, or an attacker registers notyoutube.com.
    await expect(assertUrlAllowed('https://notyoutube.com/x', policy)).rejects.toThrow(
      /not in this instance's allowed import hosts/,
    );
  });

  it('refuses everything when URL import is disabled', async () => {
    await expect(
      assertUrlAllowed('https://youtube.com/x', { ...DEFAULT_URL_POLICY, enabled: false }),
    ).rejects.toThrow(/disabled on this instance/);
  });
});

describe('resolveUrl', () => {
  it('sends every hardening flag and downloads no media', async () => {
    const ytdlp = fakeYtDlp();
    await resolveUrl({ ytdlp, policy: DEFAULT_URL_POLICY, clock }, 'https://www.youtube.com/watch?v=abc');

    const argv = ytdlp.calls[0]!;
    // The whole set, because a forgotten flag fails silently and permissively.
    for (const flag of HARDENING) expect(argv).toContain(flag);
    // --simulate and --dump-json are what make this cost one metadata request.
    expect(argv).toContain('--simulate');
    expect(argv).toContain('--dump-json');
  });

  it('never spawns yt-dlp for a URL the policy rejects', async () => {
    const ytdlp = fakeYtDlp();
    await expect(
      resolveUrl({ ytdlp, policy: DEFAULT_URL_POLICY, clock }, 'http://169.254.169.254/'),
    ).rejects.toThrow(IngestError);
    // The DoD's requirement: the rejection happens before a subprocess exists.
    expect(ytdlp.calls).toHaveLength(0);
  });

  it('rejects a live stream', async () => {
    const ytdlp = fakeYtDlp({ ...INFO, is_live: true });
    await expect(
      resolveUrl({ ytdlp, policy: DEFAULT_URL_POLICY, clock }, 'https://youtube.com/live'),
    ).rejects.toThrow(/Live streams/);
  });

  it('rejects a null duration rather than trusting the match filter', async () => {
    // yt-dlp's `duration<?N` passes when the field is missing, so this is the guard that
    // actually excludes it — and without a duration there is no cost to show.
    const ytdlp = fakeYtDlp({ ...INFO, duration: null });
    await expect(
      resolveUrl({ ytdlp, policy: DEFAULT_URL_POLICY, clock }, 'https://youtube.com/x'),
    ).rejects.toThrow(/did not report a duration/);
  });

  it('rejects media over the duration cap', async () => {
    const ytdlp = fakeYtDlp({ ...INFO, duration: 5 * 60 * 60 });
    await expect(
      resolveUrl({ ytdlp, policy: DEFAULT_URL_POLICY, clock }, 'https://youtube.com/x'),
    ).rejects.toThrow(/import limit/);
  });

  it('normalises the metadata a newsroom has to cite', async () => {
    const ytdlp = fakeYtDlp();
    const r = await resolveUrl(
      { ytdlp, policy: DEFAULT_URL_POLICY, clock },
      'https://www.youtube.com/watch?v=abc',
    );
    expect(r.title).toBe('ရွေးကောက်ပွဲ ဆွေးနွေးပွဲ');
    expect(r.uploadDate).toBe('2026-07-14');
    expect(r.durationMs).toBe(6_442_000);
    expect(r.ytdlpVersion).toBe('2026.07.21');
  });

  it('keeps the `<?` operator paired with an explicit live check', () => {
    expect(matchFilter(14400)).toBe('duration<?14400 & !is_live');
  });
});

describe('resolve tokens', () => {
  const claim = { url: 'https://youtube.com/x', durationMs: 6_442_000, estimateUsd: 1.72 };

  it('round-trips a claim', () => {
    const token = signResolveToken(claim, SECRET, NOW);
    expect(verifyResolveToken(token, SECRET, NOW + 1000)).toMatchObject(claim);
  });

  it('rejects a tampered duration', () => {
    // The attack the token exists to stop: approve 1:47, download four hours.
    const token = signResolveToken(claim, SECRET, NOW);
    const [body, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    decoded.durationMs = 14_400_000;
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`;
    expect(() => verifyResolveToken(forged, SECRET, NOW + 1000)).toThrow(/not valid/);
  });

  it('rejects a token signed with another secret', () => {
    const token = signResolveToken(claim, 'y'.repeat(48), NOW);
    expect(() => verifyResolveToken(token, SECRET, NOW + 1000)).toThrow(/not valid/);
  });

  it('expires', () => {
    const token = signResolveToken(claim, SECRET, NOW);
    expect(() => verifyResolveToken(token, SECRET, NOW + 11 * 60 * 1000)).toThrow(/expired/);
  });

  it('refuses to sign with a weak secret', () => {
    // An empty APP_SECRET_KEY would make every signature decorative, and the failure has to
    // be loud at signing time rather than discovered when someone forges a token.
    expect(() => signResolveToken(claim, '', NOW)).toThrow(/APP_SECRET_KEY/);
    expect(() => signResolveToken(claim, 'short', NOW)).toThrow(/APP_SECRET_KEY/);
  });
});

describe('Semaphore', () => {
  it('admits at most N holders at once', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await sem.acquire();
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        release();
      }),
    );

    expect(peak).toBe(2);
  });

  it('ignores a double release', async () => {
    // The release runs in a `finally` reachable twice on some abort paths; counting it twice
    // would quietly raise the limit.
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();

    const a = await sem.acquire();
    let secondAcquired = false;
    void sem.acquire().then(() => {
      secondAcquired = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondAcquired).toBe(false);
    a();
  });
});
