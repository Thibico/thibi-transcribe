# Phase 9 — Queue, worker, progress

## Goal

At the end of this phase the engine runs out-of-process. A run is a DAG of `run_steps` rows in
Postgres; pg-boss is a doorbell that tells a worker a step is ready and nothing more. Killing
`worker` mid-transcription and bringing it back loses at most one chunk, never re-bills a
`batchRecognize` that already ran, and the browser's SSE stream replays from `Last-Event-ID`
so the progress bar picks up where it left off. This sits at phase 9 because phases 1–8 built
every stage as a pure `(ctx, input) => Promise<output>` function driven by the CLI in one
process; that is exactly the shape a queue handler needs, and doing the durability work before
the stages existed would have meant guessing at their inputs. It sits *before* the UI because
phases 11–14 consume the SSE stream and `/admin/queue`, and because "kill the worker, it
resumes" is a claim best proved with a CLI and `docker kill`, not a browser.

> **Corrected 2026-08-14 against what was built.** The schema, planner, retry policy and
> reconciler are implemented and the sketches below are wrong in five places, each corrected
> inline where it appears and recorded as overview amendments 86–89. In summary:
>
> 1. **`partial` was unreachable, twice over** — §3's `hardFailed` test and its
>    dependency-poisoning rule each independently turned one dead chunk into a failed run.
>    §3 and §9 now describe the casualty rule that fixes both.
> 2. **The `worker` queue is missing from §6** — §2's kind table routes two kinds to it and
>    nothing subscribes to it. Added to the queue table, `SUBSCRIPTIONS`, and `WORKER_QUEUES`.
> 3. **§4's `array_agg` has no `ORDER BY`**, which makes replanning non-idempotent
>    intermittently.
> 4. **§-Tests' concurrency assertion is wrong** — reconcile re-rings `ready` steps on purpose.
> 5. **`step_state` is a Postgres enum and `cost_usd` is `double precision`** — see amendment 89.

## Prerequisites

| Needs | From |
|---|---|
| Every stage as `(ctx, input) => Promise<output>` | Phases 1–8 |
| `EngineContext` with `db`, `store`, `staging?`, `clock`, `logger`, `events`, `concurrency` | Phase 1 |
| `runs`, `run_chunks`, `segments`, `words`, `editorial_passes` tables | Phases 1–6 |
| Provider `submitBatch`/`pollBatch`/`fetchBatchResult`/`cancelBatch` | Phase 2 |
| Sidecar submit/poll shape | Phases 3–4 |
| Postgres 17 reachable on a **direct** connection (not via PgBouncer) | Phase 1 |

Auth does not gate this phase. The SSE and audio routes are written here **with** their
`requireUser()` call sites stubbed against a `TODO(phase-10)` shim that returns a fixed system
user; Phase 10 replaces the shim and nothing else changes. Do not ship the shim past phase 10 —
a test asserts it is gone.

## Deliverables

| Path | Purpose |
|---|---|
| `packages/db/src/schema/run-steps.ts` | `run_steps` Drizzle schema, `step_state` / `step_kind` enums |
| `packages/db/src/schema/run-events.ts` | `run_events` (bigserial `seq`) |
| `packages/db/src/schema/rate-buckets.ts` | `rate_buckets` token-bucket table |
| `packages/db/migrations/0009_*.sql` | Generated SQL for the above + `segments.placeholder_reason` |
| `packages/engine/src/queue/boss.ts` | pg-boss construction, queue declaration, `send()` wrapper pinning `retryLimit: 0` |
| `packages/engine/src/queue/queues.ts` | Queue names, kind→queue routing table, `batchSize` per queue |
| `packages/engine/src/queue/reconcile.ts` | `reconcile(ctx, runId)` — the heart of the phase |
| `packages/engine/src/queue/plan.ts` | `planRun()` — materialise the DAG from `runs.pipeline` |
| `packages/engine/src/queue/retry.ts` | `POLICY`, `isRetryable`, `backoffMs`, `parseRetryAfter` |
| `packages/engine/src/queue/lease.ts` | Heartbeat wrapper, `pg_try_advisory_lock` global slots |
| `packages/engine/src/queue/rate-bucket.ts` | `takeTokens(key, n)` over `rate_buckets` |
| `packages/engine/src/queue/recover.ts` | Boot + 60 s reconciler, stale-heartbeat sweep |
| `packages/engine/src/queue/cancel.ts` | `requestCancel()`, `AbortSignal` plumbing, NOTIFY listener |
| `packages/engine/src/queue/handlers/index.ts` | Handler registry `Record<StepKind, StepHandler>` |
| `packages/engine/src/queue/handlers/*.ts` | One file per kind, wrapping the phase 1–8 stage functions |
| `packages/engine/src/events/emit.ts` | `emitRunEvent()` — insert + `pg_notify` in one statement, 500 ms coalescer |
| `packages/engine/src/events/listener.ts` | One dedicated `pg.Client` per process → `EventEmitter` |
| `apps/worker/src/main.ts` | Entrypoint: build `EngineContext`, subscribe queues, health port, SIGTERM drain |
| `apps/worker/src/health.ts` | `GET /healthz` and `/readyz` on `WORKER_HEALTH_PORT` |
| `apps/web/src/app/api/runs/[id]/stream/route.ts` | SSE with `Last-Event-ID` replay, heartbeat, `X-Accel-Buffering: no` |
| `apps/web/src/app/api/runs/[id]/events/route.ts` | `?since=<seq>` polling fallback |
| `apps/web/src/app/api/admin/queue/route.ts` | Dead-step list + retry action (server side only; UI is phase 14) |
| `apps/cli/src/commands/run.ts` | `thibi run status|retry|cancel <runId>` |
| `packages/engine/src/queue/__tests__/*` | Reconciler, planner, retry, recovery, coalescer tests |
| `infra/compose.yml` (modified) | `worker` / `worker-heavy` services, `stop_grace_period: 120s` |
| `packages/db/src/schema/runs.ts` (modified) | `state` gains `partial`; `cancel_requested_at` |
| `packages/engine/src/index.ts` (modified) | Export the queue surface |

## Design

### 1. The pipeline DAG lives in `run_steps`; pg-boss is a doorbell

The load-bearing rule, stated once so every later decision follows from it:

> **`run_steps` is the source of truth. pg-boss holds no state that matters. Deleting the
> pg-boss tables and restarting must lose nothing but latency.**

Everything the queue library would normally own — attempt counts, backoff, dependencies,
cancellation, dead-lettering — lives in our columns, because all of it is a thing a newsroom
admin needs to *see* on `/admin/queue` and `/runs/:id/timeline`. A retry count buried in
`pgboss.job.retrycount` is a retry count nobody can render next to the step that failed.

Consequences, non-negotiable:

- **`retryLimit: 0` on every `send()`.** Enforced in one place: `boss.ts` exposes `sendStep()`
  and the raw `boss.send` is not re-exported. Two retry mechanisms racing is how you get a step
  that runs six times when the UI says three.
- **`expireInSeconds` is a lease hint, not a policy.** Set it generously (30 min) and let the
  heartbeat sweep own liveness. pg-boss expiring a job while our step is still `running` would
  otherwise create a duplicate.
- **Sends happen after commit, never inside the transaction.** A crash between commit and send
  is self-healing: the 30 s tick re-reconciles and re-sends. A send inside the transaction that
  a worker picks up before commit is not self-healing — it reads a step that does not exist yet.
- **Every send carries a singleton key** so the self-healing re-send is a no-op rather than a
  double execution.

**Against the alternatives.** Graphile Worker is excellent and its `SKIP LOCKED` fetch is the
same primitive, but its concurrency is configured per *process*; we need a global cap on GPU
work across however many `worker-heavy` containers someone accidentally scales to, which means
an advisory-lock slot layer either way — at which point Graphile's scheduler is doing less for
us than its coupling costs. BullMQ is the best-documented of the three and we are not adding
Redis: a second stateful service in a Compose file handed to a non-sysadmin, a second thing to
back up, and a second thing whose eviction policy silently drops jobs when someone sets
`maxmemory-policy allkeys-lru`. Hand-rolled `FOR UPDATE SKIP LOCKED` is genuinely close — it is
about 150 lines — and it is on the overview's cut list for exactly that reason. What pg-boss
adds over the hand-roll is *delayed* jobs (`startAfter`, which the poll steps live on),
singleton keys, cron for `maintenance.*`, and archival of completed job rows. If pg-boss ever
becomes a problem, the escape is a `Doorbell` interface with `sendStep`/`work` and a
`PgDoorbell` implementation; `reconcile.ts` does not change. Define that interface now, in
`queues.ts`, with pg-boss as the only implementation — it costs ten lines and it is what makes
the cut-list option a two-day job instead of a rewrite.

### 2. `run_steps`

```sql
-- Built as written: a real Postgres enum, against this schema's `text(…, { enum })`
-- convention, because most writes to this table are hand-written SQL that no TypeScript type
-- can constrain. `cost_usd` went the other way — `double precision`, matching every other money
-- column. Amendment 89.
CREATE TYPE step_state AS ENUM (
  'pending',            -- created, dependencies not yet satisfied
  'ready',              -- dependencies satisfied, doorbell rung
  'running',            -- a worker holds a lease and is heartbeating
  'awaiting_external',  -- work is happening at a provider; no worker slot held
  'done',
  'skipped',            -- optional step whose precondition was absent
  'failed',             -- terminal for this attempt series, run-fatal
  'dead',               -- exhausted max_attempts; visible in /admin/queue
  'cancelled'
);

CREATE TABLE run_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  ordinal       integer NOT NULL,
  shard         integer NOT NULL DEFAULT -1,   -- -1 = unsharded. NOT NULL on purpose; see below
  queue         text NOT NULL,
  depends_on    uuid[] NOT NULL DEFAULT '{}',
  optional      boolean NOT NULL DEFAULT false,
  weight        integer NOT NULL DEFAULT 1,    -- progress weighting
  state         step_state NOT NULL DEFAULT 'pending',
  attempt       integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 1,
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- NEVER secrets; key names only
  output        jsonb,
  error         jsonb,
  external_ref  text,                          -- Google LRO name, sidecar task id
  poll_after    timestamptz,
  deadline_at   timestamptz,                   -- hard two-sided deadline
  heartbeat_at  timestamptz,
  lease_owner   text,                          -- "${hostname}:${pid}:${bootId}"
  started_at    timestamptz,
  finished_at   timestamptz,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind, shard)
);

CREATE INDEX run_steps_run_ordinal_idx ON run_steps (run_id, ordinal);
CREATE INDEX run_steps_live_idx        ON run_steps (state) WHERE state IN ('ready','running','awaiting_external');
CREATE INDEX run_steps_poll_idx        ON run_steps (poll_after) WHERE state = 'awaiting_external';
CREATE INDEX run_steps_hb_idx          ON run_steps (heartbeat_at) WHERE state = 'running';
CREATE INDEX run_steps_dead_idx        ON run_steps (finished_at DESC) WHERE state = 'dead';
```

**Why `UNIQUE (run_id, kind, shard)` is the whole idempotency story.** The planner runs on
`POST /runs`, again on boot recovery, and again on every manual retry. It inserts with
`ON CONFLICT (run_id, kind, shard) DO NOTHING`. That makes planning a *convergent* operation:
running it twice produces one DAG, and running it on a partially-planned run fills only the
gaps. Without it, a crash between "insert step 1" and "insert step 2" leaves a run that can
never be planned again without a bespoke repair.

**`shard` is `NOT NULL DEFAULT -1`, not nullable.** In Postgres `NULL <> NULL`, so a unique
index over a nullable `shard` does not deduplicate unsharded steps at all — you would get one
`media.normalize` per planner invocation and discover it the first time a container restarted.
`-1` is deliberate ugliness that makes the constraint real. (`NULLS NOT DISTINCT` on PG 15+ is
the alternative; `-1` is chosen because it also sorts and groups without special-casing.)

**Step kinds.**

| `kind` | Sharded by | Queue | Optional | Weight | Notes |
|---|---|---|---|---|---|
| `media.probe` | — | `media` | no | 1 | Cheap; usually already done at ingest |
| `media.normalize` | — | `media` | no | 8 | Writes `media_derivatives`; skipped if the derivative exists |
| `media.peaks` | — | `media` | **yes** | 2 | Waveform peaks; failure must not fail a run |
| `plan.chunks` | — | `media` | no | 1 | Writes `run_chunks` before any network call |
| `asr.chunk` | chunk idx | `asr.cloud` / `asr.local` | no | 10 each | The bulk of a chunked run |
| `asr.batch.submit` | — | `asr.cloud` | no | 5 | Persists LRO to `external_ref`, → `awaiting_external` |
| `asr.poll` | — | `asr.poll` | no | 40 | Self-rescheduling; carries the batch's whole weight |
| `asr.fetch` | — | `asr.cloud` | no | 10 | Reads the output JSON from staging, persists segments |
| `diarize` | — | `diarize` | **yes** | 40 | pyannote; `optional` when the pipeline says best-effort |
| `diarize.poll` | — | `asr.poll` | yes | — | Weight folded into `diarize` |
| `reconcile.speakers` | — | `worker` | yes | 4 | The word↔turn algorithm from phase 3 |
| `normalize.text` | — | `worker` | no | 3 | Registry normalizer chain, per word |
| `editorial.pass` | pass ordinal | `editorial` | yes | 15 each | cleanup / translate / entities / document |
| `export` | export idx | `export` | yes | 2 | On-demand only |
| `staging.cleanup` | — | `media` | yes | 1 | Eager GCS prefix delete |
| `maintenance.*` | — | `maintenance` | yes | — | Runless; pg-boss cron |

`optional: true` means: on `dead`, set `skipped`, record the error in `output.skippedBecause`,
emit a `step.skipped` event, and **do not** fail the run. A run whose waveform peaks failed is
still a transcript. A run whose diarization failed is still a transcript, with every segment's
`needs_speaker_review` true — which is exactly the honest outcome, and much better than
throwing away three hours of ASR because a GPU container OOMed.

### 3. `reconcile(ctx, runId)`

Called after every step transition and on a 30 s tick over every non-terminal run. It is the
only writer of `runs.state` and `runs.progress`, and the only caller of `sendStep`.

```ts
// packages/engine/src/queue/reconcile.ts
import { sql, inArray } from 'drizzle-orm';

const TERMINAL: StepState[] = ['done', 'skipped', 'failed', 'dead', 'cancelled'];
const SATISFYING: StepState[] = ['done', 'skipped'];

// CORRECTED. `SATISFYING` alone makes a `partial` run impossible: `normalize.text` depends on
// ['asr.chunk','*'], so the poisoning branch below marks it `failed` the moment one shard dies
// and the seven survivors are never assembled. A `dead` step of a casualty kind satisfies its
// dependents and does not count toward `hardFailed`, PROVIDED a sibling shard succeeded — if
// none did, nothing was transcribed and the run really has failed. See amendment 86.
const CASUALTY_KINDS = new Set<StepKind>(['asr.chunk']);
const isCasualty = (s: StepRow) =>
  s.state === 'dead' && CASUALTY_KINDS.has(s.kind) && siblingSucceeded(steps, s.kind);
const satisfies = (s: StepRow) => SATISFYING.includes(s.state) || isCasualty(s);

export async function reconcile(ctx: EngineContext, runId: string): Promise<void> {
  const sends: PendingSend[] = [];
  const events: RunEventDraft[] = [];

  await ctx.db.transaction(async (tx) => {
    // Serialise all reconciliation for this run. _xact_ so it releases on commit OR
    // rollback — a session lock leaks a run forever the first time a handler throws.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'run:' + runId}, 42))`,
    );

    const run = await loadRunForUpdate(tx, runId);
    if (!run || isTerminalRun(run.state)) return;

    const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, runId));
    const byId = new Map(steps.map((s) => [s.id, s]));

    // ---- cancellation short-circuits everything -------------------------------
    if (run.cancelRequestedAt) {
      const killable = steps.filter((s) => s.state === 'pending' || s.state === 'ready');
      if (killable.length) {
        await tx.update(runSteps)
          .set({ state: 'cancelled', finishedAt: ctx.clock.now() })
          .where(inArray(runSteps.id, killable.map((s) => s.id)));
        for (const s of killable) s.state = 'cancelled';
      }
      // 'running' and 'awaiting_external' steps observe the AbortSignal / cancel call
      // themselves; we wait for them rather than lying about the run being stopped.
    }

    // ---- dependency satisfaction ----------------------------------------------
    for (const s of steps) {
      if (s.state !== 'pending') continue;
      if (run.cancelRequestedAt) continue;

      const deps = s.dependsOn.map((id) => byId.get(id)).filter(Boolean) as StepRow[];
      if (!deps.every(satisfies)) {                       // CORRECTED: was !SATISFYING.includes
        // A hard-failed required dependency poisons its dependents immediately;
        // leaving them 'pending' forever is how runs hang.
        // CORRECTED: a casualty is not a poison.
        if (deps.some((d) => ['failed','dead','cancelled'].includes(d.state) && !isCasualty(d))) {
          await markStep(tx, s, {
            state: s.optional ? 'skipped' : 'failed',
            error: { code: 'DEPENDENCY_FAILED', dependsOn: s.dependsOn },
            finishedAt: ctx.clock.now(),
          });
          s.state = s.optional ? 'skipped' : 'failed';
        }
        continue;
      }

      await tx.update(runSteps)
        .set({ state: 'ready' })
        .where(and(eq(runSteps.id, s.id), eq(runSteps.state, 'pending')));
      s.state = 'ready';
      sends.push({
        queue: s.queue,
        // Fresh key per attempt: a retry must not be deduped against its own prior send.
        singletonKey: `${s.id}:${s.attempt}`,
        data: { stepId: s.id, runId, kind: s.kind, attempt: s.attempt },
        startAfter: s.pollAfter ?? undefined,
      });
    }

    // ---- re-ring the doorbell for steps already 'ready' -------------------------
    // Covers the crash-between-commit-and-send window. The singleton key makes it free.
    for (const s of steps) {
      if (s.state === 'ready' && !sends.some((x) => x.data.stepId === s.id)) {
        sends.push({
          queue: s.queue,
          singletonKey: `${s.id}:${s.attempt}`,
          data: { stepId: s.id, runId, kind: s.kind, attempt: s.attempt },
        });
      }
    }

    // ---- weighted progress -------------------------------------------------------
    const totalWeight = steps.reduce((a, s) => a + s.weight, 0) || 1;
    const doneWeight = steps.reduce((a, s) => a + s.weight * stepFraction(s), 0);
    const progress = clamp01(doneWeight / totalWeight);

    // ---- terminal detection --------------------------------------------------------
    const allTerminal = steps.every((s) => TERMINAL.includes(s.state));
    let nextState = run.state;
    if (allTerminal) {
      // CORRECTED throughout. `hardFailed` without the casualty exclusion is true whenever any
      // chunk died — asr.chunk is not `optional` — so `failed` was chosen before `partial` was
      // ever tested, and the branch below was dead code.
      const hardFailed = steps.some(
        (s) => !s.optional && (s.state === 'failed' || s.state === 'dead') && !isCasualty(s));
      const anyCancelled = steps.some((s) => s.state === 'cancelled');
      const casualties = steps.filter(isCasualty);

      if (run.cancelRequestedAt && anyCancelled) nextState = 'cancelled';
      else if (hardFailed) nextState = 'failed';
      else if (casualties.length > 0) nextState = 'partial';
      else nextState = 'done';
    }

    const changed = nextState !== run.state || Math.abs(progress - run.progress) > 0.0005;
    if (changed) {
      await tx.update(runs).set({
        state: nextState,
        progress,
        finishedAt: isTerminalRun(nextState) ? ctx.clock.now() : null,
      }).where(eq(runs.id, runId));

      events.push({ runId, kind: 'run.progress', data: { state: nextState, progress } });
      if (isTerminalRun(nextState)) events.push({ runId, kind: 'run.finished', data: { state: nextState } });
    }

    // Events go in THIS transaction — a listener must never learn of a state before
    // the state is committed. See §11.
    for (const e of events) await insertAndNotify(tx, e);
  });

  // Doorbells are rung after commit, and only after. Idempotent by singleton key;
  // a crash here is repaired by the 30 s tick.
  for (const s of sends) await ctx.doorbell.sendStep(s);
}

/** Progress contribution of one step in [0,1]. */
function stepFraction(s: StepRow): number {
  if (s.state === 'done' || s.state === 'skipped') return 1;
  if (s.state === 'cancelled' || s.state === 'failed' || s.state === 'dead') return 1; // terminal: stop moving
  if (s.state === 'running' || s.state === 'awaiting_external') {
    const p = (s.output as { progress?: number } | null)?.progress;
    return typeof p === 'number' ? clamp01(p) : 0.1; // 10% for "started" — visible, honest
  }
  return 0;
}
```

Three details that matter more than they look:

- **`pg_advisory_xact_lock`, never the session variant.** The transaction-scoped lock is
  released by the commit or the rollback. The session variant needs a `finally` on a client you
  might not still hold, and the first unhandled throw wedges the run permanently.
- **`hashtextextended(text, seed)` returns `bigint`**, which is the single-argument advisory
  lock signature. Prefixing with `run:` keeps this lock space disjoint from the global-slot
  space in §6, which uses the two-argument `(classid, objid)` form.
- **Terminal steps contribute a full fraction.** A run that failed shows a progress bar at 100%
  and a red state, not a bar frozen at 63% that looks like it is still working.

### 4. The planner

`runs.pipeline` is written at run creation and is the complete specification of what the DAG
should be. The planner is a pure function of it plus the chunk plan.

**It is no longer only a specification, and every writer must merge rather than replace.**
Phase 2 added runtime keys beside the spec — `planReason`, and `batch` holding the whole
`BatchOp`, its latency, its billed duration and its poll count. `persistResult` originally did
`SET pipeline = $4` and silently deleted all of it; the fix is `pipeline = pipeline || $4::jsonb`
and it was found by querying `pipeline->'batch'` after the first successful live run and getting
null. Anything in this phase that writes the column inherits that rule: `||` to merge a whole
object, `jsonb_set` for a nested key, never a bare assignment. If the spec and the runtime state
ever need to stop sharing a column, split them — but silently truncating one from the other is
the failure that is easy to ship and hard to notice.

```ts
export interface Pipeline {
  asr:      { providerId: string; model: string; mode: 'sync' | 'sync_chunked' | 'batch'; local: boolean };
  diarize?: { providerId: 'pyannote' | 'elevenlabs'; required: boolean };
  editorial: Array<{ kind: 'cleanup' | 'translate' | 'entities' | 'document'; targetLang?: string }>;
  peaks: boolean;
  exports: Array<{ format: string; layer: string; targetLang?: string }>;
}

export interface StepSpec {
  kind: StepKind;
  shard: number;                                   // -1 when unsharded
  queue: QueueName;
  dependsOn: Array<[StepKind, number | '*']>;      // '*' = every shard of that kind
  optional: boolean;
  weight: number;
  maxAttempts: number;
  input: Record<string, unknown>;                  // key NAMES for secrets, never values
}

export function planRun(p: Pipeline, chunkCount: number): StepSpec[] {
  const out: StepSpec[] = [];
  const add = (s: Partial<StepSpec> & Pick<StepSpec, 'kind'>) =>
    out.push({ shard: -1, queue: routeOf(s.kind), dependsOn: [], optional: false,
               weight: WEIGHT[s.kind], maxAttempts: POLICY[s.kind].maxAttempts,
               input: {}, ...s } as StepSpec);

  add({ kind: 'media.probe' });
  add({ kind: 'media.normalize', dependsOn: [['media.probe', -1]] });
  if (p.peaks) add({ kind: 'media.peaks', dependsOn: [['media.normalize', -1]], optional: true });
  add({ kind: 'plan.chunks', dependsOn: [['media.normalize', -1]] });

  const asrQueue: QueueName = p.asr.local ? 'asr.local' : 'asr.cloud';
  let asrLeaves: Array<[StepKind, number | '*']>;

  if (p.asr.mode === 'batch') {
    add({ kind: 'asr.batch.submit', queue: asrQueue, dependsOn: [['plan.chunks', -1]] });
    add({ kind: 'asr.poll',  queue: 'asr.poll', dependsOn: [['asr.batch.submit', -1]] });
    add({ kind: 'asr.fetch', queue: asrQueue,   dependsOn: [['asr.poll', -1]] });
    add({ kind: 'staging.cleanup', dependsOn: [['asr.fetch', -1]], optional: true });
    asrLeaves = [['asr.fetch', -1]];
  } else {
    for (let i = 0; i < chunkCount; i++) {
      add({ kind: 'asr.chunk', shard: i, queue: asrQueue,
            dependsOn: [['plan.chunks', -1]], input: { chunkIdx: i } });
    }
    asrLeaves = [['asr.chunk', '*']];
  }

  // Diarization consumes the SAME normalized derivative and runs concurrently with ASR.
  if (p.diarize) {
    add({ kind: 'diarize', queue: 'diarize', optional: !p.diarize.required,
          dependsOn: [['media.normalize', -1]], input: { providerId: p.diarize.providerId } });
    add({ kind: 'diarize.poll', queue: 'asr.poll', optional: !p.diarize.required, weight: 0,
          dependsOn: [['diarize', -1]] });
    add({ kind: 'reconcile.speakers', optional: true,
          dependsOn: [...asrLeaves, ['diarize.poll', -1]] });
  }

  add({ kind: 'normalize.text', dependsOn: asrLeaves });

  p.editorial.forEach((e, i) =>
    add({ kind: 'editorial.pass', shard: i, queue: 'editorial', optional: true,
          dependsOn: [['normalize.text', -1]], input: { pass: e } }));

  p.exports.forEach((e, i) =>
    add({ kind: 'export', shard: i, queue: 'export', optional: true,
          dependsOn: [['normalize.text', -1]], input: { export: e } }));

  return out.map((s, ordinal) => ({ ...s, ordinal }));
}
```

**Materialising it idempotently** is two statements, and the `'*'` wildcard is resolved in the
second — which is why `depends_on` is `uuid[]` rather than a natural key: resolution happens
once, at plan time, and the reconciler never has to re-expand a wildcard.

```sql
-- 1. Insert. Convergent: run it as many times as you like.
INSERT INTO run_steps (run_id, kind, ordinal, shard, queue, optional, weight, max_attempts, input)
SELECT $1, x.kind, x.ordinal, x.shard, x.queue, x.optional, x.weight, x.max_attempts, x.input
FROM   jsonb_to_recordset($2::jsonb) AS x(
         kind text, ordinal int, shard int, queue text,
         optional boolean, weight int, max_attempts int, input jsonb)
ON CONFLICT (run_id, kind, shard) DO NOTHING;

-- 2. Resolve dependencies by natural key, wildcards included.
--    Idempotent because it assigns the full array, not an append.
WITH spec AS (
  SELECT x.kind, x.shard, d.dep_kind, d.dep_shard
  FROM   jsonb_to_recordset($2::jsonb) AS x(kind text, shard int, depends_on jsonb)
  CROSS JOIN LATERAL jsonb_to_recordset(x.depends_on)
       AS d(dep_kind text, dep_shard text)          -- '-1' | '<n>' | '*'
),
resolved AS (
  -- CORRECTED: `ORDER BY dep.id` inside array_agg. Without it Postgres may aggregate a
  -- wildcard's matches in any order, so replanning an unchanged run rewrites depends_on with
  -- the same uuids in a new sequence, `IS DISTINCT FROM` stops suppressing the update, and the
  -- idempotence test below fails intermittently. Amendment 87.
  SELECT s.kind, s.shard, array_remove(array_agg(dep.id ORDER BY dep.id), NULL) AS deps
  FROM   spec s
  LEFT JOIN run_steps dep
         ON dep.run_id = $1
        AND dep.kind   = s.dep_kind
        AND (s.dep_shard = '*' OR dep.shard = s.dep_shard::int)
  GROUP BY s.kind, s.shard
)
UPDATE run_steps t SET depends_on = r.deps
FROM   resolved r
WHERE  t.run_id = $1 AND t.kind = r.kind AND t.shard = r.shard
  AND  t.depends_on IS DISTINCT FROM r.deps;
```

`plan.chunks` is the interesting ordering problem: the number of `asr.chunk` shards is not
known until it has run. Two options were considered and the second is chosen.

| Option | Verdict |
|---|---|
| Plan the whole DAG up front, probing duration at run creation | Rejected. Duration comes from `media.probe`; a URL import has no duration until download completes. Planning would have to guess and re-plan anyway. |
| **Two-stage plan** — plan through `plan.chunks`, then have the `plan.chunks` handler call `planRun` again with the real `chunkCount` in the same transaction that writes `run_chunks` | **Chosen.** The `ON CONFLICT DO NOTHING` insert makes the second call a pure extension of the first. One code path, no special cases, and the chunk rows and the steps that consume them commit together. |

### 5. Retry policy

```ts
// packages/engine/src/queue/retry.ts
export interface RetrySpec { maxAttempts: number; baseMs: number; capMs: number; jitter: boolean }

export const POLICY: Record<StepKind, RetrySpec> = {
  'media.probe':      { maxAttempts: 2, baseMs:  5_000, capMs:  30_000, jitter: false },
  'media.normalize':  { maxAttempts: 2, baseMs:  5_000, capMs:  60_000, jitter: false },
  'media.peaks':      { maxAttempts: 2, baseMs:  5_000, capMs:  60_000, jitter: false },
  'plan.chunks':      { maxAttempts: 2, baseMs:  5_000, capMs:  30_000, jitter: false },
  'asr.chunk':        { maxAttempts: 5, baseMs:  2_000, capMs: 120_000, jitter: true  },
  'asr.batch.submit': { maxAttempts: 3, baseMs: 30_000, capMs: 300_000, jitter: false },
  'asr.poll':         { maxAttempts: 8, baseMs: 30_000, capMs: 300_000, jitter: true  },
  'asr.fetch':        { maxAttempts: 3, baseMs: 10_000, capMs: 120_000, jitter: true  },
  'diarize':          { maxAttempts: 2, baseMs: 60_000, capMs: 300_000, jitter: false },
  'diarize.poll':     { maxAttempts: 8, baseMs: 30_000, capMs: 300_000, jitter: true  },
  'reconcile.speakers':{maxAttempts: 2, baseMs:  5_000, capMs:  30_000, jitter: false },
  'normalize.text':   { maxAttempts: 2, baseMs:  5_000, capMs:  30_000, jitter: false },
  'editorial.pass':   { maxAttempts: 4, baseMs:  5_000, capMs: 120_000, jitter: true  },
  'export':           { maxAttempts: 3, baseMs:  5_000, capMs:  60_000, jitter: true  },
  'staging.cleanup':  { maxAttempts: 3, baseMs: 30_000, capMs: 300_000, jitter: false },
};
```

Matching the overview's table (`media.normalize 2 × 5s`, `asr.chunk 5 × 2s (jitter)`,
`asr.batch.submit 3 × 30s`, `diarize 2 × 60s`, `editorial.pass 4 × 5s (jitter)`) and filling in
the kinds it did not enumerate.

**Full jitter, not equal jitter, not exponential-with-a-dash-of-random.** Eight `asr.chunk`
steps that all hit a 429 at the same instant must not all wake at the same instant. Full jitter
(`random() * exp`) is the variant that actually decorrelates; capped exponential with ±10%
noise does not.

```ts
export function backoffMs(spec: RetrySpec, attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(spec.capMs, spec.baseMs * 2 ** attempt);
  const jittered = spec.jitter ? Math.random() * exp : exp;
  // Retry-After is a floor, never a ceiling. A provider that says "wait 60s" means it.
  return Math.max(Math.ceil(jittered), retryAfterMs ?? 0);
}

/** RFC 9110 delta-seconds or HTTP-date. Returns ms, clamped to 15 minutes. */
export function parseRetryAfter(h: string | null | undefined, now: number): number | undefined {
  if (!h) return undefined;
  const secs = Number(h.trim());
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, 15 * 60_000);
}
```

**`isRetryable`**, generalising `lib/queue.ts:52-53` verbatim in spirit:

```ts
// The original, kept as the documented core:
//   const RETRYABLE = (status) => status === 429 || (status !== undefined && status >= 500);
const NET_CODES = new Set([
  'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN','ENOTFOUND','EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET',
]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof CancelledError) return false;          // cancellation is not a fault
  if (err instanceof NonRetryableError) return false;       // handlers can assert finality

  const status = (err as { status?: number }).status;
  if (typeof status === 'number') {
    // 400/401/403/404 from Google are configuration or payload errors. Retrying one
    // burns quota and cannot succeed; it also delays the operator seeing the real message.
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  const code = (err as { code?: string }).code;
  if (code && NET_CODES.has(code)) return true;
  if (err instanceof Error && /aborted|socket hang up|fetch failed/i.test(err.message)) return true;
  return false;
}
```

Two extensions over the original beyond the codes: **413 is never retryable** (chunk too large —
re-chunk instead, which is a `plan.chunks` concern), and **a 429 on `asr.chunk` also debits the
provider's token bucket by a penalty amount** so the sibling chunks slow down too, rather than
each discovering the limit independently.

Failure path in the handler wrapper:

```ts
async function onStepError(ctx: EngineContext, step: StepRow, err: unknown) {
  const spec = POLICY[step.kind];
  const nextAttempt = step.attempt + 1;
  const retryable = isRetryable(err) && nextAttempt < spec.maxAttempts;
  const scrubbed = scrubProviderError(err);   // phase 10 §9

  await ctx.db.transaction(async (tx) => {
    await tx.update(runSteps).set({
      state: retryable ? 'pending' : (step.optional ? 'skipped' : 'dead'),
      attempt: nextAttempt,
      lease_owner: null,
      heartbeat_at: null,
      poll_after: retryable
        ? new Date(Date.now() + backoffMs(spec, step.attempt, retryAfterOf(err)))
        : null,
      error: scrubbed,
      finished_at: retryable ? null : ctx.clock.now(),
    }).where(eq(runSteps.id, step.id));

    await insertAndNotify(tx, {
      runId: step.runId,
      kind: retryable ? 'step.retrying' : 'step.dead',
      data: { stepId: step.id, kind: step.kind, shard: step.shard, attempt: nextAttempt, error: scrubbed },
    });
  });

  await reconcile(ctx, step.runId);
}
```

Note the retry goes back to `pending`, not `ready` — the reconciler owns promotion, and
`poll_after` becomes the `startAfter` on the resulting send. One promotion path, one send path.

### 6. Concurrency in three layers

**Layer 1 — queue routing across containers.**

| Queue | Kinds | Container | Why |
|---|---|---|---|
| `media` | `media.*`, `plan.chunks`, `staging.cleanup` | `worker` | ffmpeg: CPU-bound, bounded |
| `worker` | `normalize.text`, `reconcile.speakers` | `worker` | **Added 2026-08-14.** In-process CPU work with no external dependency. §2's kind table routed these two kinds here and this table, `SUBSCRIPTIONS` and `WORKER_QUEUES` all omitted it — so every run planned two steps onto a queue nothing subscribed to, and they would sit `ready` forever while the queue reported depth 0. Amendment 87 |
| `asr.cloud` | `asr.chunk` (cloud), `asr.batch.submit`, `asr.fetch` | `worker` | Network-bound; the concurrency limit is the provider's |
| `asr.poll` | `asr.poll`, `diarize.poll` | `worker` | Sub-second work; must never queue behind a 40-minute diarize |
| `editorial` | `editorial.pass` | `worker` | LLM calls; network-bound |
| `export` | `export` | `worker` | Pure CPU, fast |
| `maintenance` | `maintenance.*` | `worker` | Cron |
| `diarize` | `diarize` | **`worker-heavy`** | pyannote: **~0.6× realtime on CPU** (measured ×2, S6 2026-08-10; was an unmeasured 0.15–0.4×). Never gates the transcript — ASR completes in ~1 min where this takes ~1 h 40 m |
| `asr.local` | `asr.chunk` (faster-whisper) | **`worker-heavy`** | Same GPU/RAM, same contention |

The split exists so that a 2.5-hour pyannote job on a 1-hour interview cannot starve the
sub-second `asr.poll` that keeps a `batchRecognize` alive. Putting polls on the heavy queue is
the mistake that makes a batch run look hung.

**Layer 2 — pg-boss per-queue `batchSize`.**

```ts
const SUBSCRIPTIONS: Record<QueueName, { batchSize: number; pollingIntervalSeconds: number }> = {
  media:       { batchSize: 2, pollingIntervalSeconds: 1 },
  worker:      { batchSize: 2, pollingIntervalSeconds: 1 },   // added; see the table above
  'asr.cloud': { batchSize: 8, pollingIntervalSeconds: 1 },
  'asr.poll':  { batchSize: 4, pollingIntervalSeconds: 2 },
  editorial:   { batchSize: 4, pollingIntervalSeconds: 2 },
  export:      { batchSize: 2, pollingIntervalSeconds: 2 },
  maintenance: { batchSize: 1, pollingIntervalSeconds: 30 },
  diarize:     { batchSize: 1, pollingIntervalSeconds: 5 },
  'asr.local': { batchSize: 1, pollingIntervalSeconds: 5 },
};
```

Scaled by `WORKER_CONCURRENCY` (a multiplier, default 1) and clamped by
`provider.capabilities().limits.maxConcurrentRequests` for the ASR queues — the engine already
knows the provider's cap and should not need an operator to discover it.

**Layer 3 — `pg_try_advisory_lock` global slots.** `batchSize` is per process. Someone will run
`docker compose up -d --scale worker-heavy=3` on a one-GPU box, and nothing in layers 1–2 stops
that from OOMing the card.

```ts
// packages/engine/src/queue/lease.ts
const SLOT_CLASS = { gpu: 0x7101, localAsr: 0x7102, ytdlp: 0x7103 } as const;

/**
 * Session-scoped advisory lock over N global slots. MUST run on a dedicated client
 * checked out of the pool for the whole step: a pooled client returned mid-step
 * releases nothing but hands the lock's session to an unrelated query.
 */
export async function withGlobalSlot<T>(
  ctx: EngineContext, kind: keyof typeof SLOT_CLASS, slots: number, fn: () => Promise<T>,
): Promise<T | typeof NO_SLOT> {
  const client = await ctx.db.acquireDedicatedClient();
  try {
    for (let i = 0; i < slots; i++) {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock($1, $2) AS ok', [SLOT_CLASS[kind], i],
      );
      if (rows[0].ok) {
        try { return await fn(); }
        finally { await client.query('SELECT pg_advisory_unlock($1, $2)', [SLOT_CLASS[kind], i]); }
      }
    }
    return NO_SLOT;   // caller requeues with a 5–15 s jittered delay; NOT a failure
  } finally {
    client.release();
  }
}
```

`NO_SLOT` sets the step back to `pending` with a short `poll_after` and **does not increment
`attempt`**. Slot contention is not a fault and must never consume a retry budget — get this
wrong and a busy hour marks half the diarize steps dead.

Slot counts come from `GPU_SLOTS` (default 1) and `LOCAL_ASR_SLOTS` (default 1). They are
per-database, so they hold across containers, which is the entire point.

**Outbound per-provider token bucket.** Google's quota is per *project*. Ten containers each
respecting `maxConcurrentRequests: 8` is 80 concurrent requests against one project quota.

> **This is also the only place that can own the overview's fourth routing rule, and it is
> unbuilt.** `00-overview.md` lists *"sync quota exhausted / sustained 429s → batch"* as a way
> into batch mode. Phase 2 did not build it and deliberately did not design it: `planMode` takes
> no quota input, and it would have to, because the decision depends on live 429 rates rather
> than on anything about the file. This table is the only component that knows that state.
>
> Two things to settle before building it. It must not be silent — a run that becomes ~5× slower
> because a *different* run exhausted the quota is a support ticket, not a graceful degradation,
> so it needs a run event and a visible reason on the timeline. And it only makes sense at
> submit time: a run already chunked and half-transcribed cannot become a batch run, so the
> escape hatch is for runs still in `pending`, not for ones hitting 429s mid-flight. Those keep
> the existing penalty-debit behaviour. If neither turns out to be worth it, delete the rule from
> the overview rather than leaving it as an unimplemented promise.

```sql
CREATE TABLE rate_buckets (
  key           text PRIMARY KEY,     -- 'google:asia-southeast1' | 'openai:whisper-1' | 'anthropic'
  capacity      numeric NOT NULL,     -- burst
  refill_per_s  numeric NOT NULL,
  tokens        numeric NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

```ts
/**
 * Debit `n` tokens and return how long the caller must wait before proceeding.
 * The bucket is allowed to go NEGATIVE: the debit is unconditional, so concurrent
 * takers queue behind each other by deficit instead of spinning on a refusal.
 * The row lock serialises them; the arithmetic makes the wait fair and FIFO-ish.
 */
export async function takeTokens(db: Db, key: string, n = 1): Promise<number> {
  const { rows } = await db.execute(sql`
    UPDATE rate_buckets SET
      tokens     = LEAST(capacity, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * refill_per_s) - ${n},
      updated_at = now()
    WHERE key = ${key}
    RETURNING tokens, refill_per_s
  `);
  if (!rows.length) return 0;                       // unconfigured provider = unthrottled
  const { tokens, refill_per_s } = rows[0];
  return tokens >= 0 ? 0 : Math.ceil((-tokens / refill_per_s) * 1000);
}
```

Callers `await sleep(waitMs)` — but only up to `MAX_BUCKET_WAIT_MS` (30 s); beyond that the step
requeues with `poll_after` rather than holding a worker slot idle. A 429 penalty-debits the
bucket by `capacity / 2`, which is how one chunk's rejection slows its seven siblings without
any cross-process messaging.

### 7. Long async steps

The rule: **a step that is waiting on someone else's computer holds no worker slot.**
`awaiting_external` is not a lease state — no heartbeat, no `lease_owner`, and the recovery
sweep never touches it.

```ts
// packages/engine/src/queue/handlers/asr-batch.ts

> **Reconciled 2026-08-10 against what Phase 2 shipped.** The two handlers below were written
> before the provider surface existed and their calls do not match it. Phase 2's whole design
> constraint was that these steps would need *no* provider change, and that holds — but the
> sketch has to be read with four corrections, all of which are in `pipeline/batch-run.ts` and
> `pipeline/batch-persist.ts` today:
>
> 1. **`pollBatch(cfg, op)` takes the whole `BatchOp`, not `externalRef`.** Passing the name
>    alone loses `region`, and Speech v2 is regional: polling the wrong regional host 404s in a
>    way that reads like "the operation is gone" rather than "you asked the wrong server". The
>    struct is plain JSON in `runs.pipeline.batch` for exactly this reason — call
>    `loadOperation(ctx, runId)` and get a poll-ready `BatchOp` back. `pollBatch` also
>    cross-checks the name's embedded region against the stored one and refuses on a mismatch.
> 2. **The return is a `BatchStatus`, not a raw LRO.** `status.state` is
>    `running | succeeded | failed`; there is no `op.done`, and `op.error` is not the whole
>    story — see 3.
> 3. **`done: true` with no operation-level error is not success.** Spike S3 measured
>    `response.results[uri].error` set while `done` was true, `progressPercent` was 100 and
>    `error` was absent, at **1 run in 5**. `classifyOperation` already collapses this into
>    `state: 'failed'` with `error.scope: 'file'` and a `retryable` flag, so the handler must
>    branch on `state` and never on `done`.
> 4. **`progressPercent` is a percentage, not a fraction.** `op.progressPercent ?? 0.2` below
>    mixes units — a live run would jump to 2600% progress. Divide by 100. It *is* populated:
>    measured 26/52/78 across thirteen polls on a 20-minute file, which retires the Phase 2 risk
>    that assumed it might always be absent.
>
> One thing the sketch gets right and should keep: polling must not increment `attempt`. Phase 2
> counts polls separately in `runs.pipeline.batch.polls` for the same reason.

export const asrBatchSubmit: StepHandler = async (ctx, step, signal) => {
  const run = await getRun(ctx, step.runId);
  const provider = ctx.providers.get(run.providerId);

  // Idempotence guard: if a previous attempt got as far as Google but died before
  // committing, external_ref is already set and re-submitting would double-bill.
  if (step.externalRef) return { state: 'awaiting_external', pollAfter: seconds(30) };

  const wait = await takeTokens(ctx.db, `${run.providerId}:${run.region}`, 1);
  if (wait) await ctx.clock.sleep(wait, signal);

  const op = await provider.submitBatch!(await ctx.settings.providerConfig(run.providerId), {
    uris: await stageChunksToGcs(ctx, run, signal),
    languageCode: run.languageCode,
    model: run.model,
    outputPrefix: `${run.stagingPrefix}/out/`,
  });

  return {
    state: 'awaiting_external',
    externalRef: op.name,                              // survives restarts; also on runs.operation_name
    // Two-sided deadline: Google's own LRO expiry AND ours. Without the second, a
    // provider that never resolves leaves a step polling until the heat death.
    deadlineAt: new Date(Date.now() + hours(6)),
    pollAfter: new Date(Date.now() + seconds(60)),     // batch has minutes of queue latency
    output: { operationName: op.name, submittedAt: ctx.clock.now(), progress: 0.05 },
  };
};

export const asrPoll: StepHandler = async (ctx, step, signal) => {
  const submit = await siblingStep(ctx, step.runId, 'asr.batch.submit');
  const run = await getRun(ctx, step.runId);
  const provider = ctx.providers.get(run.providerId);

  if (step.deadlineAt && Date.now() > +step.deadlineAt) {
    throw new NonRetryableError('BATCH_DEADLINE_EXCEEDED', { operation: submit.externalRef });
  }

  // Corrected: the whole BatchOp, rehydrated from runs.pipeline.batch. `region` travels with
  // it because the poll URL cannot be rebuilt without one.
  const { op: batchOp } = await loadOperation(ctx, step.runId);
  const status = await provider.pollBatch!(
    await ctx.settings.providerConfig(run.providerId),
    batchOp!,
  );

  if (status.state === 'running') {
    // Capped backoff 30 → 300 s, keyed off attempt count rather than wall clock so a
    // restart does not reset the schedule to aggressive.
    const nextMs = Math.min(300_000, 30_000 * 2 ** Math.min(step.attempt, 4));
    return {
      state: 'awaiting_external',
      // Polling is not a retry. Bump a poll counter, never `attempt`.
      output: {
        ...step.output,
        polls: (step.output?.polls ?? 0) + 1,
        // A percentage, divided to a fraction. Populated in practice; the fallback is only
        // for a provider or a run that omits it, and is never fabricated upward.
        progress: status.progressPercent !== undefined ? status.progressPercent / 100 : 0.2,
      },
      pollAfter: new Date(Date.now() + jitter(nextMs)),
    };
  }
  // `state`, never `done`: an operation can report done with a per-file error and no
  // operation-level error. Measured at 1 run in 5. `error.scope` says which happened and
  // `retryable` says whether resubmitting is worth anything — code 13 yes, code 8 no.
  if (status.state === 'failed') throw providerError(status.error, { retryable: status.retryable });
  return { state: 'done', output: { outputUri: status.outputUri, progress: 1 } };
};
```

The poll step's `attempt` counter is reserved for *poll calls that themselves failed*. Its
`max_attempts: 8` therefore means "eight consecutive failed poll requests", not "eight polls".
Polls are counted in `output.polls` and displayed on the timeline; a run showing 47 polls over
four hours is informative, a run showing `attempt 47/8` is a bug report.

`diarize` / `diarize.poll` are the identical pair against the sidecar, with
`idempotency_key: step.id` on the submit so a re-delivered doorbell returns the existing task id
instead of starting a second GPU job.

### 8. Crash recovery

Runs on worker boot and every 60 s thereafter, in `recover.ts`. Three statements, in this order.

```sql
-- (a) Stale leases. A step whose worker stopped heartbeating is dead work, not lost work:
--     it goes back to 'pending' with attempt+1 so the reconciler re-promotes it.
--     90 s = 6 × the 15 s heartbeat. Tight enough to recover fast, loose enough that
--     a GC pause or a slow ffmpeg write does not steal a live step.
UPDATE run_steps
SET    state        = CASE WHEN attempt + 1 >= max_attempts
                           THEN (CASE WHEN optional THEN 'skipped' ELSE 'dead' END)::step_state
                           ELSE 'pending'::step_state END,
       attempt      = attempt + 1,
       lease_owner  = NULL,
       heartbeat_at = NULL,
       error        = COALESCE(error, '{}'::jsonb)
                      || jsonb_build_object('code','HEARTBEAT_LOST',
                                            'lostAt', now(),
                                            'lastOwner', lease_owner)
WHERE  state = 'running'
  AND  heartbeat_at < now() - interval '90 seconds'
RETURNING run_id;

-- (b) External work is NEVER reset. It is still running on someone else's computer;
--     resetting it re-submits and re-bills. All we do is make it pollable immediately.
UPDATE run_steps
SET    poll_after = LEAST(COALESCE(poll_after, now()), now())
WHERE  state = 'awaiting_external'
RETURNING run_id;

-- (c) Reconcile everything still alive. Cheap, and it repairs any run whose doorbell
--     was lost in the window between COMMIT and sendStep().
SELECT id FROM runs WHERE state NOT IN ('done','failed','partial','cancelled');
```

Statement (b) is the single most valuable line in this phase. A `docker compose restart` during
a two-hour `batchRecognize` costs a poll cycle. The naive alternative — treating
`awaiting_external` like `running` — costs $19 and two hours, silently, and only shows up on the
bill.

**Heartbeat wrapper.** Every handler runs inside it; there is no opt-out.

```ts
export async function withHeartbeat<T>(
  ctx: EngineContext, step: StepRow, fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const owner = `${os.hostname()}:${process.pid}:${ctx.bootId}`;

  const timer = setInterval(() => {
    void ctx.db.execute(sql`
      UPDATE run_steps SET heartbeat_at = now()
      WHERE id = ${step.id} AND state = 'running' AND lease_owner = ${owner}
      RETURNING cancel_observed
    `).then((r) => {
      // Lease stolen by the recovery sweep — another worker owns this step now.
      // Abort rather than write a result that will collide.
      if (r.rowCount === 0) ac.abort(new LeaseLostError(step.id));
    }).catch(() => { /* transient DB blip: the 90 s window absorbs it */ });
  }, 15_000).unref();

  ctx.cancellation.subscribe(step.runId, () => ac.abort(new CancelledError(step.runId)));

  try { return await fn(ac.signal); }
  finally { clearInterval(timer); ctx.cancellation.unsubscribe(step.runId); }
}
```

The `AND lease_owner = $owner` predicate is what makes a stolen lease detectable. Without it a
resurrected step and its zombie predecessor both write segments and the run gets duplicates.

**Draining.** `stop_grace_period: 120s` on both worker services in `compose.yml`. On SIGTERM:

```ts
process.on('SIGTERM', async () => {
  draining = true;                        // /readyz starts returning 503
  await boss.stop({ graceful: true, close: false, wait: true, timeout: 100_000 });
  await ctx.db.end();
  process.exit(0);
});
```

Graceful stop means: fetch no new jobs, let in-flight handlers finish. Handlers that cannot
finish in 100 s (a mid-file `asr.chunk`) are killed by Docker at 120 s and picked up by the next
boot's heartbeat sweep 90 s later. That is the "lose at most one chunk" guarantee, and it is
worth stating in the docs in those words. Docker's default `stop_grace_period` is **10 seconds**
— leaving it at the default is how you turn a graceful drain into the crash path on every
deploy.

### 9. Partial failure

A three-hour transcript with one bad 55-second chunk is still valuable. Losing it because chunk
94 of 180 hit five consecutive 500s is the behaviour the current app has and the behaviour that
makes people stop trusting the tool.

When an `asr.chunk` step exhausts `max_attempts`:

1. Step → `dead` (not `failed`; `failed` is reserved for run-fatal).
2. Its `run_chunks` row → `status = 'failed'`, `attempts` recorded.
3. A **placeholder segment** is inserted spanning the chunk's interval:

```sql
ALTER TABLE segments ADD COLUMN placeholder_reason text;   -- 'chunk_failed' | 'chunk_cancelled'
```

```ts
await tx.insert(segments).values({
  runId, idx: nextIdx, chunkId: chunk.id,
  startMs: chunk.offsetMs, endMs: chunk.offsetMs + chunk.durationMs,
  text: '', textRaw: '', confidence: 0, hasWords: false,
  needsSpeakerReview: true,
  placeholderReason: 'chunk_failed',
});
```

The placeholder keeps the timeline contiguous, which every downstream consumer already assumes:
subtitle reflow, export, the editor's virtualiser, and speaker reconciliation all iterate
segments in order. A hole would require each of them to grow a special case. Exporters render
placeholders as `[audio not transcribed 01:34:20–01:35:15]` in text formats and **omit the cue
entirely** in SRT/VTT — a subtitle track should not display an error.

4. `reconcile` sees `chunkCasualties > 0 && anySucceeded` → run state `partial`.
5. `/runs/:id` shows a banner and a **Retry this chunk** button per failed chunk, which resets
   exactly that step (`state='pending', attempt=0`), deletes its placeholder segment, and
   re-reconciles. Retrying one chunk of a 180-chunk run must not re-run the other 179 — the
   dependency graph already gives that for free, because `normalize.text` depends on
   `['asr.chunk','*']` and re-running one shard re-triggers only the steps downstream of it.
6. Retrying a chunk on a `partial` run moves the run back to `running`; if the retry succeeds
   and no casualties remain, it lands on `done`. `partial` is not sticky.

`runs.state` therefore becomes: `queued | running | done | partial | failed | cancelled`.

### 10. Cancellation

```ts
export async function requestCancel(ctx: EngineContext, runId: string, userId: string) {
  await ctx.db.transaction(async (tx) => {
    await tx.update(runs)
      .set({ cancelRequestedAt: ctx.clock.now(), cancelRequestedBy: userId })
      .where(and(eq(runs.id, runId), isNull(runs.cancelRequestedAt)));
    await insertAndNotify(tx, { runId, kind: 'run.cancelling', data: { by: userId } });
    await tx.execute(sql`SELECT pg_notify('run_cancel', ${runId})`);
  });
  await reconcile(ctx, runId);      // kills pending/ready immediately
}
```

Four propagation paths, because a cancel that only stops the *next* step is not a cancel:

| Where the work is | Mechanism |
|---|---|
| `pending` / `ready` steps | `reconcile` sets `cancelled` in the same pass. Instant. |
| A running handler | Every worker `LISTEN run_cancel`; the listener aborts the `AbortController` in `withHeartbeat`. Every `fetch` in the engine already takes `signal`; the `asr.chunk` loop also checks `signal.aborted` between chunks so a non-abortable provider call still stops at the boundary. |
| ffmpeg | `spawn` with the signal; `child.kill('SIGTERM')` on abort, `SIGKILL` after 5 s. Partial output files are deleted, not left for the next run to find. |
| External operations | Best-effort `provider.cancelBatch?.(cfg, externalRef)` and `DELETE {sidecar}/v1/tasks/{id}`. Best-effort means: log the failure, mark the step `cancelled` anyway, and let the lifecycle rule on the staging prefix clean up. Never block a user's cancel on a provider's cooperation. |

`CancelledError` is explicitly non-retryable in `isRetryable`. Without that, cancelling a run
schedules five more attempts of the thing you just cancelled.

The NOTIFY channel is separate from `run_events` so that workers can subscribe to cancels
without parsing the whole progress firehose.

### 11. Progress

```sql
CREATE TABLE run_events (
  seq        bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind       text NOT NULL,            -- run.progress | run.finished | step.* | chunk.done | log
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_events_run_seq_idx ON run_events (run_id, seq);
```

**Events are idempotent state snapshots, not deltas.** `run.progress` carries the absolute
progress and state; `step.state` carries the step's whole row. This is a deliberate design
choice and it buys away a real hazard: `bigserial` values are allocated before commit, so two
concurrent inserts can commit out of order and a reader tracking `seq > last` can skip a row
that was assigned a lower `seq` but became visible later. With snapshots, an out-of-order or
duplicated delivery is harmless — the client's last-write-wins reducer converges. With deltas
("chunks_done += 1") it is a permanently wrong progress bar. Do not add a delta event later
without revisiting this paragraph.

**Insert and notify in one statement, in the caller's transaction.**

```sql
WITH e AS (
  INSERT INTO run_events (run_id, kind, data)
  VALUES ($1, $2, $3::jsonb)
  RETURNING seq, run_id, kind
)
SELECT pg_notify('run_events',
                 json_build_object('seq', seq, 'runId', run_id, 'kind', kind)::text)
FROM e;
```

The payload is a **pointer, never the data**: NOTIFY has an 8000-byte payload cap, and a
transcript segment blows through it. Listeners re-read `run_events` by `seq`. This is what "the
doorbell, not the transport" means concretely, and it is also what guarantees a listener never
observes an event before the data it describes — both are in the same transaction, so both
become visible at the same instant, and `pg_notify` inside a transaction is only delivered on
commit.

**Coalescing in the worker.** `asr.chunk` on a 180-chunk run would otherwise emit 180 progress
events plus per-chunk logs; the editor does not need 20 Hz.

```ts
// packages/engine/src/events/emit.ts — at most one run.progress per run per 500 ms.
// Terminal and error kinds bypass the coalescer and flush immediately: a user waiting
// on "did it fail?" must not wait out a debounce window.
const COALESCED = new Set(['run.progress', 'step.progress']);
const IMMEDIATE = new Set(['run.finished', 'run.cancelling', 'step.dead', 'step.retrying']);
```

**The listener — one dedicated `pg.Client` per web process.**

```ts
// packages/engine/src/events/listener.ts
export class RunEventListener extends EventEmitter {
  private client?: PgClient;
  private lastSeq = new Map<string, bigint>();

  async start() {
    // A pooled client cannot hold LISTEN. This is a raw Client on DATABASE_URL_DIRECT.
    this.client = new PgClient({ connectionString: env.DATABASE_URL_DIRECT });
    this.client.on('error', () => this.reconnect());
    this.client.on('notification', (n) => this.onNotify(n));
    await this.client.connect();
    await this.client.query('LISTEN run_events');
    this.emit('resync');   // reconnect gap: every stream re-reads from its own last seq
  }
  // reconnect(): exponential backoff 1→30 s, then start() again. Always emits 'resync'.
}
```

Fan-out through one `EventEmitter` is the same shape as `lib/queue.ts:35-41`'s `runEvents()`,
just fed from Postgres instead of an in-process promise chain. Keeping the shape means the SSE
route and the `use-run-stream` hook port almost unchanged.

**PgBouncer in transaction pooling mode breaks `LISTEN`** — the connection is handed to another
client between statements and notifications are lost or delivered to the wrong session. The
listener therefore connects on `DATABASE_URL_DIRECT`, and `apps/web/src/env.ts` fails startup
if `DATABASE_URL_DIRECT` is unset while `DATABASE_URL` points at port 6432. v1 Compose has no
PgBouncer; this exists so the first person who adds one gets an error instead of a progress bar
that mysteriously never moves.

**The SSE route.**

```ts
// apps/web/src/app/api/runs/[id]/stream/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = await params;
  const user = await requireUser();                       // BEFORE any bytes are written
  await assertCanReadRun(user, runId);                    // 404, not 403 — do not confirm existence

  const enc = new TextEncoder();
  let cursor = BigInt(req.headers.get('last-event-id') ?? '0');

  const stream = new ReadableStream({
    async start(controller) {
      const write = (e: RunEventRow) =>
        controller.enqueue(enc.encode(
          `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e.data)}\n\n`));

      // Drain everything the client missed before subscribing, so nothing falls in the gap.
      const flush = async () => {
        const rows = await readEventsSince(runId, cursor, 500);
        for (const r of rows) { write(r); cursor = r.seq; }
      };
      await flush();

      const onNotify = (n: { runId: string }) => { if (n.runId === runId) void flush(); };
      listener.on('run_events', onNotify);
      listener.on('resync', () => void flush());

      // 15 s heartbeat: keeps intermediaries from reaping an idle stream.
      const hb = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15_000);
      // 10 s backstop: covers a dropped NOTIFY (they are not durable) and a listener
      // reconnect that happened while this stream was quiet.
      const backstop = setInterval(() => void flush(), 10_000);

      const cleanup = () => {
        clearInterval(hb); clearInterval(backstop);
        listener.off('run_events', onNotify);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this, Caddy/nginx buffers the response and progress appears frozen
      // until the run ends. It is the single most common SSE deployment failure.
      'X-Accel-Buffering': 'no',
    },
  });
}
```

`EventSource` sends `Last-Event-ID` automatically on reconnect, which is why `id:` must be the
raw `seq` and why `seq` must be monotonic per run. Replay is capped at 500 events per flush; a
client further behind than the retained window receives a `resync` event carrying the full run
state and resets its cursor to the newest `seq`.

**Fallback: 2-second polling.** `GET /api/runs/:id/events?since=<seq>` returns the same rows as
JSON. `PROGRESS_TRANSPORT=poll` switches the client hook over. Take it if: the deployment sits
behind a proxy that cannot be told to stop buffering; the browser hits the 6-connection-per-host
limit with several runs open (HTTP/2 makes this unlikely, but a plain-HTTP LAN install is
HTTP/1.1); or LISTEN proves flaky. At one instance per newsroom with a handful of concurrent
runs, polling is genuinely fine — 30 requests/minute against an indexed `(run_id, seq)` lookup.
Ship both, default to SSE, and keep the polling path tested in CI so it is a config change and
not a project.

**Pruning** — `maintenance.prune_events`, daily at 04:00 via pg-boss cron:

```sql
DELETE FROM run_events e
USING runs r
WHERE  e.run_id = r.id
  AND  r.state IN ('done','failed','partial','cancelled')
  AND  e.created_at < now() - interval '7 days';

-- Cap live runs too: a pathological run must not grow unbounded.
DELETE FROM run_events e
WHERE  e.seq < (SELECT max(seq) - 5000 FROM run_events WHERE run_id = e.run_id);
```

The run timeline UI reads `run_steps`, not `run_events`, so pruning the event log loses nothing
a user can see. Say that in the maintenance docs so nobody "fixes" it by retaining forever.

### 12. Dead letter

There is no separate dead-letter table. `run_steps WHERE state = 'dead'` *is* the dead-letter
queue, which is the point of putting the state machine in our schema.

```
GET  /api/admin/queue?state=dead&limit=50
     → [{ stepId, runId, jobTitle, kind, shard, attempt, maxAttempts,
           error: { code, message, status, at }, input, finishedAt, queue }]
POST /api/admin/queue/:stepId/retry     → attempt=0, state='pending', error=null, then reconcile
POST /api/admin/queue/:stepId/skip      → state='skipped' (admin accepts the loss), then reconcile
POST /api/admin/queue/retry-all         → same, over a filtered set; capped at 200
GET  /api/admin/queue/stats             → per-queue depth, oldest ready age, running count,
                                          dead count in 24 h, awaiting_external count
```

Admin-only (phase 10). The UI is phase 14; this phase ships the routes and `thibi run retry`.
`input` is safe to render because §9 of phase 10 forbids secrets in it — the admin queue page
was the specific thing that rule was written for.

Also expose `oldest ready age` prominently: a queue with depth 0 and a step that has been
`ready` for 20 minutes means no worker is subscribed to that queue, which is the most likely
misconfiguration after a `WORKER_QUEUES` typo.

### 13. `apps/worker`

```ts
// apps/worker/src/main.ts
const env = parseWorkerEnv(process.env);           // zod; fails loudly, never defaults silently
const ctx = await buildEngineContext(env);         // db, store, staging?, settings, llm, ffmpeg, …
const boss = await createBoss(env.DATABASE_URL);
const registry = createHandlerRegistry();          // Record<StepKind, StepHandler>

// Fail fast on a typo'd queue name rather than idling forever.
for (const q of env.WORKER_QUEUES) {
  if (!ALL_QUEUES.includes(q)) throw new Error(`Unknown queue "${q}". Known: ${ALL_QUEUES.join(', ')}`);
}

await startHealthServer(env.WORKER_HEALTH_PORT, () => ({ draining, boss: boss.isStarted }));
await recoverOnBoot(ctx);
setInterval(() => void recoverTick(ctx), 60_000).unref();
setInterval(() => void reconcileAllLive(ctx), 30_000).unref();
await ctx.cancellation.start();                    // LISTEN run_cancel

for (const q of env.WORKER_QUEUES) {
  const sub = SUBSCRIPTIONS[q];
  await boss.work(q, {
    batchSize: Math.max(1, Math.round(sub.batchSize * env.WORKER_CONCURRENCY)),
    pollingIntervalSeconds: sub.pollingIntervalSeconds,
  }, async (jobs) => {
    await Promise.all(jobs.map((j) => runStep(ctx, registry, j.data)));
  });
}

// Cron lives on whichever worker takes the maintenance queue; pg-boss dedupes by name.
if (env.WORKER_QUEUES.includes('maintenance')) await scheduleMaintenance(boss);
```

```ts
// The one path every step takes.
async function runStep(ctx, registry, { stepId, attempt }: StepJob) {
  const owner = `${os.hostname()}:${process.pid}:${ctx.bootId}`;

  // Claim: conditional UPDATE, so a duplicate doorbell is a no-op rather than a double run.
  const claimed = await ctx.db.execute(sql`
    UPDATE run_steps SET state='running', lease_owner=${owner},
           heartbeat_at=now(), started_at=COALESCE(started_at, now())
    WHERE id=${stepId} AND state IN ('ready','awaiting_external') AND attempt=${attempt}
    RETURNING *`);
  if (!claimed.rowCount) return;                  // someone else has it, or it moved on

  const step = claimed.rows[0];
  return ctx.logger.withContext({ runId: step.run_id, stepId, kind: step.kind }, async () => {
    try {
      const result = await withHeartbeat(ctx, step, (signal) =>
        registry[step.kind](ctx, step, signal));
      await applyStepResult(ctx, step, result);   // done | awaiting_external | pending(NO_SLOT)
    } catch (err) {
      await onStepError(ctx, step, err);
    } finally {
      await reconcile(ctx, step.run_id);
    }
  });
}
```

| Env var | Default | Meaning |
|---|---|---|
| `WORKER_QUEUES` | `media,worker,asr.cloud,asr.poll,editorial,export,maintenance` | Comma-separated; validated against `ALL_QUEUES` |
| `WORKER_CONCURRENCY` | `1` | Multiplier over per-queue `batchSize` |
| `WORKER_HEALTH_PORT` | `8081` | `/healthz` (process alive) and `/readyz` (503 while draining) |
| `GPU_SLOTS` | `1` | Global advisory-lock slots for `diarize` |
| `LOCAL_ASR_SLOTS` | `1` | Global slots for `asr.local` |
| `DATABASE_URL_DIRECT` | = `DATABASE_URL` | Listener connection; must bypass any pooler |
| `MAX_BUCKET_WAIT_MS` | `30000` | Above this, requeue rather than sleep holding a slot |

`worker-heavy` is the same image with `WORKER_QUEUES=diarize,asr.local` and
`WORKER_CONCURRENCY=1`. One image, two commands — so the engine version in the worker always
matches what the UI thinks it is talking to.

Handler registry: one file per kind, each a thin wrapper over the phase 1–8 stage function.
A handler receives `(ctx, step, signal)` and returns a `StepResult`; it never touches pg-boss,
never calls `reconcile`, and never decides its own retry. Enforced by a lint rule banning
imports of `boss.ts` and `reconcile.ts` from `handlers/**`.

## Porting notes

| From | Lines | Treatment |
|---|---|---|
| `lib/queue.ts:52-53` `RETRYABLE` | 2 | **Verbatim as the core predicate**, wrapped by `isRetryable` which adds network codes, 408/425, `CancelledError`, and the explicit "400 is not retryable" rule. Keep the original expression visible in a comment — it is correct and the reason should travel. |
| `lib/queue.ts:55-69` `withRetry` | 15 | **Concept ported, code discarded.** In-loop `setTimeout` retries hold the process; retries are now step state with `poll_after`. Fixed `[2000,4000,8000]` becomes `POLICY` + full jitter. |
| `lib/queue.ts:35-41` `runEvents()` / `emit()` | 7 | **Shape ported verbatim** — one `EventEmitter` per process, `setMaxListeners(50)`, `.on('run', …)`. The source changes from an in-process chain to a Postgres LISTEN client. The consumer API is deliberately unchanged so the SSE route and hooks port cleanly. |
| `lib/queue.ts:112-113` comment | 2 | **Keep the comment.** "Insert per chunk rather than at the end, so a long file shows partial results as it goes and a late failure doesn't discard earlier work." That is the design rationale for `partial` runs; it belongs in `handlers/asr-chunk.ts`. |
| `lib/queue.ts:17-33` `getQueue()` / `globalForQueue` | 17 | **Must not survive.** The HMR-surviving global promise chain is the whole thing being replaced. Concurrency 1 across an entire instance is not a design, it is a laptop. |
| `lib/queue.ts:71-150` `executeRun` | 80 | **Decomposed, not ported.** Becomes `handlers/media-normalize.ts`, `plan-chunks.ts`, `asr-chunk.ts`. The `fail()` closure is replaced by `onStepError`. |
| `lib/queue.ts:126` `normalizeMyanmarText` in the insert loop | 1 | **Must not survive in that position.** Normalising in place loses `text_raw`. Normalisation is its own step (`normalize.text`) writing both columns — see the overview's normalize-text section. |
| `lib/queue.ts:74` `if (run.status !== 'queued') return` | 1 | Ported in spirit as the conditional-UPDATE claim in `runStep`. Same intent — do not execute work someone else already moved on — implemented atomically instead of read-then-act. |
| `lib/db.ts:63-66` boot sweep | 4 | **DELETE. Must not survive the port.** `UPDATE runs SET status='error' WHERE status IN ('queued','chunking','running')` at every startup is precisely the behaviour this phase exists to eliminate: it converts a restart into total data loss. Its replacement is §8. A test asserts no string matching `interrupted by server restart` exists in the repo. |
| `lib/db.ts:70` `DELETE FROM runs WHERE provider NOT IN ('google')` | 1 | **DELETE. Must not survive the port.** An unconditional destructive DELETE on every process start, cascading to segments. In a multi-provider app it would erase every Whisper run on boot. There is no defensible version of this line; provider retirement is a migration, not a startup side effect. A CI grep for `DELETE FROM runs` outside `packages/db/migrations/` fails the build. |
| `lib/db.ts:74-79` `globalForDb` HMR singleton | 6 | Concept ported for the web process's `RunEventListener` and pg pool only. |
| `app/api/jobs/[id]/stream/route.ts` | 48 | **Ported nearly verbatim** — `ReadableStream`, the `send` closure, the 15 s heartbeat, `request.signal` → `cleanup`, `runtime='nodejs'`, `dynamic='force-dynamic'`, `Cache-Control: no-cache, no-transform`. Four additions: auth before the first byte, `Last-Event-ID` replay, the 10 s flush backstop, and **`X-Accel-Buffering: no`**. Route moves from job-scoped to run-scoped. |

## Tests

Unit, Vitest, against a throwaway Postgres (`pg-mem` is not sufficient — advisory locks,
`bigserial` and `LISTEN` are all exercised; use testcontainers or a per-worker schema on a real
instance) plus `FakeClock`.

**`reconcile.test.ts`** — fixtures under `__fixtures__/dags/`:

| Case | Asserts |
|---|---|
| `linear-3-step` | Promotion happens one step at a time; exactly one send per step |
| `fan-out-8-chunks` | All 8 promote together after `plan.chunks`; `normalize.text` waits for all 8 |
| `wildcard-dependency` | `['asr.chunk','*']` resolves to 8 uuids at plan time |
| `optional-dead-does-not-fail-run` | `media.peaks` dead → run `done`, peaks `skipped` |
| `required-dead-fails-run` | `media.normalize` dead → run `failed`, dependents poisoned not hung |
| `dependency-poisoning` | A dependent of a dead required step becomes `failed`, never stays `pending` |
| `partial-run` | 1 of 8 chunks dead + 7 done → run `partial`, placeholder segment present |
| `partial-all-chunks-dead` | 8 of 8 dead → `failed`, not `partial` |
| `progress-weighting` | Weighted, not step-counted: `media.normalize` (w=8) done ≫ `media.probe` (w=1) done |
| `progress-monotonic` | Property test over 500 random transition orders: progress never decreases |
| `terminal-idempotent` | `reconcile` on a `done` run is a no-op and emits nothing |
| `concurrent-reconcile` | **CORRECTED**: 20 parallel calls → every send for a step carries the *same singleton key*. Not "one send per step" — reconcile deliberately re-rings anything already `ready` to cover the COMMIT→`sendStep` window, so several sends is the design. A second *key* is what would be a second execution. Amendment 87 |
| `send-after-commit` | A `sendStep` that throws leaves committed state intact; the next tick re-sends |
| `cancel-mid-dag` | Pending/ready → `cancelled`; running left alone; run terminal only after it drains |

**`plan.test.ts`** — `plan-batch.json`, `plan-chunked-8.json`, `plan-diarize-optional.json`,
`plan-editorial-3-passes.json`, `plan-no-diarize.json`. Assert: `planRun` called twice produces
identical row sets (idempotence); a second call with a larger `chunkCount` adds only the new
shards; `depends_on` arrays are byte-identical across both calls.

**`retry.test.ts`** — `backoffMs` respects the cap; full jitter over 10 000 samples has variance
> 0 and mean ≈ exp/2; `Retry-After: 120` beats a 4 s backoff; `Retry-After: <HTTP-date>` parses;
`Retry-After: 99999` clamps to 15 min. `isRetryable`: 429 ✓, 500 ✓, 503 ✓, 408 ✓, 400 ✗, 401 ✗,
403 ✗, 404 ✗, 413 ✗, `ECONNRESET` ✓, `CancelledError` ✗, `LeaseLostError` ✗.

**`recover.test.ts`** — `stale-heartbeat.sql` seeds a `running` step with
`heartbeat_at = now() - 5 min`: asserts `pending`, `attempt+1`, `lease_owner NULL`.
`awaiting-external.sql` seeds an `awaiting_external` step: asserts state and `external_ref`
**unchanged**, only `poll_after` moved. `stale-at-max-attempts.sql`: asserts `dead`, and
`skipped` when `optional`. `lease-stolen.test.ts`: worker A's heartbeat UPDATE returns 0 rows
after worker B claims → A aborts and writes nothing.

**`events.test.ts`** — insert-and-notify visibility: a `LISTEN`er woken by the notify can always
`SELECT` the row (proves same-transaction ordering). Coalescer: 50 `run.progress` emissions in
400 ms produce 1 row; a `run.finished` in the middle flushes immediately. Replay: write 20
events, connect with `Last-Event-ID: 12`, receive exactly 8. Out-of-order commit: two concurrent
inserts committed in reverse `seq` order still converge to the correct client state (the
snapshot property).

**`sse.route.test.ts`** — headers include `X-Accel-Buffering: no` and
`Cache-Control: no-cache, no-transform`; unauthenticated request gets 401 with a
`text/event-stream`-free body and **no** partial stream; `req.signal` abort clears both
intervals (assert with fake timers that no handle leaks).

**`rate-bucket.test.ts`** — 10 concurrent `takeTokens` on a capacity-5 bucket: total debit is
exactly 10, the last caller's wait is the largest, waits are monotonically non-decreasing.

**Integration — `worker.e2e.test.ts`** — real Postgres, real pg-boss, `MemoryObjectStore`,
recorded provider fixtures:

1. `resume-after-kill`: start an 8-chunk run, `process.exit(137)` the worker after chunk 3
   commits, restart, assert chunks 1–3 are **not** re-transcribed (fixture call counter) and the
   run completes.
2. `batch-not-rebilled`: submit a fake LRO, kill during `awaiting_external`, restart, assert
   `submitBatch` was called exactly once and polling resumed.
3. `cancel-drains`: cancel mid-chunk, assert the run reaches `cancelled` and the provider's
   `cancelBatch` was attempted.
4. `duplicate-doorbell`: send the same step job twice, assert the handler ran once.

## Verification

```bash
pnpm --filter @thibi/engine test -- queue
# 60+ tests. No skipped tests. reconcile.test.ts concurrency case must not be flaky:
pnpm --filter @thibi/engine test -- reconcile --repeat 20

# The two carry-over hazards are gone from the whole repo.
! rg -n "interrupted by server restart" --glob '!plans/**'
! rg -n "DELETE FROM runs" --glob '!packages/db/migrations/**' --glob '!plans/**'
# Handlers cannot reach the queue internals.
! rg -n "from '\.\./(boss|reconcile)'" packages/engine/src/queue/handlers/
```

Live, on a real 45-minute file:

```bash
./thibi up -d
thibi transcribe fixtures/interview-45min.m4a --lang my --diarize --json | tee run.json
RUN=$(jq -r .runId run.json)

thibi run status $RUN --watch
# Expect: a step table with kinds, states, attempts, and a weighted progress percentage
# that rises monotonically. media.normalize completes before any asr.chunk starts.
# diarize sits in 'running' on worker-heavy while asr.chunk shards proceed on worker.

# 1. Crash recovery.
docker compose kill -s SIGKILL worker         # while chunks are mid-flight
docker compose up -d worker
# Within ~90 s: the killed chunk's step shows attempt=1, state=pending, then running.
# Chunks that had already committed stay 'done'. The run finishes.
psql -c "SELECT kind, shard, state, attempt FROM run_steps WHERE run_id='$RUN' ORDER BY ordinal, shard;"

# 2. batchRecognize is not re-billed.
thibi transcribe fixtures/2hr.mp3 --lang my --mode batch --json | jq -r .runId   # → $BRUN
psql -c "SELECT state, external_ref FROM run_steps WHERE run_id='$BRUN' AND kind='asr.batch.submit';"
#   awaiting_external | projects/…/operations/…
docker compose restart worker
psql -c "SELECT state, external_ref, attempt FROM run_steps WHERE run_id='$BRUN' AND kind='asr.batch.submit';"
#   IDENTICAL row. attempt unchanged. This is the assertion that matters most in the phase.

# 3. SSE.
curl -N -H "Cookie: $COOKIE" http://localhost:3000/api/runs/$RUN/stream | head -40
# Expect `id: <n>` on every event, `: ping` every 15 s, first bytes within ~1 s.
curl -sI -H "Cookie: $COOKIE" http://localhost:3000/api/runs/$RUN/stream | grep -i x-accel
#   X-Accel-Buffering: no
curl -N -H "Cookie: $COOKIE" -H "Last-Event-ID: 5" http://localhost:3000/api/runs/$RUN/stream | head -3
#   First event has id: 6.
# Through Caddy — this is where buffering actually bites:
curl -N https://$PUBLIC_HOST/api/runs/$RUN/stream | ts | head -20
#   Timestamps must be spread across the run, not all printed at the end.

# 4. Cancellation.
thibi transcribe fixtures/2hr.mp3 --lang my --json | jq -r .runId   # → $CRUN
sleep 30 && thibi run cancel $CRUN
psql -c "SELECT state FROM runs WHERE id='$CRUN';"   # cancelled, within ~10 s
psql -c "SELECT kind, state FROM run_steps WHERE run_id='$CRUN';"  # no 'running' left

# 5. Global slots.
docker compose up -d --scale worker-heavy=3
# Start three diarize runs. Exactly one 'diarize' step is 'running' at any instant:
watch -n2 "psql -tAc \"SELECT count(*) FROM run_steps WHERE kind='diarize' AND state='running'\""
#   Never exceeds GPU_SLOTS. The other two sit 'pending' with attempt UNCHANGED.

# 6. Dead letter.
curl -s -H "Cookie: $ADMIN" localhost:3000/api/admin/queue?state=dead | jq '.[0]'
# Contains kind, error.message, input — and NO api keys, tokens or credentials.

# 7. Drain.
time docker compose stop worker
# Exits well under 120 s during a chunked run; logs "graceful stop complete".
```

## Risks and open questions

1. **pg-boss version churn.** v10 renamed queues to first-class objects and changed `work()`'s
   signature from v9. Pin an exact version, keep every call behind the `Doorbell` interface, and
   put the pg-boss version in `/admin/system`. The interface is also the cut-list escape hatch.
2. **`bigserial` out-of-order commit.** Mitigated by the snapshot-event design (§11) rather than
   by a gapless sequence, which would require serialising all event writes. If a future event
   kind genuinely needs delta semantics, it needs a different mechanism — flag it in review.
3. **Advisory-lock slots need a dedicated pooled client.** If `ctx.db` is a Drizzle pool without
   `acquireDedicatedClient`, this silently degrades to no limiting at all: the lock is taken and
   released as the client bounces around the pool. Assert in a test that the same backend PID
   holds the lock for the step's duration (`SELECT pg_backend_pid()` before and after).
4. **90-second heartbeat window vs. slow ffmpeg.** A `loudnorm` two-pass on a 3-hour file on a
   2-vCPU box may block the event loop long enough to miss heartbeats if ffmpeg is ever run
   synchronously. It is spawned as a child process, so this should not happen — but the
   heartbeat is a `setInterval` on the same loop as everything else. Watch for `HEARTBEAT_LOST`
   on healthy runs; if seen, move the heartbeat to a `worker_threads` timer.
5. **Open: should `editorial.pass` steps live on the run's DAG at all?** They are on-demand and
   can be re-run independently. Modelled here as optional steps on the run, which keeps one
   timeline. The alternative — a separate lightweight DAG per `editorial_passes` row — is
   cleaner for re-runs but doubles the reconciler. Decide before phase 12 wires the UI; the
   current choice is deliberate and revisitable because `optional: true` steps do not affect
   run terminality.
6. **Open: `partial` and export.** Should an export of a `partial` run require an explicit
   acknowledgement? A newsroom exporting subtitles that silently omit 55 seconds is a real
   editorial hazard. Recommendation: exports from `partial` runs carry a warning in the response
   and, for docx/md, a visible note in the document. Confirm with the first partner newsroom.
7. **Clock skew** between containers would corrupt the heartbeat sweep. Every timestamp in this
   phase is `now()` evaluated **in Postgres**, never `new Date()` in Node, for exactly this
   reason. `ctx.clock.now()` is used only for values that are compared in application code.

## Definition of done

- [ ] `run_steps`, `run_events`, `rate_buckets` migrated; `UNIQUE (run_id, kind, shard)` present with `shard NOT NULL DEFAULT -1`.
- [ ] `runs.state` includes `partial`; `segments.placeholder_reason` exists.
- [ ] Every `sendStep` passes `retryLimit: 0`; raw `boss.send` is not exported from `boss.ts`.
- [ ] `planRun` is idempotent — running it twice on the same run changes zero rows.
- [ ] `reconcile` is the only writer of `runs.state` / `runs.progress` and the only caller of `sendStep` (enforced by lint).
- [ ] Killing `worker` with SIGKILL mid-chunk loses at most one chunk and the run completes.
- [ ] Killing `worker` during `batchRecognize` does not re-submit: `submitBatch` call count stays 1.
- [ ] A `diarize` failure on a `--diarize` best-effort run yields a `done` run with `skipped` diarization, not a failed run.
- [ ] One dead chunk out of eight yields `partial` with a placeholder segment and a working per-chunk retry.
- [ ] `thibi run cancel` reaches terminal state within 10 s for pending work and at the next chunk boundary for running work.
- [ ] SSE emits `id:` on every event, replays from `Last-Event-ID`, heartbeats at 15 s, flushes at 10 s, and sets `X-Accel-Buffering: no`.
- [ ] Progress observed through Caddy updates continuously, not in one burst at the end.
- [ ] `PROGRESS_TRANSPORT=poll` works end to end and is covered in CI.
- [ ] `--scale worker-heavy=3` never runs more than `GPU_SLOTS` diarize steps; slot contention does not consume `attempt`.
- [ ] `/api/admin/queue` lists dead steps with error and input, and retry/skip work.
- [ ] `lib/db.ts:63-66` and `lib/db.ts:70` have no analogue anywhere in the repo; the CI greps pass.
- [ ] `stop_grace_period: 120s` on both worker services; `docker compose stop worker` drains cleanly.
- [ ] `apps/worker` fails fast on an unknown `WORKER_QUEUES` entry.
- [ ] The phase-10 auth shim is the only `TODO(phase-10)` remaining and is referenced from the phase-10 plan.

---
