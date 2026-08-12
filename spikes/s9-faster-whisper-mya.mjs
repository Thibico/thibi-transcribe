/**
 * S9 — is faster-whisper any better than Groq on Burmese, given they are the same weights?
 *
 * This is the measurement the 2026-08-12 handoff note named as the highest-value one in the
 * project, and the reason is amendment 51: giving faster-whisper a matrix column derived
 * from the Whisper tokenizer dropped `exclusiveTo: 'google'` from 21 to 20, because `my` has
 * a token and a `suspected` verdict leaves `supported: true`. Burmese acquired a claimant on
 * no evidence at all, and the product's own sentence weakened from "only Google works" to
 * "only Google is known to work". One measurement decides which it is.
 *
 * The expected answer is a demotion. faster-whisper serves the same `whisper-large-v3`
 * weights GroqCloud does, and Phase 4a measured those returning Myanmar-script non-words for
 * `language=my` and Vietnamese on autodetect, both at HTTP 200. **Expecting is not
 * measuring**, and a matrix row that says `measured-failure` has to be backed by output
 * somebody can look at.
 *
 * **N runs, not one.** S7 is why: `gpt-4o-transcribe-diarize` on `language=mya` returned
 * correct Myanmar script once and twenty distinct wrong-script transcripts over twenty
 * identical requests — 1 in 21. A single probe of a generative model is a coin flip
 * presented as a measurement, so this reports a distribution.
 *
 * Both language settings are probed, because they failed *differently* on Groq and the
 * difference is the interesting part: a consistent wrong-language output can be screened
 * once and trusted, while an unstable one cannot be screened at all.
 *
 *   node spikes/s9-faster-whisper-mya.mjs OUTDIR [N=5] [model=large-v3]
 *
 * Needs the sidecar up with the model pulled, and MinIO up. Runs from anywhere: the two
 * workspace imports go through `createRequire` anchored at `apps/cli`, because **ESM
 * resolves bare specifiers from the importing file's directory, not the cwd** — `spikes/`
 * has no `node_modules`, so `cd` cannot fix it and every spike header that says "run it from
 * packages/x" is wrong. `spikes/s8-run-sidecar.mjs` still says that; this is the shape that
 * actually works.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptIntegrity } from '../packages/core/dist/index.js';

const OUT = resolve(process.argv[2] ?? '.');
const N = Number(process.argv[3] ?? 5);
const MODEL = process.argv[4] ?? 'large-v3';
const ROOT = resolve(import.meta.dirname, '..');
const SIDECAR = process.env.SIDECAR_URL ?? 'http://localhost:8081';

const bytes = readFileSync(resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac'));
const scripts = JSON.parse(
  readFileSync(resolve(ROOT, 'packages/languages/data/scripts.json'), 'utf8'),
);
const MYMR = [{ code: 'Mymr', unicodeRanges: (scripts.scripts ?? scripts).Mymr.unicodeRanges }];

// Anchored at apps/cli, the one workspace that has both of these installed.
//
// `@thibi/storage` is reached by its built entry point rather than through `require.resolve`,
// because our packages declare ESM-only `exports` and CJS resolution refuses them. The AWS
// SDK has a CJS entry and resolves normally.
const req = createRequire(resolve(ROOT, 'apps/cli/package.json'));
const storageEntry = resolve(ROOT, 'apps/cli/node_modules/@thibi/storage/dist/index.js');
const { S3ObjectStore } = await import(pathToFileURL(storageEntry).href);
const { S3Client } = await import(pathToFileURL(req.resolve('@aws-sdk/client-s3')).href);
const client = (endpoint) =>
  new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'thibi',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'thibi-dev-secret',
    },
  });
// Signed for the host the *sidecar* uses. SigV4 signs Host; amendment 43.
const store = new S3ObjectStore({
  bucket: process.env.S3_BUCKET ?? 'thibi',
  client: client(process.env.S3_ENDPOINT ?? 'http://localhost:9000'),
  signingClient: client(process.env.S3_INTERNAL_ENDPOINT ?? 'http://minio:9000'),
});

const key = 's9/probe-2s.flac';
await store.put(key, bytes, { contentType: 'audio/flac' });
const audioUrl = await store.presignGet(key, 6 * 3600);

async function once(language, i) {
  // A fresh idempotency key every time — the sidecar answers a repeated key from its
  // journal in milliseconds, which would turn N runs into one run reported N times.
  const idempotencyKey = `s9:${MODEL}:${language ?? 'auto'}:${i}:${Date.now()}`;
  const post = await fetch(`${SIDECAR}/v1/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      audio_url: audioUrl,
      expected_duration_ms: 2000,
      language,
      model: MODEL,
      deadline_s: 1800,
    }),
  });
  if (!post.ok) throw new Error(`POST ${post.status}: ${(await post.text()).slice(0, 200)}`);
  const { task_id } = await post.json();

  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await (await fetch(`${SIDECAR}/v1/tasks/${task_id}`)).json();
    if (['succeeded', 'failed', 'cancelled', 'lost'].includes(status.state)) {
      if (status.state !== 'succeeded') throw new Error(JSON.stringify(status.error));
      return status.result;
    }
  }
}

const rows = [];
for (const language of ['my', null]) {
  for (let i = 0; i < N; i += 1) {
    const result = await once(language, i);
    const text = result.segments.map((s) => s.text).join('').trim();
    const integrity = scriptIntegrity(text, MYMR);
    // Every word probability the decoder emitted. The point is not the mean but whether a
    // confident number accompanies wrong output — which is the entire Groq finding.
    const probs = result.segments.flatMap((s) => s.words.map((w) => w.probability));
    const mean = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
    rows.push({
      language: language ?? 'autodetect',
      run: i,
      detected: result.language,
      detectedProbability: result.language_probability,
      text,
      scriptIntegrity: integrity.fraction,
      words: probs.length,
      meanWordProbability: mean,
      avgLogprob: result.segments[0]?.avg_logprob ?? null,
      realtimeFactor: result.realtime_factor,
      computeMs: result.compute_ms,
    });
    console.log(
      `${(language ?? 'auto').padEnd(4)} #${i}  detected=${result.language}  ` +
        // `fraction` is null when there is nothing to score — an empty transcript, which
        // is itself a result rather than an error.
        `script=${integrity.fraction === null ? 'n/a' : integrity.fraction.toFixed(2)}  ` +
        `words=${probs.length}  ` +
        `meanP=${mean === null ? 'n/a' : mean.toFixed(3)}  rtf=${result.realtime_factor}\n` +
        `      ${text === '' ? '(empty transcript)' : text.slice(0, 120)}`,
    );
  }
}

await store.delete(key);

const distinct = new Set(rows.map((r) => r.text)).size;
const summary = {
  spike: 'S9',
  question: 'Is faster-whisper usable for Burmese?',
  model: MODEL,
  clip: 'packages/languages/fixtures/probe-2s.flac',
  runsPerSetting: N,
  distinctTranscripts: distinct,
  rows,
};
writeFileSync(resolve(OUT, `s9-${MODEL}-mya.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${rows.length} runs, ${distinct} distinct transcripts → ${OUT}/s9-${MODEL}-mya.json`);
