import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { runs } from './runs.js';

/**
 * The progress log the browser replays from.
 *
 * **Events are idempotent state snapshots, never deltas.** `run.progress` carries the
 * absolute progress and state; `step.state` carries the step's whole row. This is a
 * deliberate design choice that buys away a real hazard: `bigserial` values are allocated
 * *before* commit, so two concurrent inserts can commit out of order, and a reader tracking
 * `seq > last` can skip a row that was assigned a lower `seq` but became visible later.
 * With snapshots, an out-of-order or duplicated delivery is harmless — the client's
 * last-write-wins reducer converges. With deltas (`chunksDone += 1`) it is a permanently
 * wrong progress bar that nothing ever corrects.
 *
 * Do not add a delta event kind without revisiting this paragraph.
 *
 * Pruning is safe: the run timeline UI reads `run_steps`, not this table, so a pruned event
 * log loses nothing a user can see. Say that wherever retention is configured, so nobody
 * "fixes" it by retaining forever.
 */
export const runEvents = pgTable(
  'run_events',
  {
    /**
     * `bigserial`. It is the SSE `id:` field, so `EventSource` hands it back as
     * `Last-Event-ID` on reconnect and replay is a `seq >` scan. Monotonic per run is all
     * that is required; gapless is not, and buying gaplessness would mean serialising every
     * event write.
     *
     * `mode: 'number'` is safe here for the same reason it is on `words.id`: the client
     * parses these as JS numbers and 2^53 events is not a quantity this project reaches.
     */
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    /** `run.progress` | `run.finished` | `run.cancelling` | `step.*` | `chunk.done` | `log` */
    kind: text('kind').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_events_run_seq').on(t.runId, t.seq)],
);

export type RunEventRow = typeof runEvents.$inferSelect;
