import { describe, expect, it } from 'vitest';
import { ALL_QUEUES, LIGHT_QUEUES } from '@thibi/engine';
import { parseWorkerEnv, WorkerEnvError } from '../env.js';

describe('parseWorkerEnv', () => {
  it('serves the light queues by default', () => {
    expect(parseWorkerEnv({}).queues).toEqual([...LIGHT_QUEUES]);
  });

  it('refuses a queue name that does not exist, and says which do', () => {
    // The failure this guards against is the quietest in the phase: a typo produces a worker
    // that starts cleanly, reports healthy and does nothing, while the queue it was meant to
    // serve shows depth 0 and its steps sit `ready` forever.
    expect(() => parseWorkerEnv({ WORKER_QUEUES: 'media,asr-cloud' })).toThrow(WorkerEnvError);
    try {
      parseWorkerEnv({ WORKER_QUEUES: 'media,asr-cloud' });
    } catch (err) {
      expect((err as Error).message).toContain('asr-cloud');
      expect((err as WorkerEnvError).hint).toContain('asr.cloud');
    }
  });

  it('names every unknown queue, not just the first', () => {
    try {
      parseWorkerEnv({ WORKER_QUEUES: 'nope,media,alsonope' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('nope');
      expect((err as Error).message).toContain('alsonope');
      expect((err as Error).message, 'plural, because two are wrong').toContain('queues that do not');
    }
  });

  it('refuses an empty list rather than serving nothing', () => {
    // `WORKER_QUEUES=` is a plausible way to write "defaults", and it would instead produce a
    // worker subscribed to nothing that still reports ready.
    expect(() => parseWorkerEnv({ WORKER_QUEUES: ' , ' })).toThrow(/would subscribe to nothing/);
  });

  it('tolerates whitespace around names', () => {
    expect(parseWorkerEnv({ WORKER_QUEUES: ' media , diarize ' }).queues).toEqual([
      'media',
      'diarize',
    ]);
  });

  it('accepts the heavy set a worker-heavy container runs', () => {
    expect(parseWorkerEnv({ WORKER_QUEUES: 'diarize,asr.local' }).queues).toEqual([
      'diarize',
      'asr.local',
    ]);
  });

  it('knows every queue that exists', () => {
    expect(parseWorkerEnv({ WORKER_QUEUES: ALL_QUEUES.join(',') }).queues).toEqual([...ALL_QUEUES]);
  });

  it('defaults the numbers, and rejects nonsense rather than coercing it', () => {
    const d = parseWorkerEnv({});
    expect(d.concurrency).toBe(1);
    // 8090, not the plan's 8081: that is the sidecar's port in this repo's own dev compose,
    // so the plan's default made the worker refuse to start on any box that can diarize.
    expect(d.healthPort).toBe(8090);
    expect(d.gpuSlots).toBe(1);
    expect(d.localAsrSlots).toBe(1);
    expect(d.maxBucketWaitMs).toBe(30_000);

    // `Number('two')` is NaN and `Number('')` is 0; both would silently become a worker with
    // no concurrency or a health server on port 0.
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: 'two' })).toThrow(WorkerEnvError);
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: '0' })).toThrow(WorkerEnvError);
    expect(() => parseWorkerEnv({ GPU_SLOTS: '1.5' })).toThrow(/non-negative integer/);
  });

  it('allows zero GPU slots, which is how a box says it has no GPU', () => {
    expect(parseWorkerEnv({ GPU_SLOTS: '0' }).gpuSlots).toBe(0);
  });

  it('falls back to DATABASE_URL for the listener, but prefers the direct one', () => {
    // PgBouncer in transaction pooling mode cannot carry LISTEN: the connection is handed to
    // another client between statements, and the symptom is a progress bar that never moves.
    expect(parseWorkerEnv({ DATABASE_URL: 'postgres://a' }).databaseUrlDirect).toBe('postgres://a');
    expect(
      parseWorkerEnv({ DATABASE_URL: 'postgres://pooled', DATABASE_URL_DIRECT: 'postgres://direct' })
        .databaseUrlDirect,
    ).toBe('postgres://direct');
  });
});
