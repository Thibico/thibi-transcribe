/**
 * Inspect a long-running operation by name. Used to confirm S3 point 4: an operation
 * survives a client disconnect, so killing the poller and resuming ten minutes later
 * costs nothing and is not re-billed. The whole "long async steps never hold a worker
 * slot" design depends on that being true.
 *
 *   node spikes/get-operation.mjs projects/.../operations/...
 */
import { accessToken, env } from "./lib.mjs";
const { region } = env;
const token = await accessToken();
const r = await fetch(`https://${region}-speech.googleapis.com/v2/${process.argv[2]}`,
  { headers: { Authorization: `Bearer ${token}` } });
console.log(JSON.stringify(JSON.parse(await r.text()), null, 2).slice(0, 2500));
