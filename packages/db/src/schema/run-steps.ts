import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { runs } from './runs.js';

/**
 * The state machine, as a real Postgres enum rather than the `text(…, { enum })` this
 * schema uses everywhere else.
 *
 * The divergence is deliberate and this table is the one place it is earned. Drizzle's
 * `enum` option is a TypeScript constraint and nothing more — the column is plain `text`
 * and the database will accept any string. That is fine for `runs.state`, which only ever
 * moves through Drizzle. `run_steps` is different: the planner inserts through
 * `jsonb_to_recordset`, the recovery sweep writes with a hand-written `UPDATE … CASE`, and
 * the reconciler casts. None of those paths see a TypeScript type, so a typo'd state in
 * hand-written SQL would be stored and then never match any predicate — a step that is
 * neither live nor terminal, invisible to both the reconciler and `/admin/queue`.
 *
 * The cost is that adding a state is a migration. That is the right price for a column
 * whose whole job is to be exhaustively matched.
 */
export const stepState = pgEnum('step_state', [
  /** Created; dependencies not yet satisfied, or waiting out a retry backoff. */
  'pending',
  /** Dependencies satisfied and the doorbell rung. */
  'ready',
  /** A worker holds a lease and is heartbeating. */
  'running',
  /**
   * Work is happening at a provider. **Not a lease state**: no heartbeat, no `lease_owner`,
   * and the recovery sweep never resets it. Resetting one re-submits and re-bills.
   */
  'awaiting_external',
  'done',
  /** An optional step whose precondition was absent, or whose failure the run survives. */
  'skipped',
  /** Terminal and run-fatal. */
  'failed',
  /** Exhausted `max_attempts`. This state *is* the dead-letter queue; see phase 9 §12. */
  'dead',
  'cancelled',
]);

/**
 * `kind` is `text`, not an enum, on purpose — the opposite call from `state` above and for
 * the opposite reason. States are matched exhaustively by code that must handle every one;
 * kinds are dispatched through a handler registry keyed by string. Adding a step kind
 * should be a code change, not a migration, and `UNIQUE (run_id, kind, shard)` does not
 * care what the domain is.
 */

/**
 * One node of a run's pipeline DAG.
 *
 * **This table is the source of truth. pg-boss holds no state that matters.** Deleting the
 * pg-boss tables and restarting must lose nothing but latency. Everything a queue library
 * would normally own — attempt counts, backoff, dependencies, cancellation, dead-lettering
 * — lives in these columns, because all of it is something a newsroom admin needs to *see*
 * next to the step that failed. A retry count buried in `pgboss.job.retrycount` is a retry
 * count nobody can render.
 */
export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    /** Planner order. Display order on the timeline; carries no execution meaning. */
    ordinal: integer('ordinal').notNull(),

    /**
     * `-1` for an unsharded step, and `NOT NULL` is the whole point.
     *
     * In Postgres `NULL <> NULL`, so a unique index over a nullable `shard` deduplicates
     * nothing: every planner invocation would insert another `media.normalize`, and the
     * first anyone knew of it would be a container restart producing a second one. `-1` is
     * deliberate ugliness that makes the constraint real. (`NULLS NOT DISTINCT` on PG 15+
     * is the alternative; `-1` also sorts and groups without special-casing.)
     */
    shard: integer('shard').notNull().default(-1),

    queue: text('queue').notNull(),

    /**
     * Resolved to step ids at plan time, wildcards included, which is why this is `uuid[]`
     * and not a natural key: the reconciler must never have to re-expand `['asr.chunk','*']`.
     */
    dependsOn: uuid('depends_on')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    /**
     * On `dead`: become `skipped`, record why in `output.skippedBecause`, and **do not fail
     * the run**. A run whose waveform peaks failed is still a transcript. A run whose
     * diarization failed is still a transcript with every segment flagged for speaker
     * review, which is a far better outcome than discarding three hours of ASR because a
     * GPU container OOMed.
     */
    optional: boolean('optional').notNull().default(false),

    /**
     * Progress weighting. Progress is weighted, never step-counted: `media.normalize` (8)
     * finishing is worth eight times `media.probe` (1), because that is what the user
     * experiences.
     */
    weight: integer('weight').notNull().default(1),

    state: stepState('state').notNull().default('pending'),

    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),

    /**
     * **Never secrets — key names only.** `/admin/queue` renders this verbatim, and that
     * page is the specific thing the rule was written for.
     */
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    error: jsonb('error').$type<Record<string, unknown> | null>(),

    /** Google LRO name, sidecar task id. Its presence is the re-submit guard. */
    externalRef: text('external_ref'),
    pollAfter: timestamp('poll_after', { withTimezone: true }),
    /**
     * A hard two-sided deadline. Without our own, a provider that never resolves leaves a
     * step polling until the heat death of the universe.
     */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),

    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** `${hostname}:${pid}:${bootId}`. Predicating the heartbeat on it detects a stolen lease. */
    leaseOwner: text('lease_owner'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    /**
     * `doublePrecision`, matching `runs.cost_usd` and `usage_records.usd`, rather than the
     * `numeric(12,6)` the phase-9 plan sketched. A step's cost is summed into a run's, and
     * a sum that mixes `numeric` with `double precision` returns `double precision` anyway
     * — so the stricter type buys nothing here and costs consistency with every other money
     * column in the schema.
     */
    costUsd: doublePrecision('cost_usd').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The whole idempotency story.
     *
     * The planner runs on run creation, again on boot recovery, and again on every manual
     * retry, inserting `ON CONFLICT DO NOTHING`. That makes planning *convergent*: running
     * it twice produces one DAG, and running it on a half-planned run fills only the gaps.
     * Without it, a crash between "insert step 1" and "insert step 2" leaves a run that can
     * never be planned again without a bespoke repair.
     */
    uniqueIndex('run_steps_run_kind_shard').on(t.runId, t.kind, t.shard),
    index('run_steps_run_ordinal').on(t.runId, t.ordinal),
    index('run_steps_live')
      .on(t.state)
      .where(sql`${t.state} in ('ready', 'running', 'awaiting_external')`),
    index('run_steps_poll')
      .on(t.pollAfter)
      .where(sql`${t.state} = 'awaiting_external'`),
    index('run_steps_hb')
      .on(t.heartbeatAt)
      .where(sql`${t.state} = 'running'`),
    /** `/admin/queue`'s default view: the most recently dead first. */
    index('run_steps_dead')
      .on(t.finishedAt.desc())
      .where(sql`${t.state} = 'dead'`),
  ],
);

export type RunStepRow = typeof runSteps.$inferSelect;
export type StepState = (typeof stepState.enumValues)[number];
