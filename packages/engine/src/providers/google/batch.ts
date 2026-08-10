import type { Clock } from '../../context.js';
import { AbortedError, ProviderError } from '../../errors.js';
import type {
  BatchOp,
  BatchRequest,
  BatchStatus,
  FetchBatchArgs,
  TranscribeResult,
} from '../types.js';
import {
  batchRecognizeUrl,
  cancelOperationUrl,
  listOperationsUrl,
  operationUrl,
  regionOfOperation,
} from './endpoints.js';
import { toProviderError } from './errors.js';
import { parseRecognizeResults, type BatchRecognizeResults } from './parse.js';

/**
 * `batchRecognize` — submit, poll, fetch, cancel.
 *
 * The four methods exist as four methods, rather than one `await`ed call, because of a
 * constraint that only bites in Phase 9: **a long-running operation must never hold a worker
 * slot**. Phase 2 drives the loop in process (`pipeline/batch-run.ts`); Phase 9 deletes that
 * loop and calls these same three methods from two `run_steps`, one of which reschedules
 * itself. Nothing here changes when that happens, and the single property that buys it is
 * stated and tested below.
 */

/**
 * `BatchOp`, `BatchRequest` and `BatchStatus` live in `providers/types.ts`, not here.
 *
 * They are the port's vocabulary rather than Google's: Phase 4's Whisper providers and any
 * future batch surface speak the same three shapes, and Phase 9's poll step is written
 * against them without knowing which provider it is driving. Re-exported so a reader of this
 * file does not have to go looking.
 *
 * The property that matters is on `BatchOp` and is documented there: **it is plain JSON**.
 */
export type { BatchOp, BatchRequest, BatchStatus, BatchState } from '../types.js';

export interface BatchDeps {
  region: string;
  projectId: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  clock: Clock;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 120_000;

/** The v2 LRO envelope, as much of it as we read. */
interface OperationJson {
  name?: string;
  done?: boolean;
  metadata?: {
    progressPercent?: number;
    batchRecognizeRequest?: { files?: Array<{ uri?: string }> };
    createTime?: string;
  };
  error?: { code?: number; message?: string };
  response?: {
    results?: Record<string, { uri?: string; error?: { code?: number; message?: string } }>;
    totalBilledDuration?: string;
  };
}

function signalFor(deps: BatchDeps): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
}

async function call(deps: BatchDeps, url: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.getToken();
  try {
    return await doFetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: signalFor(deps),
    });
  } catch (err) {
    if (deps.signal?.aborted) throw new AbortedError();
    throw err;
  }
}

/**
 * The wire body.
 *
 * Four decisions, all of them load-bearing:
 *
 *  - **`gcsOutputConfig`, never `inlineResponseConfig`.** Inline is size-capped and would
 *    force two parse paths for the same data. One transport, one parser.
 *  - **One file per operation.** `files[]` accepts several; submitting one keeps
 *    cancellation, cost attribution and failure isolation all per-run.
 *  - **`processingStrategy: DYNAMIC_BATCHING`** is the entire cost argument — $0.003/min
 *    against $0.016 (confirmed from the Cloud Billing Catalog, 2026-08-10). If the field is
 *    rejected, `submitBatch` retries once without it and records `dynamicBatching: false`
 *    rather than failing the run.
 *  - **`enableWordConfidence` unconditionally.** Spike S2 measured it genuine on `chirp_2`
 *    across a ten-language sample; asking costs nothing where it is not.
 *
 * `config.adaptation` is deliberately absent even when `phraseSet` is supplied: S1 measured
 * it inert on Chirp and an irrelevant phrase set actively corrupting output.
 */
export function buildBatchBody(req: BatchRequest, dynamicBatching: boolean): unknown {
  return {
    config: {
      autoDecodingConfig: {},
      languageCodes: [req.languageCode],
      model: req.model,
      features: {
        enableWordTimeOffsets: true,
        enableWordConfidence: true,
        enableAutomaticPunctuation: true,
      },
    },
    files: [{ uri: req.audioUri }],
    recognitionOutputConfig: { gcsOutputConfig: { uri: req.outputUri } },
    ...(dynamicBatching ? { processingStrategy: 'DYNAMIC_BATCHING' } : {}),
  };
}

/** Does this error read like "you sent a field I do not know about"? */
function looksLikeUnknownStrategy(message: string): boolean {
  return /processing_?strategy|processingStrategy|DYNAMIC_BATCHING/i.test(message);
}

export async function submitBatch(deps: BatchDeps, req: BatchRequest): Promise<BatchOp> {
  const url = batchRecognizeUrl(deps.region, deps.projectId);

  async function attempt(dynamicBatching: boolean): Promise<Response> {
    return call(deps, url, {
      method: 'POST',
      body: JSON.stringify(buildBatchBody(req, dynamicBatching)),
    });
  }

  let dynamicBatching = true;
  let response = await attempt(true);

  if (!response.ok && response.status === 400) {
    // Read the body once; `toProviderError` consumes it, so clone before deciding.
    const detail = await response.clone().text();
    if (looksLikeUnknownStrategy(detail)) {
      // Risk 1. The cost argument weakens and the run still happens; `usage_records` will
      // record what it actually cost, so the truth comes from the ledger and not the plan.
      dynamicBatching = false;
      response = await attempt(false);
    }
  }

  if (!response.ok) throw await toProviderError(response);

  const body = (await response.json()) as OperationJson;
  if (!body.name) {
    throw new ProviderError('batchRecognize returned no operation name; nothing to poll.');
  }

  return {
    provider: 'google',
    region: deps.region,
    name: body.name,
    inputUri: req.audioUri,
    outputPrefix: req.outputUri,
    submittedAtMs: deps.clock.now().getTime(),
    dynamicBatching,
  };
}

/**
 * Turn an operation body into a status.
 *
 * **The per-file error is the trap this function exists for.** Spike S3 measured an operation
 * reporting `done: true`, `progressPercent: 100` and *no* operation-level error while
 * `response.results[uri].error` was set to code 13 with `totalBilledDuration: "0s"`. A poller
 * trusting `done` and `error` reports success and then fails to find an output object that
 * was never written. **It hit 1 run in 5**, and an immediate resubmit succeeded — so code 13
 * here is transient, and `totalBilledDuration: "0s"` confirms a failed file is not billed,
 * which makes resubmitting free.
 *
 * Pure and exported so all three `done: true` shapes are table-testable against fixtures.
 */
export function classifyOperation(body: OperationJson, op: BatchOp, nowMs: number): BatchStatus {
  if (!body.done) {
    return {
      state: 'running',
      // Only when Google actually sent one. A fabricated percentage is worse than none.
      ...(typeof body.metadata?.progressPercent === 'number'
        ? { progressPercent: body.metadata.progressPercent }
        : {}),
    };
  }

  const totalBilledDuration = body.response?.totalBilledDuration;
  const base = {
    doneAtMs: nowMs,
    ...(totalBilledDuration !== undefined ? { totalBilledDuration } : {}),
  };

  if (body.error) {
    return {
      state: 'failed',
      ...base,
      error: {
        ...(body.error.code !== undefined ? { code: body.error.code } : {}),
        message: body.error.message ?? 'The operation failed without a message.',
        scope: 'operation',
      },
      // A run-level failure, not a poll-level one: retrying the *poll* accomplishes nothing.
      // Code 8 (RESOURCE_EXHAUSTED) in particular means resubmitting now will fail again.
      retryable: isTransientCode(body.error.code),
    };
  }

  const results = body.response?.results ?? {};
  const file = results[op.inputUri];

  if (file?.error) {
    return {
      state: 'failed',
      ...base,
      error: {
        ...(file.error.code !== undefined ? { code: file.error.code } : {}),
        message: file.error.message ?? 'The file failed without a message.',
        scope: 'file',
      },
      retryable: isTransientCode(file.error.code),
    };
  }

  if (file?.uri) return { state: 'succeeded', ...base, outputUri: file.uri };

  // `done`, no error anywhere, and no entry for our URI. Google should not do this. Reported
  // as a failure with the keys we did get, because guessing which result is ours would be
  // worse than saying we cannot tell — `fetchBatchResult` has a narrower fallback.
  const keys = Object.keys(results);
  return {
    state: 'failed',
    ...base,
    error: {
      message:
        `The operation finished without a result for ${op.inputUri}. ` +
        (keys.length > 0
          ? `It returned results for: ${keys.join(', ')}.`
          : 'It returned no results at all.'),
      scope: 'operation',
    },
    retryable: false,
  };
}

/**
 * gRPC status codes worth a resubmit.
 *
 * 13 INTERNAL is the measured one (1 run in 5, transient, unbilled). 14 UNAVAILABLE and
 * 4 DEADLINE_EXCEEDED are transient by definition. 8 RESOURCE_EXHAUSTED is deliberately
 * **not** here: it is a quota wall, and resubmitting into it immediately is how a quota wall
 * becomes a quota ban.
 */
function isTransientCode(code: number | undefined): boolean {
  return code === 13 || code === 14 || code === 4;
}

export async function pollBatch(deps: BatchDeps, op: BatchOp): Promise<BatchStatus> {
  const stored = regionOfOperation(op.name);
  if (stored !== null && stored !== op.region) {
    throw new ProviderError(
      `Operation ${op.name} is in ${stored} but the stored region is ${op.region}. ` +
        `Polling the wrong regional host would 404 misleadingly.`,
    );
  }

  const response = await call(deps, operationUrl(op.region, op.name));
  if (!response.ok) throw await toProviderError(response);
  const body = (await response.json()) as OperationJson;
  return classifyOperation(body, op, deps.clock.now().getTime());
}

/**
 * Read the transcript Google wrote into GCS.
 *
 * The path is not guessable — Google appends a uuid — so it comes from the operation. The
 * `read` argument is `StagingStore['readJson']`, handed in rather than imported: the provider
 * never learns what GCS is, which is what keeps this function testable against a fixture.
 */
export async function fetchBatchResult(
  _deps: BatchDeps,
  op: BatchOp,
  args: FetchBatchArgs,
): Promise<TranscribeResult> {
  const uri = args.status.outputUri ?? (await resolveOutputUri(op, args.list));

  const body = await args.read<BatchRecognizeResults>(uri);
  // offsetMs is 0 because batch is whole-file; that single argument is the entire
  // difference between this call site and the chunked sync one.
  const parsed = parseRecognizeResults(body.results ?? [], {
    offsetMs: 0,
    durationMs: args.durationMs,
  });

  return { ...parsed, usage: { audioMs: args.durationMs, requests: 1 }, raw: body };
}

/**
 * The fallback for a `succeeded` status with no `outputUri`.
 *
 * Expect exactly one `.json` under the prefix. Zero or several is an explicit failure rather
 * than a guess: picking one of two transcripts at random would produce a plausible, wrong
 * result that nobody would ever catch.
 */
async function resolveOutputUri(op: BatchOp, list: FetchBatchArgs['list']): Promise<string> {
  const prefix = op.outputPrefix.replace(/^gs:\/\/[^/]+\//, '');
  const objects = (await list(prefix)).filter((o) => o.key.endsWith('.json'));

  if (objects.length === 1) return objects[0]!.uri;
  throw new ProviderError(
    objects.length === 0
      ? `The operation succeeded but wrote no .json under ${op.outputPrefix}.`
      : `The operation wrote ${objects.length} .json objects under ${op.outputPrefix}; ` +
        `expected exactly one. Refusing to guess which is the transcript.`,
  );
}

/**
 * Best effort, and the caller must treat it as such.
 *
 * A `DYNAMIC_BATCHING` operation may already be running, in which case Google accepts the
 * cancel and bills for what it processed. `batch-run.ts` sweeps the staging prefix whether or
 * not this throws — leaving audio in someone else's bucket because the cancel failed is the
 * worse outcome of the two.
 */
export async function cancelBatch(deps: BatchDeps, op: BatchOp): Promise<void> {
  const response = await call(deps, cancelOperationUrl(op.region, op.name), { method: 'POST' });
  // Already finished or already cancelled: the desired end state either way.
  if (response.ok || response.status === 404 || response.status === 400) {
    await response.text().catch(() => '');
    return;
  }
  throw await toProviderError(response);
}

/**
 * Recover an operation whose name we lost.
 *
 * The crash window is between the submit returning and the transaction committing. It is
 * narrow and the transaction is the real fix; this is belt and braces, and it is possible at
 * all only because `staging_prefix` is derived from `runId` and therefore stable across
 * restarts — the input URI is the same on both sides of the crash.
 */
export async function findOrphanOperation(
  deps: BatchDeps,
  opts: { inputUri: string; sinceMs: number; nowMs: number; outputPrefix: string },
): Promise<BatchOp | null> {
  const url = `${listOperationsUrl(deps.region, deps.projectId)}?pageSize=100`;
  const response = await call(deps, url);
  if (!response.ok) throw await toProviderError(response);

  const body = (await response.json()) as { operations?: OperationJson[] };

  for (const candidate of body.operations ?? []) {
    if (!candidate.name) continue;
    const files = candidate.metadata?.batchRecognizeRequest?.files ?? [];
    if (!files.some((f) => f.uri === opts.inputUri)) continue;

    // Outside the lookback window this is a previous run of the same audio, not ours.
    // Matching it would attach this run to a stale transcript.
    const createdAt = Date.parse(candidate.metadata?.createTime ?? '');
    if (Number.isFinite(createdAt) && opts.nowMs - createdAt > opts.sinceMs) continue;

    return {
      provider: 'google',
      region: deps.region,
      name: candidate.name,
      inputUri: opts.inputUri,
      outputPrefix: opts.outputPrefix,
      submittedAtMs: Number.isFinite(createdAt) ? createdAt : opts.nowMs,
      // Unknowable from the listing. False is the honest default: it only affects which
      // rate the estimate quotes, and under-promising a discount is the safe direction.
      dynamicBatching: false,
    };
  }

  return null;
}
