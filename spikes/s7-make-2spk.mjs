/**
 * Build a two-speaker English clip whose turn boundaries are known exactly.
 *
 * S6 measured how *fast* pyannote is and explicitly did not measure whether the speakers
 * were right. Scoring a diarizer needs a reference, and the cheapest honest reference is
 * one we construct: synthesise each turn separately with a different macOS voice,
 * concatenate with a known silence between, and the cumulative offsets *are* the RTTM.
 * No hand-labelling, no judgement calls about where a turn starts.
 *
 * What this is not: real audio. Two TTS voices are far more separable than two people on
 * one microphone in a room, there is no overlap, no crosstalk and no channel noise, so a
 * good score here is a floor on difficulty rather than evidence of field accuracy. It is
 * enough to answer "does this diarizer attribute turns at all, and does it invent
 * speakers", which is what the probe needs to settle.
 *
 *   node spikes/s7-make-2spk.mjs OUTDIR
 *
 * Writes OUTDIR/en-2spk.flac (16 kHz mono, the norm_16k_mono_flac shape) and
 * OUTDIR/en-2spk.truth.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const OUT = resolve(process.argv[2] ?? '.');
const GAP_S = 0.4; // silence between turns, so a boundary error is visible rather than absorbed

// Interview register on purpose: short answers, one-word interjections and a long
// explanation, because the reconcile filter in Phase 3 is tuned around exactly that mix.
const SCRIPT = [
  ['A', 'Samantha', 'Thank you for making time today. Can you tell me when you first noticed the flooding getting worse?'],
  ['B', 'Daniel', 'Around two thousand and nineteen. Before that the river rose maybe once a decade, and then suddenly it was every single year.'],
  ['A', 'Samantha', 'Every year?'],
  ['B', 'Daniel', 'Yes.'],
  ['A', 'Samantha', 'And what did the township office say when you reported it?'],
  ['B', 'Daniel', 'They told us the drainage project was funded and would begin in the dry season. We are still waiting for it to begin.'],
  ['A', 'Samantha', 'Has anyone left the village because of this?'],
  ['B', 'Daniel', 'Eleven families. Most of them went to Mandalay to look for work, and only two have come back since.'],
];

const durationOf = (path) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ]).toString().trim(),
  );

const tmp = mkdtempSync(join(tmpdir(), 's7-2spk-'));
try {
  const parts = [];
  const truth = [];
  let cursorS = 0;

  SCRIPT.forEach(([speaker, voice, text], i) => {
    const aiff = join(tmp, `turn-${i}.aiff`);
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    // Resample here rather than at concat: `say` emits 22.05 kHz, and the concat demuxer
    // requires every input to share a format.
    const wav = join(tmp, `turn-${i}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '16000', wav]);

    const d = durationOf(wav);
    truth.push({
      startMs: Math.round(cursorS * 1000),
      endMs: Math.round((cursorS + d) * 1000),
      speakerKey: speaker,
      voice,
      text,
    });
    cursorS += d + GAP_S;
    parts.push(wav);
  });

  const silence = join(tmp, 'gap.wav');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `anullsrc=r=16000:cl=mono:d=${GAP_S}`, silence,
  ]);

  const list = join(tmp, 'list.txt');
  writeFileSync(
    list,
    parts.flatMap((p, i) => (i === 0 ? [p] : [silence, p])).map((p) => `file '${p}'`).join('\n') + '\n',
  );

  const flac = join(OUT, 'en-2spk.flac');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-ac', '1', '-ar', '16000', flac,
  ]);

  const totalMs = Math.round(durationOf(flac) * 1000);
  const truthPath = join(OUT, 'en-2spk.truth.json');
  writeFileSync(
    truthPath,
    JSON.stringify(
      { audio: 'en-2spk.flac', durationMs: totalMs, gapMs: GAP_S * 1000, speakers: 2, turns: truth },
      null,
      2,
    ) + '\n',
  );

  console.log(`${flac}  ${(totalMs / 1000).toFixed(1)}s  ${truth.length} turns  2 speakers`);
  console.log(truthPath);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
