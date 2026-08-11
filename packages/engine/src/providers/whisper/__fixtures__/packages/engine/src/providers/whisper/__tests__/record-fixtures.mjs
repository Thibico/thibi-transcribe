/**
 * Record real provider responses as Phase 4 fixtures.
 *
 * Not hand-written JSON: the whole point of the fixtures is that they are what the API
 * actually said on a date, so a parser test fails when the shape changes rather than when
 * somebody's memory of the shape changes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = process.argv[2] ?? '.';
const ROOT = '/Users/yan/Coding_work/thibi-transcribe';

process.loadEnvFile(resolve(ROOT, '.env'));

async function call({ endpoint, apiKey, clip, filename, model, language, verbose = true, prompt }) {
  const form = new FormData();
  form.set('file', new Blob([await readFile(clip)], { type: 'audio/flac' }), filename);
  form.set('model', model);
  if (language) form.set('language', language);
  form.set('response_format', verbose ? 'verbose_json' : 'json');
  if (verbose) {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
  if (prompt) form.set('prompt', prompt);
  form.set('temperature', '0');

  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _unparseable: text.slice(0, 2000) };
  }
  return {
    status: response.status,
    ms: Date.now() - started,
    headers: Object.fromEntries(
      [...response.headers].filter(([k]) => k.startsWith('x-ratelimit') || k === 'retry-after'),
    ),
    body,
  };
}

const OPENAI = 'https://api.openai.com/v1/audio/transcriptions';
const GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions';
const openaiKey = process.env.OPENAI_API_KEY;
const groqKey = process.env.GROQ_API_KEY;
const burmese = resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac');
const english = resolve(OUT, 'en-16k.flac');

const jobs = [
  ['openai-verbose-json-en', () => call({ endpoint: OPENAI, apiKey: openaiKey, clip: english, filename: 'en.flac', model: 'whisper-1', language: 'en' })],
  ['openai-prompt-echo-en', () => call({ endpoint: OPENAI, apiKey: openaiKey, clip: english, filename: 'en.flac', model: 'whisper-1', language: 'en', prompt: 'Naypyidaw, ASEAN, Tatmadaw, Irrawaddy, Rakhine, Kachin, Shan State, Mandalay' })],
  ['openai-my-rejected', () => call({ endpoint: OPENAI, apiKey: openaiKey, clip: burmese, filename: 'probe-2s.flac', model: 'whisper-1', language: 'my' })],
  ['openai-gpt4o-json-en', () => call({ endpoint: OPENAI, apiKey: openaiKey, clip: english, filename: 'en.flac', model: 'gpt-4o-transcribe', language: 'en', verbose: false })],
  ['openai-gpt4o-verbose-refused', () => call({ endpoint: OPENAI, apiKey: openaiKey, clip: english, filename: 'en.flac', model: 'gpt-4o-transcribe', language: 'en', verbose: true })],
  ['groq-my-mangled', () => call({ endpoint: GROQ, apiKey: groqKey, clip: burmese, filename: 'probe-2s.flac', model: 'whisper-large-v3', language: 'my' })],
  ['groq-my-autodetect', () => call({ endpoint: GROQ, apiKey: groqKey, clip: burmese, filename: 'probe-2s.flac', model: 'whisper-large-v3' })],
  ['groq-en-verbose', () => call({ endpoint: GROQ, apiKey: groqKey, clip: english, filename: 'en.flac', model: 'whisper-large-v3', language: 'en' })],
];

for (const [name, run] of jobs) {
  try {
    const result = await run();
    await writeFile(resolve(OUT, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
    const text = (result.body.text ?? '').slice(0, 90).replace(/\n/g, ' ');
    console.log(`${name.padEnd(32)} ${result.status}  ${String(result.ms).padStart(6)}ms  ${text}`);
    if (result.status >= 400) console.log(`  ${JSON.stringify(result.body).slice(0, 300)}`);
  } catch (err) {
    console.log(`${name.padEnd(32)} THREW  ${err.message}`);
  }
  // Groq's on-demand tier measured ~20 rpm on 2026-08-09; pace all of it.
  await new Promise((r) => setTimeout(r, 3500));
}
