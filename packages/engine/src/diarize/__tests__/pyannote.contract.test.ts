/**
 * `PyannoteSource` against the real container.
 *
 * Every other test in this phase runs against a fake source that speaks §1's contract,
 * which is exactly the problem: a fake is a copy of what we *believe* the sidecar does, so
 * two halves in two languages can drift apart while both suites stay green. Nothing here
 * asserts a behaviour the fake already covers. What it checks is the seam — that the wire
 * shapes `pyannote.ts` hard-codes are the shapes `schemas.py` emits, that the status codes
 * it branches on are the ones `main.py` returns, and that `task_id` really is derivable
 * from the step key rather than merely documented as such.
 *
 * **This costs about 45 seconds** and skips itself when the sidecar is unreachable or its
 * model is not loaded. The bill is a real diarization: 11 s of audio takes ~40 s of CPU
 * inside Docker Desktop's Linux VM, which is the same macOS penalty S6 recorded. The
 * idempotency key is fresh on every run on purpose — a stable key would let the sidecar
 * return yesterday's completed task in milliseconds, and a test that never runs the model
 * would pass after the model stopped working.
 *
 * The audio is `__fixtures__/en-2spk-short.flac`, four alternating TTS turns with 400 ms of
 * silence between them; `packages/engine/scripts/make-2spk-fixture.mjs` regenerates both it
 * and the reference beside it. Two synthetic voices are far more separable than two people
 * on one microphone, which is the point — this is a contract test, not a measurement, and
 * an accuracy claim needs `thibi diarize score` against real audio (open question 2).
 */
import { readFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@thibi/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineContext } from '../../context.js';
import { ProviderError } from '../../errors.js';
import { DiarizerBusyError, PyannoteSource } from '../pyannote.js';
import { deadlineForDuration, diarizeStepKey } from '../run.js';
import type { DiarizationResult, DiarizeHandle, DiarizeStatus } from '../types.js';

const SIDECAR_URL = process.env['TEST_SIDECAR_URL'] ?? 'http://localhost:8081';
const S3_ENDPOINT = process.env['TEST_S3_ENDPOINT'] ?? 'http://localhost:9000';
/**
 * Where the *sidecar* reaches MinIO, which is not where we reach it.
 *
 * SigV4 signs the `Host` header, so a URL presigned against `localhost:9000` comes back
 * 403 when the container asks for it as `minio:9000` — overview amendment 43, and the first
 * failure of the first real diarization. Getting this wrong here would reproduce that
 * failure rather than test around it, which is why the test mints its URLs through the same
 * `signingClient` seam `apps/cli/src/context.ts` uses.
 */
const S3_INTERNAL_ENDPOINT = process.env['TEST_S3_INTERNAL_ENDPOINT'] ?? 'http://minio:9000';
const S3_BUCKET = process.env['TEST_S3_BUCKET'] ?? 'thibi';

interface SidecarHealth {
  status: string;
  models: { diarization: string };
}

/** Reachable *and* able to diarize. A degraded sidecar would fail every assertion below. */
async function sidecarReady(): Promise<{ ready: boolean; why: string }> {
  let health: SidecarHealth;
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ready: false, why: `/health returned HTTP ${res.status}` };
    health = (await res.json()) as SidecarHealth;
  } catch {
    return { ready: false, why: 'not reachable' };
  }
  if (health.models.diarization !== 'loaded') {
    return { ready: false, why: `the model is ${health.models.diarization}` };
  }
  return { ready: true, why: '' };
}

async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const health = await sidecarReady();
const hasMinio = await minioReachable();
const ready = health.ready && hasMinio;
if (!ready) {
  console.warn(
    `\n  [engine] Skipping the pyannote contract test — ` +
      (health.ready ? `MinIO is not reachable at ${S3_ENDPOINT}` : `sidecar ${health.why}`) +
      `.\n  Start both with: docker compose --env-file .env -f infra/compose.dev.yml ` +
      `--profile diarize up -d\n`,
  );
}

interface Reference {
  durationMs: number;
  turns: { startMs: number; endMs: number; speakerKey: string }[];
}

// `resolveJsonModule` is off repo-wide, so a JSON import type-checks under vitest's esbuild
// and then fails `tsc -b`. Both files are read as bytes.
const fixture = (name: string): URL => new URL(`../__fixtures__/${name}`, import.meta.url);
const AUDIO = readFileSync(fixture('en-2spk-short.flac'));
const REFERENCE = JSON.parse(
  readFileSync(fixture('en-2spk-short.truth.json'), 'utf8'),
) as Reference;

function makeStore(): S3ObjectStore {
  const client = (endpoint: string): S3Client =>
    new S3Client({
      endpoint,
      region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'thibi',
        secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'thibi-dev-secret',
      },
    });
  return new S3ObjectStore({
    bucket: S3_BUCKET,
    client: client(S3_ENDPOINT),
    signingClient: client(S3_INTERNAL_ENDPOINT),
  });
}

/** What `PyannoteSource` actually touches: a store to presign with, a clock and a logger. */
function makeCtx(store: S3ObjectStore): { ctx: EngineContext; logged: Record<string, unknown>[] } {
  const logged: Record<string, unknown>[] = [];
  const ctx = {
    clock: { now: () => new Date(), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
    logger: {
      info: (fields: Record<string, unknown>) => logged.push(fields),
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
    store,
    events: { emit: () => {} },
  } as unknown as EngineContext;
  return { ctx, logged };
}

/** The label covering a moment, which is what "who is speaking at t" means. */
function labelAt(result: DiarizationResult, atMs: number): string | undefined {
  return result.turns.find((t) => t.startMs <= atMs && atMs < t.endMs)?.speakerKey;
}

const source = new PyannoteSource({ baseUrl: SIDECAR_URL });
const prefix = `contract-test/${Date.now()}-${Math.trunc(Math.random() * 1e6)}/`;
const AUDIO_KEY = `${prefix}en-2spk-short.flac`;
// Unique per run: a fresh key is what forces a real diarization rather than a cached one.
const RUN_ID = `contract-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`;
const STEP_ID = diarizeStepKey(RUN_ID);

describe.skipIf(!ready)('PyannoteSource against the real sidecar', () => {
  let store: S3ObjectStore;
  let ctx: EngineContext;
  let logged: Record<string, unknown>[];
  let handle: DiarizeHandle;
  let resubmitted: DiarizeHandle;
  /** Captured in `beforeAll`, where the slot is guaranteed held. See the busy test. */
  let busyError: unknown;

  beforeAll(async () => {
    store = makeStore();
    ({ ctx, logged } = makeCtx(store));
    await store.put(AUDIO_KEY, AUDIO, { contentType: 'audio/flac' });

    const request = {
      runId: RUN_ID,
      stepId: STEP_ID,
      audio: { key: AUDIO_KEY, durationMs: REFERENCE.durationMs },
      hints: {},
      deadlineMs: deadlineForDuration(REFERENCE.durationMs),
    };
    handle = await source.submit(ctx, request);
    // Same key, immediately. The claim is that this lands on the running task rather than
    // starting a second one.
    resubmitted = await source.submit(ctx, request);
    // A *different* key while the first still holds the only slot. This happens here, not
    // in the test body, because the assertion is only meaningful while the slot is held —
    // and by the time an `it` ran, the task might have finished and this submission would
    // start a second real diarization instead of being refused.
    busyError = await source
      .submit(ctx, { ...request, runId: `${RUN_ID}-b`, stepId: diarizeStepKey(`${RUN_ID}-b`) })
      .then(() => undefined)
      .catch((err: unknown) => err);
  }, 60_000);

  afterAll(async () => {
    await store?.deletePrefix(prefix);
  }, 30_000);

  it('mints the task id the sidecar derives from the step key', async () => {
    // The deterministic-id claim, checked from outside. `uuid5(NAMESPACE_URL, step_id)`
    // lives in Python; the engine persists whatever id it is handed. Reading the Python to
    // confirm they agree would not be checking anything, which is why `/v1/tasks/by-key`
    // exists at all.
    const res = await fetch(`${SIDECAR_URL}/v1/tasks/by-key/${encodeURIComponent(STEP_ID)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string };
    expect(handle.taskId).toBe(body.task_id);
    expect(handle.sourceId).toBe('pyannote');
    expect(handle.meta).toMatchObject({ audioKey: AUDIO_KEY, durationMs: REFERENCE.durationMs });
  });

  it('lands a resubmit of the same key on the same task instead of starting a second', () => {
    expect(resubmitted.taskId).toBe(handle.taskId);
    // 200 rather than 202, which the client reports as `existing`. Without this the sidecar
    // could mint a task per attempt and nothing in the handle would show it: a resubmit
    // after a lost response would silently pay for a second three-hour diarization.
    expect(logged.map((f) => f['existing'])).toEqual([false, true]);
  });

  it('refuses a second key as a rate limit, not a failure', () => {
    // A 429 must arrive as `DiarizerBusyError` carrying `retryAfterMs`, because the engine
    // reads that class to decide *not* to count an attempt: waiting for the slot is not a
    // failed try, and spending one of diarize's two retries on a scheduling collision would
    // fail a run because two jobs happened to overlap.
    expect(busyError).toBeInstanceOf(DiarizerBusyError);
    expect((busyError as DiarizerBusyError).retryAfterMs).toBeGreaterThan(0);
  });

  it('reports a task it has never seen as retryable rather than throwing', async () => {
    // 404 is "never seen, safe to submit" — the journal was lost, not the task. It must
    // come back as a retryable failure; throwing here would surface a wiped volume as a
    // crash instead of a resubmit.
    const unknown = { ...handle, taskId: '00000000-0000-5000-8000-000000000000' };
    const status = await source.poll(ctx, unknown);
    expect(status.state).toBe('failed');
    expect(status.error).toMatchObject({ code: 'task_unknown', retryable: true });
  });

  it(
    'polls a real diarization to success and maps the wire result into the engine shape',
    async () => {
      let status: DiarizeStatus;
      const deadline = Date.now() + 150_000;
      for (;;) {
        status = await source.poll(ctx, handle);
        if (['succeeded', 'failed', 'cancelled', 'lost'].includes(status.state)) break;
        expect(['queued', 'running']).toContain(status.state);
        // Absent progress means "this source does not report it"; present progress is a
        // fraction. Zero is a legitimate value and must not be confused with absent.
        if (status.progress !== undefined) {
          expect(status.progress).toBeGreaterThanOrEqual(0);
          expect(status.progress).toBeLessThanOrEqual(1);
        }
        if (Date.now() > deadline) throw new Error(`still ${status.state} after 150 s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(status.state).toBe('succeeded');

      const result = await source.fetch(ctx, handle);

      // snake_case in, camelCase out. Each of these is a field `pyannote.ts` renames by
      // hand, so a rename on either side lands here rather than in production.
      expect(result.model).toMatch(/pyannote/);
      expect(result.audioDurationMs).toBeGreaterThan(0);
      expect(result.computeMs).toBeGreaterThan(0);
      expect(result.realtimeFactor).toBeGreaterThan(0);
      expect(result.params).toBeTypeOf('object');
      // `raw` is the untouched envelope, still snake_case, so a field nobody mapped yet is
      // still recoverable from the database. `device` is one of those: nothing reads it,
      // and it is asserted as present rather than as `cpu`, because a GPU host is a
      // deployment we want, not a test failure.
      expect(result.raw).toMatchObject({ num_speakers: result.numSpeakers });
      expect((result.raw as { device: unknown }).device).toBeTypeOf('string');

      // The duration the sidecar probed is the file's, not the one we claimed — it re-probes
      // precisely so a wrong `expected_duration_ms` is caught rather than believed.
      expect(Math.abs(result.audioDurationMs! - REFERENCE.durationMs)).toBeLessThan(500);

      expect(result.numSpeakers).toBe(2);
      expect(result.turns.length).toBeGreaterThanOrEqual(REFERENCE.turns.length);
      for (const turn of result.turns) {
        expect(turn.speakerKey).toMatch(/^SPEAKER_\d+$/);
        expect(turn.endMs).toBeGreaterThan(turn.startMs);
        expect(turn.startMs).toBeGreaterThanOrEqual(0);
        expect(turn.endMs).toBeLessThanOrEqual(REFERENCE.durationMs + 500);
      }

      // The content check, and the reason this fixture is four turns rather than one:
      // asking who speaks at the middle of each reference turn must reproduce the reference's
      // A-B-A-B pattern. It asserts the *pattern*, never which label pyannote chose, because
      // `SPEAKER_00` is meaningless across runs — that is what `identity.ts` exists for.
      // Stated as a pattern it also survives pyannote splitting a turn in two, which a
      // turn-by-turn comparison would not.
      const heard = REFERENCE.turns.map((t) =>
        labelAt(result, Math.round((t.startMs + t.endMs) / 2)),
      );
      expect(heard.every((label) => label !== undefined)).toBe(true);
      const pattern = (keys: (string | undefined)[]): number[] => {
        const seen = new Map<string | undefined, number>();
        return keys.map((k) => {
          if (!seen.has(k)) seen.set(k, seen.size);
          return seen.get(k)!;
        });
      };
      expect(pattern(heard)).toEqual(pattern(REFERENCE.turns.map((t) => t.speakerKey)));
    },
    180_000,
  );

  it(
    'cancels a task and refuses to fetch a result from it',
    async () => {
      const runId = `${RUN_ID}-cancel`;
      const cancelled = await source.submit(ctx, {
        runId,
        stepId: diarizeStepKey(runId),
        audio: { key: AUDIO_KEY, durationMs: REFERENCE.durationMs },
        hints: {},
        deadlineMs: deadlineForDuration(REFERENCE.durationMs),
      });
      await source.cancel(ctx, cancelled);

      // Cooperative: the worker notices at pyannote's progress hook, which fires per step.
      let status: DiarizeStatus;
      const deadline = Date.now() + 60_000;
      for (;;) {
        status = await source.poll(ctx, cancelled);
        if (status.state === 'cancelled') break;
        if (Date.now() > deadline) throw new Error(`still ${status.state} 60 s after cancel`);
        await new Promise((r) => setTimeout(r, 500));
      }

      // A cancelled task has no result, and asking for one is a programming error rather
      // than an outage — `ProviderError`, not `ProviderUnavailableError`, so the retry
      // policy does not wait an hour for a task that will never produce anything.
      await expect(source.fetch(ctx, cancelled)).rejects.toBeInstanceOf(ProviderError);
    },
    90_000,
  );
});
