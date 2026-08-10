import { describe, expect, it } from 'vitest';
import { googleCapabilities } from '../../providers/google/capabilities.js';
import { ModeUnavailableError, planMode, type PlanInput } from '../plan.js';

const caps = googleCapabilities();
const SYNC_MAX_MS = caps.limits.syncMaxSeconds * 1000; // 55 s
const SYNC_MAX_BYTES = caps.limits.syncMaxBytes; // 10 MB

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  durationMs: 30_000,
  bytes: 1_000_000,
  caps,
  stagingConfigured: true,
  ...over,
});

describe('planMode', () => {
  it('sends a short small file as one request', () => {
    const d = planMode(input());
    expect(d.mode).toBe('sync');
    expect(d.reason).toContain('fits one 55s request');
  });

  it('treats exactly syncMaxSeconds as fitting', () => {
    expect(planMode(input({ durationMs: SYNC_MAX_MS })).mode).toBe('sync');
  });

  it('chunks one millisecond over the duration limit', () => {
    expect(planMode(input({ durationMs: SYNC_MAX_MS + 1 })).mode).toBe('sync_chunked');
  });

  it('chunks one byte over the size limit even when the duration fits', () => {
    const d = planMode(input({ bytes: SYNC_MAX_BYTES + 1 }));
    expect(d.mode).toBe('sync_chunked');
    expect(d.reason).toContain('exceeds the 10.0 MB request limit');
  });

  it('chunks conservatively when the duration is unknown, and says so', () => {
    const d = planMode(input({ durationMs: null }));
    expect(d.mode).toBe('sync_chunked');
    expect(d.warnings.map((w) => w.code)).toContain('duration_unknown');
  });

  /**
   * The correction this whole file exists for.
   *
   * The design routed anything over fifteen minutes to `batchRecognize`, reasoning that
   * batch amortises its queue latency on long audio. Spike S3 measured batch at a flat
   * 5.9x realtime against chunked parallel sync's 3.6-7x advantage — the curves never cross,
   * so there is no duration at which batch is the faster choice and therefore none at which
   * the engine should pick it unasked. These four rows are that finding as a test.
   */
  describe('duration never selects batch', () => {
    for (const minutes of [16, 30, 120, 600]) {
      it(`leaves a ${minutes}-minute file on sync_chunked even with staging configured`, () => {
        const d = planMode(input({ durationMs: minutes * 60_000, bytes: 500_000_000 }));
        expect(d.mode).toBe('sync_chunked');
        // The reason names batch without recommending it: an operator should be able to
        // tell another mode exists and that not choosing it was deliberate.
        expect(d.reason).toContain('batch was not requested');
      });
    }
  });

  describe('force', () => {
    it('reaches batch only when asked, and explains the trade in the reason', () => {
      const d = planMode(input({ force: 'batch', durationMs: 30_000 }));
      expect(d.mode).toBe('batch');
      expect(d.reason).toContain('5.3x cheaper');
    });

    it('allows batch on a short file: cost is the reason, not length', () => {
      // Phase 8's overnight importer is the same seam. Nothing about duration gates this.
      expect(planMode(input({ force: 'batch', durationMs: 5_000 })).mode).toBe('batch');
    });

    it('throws for batch without a staging bucket rather than downgrading silently', () => {
      // There is nothing to fall back *from* now that duration never selects batch, and
      // substituting a mode the user did not ask for — at 5.3x the price — is worse than
      // saying no.
      expect(() => planMode(input({ force: 'batch', stagingConfigured: false }))).toThrow(
        ModeUnavailableError,
      );
      expect(() => planMode(input({ force: 'batch', stagingConfigured: false }))).toThrow(
        /google_gcs_staging_bucket/,
      );
    });

    it('throws when the provider does not offer the mode at all', () => {
      const noBatch = { ...caps, modes: ['sync' as const, 'sync_chunked' as const] };
      expect(() => planMode(input({ force: 'batch', caps: noBatch }))).toThrow(
        /does not support --mode batch/,
      );
    });

    it('throws for sync on a file that cannot fit one request', () => {
      expect(() => planMode(input({ force: 'sync', durationMs: 7_200_000 }))).toThrow(
        /--mode sync sends the whole file in one request/,
      );
      expect(() => planMode(input({ force: 'sync', bytes: SYNC_MAX_BYTES + 1 }))).toThrow(
        /10.0 MB request limit/,
      );
      expect(() => planMode(input({ force: 'sync', durationMs: null }))).toThrow(
        /could not be determined/,
      );
    });

    it('honours an explicit sync_chunked on a file that would have fitted one request', () => {
      const d = planMode(input({ force: 'sync_chunked', durationMs: 5_000 }));
      expect(d.mode).toBe('sync_chunked');
      expect(d.reason).toContain('requested explicitly');
    });
  });

  it('always returns a reason', () => {
    const cases: PlanInput[] = [
      input(),
      input({ durationMs: 7_200_000 }),
      input({ durationMs: null }),
      input({ force: 'batch' }),
      input({ force: 'sync_chunked' }),
    ];
    for (const c of cases) expect(planMode(c).reason.length).toBeGreaterThan(0);
  });
});
