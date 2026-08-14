import { describe, expect, it } from 'vitest';
import {
  ALL_QUEUES,
  HEAVY_QUEUES,
  LIGHT_QUEUES,
  ROUTE,
  STEP_KINDS,
  SUBSCRIPTIONS,
  WEIGHT,
  isQueueName,
  isStepKind,
  routeOf,
} from '../queues.js';

/**
 * These look like tautologies and are not. Four tables have to agree about the set of queues —
 * the routing table, the subscription settings, and the two containers' queue sets — and the
 * phase-9 plan they come from disagreed with itself: its step-kind table routes
 * `normalize.text` and `reconcile.speakers` to a `worker` queue that its queue table, its
 * SUBSCRIPTIONS map and its default WORKER_QUEUES all omit.
 *
 * The consequence is not a crash. Every run would plan two steps onto a queue no container
 * subscribes to; they would sit `ready` forever, the queue would report depth 0, and the run
 * would simply never finish. That is the single hardest failure in this phase to diagnose from
 * the outside, and it is a one-word omission away at all times.
 */
describe('queue tables', () => {
  it('routes every step kind to a queue that exists', () => {
    for (const kind of STEP_KINDS) {
      expect(ALL_QUEUES, `${kind} routes to ${ROUTE[kind]}`).toContain(routeOf(kind));
    }
  });

  it('gives every queue a subscription', () => {
    // A queue with no entry gets `undefined.batchSize` at worker startup.
    expect(Object.keys(SUBSCRIPTIONS).sort()).toEqual([...ALL_QUEUES].sort());
  });

  it('has some container subscribed to every queue', () => {
    // The assertion that would have caught the plan's `worker` gap.
    const served = new Set([...LIGHT_QUEUES, ...HEAVY_QUEUES]);
    for (const q of ALL_QUEUES) {
      expect(served.has(q), `no container subscribes to "${q}" — its steps would sit ready forever`).toBe(true);
    }
  });

  it('never puts the same queue on both containers', () => {
    // The split is the whole point: a 1 h 40 m pyannote job must not be able to take a slot
    // that sub-second poll work needs.
    const overlap = LIGHT_QUEUES.filter((q) => HEAVY_QUEUES.includes(q));
    expect(overlap).toEqual([]);
  });

  it('keeps every long-running kind off the poll queue and every poll on it', () => {
    expect(routeOf('asr.poll')).toBe('asr.poll');
    expect(routeOf('diarize.poll')).toBe('asr.poll');
    expect(routeOf('diarize'), 'the work itself belongs on the heavy container').toBe('diarize');
  });

  it('weights every step kind', () => {
    expect(Object.keys(WEIGHT).sort()).toEqual([...STEP_KINDS].sort());
    // diarize.poll is 0 deliberately: its weight is folded into `diarize`, because the pair is
    // one piece of work to anyone watching and counting the poll separately would make
    // diarization appear to finish twice.
    expect(WEIGHT['diarize.poll']).toBe(0);
    expect(Object.values(WEIGHT).every((w) => w >= 0)).toBe(true);
  });

  it('narrows strings the database hands back', () => {
    // `run_steps.kind` and `.queue` are text columns written by hand-rolled SQL, so a value
    // read back is a string until something checks it.
    expect(isStepKind('asr.chunk')).toBe(true);
    expect(isStepKind('asr.chunks')).toBe(false);
    expect(isQueueName('worker')).toBe(true);
    expect(isQueueName('workers')).toBe(false);
  });
});
