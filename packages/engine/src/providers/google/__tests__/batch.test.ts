import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeStagingStore } from '../../../staging/memory.js';
import type { BatchOp, BatchRequest } from '../../types.js';
import {
  buildBatchBody,
  cancelBatch,
  classifyOperation,
  fetchBatchResult,
  findOrphanOperation,
  pollBatch,
  submitBatch,
  type BatchDeps,
} from '../batch.js';
import { parseRecognizeResults, type BatchRecognizeResults, type RecognizeResponse } from '../parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const BUCKET = 'thibi-stt-staging-asse1';
const RUN = '412d5945-f999-4a0a-8c49-7bad085e9f5d';
const INPUT_URI = `gs://${BUCKET}/thibi-staging/${RUN}/audio.flac`;

const clock = { now: () => new Date(1_760_000_000_000), sleep: async () => {} };

function deps(fetchImpl: typeof fetch): BatchDeps {
  return {
    region: 'asia-southeast1',
    projectId: 'myanmar-transcription',
    getToken: async () => 'token',
    fetchImpl,
    clock,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const op: BatchOp = {
  provider: 'google',
  region: 'asia-southeast1',
  name: 'projects/477538743654/locations/asia-southeast1/operations/v2-6b33deaf-0000-2e70-af8a-d4f547fe730c',
  inputUri: INPUT_URI,
  outputPrefix: `gs://${BUCKET}/thibi-staging/${RUN}/out`,
  submittedAtMs: 1_759_999_000_000,
  dynamicBatching: true,
};

const request: BatchRequest = {
  runId: RUN,
  audioUri: INPUT_URI,
  outputUri: `gs://${BUCKET}/thibi-staging/${RUN}/out`,
  languageCode: 'my-MM',
  model: 'chirp_2',
  durationMs: 1_200_000,
};

describe('buildBatchBody', () => {
  it('asks for GCS output, one file, and the cheap processing strategy', () => {
    const body = buildBatchBody(request, true) as Record<string, never>;
    expect(body).toMatchObject({
      files: [{ uri: INPUT_URI }],
      recognitionOutputConfig: { gcsOutputConfig: { uri: request.outputUri } },
      processingStrategy: 'DYNAMIC_BATCHING',
    });
    // One file per operation, so cancellation, cost attribution and failure isolation are
    // all per-run.
    expect((body as unknown as { files: unknown[] }).files).toHaveLength(1);
  });

  it('never sends config.adaptation, whatever it is handed', () => {
    // Spike S1: chirp_2 ignores phrase sets, and an *irrelevant* one measurably corrupted
    // output. Supplying one is not free, so the field must not exist on this path.
    const body = buildBatchBody(
      { ...request, phraseSet: { phrases: [{ value: 'အာဆီယံ' }] } },
      true,
    ) as { config: Record<string, unknown> };
    expect(body.config).not.toHaveProperty('adaptation');
  });

  it('omits processingStrategy entirely on the fallback, rather than sending a null', () => {
    expect(buildBatchBody(request, false)).not.toHaveProperty('processingStrategy');
  });
});

describe('submitBatch', () => {
  it('returns a BatchOp carrying the region and input URI', async () => {
    const fetchImpl = vi.fn(async () => json(load('batch-submit-response.json')));
    const result = await submitBatch(deps(fetchImpl as unknown as typeof fetch), request);

    expect(result.name).toBe(op.name);
    expect(result.region).toBe('asia-southeast1');
    expect(result.inputUri).toBe(INPUT_URI);
    expect(result.dynamicBatching).toBe(true);
    expect(result.submittedAtMs).toBe(clock.now().getTime());
  });

  it('retries without DYNAMIC_BATCHING when the field is rejected, and records that', async () => {
    // Risk 1. The run still happens and `usage_records` tells the truth about the cost.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      if (calls.length === 1) {
        return json({ error: { message: 'Invalid JSON payload: unknown field processingStrategy' } }, 400);
      }
      return json(load('batch-submit-response.json'));
    });

    const result = await submitBatch(deps(fetchImpl as unknown as typeof fetch), request);
    expect(calls).toHaveLength(2);
    expect(calls[0]!).toContain('DYNAMIC_BATCHING');
    expect(calls[1]!).not.toContain('DYNAMIC_BATCHING');
    expect(result.dynamicBatching).toBe(false);
  });

  it('does not retry a 400 that is about something else', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: 'Bad language code' } }, 400));
    await expect(submitBatch(deps(fetchImpl as unknown as typeof fetch), request)).rejects.toThrow(
      /Bad language code/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a response with no operation name: there would be nothing to poll', async () => {
    const fetchImpl = vi.fn(async () => json({ done: false }));
    await expect(submitBatch(deps(fetchImpl as unknown as typeof fetch), request)).rejects.toThrow(
      /no operation name/,
    );
  });
});

describe('classifyOperation', () => {
  it('reports running, and carries progressPercent only when Google sent one', () => {
    expect(classifyOperation(load('batch-poll-running.json'), op, 1)).toMatchObject({
      state: 'running',
      progressPercent: 52,
    });
    // Measured 2026-08-10: progressPercent *is* usually populated (26/52/78 over thirteen
    // polls on a 20-minute file), which risk 3 had assumed might never happen. It is still
    // never fabricated when absent.
    expect(classifyOperation(load('batch-poll-running-noprogress.json'), op, 1)).toEqual({
      state: 'running',
    });
  });

  it('reports success with the output URI and the billed duration', () => {
    const status = classifyOperation(load('batch-poll-done-success.json'), op, 42);
    expect(status.state).toBe('succeeded');
    expect(status.outputUri).toContain('audio_transcript_');
    expect(status.totalBilledDuration).toBe('1200s');
    expect(status.doneAtMs).toBe(42);
  });

  it('treats a PER-FILE error under done:true as a failure, and marks code 13 retryable', () => {
    /**
     * The trap this function exists for. Spike S3 measured an operation reporting
     * `done: true`, `progressPercent: 100` and **no operation-level error** while
     * `results[uri].error` was set to code 13 with `totalBilledDuration: "0s"`. It hit
     * **1 run in 5**. A poller trusting `done` and `error` reports success and then cannot
     * find an output object that was never written.
     */
    const status = classifyOperation(load('batch-poll-done-file-error.json'), op, 1);
    expect(status.state).toBe('failed');
    expect(status.error?.scope).toBe('file');
    expect(status.error?.code).toBe(13);
    // "0s" confirms a failed file is unbilled, which is what makes resubmitting free.
    expect(status.totalBilledDuration).toBe('0s');
    expect(status.retryable).toBe(true);
  });

  it('reports an operation-level error and does NOT mark RESOURCE_EXHAUSTED retryable', () => {
    // Resubmitting straight into a quota wall is how a quota wall becomes a quota ban.
    const status = classifyOperation(load('batch-poll-done-op-error.json'), op, 1);
    expect(status.state).toBe('failed');
    expect(status.error?.scope).toBe('operation');
    expect(status.error?.code).toBe(8);
    expect(status.retryable).toBe(false);
  });

  it('fails rather than guessing when the result map has no entry for our file', () => {
    const status = classifyOperation(load('batch-poll-done-missing-key.json'), op, 1);
    expect(status.state).toBe('failed');
    expect(status.error?.message).toContain('somebody-elses.flac');
    expect(status.retryable).toBe(false);
  });

  it('distinguishes the three done:true shapes from one another', () => {
    const states = [
      'batch-poll-done-success.json',
      'batch-poll-done-op-error.json',
      'batch-poll-done-file-error.json',
    ].map((f) => {
      const s = classifyOperation(load(f), op, 1);
      return `${s.state}/${s.error?.scope ?? '-'}`;
    });
    expect(states).toEqual(['succeeded/-', 'failed/operation', 'failed/file']);
  });
});

describe('pollBatch', () => {
  it('survives a JSON round-trip and still polls — the Phase 9 constraint, executable', () => {
    /**
     * Phase 9 deletes Phase 2's in-process loop and calls these same methods from a
     * self-rescheduling `run_steps` row, in a worker process that never saw the submit and
     * rebuilds the operation from Postgres. The single property that makes that possible is
     * that `BatchOp` is plain JSON — no clients, no closures, no timers. If this test ever
     * needs changing, Phase 9 has just become much harder.
     */
    const rehydrated = JSON.parse(JSON.stringify(op)) as BatchOp;
    expect(rehydrated).toEqual(op);

    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return json(load('batch-poll-done-success.json'));
    });
    return pollBatch(deps(fetchImpl as unknown as typeof fetch), rehydrated).then((status) => {
      expect(status.state).toBe('succeeded');
      // And it polled the regional host the *stored* region names, not a recomputed one.
      expect(urls[0]).toContain('asia-southeast1-speech.googleapis.com');
    });
  });

  it('refuses to poll when the stored region disagrees with the operation name', async () => {
    // Polling the wrong regional host 404s in a way that reads like "the operation is gone"
    // rather than "you asked the wrong server", which is a bad afternoon.
    const wrong = { ...op, region: 'europe-west4' };
    const fetchImpl = vi.fn(async () => json({}));
    await expect(pollBatch(deps(fetchImpl as unknown as typeof fetch), wrong)).rejects.toThrow(
      /asia-southeast1.*europe-west4/s,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchBatchResult', () => {
  it('reads the transcript through the port and parses it with the sync parser', async () => {
    const staging = new FakeStagingStore({ bucket: BUCKET });
    const outputUri = staging.seedJson(
      `thibi-staging/${RUN}/out/audio_transcript_x.json`,
      load('batch-output-my.json'),
    );

    const result = await fetchBatchResult(deps((async () => json({})) as unknown as typeof fetch), op, {
      status: { state: 'succeeded', outputUri },
      durationMs: 1_200_000,
      read: staging.readJson.bind(staging),
      list: staging.list.bind(staging),
    });

    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.wordTimingQuality).toBe('full');
    expect(result.usage).toEqual({ audioMs: 1_200_000, requests: 1 });
  });

  it('falls back to listing the prefix, and refuses when that is ambiguous', async () => {
    const staging = new FakeStagingStore({ bucket: BUCKET });
    staging.seedJson(`thibi-staging/${RUN}/out/a.json`, load('batch-output-my.json'));

    const args = {
      status: { state: 'succeeded' as const },
      durationMs: 1000,
      read: staging.readJson.bind(staging),
      list: staging.list.bind(staging),
    };
    const d = deps((async () => json({})) as unknown as typeof fetch);
    await expect(fetchBatchResult(d, op, args)).resolves.toBeDefined();

    // Two transcripts under one prefix: picking one at random would produce a plausible,
    // wrong result that nobody would ever catch.
    staging.seedJson(`thibi-staging/${RUN}/out/b.json`, load('batch-output-my.json'));
    await expect(fetchBatchResult(d, op, args)).rejects.toThrow(/expected exactly one/);
  });

  it('refuses an output URI pointing at a different bucket', async () => {
    // Google writes where we told it to. A different bucket means this is not our
    // operation, and following the URI would read a stranger's object with our credentials.
    const staging = new FakeStagingStore({ bucket: BUCKET });
    await expect(
      staging.readJson('gs://someone-else/out/transcript.json'),
    ).rejects.toThrow(/Refusing to read it/);
  });

  it('rejects a body over maxBytes with a message naming the size', async () => {
    const staging = new FakeStagingStore({ bucket: BUCKET });
    const uri = staging.seedJson('big.json', { padding: 'x'.repeat(4096) });
    await expect(staging.readJson(uri, { maxBytes: 1024 })).rejects.toThrow(/KB, over the/);
  });
});

describe('one parser, two transports', () => {
  it('produces identical segments from a sync response and a batch output', () => {
    /**
     * The load-bearing claim of the whole batch path, asserted rather than assumed:
     * `BatchRecognizeResults.results[]` is the *same shape* as `RecognizeResponse.results[]`,
     * so `parseRecognizeResults` over either produces the same `ProviderSegment[]`. The two
     * call sites differ only in `offsetMs` — the chunk's position for sync, and 0 for batch
     * because batch is whole-file.
     */
    const sync = load<RecognizeResponse>('recognize-my-full.json');
    // Same array, arriving through the other envelope.
    const batch: BatchRecognizeResults = { results: sync.results ?? [] };

    const opts = { offsetMs: 0, durationMs: 55_000 };
    const fromSync = parseRecognizeResults(sync.results ?? [], opts);
    const fromBatch = parseRecognizeResults(batch.results ?? [], opts);

    expect(fromBatch.segments).toEqual(fromSync.segments);
    expect(fromBatch.wordTimingQuality).toEqual(fromSync.wordTimingQuality);
  });

  it('reports quality `none` for a wordless batch output and still bounds the segments', () => {
    const body = load<BatchRecognizeResults>('batch-output-no-words.json');
    const parsed = parseRecognizeResults(body.results ?? [], { offsetMs: 0, durationMs: 1_200_000 });

    expect(parsed.wordTimingQuality).toBe('none');
    expect(parsed.segments.length).toBeGreaterThan(0);
    // Bounded from resultEndOffset rather than left at zero-length.
    expect(parsed.segments.every((s) => s.endMs >= s.startMs)).toBe(true);
    expect(parsed.segments.some((s) => s.endMs > 0)).toBe(true);
  });
});

describe('cancelBatch', () => {
  it('treats an already-finished operation as cancelled', async () => {
    for (const status of [200, 400, 404]) {
      const fetchImpl = vi.fn(async () => json({}, status));
      await expect(
        cancelBatch(deps(fetchImpl as unknown as typeof fetch), op),
      ).resolves.toBeUndefined();
    }
  });

  it('surfaces a real failure', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: 'nope' } }, 500));
    await expect(cancelBatch(deps(fetchImpl as unknown as typeof fetch), op)).rejects.toThrow();
  });
});

describe('findOrphanOperation', () => {
  const listFetch = () => vi.fn(async () => json(load('operations-list.json')));

  it('matches the operation by input URI', async () => {
    const found = await findOrphanOperation(deps(listFetch() as unknown as typeof fetch), {
      inputUri: INPUT_URI,
      sinceMs: 6 * 3600_000,
      nowMs: Date.parse('2026-08-10T05:00:00Z'),
      outputPrefix: op.outputPrefix,
    });
    expect(found?.name).toBe(op.name);
    expect(found?.inputUri).toBe(INPUT_URI);
    // Unknowable from a listing, and under-promising the discount is the safe direction.
    expect(found?.dynamicBatching).toBe(false);
  });

  it('returns null outside the lookback window', async () => {
    // Beyond it, a match is a previous run of the same audio, and attaching this run to a
    // stale transcript is worse than admitting we lost the operation.
    const found = await findOrphanOperation(deps(listFetch() as unknown as typeof fetch), {
      inputUri: INPUT_URI,
      sinceMs: 60_000,
      nowMs: Date.parse('2026-08-11T00:00:00Z'),
      outputPrefix: op.outputPrefix,
    });
    expect(found).toBeNull();
  });

  it('returns null when no operation names our file', async () => {
    const found = await findOrphanOperation(deps(listFetch() as unknown as typeof fetch), {
      inputUri: 'gs://b/thibi-staging/some-other-run/audio.flac',
      sinceMs: 6 * 3600_000,
      nowMs: Date.parse('2026-08-10T05:00:00Z'),
      outputPrefix: 'gs://b/out',
    });
    expect(found).toBeNull();
  });
});
