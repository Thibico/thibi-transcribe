/**
 * S2 — Is `wordConfidence` actually populated on Chirp, or a placeholder?
 *
 * `distinctConf` is the tell. One distinct value across every word is a constant the API
 * fills in, not a measurement, and the whole low-confidence QA surface in Phase 12 would
 * be built on it.
 *
 *   node spikes/s2-word-confidence.mjs <clip.flac> [lang...]
 *
 * Verdict recorded 2026-08-09 for my-MM: PASS — 101/101 words, 101 distinct values,
 * full start and end offsets. See RESULTS.md.
 */
import fs from 'node:fs';
import { accessToken, baseConfig, speechUrl, words } from './lib.mjs';

const [clip, ...langs] = process.argv.slice(2);
if (!clip) {
  console.error('usage: node spikes/s2-word-confidence.mjs <clip.flac> [lang...]');
  process.exit(2);
}

// The sample is chosen to include the long tail, where the word array is most likely to
// be missing — not just the language we already know works.
const LANGS = langs.length
  ? langs
  : ['my-MM', 'ha-NG', 'yo-NG', 'am-ET', 'km-KH', 'ps-AF', 'ceb-PH', 'om-ET', 'zu-ZA', 'si-LK'];

const token = await accessToken();
const content = fs.readFileSync(clip).toString('base64');

console.log('lang     segs  words  withConf  distinct  minConf  maxConf  withOffsets  segConf');
for (const lang of LANGS) {
  const res = await fetch(speechUrl('recognize'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: baseConfig(lang), content }),
  });
  if (!res.ok) {
    console.log(`${lang.padEnd(8)} HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    continue;
  }
  const body = await res.json();
  const segs = body.results ?? [];
  const w = words(body);
  const confs = w.filter((x) => typeof x.confidence === 'number').map((x) => x.confidence);
  const offsets = w.filter((x) => x.startOffset !== undefined && x.endOffset !== undefined);
  const segConf = segs[0]?.alternatives?.[0]?.confidence;

  console.log(
    [
      lang.padEnd(8),
      String(segs.length).padStart(4),
      String(w.length).padStart(6),
      String(confs.length).padStart(9),
      String(new Set(confs).size).padStart(9),
      (confs.length ? Math.min(...confs).toFixed(3) : '-').padStart(8),
      (confs.length ? Math.max(...confs).toFixed(3) : '-').padStart(8),
      String(offsets.length).padStart(12),
      (segConf === undefined ? '-' : segConf.toFixed(3)).padStart(8),
    ].join(' '),
  );
}
