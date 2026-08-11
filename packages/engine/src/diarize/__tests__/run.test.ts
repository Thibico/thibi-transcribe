/**
 * The `diarize` stage's state machine, against a fake source.
 *
 * Three of these encode a distinction that is easy to collapse and expensive to get wrong:
 * a **429 is not an attempt** (nothing ran, so waiting for the slot must not consume a
 * retry), a **`lost` task is** (it ran, held the slot and was killed, so a crash-looping
 * container must not resubmit forever), and the **client wins the deadline race** (the
 * server's own backstop is 120 s later, so the failure is attributed on our side).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EngineContext } from '../../context.js';
import { DiarizerBusyError } from '../pyannote.js';
import { deadlineForDuration, diarizeStepKey, runDiarization } from '../run.js';
import type { DiarizationSource } from '../run.js';
import type { DiarizationResult, DiarizeHandle, DiarizeStatus } from '../types.js';

/** A clock that advances only when someone sleeps, so a 5-hour deadline costs no seconds. */
function fakeClock(): { now(): Date; sleep(ms: number): Promise<void>; advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeCtx(clock: ReturnType<typeof fakeClock>): {
  ctx: EngineContext;
  failures: unknown[][];
} {
  const failures: unknown[][] = [];
  const ctx = {
    clock,
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    events: { emit: () => {} },
    db: {
      $client: {
        query: async (_sql: string, params: unknown[]) => {
          failures.push(params);
          return { rows: [{ id: 'diar-run-1' }] };
        },
      },
    },
  } as unknown as EngineContext;
  return { ctx, failures };
}

interface FakeOpts {
  statuses: DiarizeStatus[];
  submitErrors?: Error[];
}

function fakeSource(opts: FakeOpts): DiarizationSource & { submits: number; cancels: number } {
  let i = 0;
  const submitErrors = [...(opts.submitErrors ?? [])];
  const source = {
    id: 'fake',
    label: 'fake',
    submits: 0,
    cancels: 0,
    capabilities: () => ({
      mode: 'async-task' as const,
      needsAudioUrl: true,
      overlapAware: true,
      speakerCountHint: 'range' as const,
      costModel: { unit: 'audio_minute' as const, usdPerUnit: 0 },
    }),
    submit: async (): Promise<DiarizeHandle> => {
      const err = submitErrors.shift();
      if (err) throw err;
      source.submits += 1;
      return { sourceId: 'fake', taskId: `task-${source.submits}`, submittedAtMs: 0, meta: {} };
    },
    poll: async (): Promise<DiarizeStatus> => opts.statuses[Math.min(i++, opts.statuses.length - 1)]!,
    fetch: async (): Promise<DiarizationResult> => {
      throw new Error('not used');
    },
    cancel: async (): Promise<void> => {
      source.cancels += 1;
    },
  };
  return source;
}

const input = {
  runId: '11111111-1111-1111-1111-111111111111',
  jobId: '22222222-2222-2222-2222-222222222222',
  audio: { key: 'assets/aa/x/norm.flac', durationMs: 3_600_000 },
  pollIntervalMs: 15_000,
};

describe('deadline and idempotency key', () => {
  it('is max(10 min, 12x duration)', () => {
    // The floor only bites below 50 s of audio — 12 x 60 s is already 12 minutes. Written
    // out because the first version of this test asserted the floor at a one-minute clip
    // and was wrong: "max(10 min, ...)" reads like a generous floor and is a narrow one.
    expect(deadlineForDuration(30_000)).toBe(600_000);
    expect(deadlineForDuration(60_000)).toBe(720_000);
    expect(deadlineForDuration(3_600_000)).toBe(43_200_000); // an hour: 12 h
  });

  it('derives the idempotency key from the run alone', () => {
    // Reconstructible without having stored the submit response, which is what makes a
    // lost 202 recoverable by GET.
    expect(diarizeStepKey('abc')).toBe('abc:diarize');
  });
});

describe('runDiarization', () => {
  it('waits out a busy slot without spending an attempt', async () => {
    const clock = fakeClock();
    const { ctx } = fakeCtx(clock);
    const source = fakeSource({
      statuses: [{ state: 'failed', error: { code: 'oom', message: 'no', retryable: false } }],
      submitErrors: [new DiarizerBusyError(60), new DiarizerBusyError(60)],
    });
    const sleep = vi.spyOn(clock, 'sleep');

    const outcome = await runDiarization(ctx, { ...input, source });

    expect(source.submits, 'the two 429s must not count as submissions').toBe(1);
    expect(sleep).toHaveBeenCalledWith(60_000, undefined);
    expect(outcome.kind).toBe('failed');
  });

  it('resubmits a lost task exactly once, then gives up', async () => {
    const clock = fakeClock();
    const { ctx } = fakeCtx(clock);
    const source = fakeSource({ statuses: [{ state: 'lost' }] });

    const outcome = await runDiarization(ctx, { ...input, source });

    expect(source.submits).toBe(2);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'lost' });
  });

  it('fails on the client deadline and cancels the server task', async () => {
    const clock = fakeClock();
    const { ctx } = fakeCtx(clock);
    // Never finishes. Each poll costs a 15 s sleep, so the 12 h deadline arrives on its own.
    const source = fakeSource({ statuses: [{ state: 'running', progress: 0.1 }] });

    const outcome = await runDiarization(ctx, { ...input, source });

    expect(outcome).toMatchObject({ kind: 'failed', code: 'deadline_exceeded' });
    expect(source.cancels, 'a runaway task must be told to free the slot').toBe(1);
  });

  it('reports a source-side failure with its own code, not a generic one', async () => {
    const clock = fakeClock();
    const { ctx } = fakeCtx(clock);
    const source = fakeSource({
      statuses: [
        { state: 'running' },
        {
          state: 'failed',
          error: { code: 'model_unavailable', message: 'gate not accepted', retryable: true },
        },
      ],
    });

    const outcome = await runDiarization(ctx, { ...input, source });
    expect(outcome).toMatchObject({ kind: 'failed', code: 'model_unavailable' });
  });
});
