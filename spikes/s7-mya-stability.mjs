/**
 * `language=mya` is accepted by gpt-4o-transcribe-diarize. Is what it returns stable?
 *
 * Two identical requests, same clip, same code, minutes apart, returned:
 *
 *   "Tùn nàng ai dít cô già phiêu khuê mà bê bù"      — Latin, Vietnamese orthography
 *   "ကုန်နံ့ရည်ကုသ ုစာပျောက်ခွဲမပီဘူး"                  — Myanmar script
 *
 * That is a different failure from the one Phase 4a found on Groq. There the wrong-language
 * output was *consistent*, so a script-integrity screen could catch it once and be trusted.
 * Here the same request produces different scripts on different tries, which means a single
 * probe — including the one in the sweep — is not evidence of anything. So run it N times
 * and report the distribution rather than a verdict.
 *
 * `temperature` is not settable on this model, so this is not a sampling knob left turned
 * up; it is the model's default behaviour.
 *
 *   node spikes/s7-mya-stability.mjs OUTDIR [N=10]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scriptIntegrity } from '../packages/core/dist/index.js';

const OUT = resolve(process.argv[2] ?? '.');
const N = Number(process.argv[3] ?? 10);
const ROOT = resolve(import.meta.dirname, '..');
process.loadEnvFile(resolve(ROOT, '.env'));

const KEY = process.env.OPENAI_API_KEY;
const bytes = await readFile(resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac'));

const scripts = JSON.parse(
  await readFile(resolve(ROOT, 'packages/languages/data/scripts.json'), 'utf8'),
);
const MYMR = { code: 'Mymr', unicodeRanges: (scripts.scripts ?? scripts).Mymr.unicodeRanges };

async function once(language) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/flac' }), 'probe-2s.flac');
  form.set('model', 'gpt-4o-transcribe-diarize');
  form.set('response_format', 'diarized_json');
  if (language) form.set('language', language);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  const text = body.text ?? '';
  const integrity = scriptIntegrity(text, [MYMR]);
  return {
    language: language ?? '(autodetect)',
    status: response.status,
    text,
    speakers: [...new Set((body.segments ?? []).map((s) => s.speaker))],
    scriptFraction: integrity.fraction,
    strays: integrity.strays,
  };
}

const runs = [];
for (const language of ['mya', null]) {
  for (let i = 0; i < N; i++) {
    runs.push(await once(language));
    const r = runs.at(-1);
    console.log(
      `${(r.language).padEnd(12)} ${r.status}  script ${r.scriptFraction === null ? '  null' : r.scriptFraction.toFixed(2).padStart(6)}  ` +
        `spk ${r.speakers.join(',')||'-'}  ${JSON.stringify(r.text).slice(0, 70)}`,
    );
    await new Promise((res) => setTimeout(res, 400));
  }
}

const summarise = (language) => {
  const rows = runs.filter((r) => r.language === language && r.status === 200);
  const inScript = rows.filter((r) => (r.scriptFraction ?? 0) >= 0.9).length;
  const distinct = new Set(rows.map((r) => r.text)).size;
  const multiSpeaker = rows.filter((r) => r.speakers.length > 1).length;
  return { language, runs: rows.length, myanmarScript: inScript, distinctTranscripts: distinct, multiSpeaker };
};
const summary = ['mya', '(autodetect)'].map(summarise);

await writeFile(
  resolve(OUT, 's7-mya-stability.json'),
  JSON.stringify({ model: 'gpt-4o-transcribe-diarize', n: N, summary, runs }, null, 2) + '\n',
);

console.log();
for (const s of summary) {
  console.log(
    `${s.language.padEnd(12)} ${s.myanmarScript}/${s.runs} in Myanmar script · ` +
      `${s.distinctTranscripts} distinct transcripts · ${s.multiSpeaker}/${s.runs} found >1 speaker in 2 s of one voice`,
  );
}
