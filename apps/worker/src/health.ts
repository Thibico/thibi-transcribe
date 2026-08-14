import { createServer, type Server } from 'node:http';
import type { Logger } from '@thibi/engine';

export interface HealthState {
  /** SIGTERM received: finish what is in flight, accept nothing new. */
  draining: boolean;
  /** The doorbell is connected and the queues are subscribed. */
  ready: boolean;
}

/**
 * `/healthz` and `/readyz`, and the difference between them is the whole point.
 *
 * `/healthz` answers "is this process alive" — it stays 200 through a drain, because a
 * draining worker is not broken and restarting it would abandon the chunk it is finishing.
 * `/readyz` answers "should this process be given work", and goes 503 the moment SIGTERM
 * arrives so an orchestrator stops routing to it before the drain begins.
 *
 * Conflating them is how a rolling deploy kills a worker mid-transcription: a health check
 * that fails during a drain gets the container SIGKILLed at once, and the graceful stop that
 * exists to lose at most one chunk never runs.
 */
export function startHealthServer(
  port: number,
  state: () => HealthState,
  logger: Logger,
): Promise<Server> {
  const server = createServer((req, res) => {
    const now = state();
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', draining: now.draining }));
      return;
    }
    if (req.url === '/readyz') {
      const ok = now.ready && !now.draining;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ready' : 'not-ready', ...now }));
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      logger.info({ port }, 'health server listening');
      resolve(server);
    });
  });
}
