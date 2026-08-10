/**
 * S4 — Can the app's own service account actually validate a staging bucket?
 *
 * Phase 2 refuses to stage into a bucket whose region and retention rule it cannot verify,
 * so the question is not "does the bucket exist" but "can *these* credentials see enough to
 * make that judgement". They are different questions and the answer differed:
 *
 *   Measured 2026-08-10 with roles/storage.objectAdmin
 *     getMetadata   403   storage.buckets.get denied
 *     write probe   200
 *     delete probe  204
 *
 * objectAdmin — the obvious least-privilege grant for a staging bucket — can write and
 * delete freely and cannot read the bucket's own location or lifecycle rule. A correctly
 * provisioned bucket therefore fails validation on its first check. The narrow remedy is
 * roles/storage.legacyBucketReader (storage.buckets.get + objects.list), NOT
 * roles/storage.admin, which is what the Phase 2 draft said and which would grant a
 * newsroom's staging service account full bucket administration in order to read one field.
 *
 * Two further findings this script surfaces, both in plans/00-overview.md amendments 22-23:
 *   - GCS returns `location` upper-cased (ASIA-SOUTHEAST1). Fold case before comparing.
 *   - The Speech service agent does not appear in the bucket policy and does not need to,
 *     for a bucket in the same project: enabling the Speech API creates a project-level
 *     roles/speech.serviceAgent binding that already covers it. Cross-project is the real
 *     hazard.
 *
 *   node spikes/s4-staging-preflight.mjs
 *
 * Run it again after changing an IAM binding; it is the instrument behind the numbers above.
 */
import { accessToken, env } from './lib.mjs';

const token = await accessToken();
const H = { Authorization: `Bearer ${token}` };
const b = env.bucket;
if (!b) {
  console.error('GOOGLE_GCS_STAGING_BUCKET is not set. See .env.example.');
  process.exit(2);
}
console.log(`bucket ${b}   recognizer region ${env.region}   project ${env.project}\n`);

const meta = await fetch(`https://storage.googleapis.com/storage/v1/b/${b}?projection=full`, {
  headers: H,
});
console.log(`getMetadata     ${meta.status}`);
if (meta.ok) {
  const m = await meta.json();
  const matches = m.location.toLowerCase() === env.region.toLowerCase();
  console.log(`  location      ${m.location}  (${m.locationType})  ${matches ? '✓ matches' : '✗ MISMATCH'}`);
  console.log(`  storageClass  ${m.storageClass}`);
  console.log(`  lifecycle     ${JSON.stringify(m.lifecycle ?? null)}`);
} else {
  // This is the interesting branch and the one objectAdmin lands in.
  console.log(`  ${(await meta.text()).replace(/\s+/g, ' ').slice(0, 220)}`);
  console.log(
    `  fix: gcloud storage buckets add-iam-policy-binding gs://${b} \\\n` +
      `         --member=serviceAccount:<SA> --role=roles/storage.legacyBucketReader`,
  );
}

const key = `thibi-staging/.probe-${process.pid}`;
const put = await fetch(
  `https://storage.googleapis.com/upload/storage/v1/b/${b}/o?uploadType=media&name=${encodeURIComponent(key)}`,
  { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: 'probe' },
);
console.log(`\nwrite probe     ${put.status}`);
if (put.ok) {
  const del = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${b}/o/${encodeURIComponent(key)}`,
    { method: 'DELETE', headers: H },
  );
  console.log(`delete probe    ${del.status}`);
} else {
  console.log(`  ${(await put.text()).replace(/\s+/g, ' ').slice(0, 220)}`);
}

// Who is actually on the bucket? Needs storage.buckets.getIamPolicy, which neither
// objectAdmin nor legacyBucketReader grants — so a 403 here is expected and not a failure.
const iam = await fetch(`https://storage.googleapis.com/storage/v1/b/${b}/iam`, { headers: H });
console.log(`\nbucket IAM      ${iam.status}${iam.ok ? '' : '  (expected: needs an admin credential)'}`);
if (iam.ok) {
  for (const bind of (await iam.json()).bindings ?? []) {
    console.log(`  ${bind.role.padEnd(36)} ${bind.members.join(', ')}`);
  }
  console.log(
    '\nNote: the Speech service agent service-<PROJECT_NUMBER>@gcp-sa-speech.iam.gserviceaccount.com\n' +
      'is not expected here for a same-project bucket — roles/speech.serviceAgent at the project\n' +
      'level already covers it. Check with: gcloud projects get-iam-policy <project>',
  );
}
