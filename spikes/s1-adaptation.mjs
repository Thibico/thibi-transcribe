/**
 * S1 — Does Chirp honour speech adaptation?
 *
 * A 200 is not an answer. The dangerous outcome is "accepted and silently ignored", so
 * this runs an A/B: a baseline with no adaptation, the relevant keyterms at three boost
 * values, and a control set of five *irrelevant* nouns. If boost is inert and relevant
 * terms change nothing, adaptation does not work however many 200s come back.
 *
 *   node spikes/s1-adaptation.mjs <clip.flac> [outdir]
 *
 * Verdict recorded 2026-08-09: FAIL. See RESULTS.md.
 */
import fs from 'node:fs';
import { accessToken, baseConfig, speechUrl, transcript } from './lib.mjs';

const [clip, outdir = 'spikes/raw'] = process.argv.slice(2);
if (!clip) {
  console.error('usage: node spikes/s1-adaptation.mjs <clip.flac> [outdir]');
  process.exit(2);
}

const RELEVANT = [
  'အပစ်အခတ်ရပ်စဲရေး', // ceasefire
  'စစ်ကောင်စီ', // military council
  'ဘုံသဘောတူညီချက်ငါးရပ်', // five-point consensus
  'နေပြည်တော်', // Naypyidaw
  'အာဆီယံထိပ်သီးအစည်းအဝေး', // ASEAN summit
];

// Five nouns with no relationship to the audio. If supplying these changes the output,
// the adaptation field perturbs decoding without biasing the lexicon — which is exactly
// what was measured, and it means a stale glossary makes transcripts worse.
const IRRELEVANT = ['ကြက်ဥ', 'ဆိတ်သား', 'ဘတ်စကက်ဘော', 'ရုပ်မြင်သံကြား', 'ငှက်ပျောသီး'];

const CELLS = [
  { label: 'baseline', phrases: null, boost: null },
  { label: 'relevant-boost0', phrases: RELEVANT, boost: 0 },
  { label: 'relevant-boost10', phrases: RELEVANT, boost: 10 },
  { label: 'relevant-boost20', phrases: RELEVANT, boost: 20 },
  { label: 'irrelevant-boost15', phrases: IRRELEVANT, boost: 15 },
];

fs.mkdirSync(outdir, { recursive: true });
const token = await accessToken();
const content = fs.readFileSync(clip).toString('base64');
const results = new Map();

for (const cell of CELLS) {
  const config = baseConfig();
  if (cell.phrases) {
    config.adaptation = {
      phraseSets: [
        {
          inlinePhraseSet: {
            phrases: cell.phrases.map((value) => ({ value, boost: cell.boost })),
          },
        },
      ],
    };
  }

  const res = await fetch(speechUrl('recognize'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, content }),
  });
  const body = await res.text();
  fs.writeFileSync(`${outdir}/s1-${cell.label}.json`, body);
  if (!res.ok) {
    console.log(`${cell.label.padEnd(20)} HTTP ${res.status}  ${body.slice(0, 200)}`);
    continue;
  }
  const text = transcript(JSON.parse(body));
  results.set(cell.label, text);
  console.log(`${cell.label.padEnd(20)} HTTP ${res.status}  ${text.length} chars`);
}

const baseline = results.get('baseline');
console.log('\ndiff vs baseline:');
for (const [label, text] of results) {
  if (label === 'baseline') continue;
  const identical = text === baseline;
  console.log(`  ${label.padEnd(20)} ${identical ? 'BYTE-IDENTICAL' : 'differs'}`);
}
console.log(
  '\nAdaptation counts as working only if relevant keyterms fix a targeted error and\n' +
    'boost shows some sensitivity between 0 and 20. Byte-identical output across boost\n' +
    'values means the field is inert whatever the status code said.',
);
