/**
 * S3, the other half — chunked parallel sync, for comparison against batchRecognize.
 *
 *   node spikes/s3-chunked-sync.mjs [concurrency] <dir-of-chunks>
 *
 * Measured 2026-08-09 at concurrency 8: 43s for 30 min of audio (34 chunks) and 338s for
 * 2 h (136 chunks), against batch's 305s and 1211s. Zero 429s across 136 requests, which
 * is what makes chunked sync viable as the default at any duration.
 *
 * Two things this measures that matter beyond latency: `retries` (rate-limit headroom)
 * and `words` — chunked sync loses 2-3 words at every hard cut, which is the measured
 * justification for the Phase 1 overlap-and-LCS merge.
 */
import fs from "node:fs";
import { accessToken, speechUrl, env } from "./lib.mjs";
const CONC = Number(process.argv[2] || 8);
const dir = process.argv[3];
const { model } = env;
const token = await accessToken();
const url = speechUrl("recognize");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".flac")).sort();
const stats = { ok: 0, words: 0, err: {}, retries: 0 };
let next = 0;
const t0 = Date.now();
async function one(f) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { autoDecodingConfig: {}, languageCodes: ["my-MM"], model,
          features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true, enableWordConfidence: true } },
        content: fs.readFileSync(`${dir}/${f}`).toString("base64"),
      }),
    });
    if (res.ok) {
      const j = await res.json();
      stats.ok++;
      stats.words += (j.results ?? []).flatMap(r => r.alternatives?.[0]?.words ?? []).length;
      return;
    }
    const s = res.status;
    stats.err[s] = (stats.err[s] ?? 0) + 1;
    if (s === 429 || s >= 500) { stats.retries++; await new Promise(r => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500)); continue; }
    return;
  }
}
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < files.length) await one(files[next++]);
}));
console.log(`  concurrency ${CONC}: ${files.length} chunks in ${((Date.now()-t0)/1000).toFixed(1)}s  ok=${stats.ok} words=${stats.words} retries=${stats.retries} errors=${JSON.stringify(stats.err)}`);
