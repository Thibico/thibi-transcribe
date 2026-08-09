/**
 * S3 — Does `batchRecognize` work end to end, and how fast?
 *
 * Stages the file to GCS, submits, polls to completion with wall-clock timing, then reads
 * the transcript back out of GCS. The measured number IS the routing rule: compare it
 * against s3-chunked-sync.mjs on the same audio.
 *
 *   node spikes/s3-batch-recognize.mjs <file.flac> <label> [DYNAMIC_BATCHING]
 *
 * Measured 2026-08-09: a flat 5.9x realtime at both 30 min and 2 h, which chunked
 * parallel sync beats at every size. See RESULTS.md.
 *
 * One trap this script deliberately surfaces: `done: true` with no operation-level error
 * can still hide `results[uri].error`. It hit 1 run in 5.
 */
import fs from "node:fs";
import path from "node:path";
import { accessToken, env, secs as t } from "./lib.mjs";

const [file, label, strategy] = process.argv.slice(2);
const { project, region, model, bucket } = env;
const token = await accessToken();
const H = { Authorization: `Bearer ${token}` };
const J = { ...H, "Content-Type": "application/json" };
const runId = `spike-${label}`;
const inKey = `thibi-staging/${runId}/audio.flac`;
const outPrefix = `thibi-staging/${runId}/out`;

// 1. stage
let t0 = Date.now();
const up = await fetch(
  `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(inKey)}`,
  { method: "POST", headers: { ...H, "Content-Type": "audio/flac" }, body: fs.readFileSync(file) });
if (!up.ok) { console.log("upload FAILED", up.status, (await up.text()).slice(0, 300)); process.exit(1); }
const tUpload = Date.now() - t0;
console.log(`  upload          ${t(tUpload)}`);

// 2. submit
t0 = Date.now();
const body = {
  config: {
    autoDecodingConfig: {},
    languageCodes: ["my-MM"],
    model,
    features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true, enableWordConfidence: true },
  },
  files: [{ uri: `gs://${bucket}/${inKey}` }],
  recognitionOutputConfig: { gcsOutputConfig: { uri: `gs://${bucket}/${outPrefix}` } },
  ...(strategy ? { processingStrategy: strategy } : {}),
};
const sub = await fetch(
  `https://${region}-speech.googleapis.com/v2/projects/${project}/locations/${region}/recognizers/_:batchRecognize`,
  { method: "POST", headers: J, body: JSON.stringify(body) });
const subTxt = await sub.text();
if (!sub.ok) { console.log(`  submit FAILED ${sub.status}`, subTxt.slice(0, 500)); process.exit(1); }
const op = JSON.parse(subTxt).name;
console.log(`  submit          ${t(Date.now() - t0)}   strategy=${strategy || "default"}`);
console.log(`  operation       ${op}`);

// 3. poll
const tSubmit = Date.now();
let done = false, opJson;
for (let i = 0; !done; i++) {
  await new Promise(r => setTimeout(r, i < 3 ? 5000 : i < 10 ? 15000 : 30000));
  const p = await fetch(`https://${region}-speech.googleapis.com/v2/${op}`, { headers: H });
  opJson = JSON.parse(await p.text());
  done = !!opJson.done;
  const pct = opJson.metadata?.progressPercent;
  process.stdout.write(`\r  polling         ${t(Date.now() - tSubmit)}  done=${done}${pct !== undefined ? `  ${pct}%` : ""}   `);
}
const tBatch = Date.now() - tSubmit;
console.log(`\n  batch complete  ${t(tBatch)}`);
if (opJson.error) { console.log("  ERROR", JSON.stringify(opJson.error).slice(0, 500)); process.exit(1); }

// done:true and no operation-level error is NOT success. A per-file error can be set
// while progressPercent is 100 and totalBilledDuration is 0s. pollBatch must treat this
// as authoritative and retry; code 13 here was transient and unbilled.
for (const [uri, r] of Object.entries(opJson.response?.results ?? {})) {
  if (r.error) {
    console.log(`  PER-FILE ERROR  ${uri}`);
    console.log(`                  ${JSON.stringify(r.error)}`);
    console.log(`                  totalBilledDuration=${opJson.response?.totalBilledDuration}`);
    process.exit(1);
  }
}

// 4. fetch output from GCS
const fileResult = Object.values(opJson.response?.results ?? {})[0];
const outUri = fileResult?.uri;
console.log(`  output uri      ${outUri ?? "(none — inline?)"}`);
if (outUri) {
  const key = outUri.replace(`gs://${bucket}/`, "");
  const g = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`, { headers: H });
  const out = JSON.parse(await g.text());
  fs.writeFileSync(path.join(path.dirname(file), `batch-${label}.json`), JSON.stringify(out));
  const results = out.results ?? [];
  const words = results.flatMap(r => (r.alternatives?.[0]?.words) ?? []);
  const last = words[words.length - 1];
  console.log(`  results         ${results.length} segments, ${words.length} words`);
  console.log(`  word conf       ${words.filter(w => "confidence" in w).length}/${words.length}`);
  console.log(`  last word end   ${last?.endOffset}  (audio is ~${label})`);
}
console.log(`  TOTAL           ${t(tUpload + tBatch)}`);
