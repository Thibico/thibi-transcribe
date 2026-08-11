/**
 * S8 — drive the real sidecar end to end: upload to MinIO, presign, POST, poll.
 *
 * The first real diarization this project ran. S6 measured pyannote's *speed* and said
 * plainly that it did not check whether the speakers were right; feeding the result to
 * `s7-score.mjs` against `s7-make-2spk.mjs`'s reference is what closes that gap, and using
 * the same scorer is what makes the number comparable to S7's hosted model.
 *
 * Audio goes through MinIO rather than a local path, because the presigned-URL hop is part
 * of what is being tested — and it is where the first failure was.
 *
 *   node spikes/s8-run-sidecar.mjs OUTDIR clip.flac idempotency-key
 *
 * Run it from `packages/storage`, whose node_modules has the AWS SDK this imports.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const OUT = process.argv[2];
const CLIP = process.argv[3] ?? 'en-2spk.flac';
const KEY = process.argv[4] ?? `probe-${CLIP}`;
const ROOT = '/Users/yan/Coding_work/thibi-transcribe';
process.loadEnvFile(resolve(ROOT, '.env'));

const bytes = readFileSync(resolve(OUT, CLIP));
const durationMs = Math.round(Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', resolve(OUT, CLIP)]).toString().trim()) * 1000);

// Upload through the repo's own storage port so the presigned URL is minted exactly the
// way PyannoteSource mints it.
const { S3ObjectStore } = await import('@thibi/storage');
const { S3Client } = await import('@aws-sdk/client-s3');
const mk = (endpoint) => new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
// Two clients, and this is the finding rather than a workaround. SigV4 signs the Host
// header, so a URL minted against localhost:9000 is rejected 403 by MinIO when the sidecar
// requests it as minio:9000. `signingClient` exists for the mirror-image case (public URL
// through Caddy, Phase 10) and nothing sets it for the internal one.
const store = new S3ObjectStore({
  bucket: process.env.S3_BUCKET,
  client: mk(process.env.S3_ENDPOINT),
  signingClient: mk('http://minio:9000'),
});
const key = `probe/${CLIP}`;
await store.put(key, bytes, { contentType: 'audio/flac' });
// http://minio:9000 is what the sidecar can reach on the compose network; the host client
// talks to localhost:9000. Rewrite the host, keep the signature — it signs the path, not
// the authority.
const presigned = (await store.presignGet(key, 3600));

const post = await fetch('http://localhost:8081/v1/diarize', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ idempotency_key: KEY, audio_url: presigned, expected_duration_ms: durationMs, deadline_s: 7200 }),
});
console.log('POST', post.status, JSON.stringify(await post.clone().json()));
const { task_id } = await post.json();

const started = Date.now();
let status;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  status = await (await fetch(`http://localhost:8081/v1/tasks/${task_id}`)).json();
  process.stdout.write(`\r  ${status.state} ${status.progress != null ? (status.progress*100).toFixed(0)+'%' : ''}   ${((Date.now()-started)/1000).toFixed(0)}s      `);
  if (['succeeded','failed','cancelled','lost'].includes(status.state)) break;
}
console.log();
writeFileSync(resolve(OUT, `real-${CLIP}.json`), JSON.stringify(status, null, 2) + '\n');
if (status.state !== 'succeeded') { console.log(JSON.stringify(status.error)); process.exit(1); }

const r = status.result;
console.log(`speakers ${r.num_speakers}  turns ${r.turns.length}  compute ${(r.compute_ms/1000).toFixed(1)}s  rtf ${r.realtime_factor}x  device ${r.device}`);
