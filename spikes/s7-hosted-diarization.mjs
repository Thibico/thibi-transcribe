/**
 * S7 — is a hosted diarizing ASR an alternative to running pyannote ourselves?
 *
 * Phase 3 is built on the premise that diarization means pyannote on our own hardware at
 * ~0.6× realtime (S6). OpenAI's `gpt-4o-transcribe-diarize` returns a `diarized_json` with
 * per-segment speaker labels, which would be a `DiarizationSource` that did not exist when
 * that premise was formed. Nothing about it was measured: not language coverage, not
 * quality, not price, and in particular nothing at all for the 44-language set that is the
 * whole product.
 *
 * The questions, in the order they can kill the idea:
 *
 *   1. Does it accept the long-tail languages? Burmese is the product's reason to exist.
 *      Phase 4a already found that a Whisper endpoint will return a confident, HTTP-200,
 *      wrong-language transcript, so acceptance is not the test — script integrity is.
 *   2. Does it diarize correctly? Scored against a constructed reference (s7-make-2spk.mjs),
 *      not eyeballed.
 *   3. Does it invent speakers on a monologue? The failure mode that would put a second
 *      speaker into a single-source interview.
 *   4. Does it return word timings? Phase 3 §3 reconciles *words* against turns; a source
 *      that returns only segments changes what reconcile can do.
 *   5. What does it cost, and how fast is it against S6's 0.56–0.61× for the same file?
 *
 *   node spikes/s7-hosted-diarization.mjs OUTDIR [probe...]
 *
 * Needs OPENAI_API_KEY in .env. Audio inputs are prepared by s7-prepare.sh.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';

const OUT = resolve(process.argv[2] ?? '.');
const ONLY = process.argv.slice(3);
const ROOT = resolve(import.meta.dirname, '..');

process.loadEnvFile(resolve(ROOT, '.env'));
const KEY = process.env.OPENAI_API_KEY;
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'gpt-4o-transcribe-diarize';

const durationMs = (path) =>
  Math.round(
    Number(
      execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
      ]).toString().trim(),
    ) * 1000,
  );

/**
 * Posted over `node:https` rather than `fetch`, for a reason that is part of the answer:
 * this endpoint is synchronous. One HTTP request is held open for the entire
 * transcription, with no task handle to poll. A 23-minute file takes longer to return
 * headers than undici's 300 s default allows, so `fetch` kills it with
 * UND_ERR_HEADERS_TIMEOUT — which reads exactly like a provider failure and is not one.
 * `node:https` applies no headers timeout, so the instrument measures the provider instead
 * of measuring Node's defaults. Any engine client for a model like this would need the
 * same treatment.
 *
 * The multipart body is assembled in memory. The model's own 1400 s ceiling caps how large
 * that can get, so streaming would be complexity with nothing to buy.
 */
function postMultipart({ fields, file }) {
  const boundary = `----thibi${randomUUID()}`;
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const body = Buffer.concat(parts);

  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function call({ clip, language, format = 'diarized_json', chunking = 'auto', words = false }) {
  const bytes = await readFile(clip);
  const fields = [
    ['model', MODEL],
    ['response_format', format],
  ];
  if (language) fields.push(['language', language]);
  if (chunking) fields.push(['chunking_strategy', chunking]);
  if (words) fields.push(['timestamp_granularities[]', 'word']);

  const started = Date.now();
  const response = await postMultipart({
    fields,
    file: {
      name: clip.split('/').pop(),
      type: clip.endsWith('.ogg') ? 'audio/ogg' : 'audio/flac',
      bytes,
    },
  });
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = { _unparseable: response.text.slice(0, 2000) };
  }
  return {
    request: { model: MODEL, response_format: format, language: language ?? null, chunking_strategy: chunking ?? null, word_granularity: words },
    audio: { file: clip.split('/').pop(), bytes: bytes.length, durationMs: durationMs(clip) },
    status: response.status,
    ms: Date.now() - started,
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(
        ([k]) => k.startsWith('x-ratelimit') || k === 'retry-after',
      ),
    ),
    body,
  };
}

const clip = (name) => resolve(OUT, name);
const PROBES = [
  // 1. The floor: does the model exist on this key, and is chunking_strategy really
  //    mandatory above 30 s? A 33.6 s clip is the cheapest way to find out.
  ['en-2spk-nochunk', () => call({ clip: clip('en-2spk.flac'), chunking: null })],
  // 2. The measurement. Scored against en-2spk.truth.json by s7-score.mjs.
  ['en-2spk', () => call({ clip: clip('en-2spk.flac') })],
  // 3. Are word timings obtainable at all, or is the unit of attribution the segment?
  ['en-2spk-words', () => call({ clip: clip('en-2spk.flac'), words: true })],
  // 4. Phase 4a found gpt-4o-transcribe refuses verbose_json. Does this one?
  ['en-2spk-verbose', () => call({ clip: clip('en-2spk.flac'), format: 'verbose_json' })],
  // 5. Burmese, short. Under 30 s, so chunking cannot be blamed for a failure.
  ['my-2s', () => call({ clip: resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac'), language: 'my', chunking: null })],
  ['my-2s-autodetect', () => call({ clip: resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac'), chunking: null })],
  // 6. Burmese at length, single speaker. S6 ran pyannote on this exact file and found
  //    1 speaker over 21 turns. A second speaker here is an invented one.
  ['my-106s', () => call({ clip: clip('my-106s.flac') })],
  // 7. The head-to-head. S6: 4 speakers, 317 turns, 0.56–0.61× realtime on CPU. The full
  //    1523 s file is over the model's ceiling, which is itself the finding; the 1390 s
  //    trim is what actually gets a number to compare against.
  ['en-podcast', () => call({ clip: clip('en-podcast.flac'), language: 'en' })],
  ['en-podcast-23min', () => call({ clip: clip('en-podcast-23min.flac'), language: 'en' })],
  // Opus rather than FLAC only because the 43 MB FLAC of the same trim never got a
  // response. Fine for a speaker-count and throughput comparison, not for an accuracy one.
  ['en-podcast-23min-opus', () => call({ clip: clip('en-podcast-23min.ogg'), language: 'en' })],
];

for (const [name, run] of PROBES) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  try {
    const result = await run();
    await writeFile(resolve(OUT, `s7-${name}.json`), JSON.stringify(result, null, 2) + '\n');
    const b = result.body;
    const segs = b.segments?.length ?? b.chunks?.length ?? 0;
    const speakers = new Set((b.segments ?? b.chunks ?? []).map((s) => s.speaker).filter(Boolean));
    const rtf = result.audio.durationMs / result.ms;
    console.log(
      `${name.padEnd(20)} ${result.status}  ${String(result.ms).padStart(7)}ms  ` +
        `rtf ${rtf.toFixed(2)}×  segs ${String(segs).padStart(4)}  spk ${speakers.size}  ` +
        `${(b.text ?? '').slice(0, 60).replace(/\n/g, ' ')}`,
    );
    if (result.status >= 400) console.log(`  ${JSON.stringify(b).slice(0, 400)}`);
    if (b.usage) console.log(`  usage ${JSON.stringify(b.usage)}`);
  } catch (err) {
    console.log(`${name.padEnd(20)} THREW  ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
