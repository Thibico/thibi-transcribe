/**
 * Rebuild `src/diarize/__fixtures__/en-2spk-short.flac` and its reference.
 *
 *   node packages/engine/scripts/make-2spk-fixture.mjs
 *
 * The fixture is committed, so this script is not part of any test run. It is here because
 * a binary in a repo with no way to regenerate it is a fact nobody can check: if the
 * contract test ever disagrees with the reference, the question "is the audio what we think
 * it is" has to be answerable without asking whoever generated it.
 *
 * The method is `spikes/s7-make-2spk.mjs`'s, unchanged and for the same reason — synthesise
 * each turn separately with a different macOS voice, concatenate with a known silence, and
 * the cumulative offsets *are* the reference, with no hand-labelling. What differs is
 * length: S7's clip is 34 s because it was measuring accuracy, and this one is 11 s because
 * every second of it costs about four seconds of CPU in the contract test. Four turns is
 * the shortest script that still asserts something the wire format could get wrong —
 * A-B-A-B distinguishes "two speakers, alternating" from "two labels assigned at random".
 *
 * macOS only: `say` is the voice synthesiser. ffmpeg and ffprobe must be on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/diarize/__fixtures__');
const GAP_S = 0.4; // silence between turns, so a boundary error is visible rather than absorbed

const SCRIPT = [
  ['A', 'Samantha', 'When did the flooding start getting worse?'],
  ['B', 'Daniel', 'Around two thousand nineteen. Before that, once a decade.'],
  ['A', 'Samantha', 'And now?'],
  ['B', 'Daniel', 'Every single year. Eleven families have already left.'],
];

const durationOf = (path) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ]).toString().trim(),
  );

const tmp = mkdtempSync(join(tmpdir(), 'thibi-2spk-'));
try {
  const parts = [];
  const turns = [];
  let cursorS = 0;

  SCRIPT.forEach(([speakerKey, voice, text], i) => {
    const aiff = join(tmp, `turn-${i}.aiff`);
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    // Resample here rather than at concat: `say` emits 22.05 kHz and the concat demuxer
    // requires every input to share a format.
    const wav = join(tmp, `turn-${i}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '16000', wav]);

    const d = durationOf(wav);
    turns.push({
      startMs: Math.round(cursorS * 1000),
      endMs: Math.round((cursorS + d) * 1000),
      speakerKey,
      voice,
      text,
    });
    cursorS += d + GAP_S;
    parts.push(wav);
  });

  const silence = join(tmp, 'gap.wav');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono:d=${GAP_S}`, silence,
  ]);

  const list = join(tmp, 'list.txt');
  writeFileSync(
    list,
    parts.flatMap((p, i) => (i === 0 ? [p] : [silence, p])).map((p) => `file '${p}'`).join('\n') +
      '\n',
  );

  const flac = join(OUT, 'en-2spk-short.flac');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '16000', flac,
  ]);

  const durationMs = Math.round(durationOf(flac) * 1000);
  writeFileSync(
    join(OUT, 'en-2spk-short.truth.json'),
    JSON.stringify(
      {
        audio: 'en-2spk-short.flac',
        generator: 'packages/engine/scripts/make-2spk-fixture.mjs',
        durationMs,
        gapMs: GAP_S * 1000,
        speakers: 2,
        turns,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`${flac}  ${(durationMs / 1000).toFixed(1)}s  ${turns.length} turns  2 speakers`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
