import { sql } from 'drizzle-orm';
import type { Db } from '@thibi/db';
import { POLICY } from './retry.js';
import { routeOf, WEIGHT, type QueueName, type StepKind } from './queues.js';

/**
 * The spec half of `runs.pipeline` — what the DAG *should* be.
 *
 * It shares a column with runtime state (`planReason`, and `batch` holding the whole
 * `BatchOp` with its latency, billed duration and poll count), which is why **every writer of
 * that column must merge rather than replace**. `persistResult` originally did
 * `SET pipeline = $4` and silently deleted all of it; it was found by querying
 * `pipeline->'batch'` after the first successful live run and getting null. The rule this
 * phase inherits: `||` to merge a whole object, `jsonb_set` for a nested key, never a bare
 * assignment.
 */
export interface PipelineSpec {
  asr: {
    providerId: string;
    model: string;
    mode: 'sync' | 'sync_chunked' | 'batch';
    /** faster-whisper on this box, which routes ASR to the GPU-contended queue. */
    local: boolean;
    /**
     * How much earlier each chunk starts than its boundary, for the seam merge. 0 disables it.
     *
     * On the spec rather than a constant in the handler because it is a property of *this run*:
     * a run planned with no overlap must still assemble with no overlap when `normalize.text`
     * picks it up in a different process, possibly after a redeploy that changed the default.
     */
    overlapMs?: number;
  };
  diarize?: {
    providerId: string;
    required: boolean;
    /**
     * What the caller knows about how many people are talking, passed to the diarizer.
     *
     * On the spec rather than taken from a flag at execution time because it is a property of
     * *this run*: a run planned with `numSpeakers: 2` must still be submitted that way when
     * `diarize` is picked up by a different process, possibly days later after a redeploy.
     */
    hints?: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number };
  };
  editorial: Array<{ kind: 'cleanup' | 'translate' | 'entities' | 'document'; targetLang?: string }>;
  peaks: boolean;
  exports: Array<{ format: string; layer: string; targetLang?: string }>;
}

/** `'*'` means every shard of that kind, resolved once at plan time and never again. */
export type DependencyRef = readonly [StepKind, number | '*'];

export interface StepSpec {
  kind: StepKind;
  ordinal: number;
  /** `-1` when unsharded. See the column comment in `run-steps.ts` for why not NULL. */
  shard: number;
  queue: QueueName;
  dependsOn: DependencyRef[];
  optional: boolean;
  weight: number;
  maxAttempts: number;
  /** Key **names** for anything secret, never values. `/admin/queue` renders this. */
  input: Record<string, unknown>;
}

/**
 * Materialise a pipeline spec into a list of steps.
 *
 * Pure: a function of the spec and the chunk count, with no clock, no database and no
 * randomness. That is what lets `materialisePlan` be convergent — running the planner again
 * must produce the same rows, not merely compatible ones.
 *
 * **`chunkCount` is not known when the run is created**, which is the interesting ordering
 * problem in this phase. Duration comes from `media.probe`, and a URL import has no duration
 * at all until the download finishes, so planning the whole DAG up front would mean guessing
 * and then re-planning anyway. Instead the run is planned twice: once through `plan.chunks`,
 * and again by the `plan.chunks` handler with the real count, in the same transaction that
 * writes `run_chunks`. The convergent insert makes the second call an extension of the first —
 * one code path, no special cases, and the chunk rows and the steps that consume them commit
 * together.
 *
 * **`null` means "not known yet", and it is not the same as `0`.** The first pass used to pass
 * `0`, which emitted zero `asr.chunk` shards *and* every step downstream of them — including
 * `normalize.text`, whose `['asr.chunk','*']` dependency then resolved to an empty array. A
 * step with no dependencies is a root, so the reconciler promoted it immediately, and a worker
 * assembled a transcript out of nothing before a single chunk had been cut: the run reached
 * `done` at progress 1 with zero segments while twenty `asr.chunk` steps were still queued.
 * Found on the first real file, in the first minute of the first run — no unit test could have
 * produced it, because every one of them plans with a chunk count already known.
 *
 * A wildcard over a kind that has no shards *yet* is vacuously satisfied, and `depends_on` is
 * `uuid[]` by then, so the reconciler cannot tell that from a genuine root. The planner is the
 * only place that still knows the difference, so it must not emit the step at all.
 */
export function planRun(p: PipelineSpec, chunkCount: number | null): StepSpec[] {
  const out: Array<Omit<StepSpec, 'ordinal'>> = [];

  const add = (s: Partial<StepSpec> & Pick<StepSpec, 'kind'>): void => {
    out.push({
      shard: -1,
      queue: routeOf(s.kind),
      dependsOn: [],
      optional: false,
      weight: WEIGHT[s.kind],
      maxAttempts: POLICY[s.kind].maxAttempts,
      input: {},
      ...s,
    });
  };

  add({ kind: 'media.probe' });
  add({ kind: 'media.normalize', dependsOn: [['media.probe', -1]] });
  if (p.peaks) {
    add({ kind: 'media.peaks', dependsOn: [['media.normalize', -1]], optional: true });
  }
  add({ kind: 'plan.chunks', dependsOn: [['media.normalize', -1]] });

  const asrQueue: QueueName = p.asr.local ? 'asr.local' : 'asr.cloud';
  let asrLeaves: DependencyRef[];

  /**
   * The first pass stops here on the chunked paths.
   *
   * Nothing below can be planned without knowing how many shards there are: every step past
   * this point depends, directly or through `normalize.text`, on `['asr.chunk','*']`. The
   * `batch` path is exempt because its ASR steps are not sharded at all — the count it does not
   * know is not one it needs.
   *
   * **`diarize` is caught by this too, and it costs a little parallelism.** That step depends
   * only on `media.normalize`, so nothing about it needs a chunk count — but it is emitted
   * after the early return, so on a chunked run it is not created until `plan.chunks` has
   * committed. In DAG terms it still starts the moment its dependency is satisfied; in wall
   * clock it starts one short step later than it could. Left alone rather than hoisted above
   * the return: splitting the planner's output into "before the count is known" and "after"
   * by anything other than that one condition is how the two passes stop being the same code
   * path, which is the property that makes `materialisePlan` convergent. `plan.chunks` is
   * seconds against a diarization measured in hours.
   */
  if (chunkCount === null && p.asr.mode !== 'batch') {
    return out.map((s, ordinal) => ({ ...s, ordinal }));
  }
  const shards = chunkCount ?? 0;

  if (p.asr.mode === 'batch') {
    add({ kind: 'asr.batch.submit', queue: asrQueue, dependsOn: [['plan.chunks', -1]] });
    add({ kind: 'asr.poll', dependsOn: [['asr.batch.submit', -1]] });
    add({ kind: 'asr.fetch', queue: asrQueue, dependsOn: [['asr.poll', -1]] });
    add({ kind: 'staging.cleanup', dependsOn: [['asr.fetch', -1]], optional: true });
    asrLeaves = [['asr.fetch', -1]];
  } else {
    for (let i = 0; i < shards; i++) {
      add({
        kind: 'asr.chunk',
        shard: i,
        queue: asrQueue,
        dependsOn: [['plan.chunks', -1]],
        input: { chunkIdx: i },
      });
    }
    asrLeaves = [['asr.chunk', '*']];
  }

  /**
   * Diarization consumes the *same* normalized derivative as ASR and runs beside it, never
   * after it. It is ~0.6× realtime on CPU — 1 h 40 m on a one-hour interview, against about a
   * minute for the ASR — so gating the transcript on it would mean nobody sees a word for an
   * hour and a half.
   */
  if (p.diarize) {
    const optional = !p.diarize.required;
    add({
      kind: 'diarize',
      optional,
      dependsOn: [['media.normalize', -1]],
      input: {
        providerId: p.diarize.providerId,
        ...(p.diarize.hints ? { hints: p.diarize.hints } : {}),
      },
    });
    add({ kind: 'diarize.poll', optional, dependsOn: [['diarize', -1]] });
    add({
      kind: 'reconcile.speakers',
      optional: true,
      dependsOn: [...asrLeaves, ['diarize.poll', -1]],
    });
  }

  add({ kind: 'normalize.text', dependsOn: asrLeaves });

  p.editorial.forEach((e, i) => {
    add({
      kind: 'editorial.pass',
      shard: i,
      optional: true,
      dependsOn: [['normalize.text', -1]],
      input: { pass: e },
    });
  });

  p.exports.forEach((e, i) => {
    add({
      kind: 'export',
      shard: i,
      optional: true,
      dependsOn: [['normalize.text', -1]],
      input: { export: e },
    });
  });

  return out.map((s, ordinal) => ({ ...s, ordinal }));
}

/** What the two SQL statements below consume. Shapes the `jsonb_to_recordset` columns. */
interface SpecRow {
  kind: string;
  ordinal: number;
  shard: number;
  queue: string;
  optional: boolean;
  weight: number;
  max_attempts: number;
  input: Record<string, unknown>;
  depends_on: Array<{ dep_kind: string; dep_shard: string }>;
}

function toSpecRows(specs: StepSpec[]): SpecRow[] {
  return specs.map((s) => ({
    kind: s.kind,
    ordinal: s.ordinal,
    shard: s.shard,
    queue: s.queue,
    optional: s.optional,
    weight: s.weight,
    max_attempts: s.maxAttempts,
    input: s.input,
    depends_on: s.dependsOn.map(([kind, shard]) => ({
      dep_kind: kind,
      dep_shard: String(shard),
    })),
  }));
}

/** Anything with `execute`: the pool, or a transaction handle. */
type Executor = Pick<Db, 'execute'>;

/**
 * Write the plan to `run_steps`, convergently.
 *
 * Safe to call as many times as you like, on a fresh run or a half-planned one. Two
 * statements, and the second is where `'*'` is resolved — which is why `depends_on` is
 * `uuid[]` rather than a natural key. Resolution happens once, here, and the reconciler
 * never has to re-expand a wildcard on the hot path.
 */
export async function materialisePlan(
  tx: Executor,
  runId: string,
  specs: StepSpec[],
): Promise<void> {
  if (specs.length === 0) return;
  const payload = JSON.stringify(toSpecRows(specs));

  /**
   * `do update set ordinal` rather than `do nothing`, guarded so it writes only on a change.
   *
   * Ordinal order is a topological order of the DAG, and `reconcile` relies on it to promote a
   * whole chain in one pass. The second planning pass inserts the `asr.chunk` shards *between*
   * `plan.chunks` and `normalize.text`, so every ordinal after the shards moves — and under a
   * bare `DO NOTHING` the already-inserted rows kept the ordinals of the first pass. Observed on
   * the first real run: `normalize.text` and `asr.chunk` shard 0 both sat at ordinal 3.
   *
   * The `where` is what keeps planning idempotent. An unconditional `DO UPDATE` rewrites every
   * row on every call, which advances `xmin` and fails the idempotence tests — the reason those
   * tests assert on `xmin` rather than on column values in the first place.
   */
  await tx.execute(sql`
    insert into run_steps (run_id, kind, ordinal, shard, queue, optional, weight, max_attempts, input)
    select ${runId}::uuid, x.kind, x.ordinal, x.shard, x.queue, x.optional, x.weight,
           x.max_attempts, x.input
    from   jsonb_to_recordset(${payload}::jsonb) as x(
             kind text, ordinal int, shard int, queue text,
             optional boolean, weight int, max_attempts int, input jsonb)
    on conflict (run_id, kind, shard) do update
      set ordinal = excluded.ordinal
      where run_steps.ordinal is distinct from excluded.ordinal
  `);

  /**
   * `array_agg(dep.id order by dep.id)` — the ordering is load-bearing and the phase-9 plan's
   * sketch omitted it. Without it Postgres may aggregate a wildcard's matches in any order,
   * so re-planning an unchanged run rewrites `depends_on` with the same eight uuids in a
   * different sequence. The `is distinct from` guard would then not suppress the update,
   * planning would stop being a no-op, and the idempotence test the plan itself specifies
   * ("`depends_on` arrays are byte-identical across both calls") would fail intermittently —
   * the worst possible way for it to fail, because it would pass on most runs.
   *
   * `left join lateral … on true` rather than `cross join lateral`: a step with no
   * dependencies must still appear in `resolved`, so its empty array is asserted rather than
   * merely defaulted. Otherwise a step whose `depends_on` was somehow wrong could never be
   * corrected by re-planning.
   */
  await tx.execute(sql`
    with spec as (
      select x.kind, x.shard, d.dep_kind, d.dep_shard
      from   jsonb_to_recordset(${payload}::jsonb) as x(kind text, shard int, depends_on jsonb)
      left join lateral jsonb_to_recordset(x.depends_on)
             as d(dep_kind text, dep_shard text) on true
    ),
    resolved as (
      select s.kind, s.shard, array_remove(array_agg(dep.id order by dep.id), null) as deps
      from   spec s
      left join run_steps dep
             on dep.run_id = ${runId}::uuid
            and dep.kind   = s.dep_kind
            and (s.dep_shard = '*' or dep.shard = s.dep_shard::int)
      group by s.kind, s.shard
    )
    update run_steps t set depends_on = r.deps
    from   resolved r
    where  t.run_id = ${runId}::uuid and t.kind = r.kind and t.shard = r.shard
      and  t.depends_on is distinct from r.deps
  `);
}
