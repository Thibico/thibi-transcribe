# Phase 2 — batchRecognize + GCS staging

> **Corrected 2026-08-10, before implementation.** This document was written before spike S3
> ran. Three of its claims were measured wrong and are fixed inline below; each correction is
> marked **Measured 2026-08-09** or **Measured 2026-08-10** at the point it applies.
>
> | What the draft said | What was measured | Where |
> |---|---|---|
> | Route to batch above a 15-minute duration threshold | Batch is a flat 5.9× realtime and chunked sync beats it at every size. **There is no duration threshold**; batch is an opt-in cost choice. (Overview amendment 2, never applied to this file until now.) | §7 |
> | Remediate a bucket-metadata 403 with `roles/storage.admin` | `roles/storage.objectAdmin` — the natural grant for a staging bucket — does not include `storage.buckets.get`, so this is the *expected* first-run failure, and the narrow fix is `roles/storage.legacyBucketReader`. Granting `storage.admin` to read metadata is bad advice. | §5 |
> | The Speech service agent is the second-most-common first-run failure | For a bucket in the **same project** as the recognizer, the auto-granted project binding `roles/speech.serviceAgent` already covers it and no per-bucket grant is needed. The hazard is real only cross-project. | §5, risk 5 |
> | `$0.016` vs `$0.003` asserted from documentation | Confirmed from the Cloud Billing Catalog API, and it also turned up a `(Logged)` SKU at 25% off that we must never silently opt into. | §8 |
>
> One prerequisite is also wrong: `run_steps` and `run_events` **do not exist**. Phase 1
> deferred them to Phase 9 and this phase does not bring them forward. See §3.

## Goal

At the end of this phase `thibi transcribe 2hr.mp3 --lang my --mode batch` routes to Google's
`batchRecognize`, stages one normalized FLAC into `gs://…/thibi-staging/<runId>/`, persists the
long-running-operation name before doing anything else, polls to completion, reads the result
JSON back out of GCS, parses it with the *same* parser the sync path uses, archives the raw
response into MinIO and deletes the staging prefix. It sits at position 2 because spike S3 only
proved one hand-driven round trip: if the staging path fails in practice — bucket-region rules,
IAM, lifecycle, dynamic-batch pricing, unusable latency — then `runs.operation_name`,
`runs.staging_prefix`, `mode = 'batch'`, the `StagingStore` port and the $9-vs-$48 argument all
come out of the design. That has to be known **before** Phase 9 builds a queue whose
`awaiting_external` state exists mostly to serve it.

The word `routes itself` was in that sentence and is now gone. S3 measured that nothing about a
file's duration should send it to batch; an admin opts in. §7 carries the argument.

## Prerequisites

| From | What |
|---|---|
| Phase 0 · S3 | `batchRecognize` submit → poll → read confirmed by hand, once |
| Phase 0 · S2 | Whether `enableWordConfidence` populates on `chirp_2` (changes nothing here, recorded per run) |
| Phase 1 | `EngineContext`, `ObjectStore` + MinIO adapter, `runs` / `run_chunks`, `media_derivatives` with `norm_16k_mono_flac` |
| Phase 1 | `providers/google/{auth,parse,index}.ts`, `thibi transcribe` on sync and `sync_chunked` |
| Phase 1 | `settings` table and the `SettingsPort` precedence chain |

**Not available, contrary to the draft above.** `run_steps` and `run_events` are Phase 9's
(`phase-01-engine-core.md:184` says so explicitly), `rates` and `usage_records` did not exist,
and `providers/google/endpoints.ts` and `recognize.ts` were never separate files — Phase 1 put
`speechEndpoint` and `transcribe` in `providers/google/index.ts`. This phase splits the endpoint
helpers out, adds `rates` + `usage_records` because its own definition of done costs from them,
and leaves the step state machine alone.

## Deliverables

| Path | Purpose |
|---|---|
| `packages/engine/src/staging/types.ts` | `StagingStore` port, `LifecycleCheck`, `StagingLocation` |
| `packages/engine/src/staging/gcs.ts` | GCS adapter over `@google-cloud/storage`, sharing the STT service-account credentials |
| `packages/engine/src/staging/memory.ts` | `FakeStagingStore` for tests — same port, in-memory, fake lifecycle metadata |
| `packages/engine/src/staging/lifecycle.ts` | `assertLifecycle`, the acceptance rule, and the copy-pasteable fix command |
| `packages/engine/src/staging/validate.ts` | Settings-time bucket validation: region match, storage class, write probe |
| `packages/engine/src/providers/google/batch.ts` | `submitBatch` / `pollBatch` / `fetchBatchResult` / `cancelBatch` |
| `packages/engine/src/providers/google/endpoints.ts` | *(modified)* adds `batchRecognizeUrl`, `operationUrl`, `cancelOperationUrl`, `listOperationsUrl` |
| `packages/engine/src/providers/google/parse.ts` | *(modified)* `parseRecognizeResults()` extracted so sync and batch share one parser |
| `packages/engine/src/providers/google/errors.ts` | *(modified)* stale region hint removed; GCS/IAM hint added |
| `packages/engine/src/pipeline/plan.ts` | `planMode()` — the routing rule and its `reason` |
| `packages/engine/src/pipeline/batch-run.ts` | Phase-2 in-process drive loop: submit → persist → poll → fetch → archive → sweep |
| `packages/engine/src/pipeline/operation-reconcile.ts` | Orphan-LRO recovery by input-URI match |
| `packages/engine/src/retry.ts` | Already has full jitter, `Retry-After` and the per-step-kind policy from Phase 1. Unchanged. |
| `packages/db/src/schema/runs.ts` | `operation_name`, `staging_prefix`, `mode` already exist from Phase 1; `runs.pipeline.planReason` is a jsonb key and needs no migration |
| `packages/db/src/schema/spend.ts` + migration `0001` | `rates` and `usage_records`, seeded `google\|chirp_2\|minute\|0.016` and `google\|chirp_2\|batch_minute\|0.003` |
| `apps/cli/src/commands/transcribe.ts` | *(modified)* `--mode auto\|sync\|sync_chunked\|batch`, `--dry-run`, SIGINT → cancel |
| `apps/cli/src/commands/settings.ts` | *(modified)* `thibi settings set google_gcs_staging_bucket … --check` |
| `apps/cli/src/commands/runs.ts` | *(modified)* `thibi runs resume <id>` |
| `packages/engine/src/providers/google/__fixtures__/batch-*.json` | Recorded submit / poll / output fixtures |

## Design

### 1. Endpoints

Google STT v2 is regional and the operation name is already a full resource path, so every URL
is derived from `region` plus that name — never string-concatenated at the call site.

```ts
// providers/google/endpoints.ts
const host = (region: string) => `https://${region}-speech.googleapis.com/v2`;

export const recognizeUrl = (region: string, project: string) =>
  `${host(region)}/projects/${project}/locations/${region}/recognizers/_:recognize`;

export const batchRecognizeUrl = (region: string, project: string) =>
  `${host(region)}/projects/${project}/locations/${region}/recognizers/_:batchRecognize`;

// name === 'projects/P/locations/R/operations/OPID' — already fully qualified
export const operationUrl        = (region: string, name: string) => `${host(region)}/${name}`;
export const cancelOperationUrl  = (region: string, name: string) => `${host(region)}/${name}:cancel`;
export const listOperationsUrl   = (region: string, project: string) =>
  `${host(region)}/projects/${project}/locations/${region}/operations`;
```

`speechEndpoint()` at `lib/providers/google.ts:89-94` is the ancestor of this file. Same idea,
one more method, plus the operation URLs it never needed.

### 2. `submitBatch`

```ts
// Plain JSON. No clients, no closures, no timers — see §8.
export interface BatchOp {
  provider: 'google';
  region: string;          // needed to rebuild the poll URL after a restart
  name: string;            // LRO resource name — the thing we must not lose
  inputUri: string;        // key into BatchRecognizeResponse.results
  outputPrefix: string;    // gs:// prefix we asked Google to write into
  submittedAtMs: number;
}

export interface BatchRequest {
  runId: string;
  audioUri: string;        // gs://… — the engine staged it, the provider never touches GCS
  outputUri: string;       // gs://…/out
  languageCode: string;
  model?: string;
  durationMs: number;
  phraseSet?: InlinePhraseSet;   // only if spike S1 said yes
}
```

Wire body:

```json
{
  "config": {
    "autoDecodingConfig": {},
    "languageCodes": ["my-MM"],
    "model": "chirp_2",
    "features": {
      "enableWordTimeOffsets": true,
      "enableWordConfidence": true,
      "enableAutomaticPunctuation": true
    }
  },
  "files": [{ "uri": "gs://thibi-stt-asia/thibi-staging/<runId>/audio.flac" }],
  "recognitionOutputConfig": {
    "gcsOutputConfig": { "uri": "gs://thibi-stt-asia/thibi-staging/<runId>/out" }
  },
  "processingStrategy": "DYNAMIC_BATCHING"
}
```

Four decisions in that body:

- **`gcsOutputConfig`, never `inlineResponseConfig`.** Inline is size-capped and would force two
  parse paths for the same data. One transport, one parser.
- **One file per operation.** `files[]` accepts several; we submit one so cancellation, cost
  attribution and failure isolation are all per run. Revisit only if per-operation overhead is
  ever measured to dominate.
- **`processingStrategy: DYNAMIC_BATCHING`** is the whole cost argument. If the field is rejected
  for `chirp_2` in the configured region, fall back to a plain batch submit, record
  `pipeline.dynamicBatching = false` on the run, and let the recorded `usage_records` — not the
  estimate — tell the truth about what it cost.
- `enableWordConfidence` is requested unconditionally. If S2 said Chirp does not populate it, the
  field is absent and `wordConfidence` stays false in the capability matrix. Asking costs nothing.

Response: `{ "name": "projects/P/locations/R/operations/1234", "metadata": {…}, "done": false }`.

### 3. Persist the operation name before anything else

This is the ordering the phase exists to get right. A lost LRO name means a second submission and
a second bill for audio Google has already processed.

**Corrected 2026-08-10.** The draft below wrote `run_steps` and `run_events`. Neither table
exists — Phase 1 deferred the step state machine to Phase 9 and this phase does not bring it
forward for the sake of one row. The invariant does not need it: what must be atomic is that the
operation name becomes durable before anything can poll, and `runs` alone carries that.

```
1. UPDATE runs SET staging_prefix = 'thibi-staging/<runId>/', mode = 'batch'
                                                                  -- deterministic, before upload
2. staging.put(...)                                               -- upload the FLAC
3. POST :batchRecognize
4. BEGIN
     UPDATE runs SET operation_name = $name,
                     pipeline = pipeline || {'batch': {name, region, inputUri,
                                                       outputPrefix, submittedAtMs}}
   COMMIT
5. only now return control to the drive loop
```

Step 1 sets `mode` *before* the upload rather than with the operation name, which the draft did
not. It is what makes an interrupted run identifiable as a batch run at all: the reconciler in
§3's second half looks for `mode='batch' AND operation_name IS NULL`, and a run that crashed
between the upload and the submit would otherwise be indistinguishable from a sync run.

The whole `BatchOp` goes into `runs.pipeline.batch`, not just the name. §10's constraint is that
`BatchOp` is plain JSON precisely so it can be stored and rehydrated, and storing it whole means
`thibi runs resume` reconstructs the poll without re-deriving `region` and `inputUri` from three
other columns. When Phase 9 lands, `run_steps.external_ref` becomes the name's second home and
this jsonb key becomes redundant; deleting it then is a one-line change.

The crash window is between 4 and 5. `operation-reconcile.ts` closes it:

```ts
export async function findOrphanOperation(ctx, cfg, opts: { inputUri: string; sinceMs: number }) {
  // GET listOperationsUrl(region, project)?pageSize=100
  // Match on metadata.batchRecognizeRequest.files[0].uri === opts.inputUri
  // Only consider operations created within sinceMs (default 6h).
  // Returns BatchOp | null.
}
```

Called by `thibi runs resume <id>` and by the Phase 9 boot sweep whenever a run is in
`mode='batch'` with `operation_name IS NULL` but a `staging_prefix` that already has an object.
(The common case is cheaper: `operation_name IS NOT NULL` means resume just re-polls, no listing
required. `findOrphanOperation` is only for the crash between submit and commit.)
Because `staging_prefix` is derived from `runId` it is stable across restarts, which is what makes
the match possible at all. Belt and braces; the transaction is the real fix.

### 4. The `StagingStore` port

```ts
export interface StagingStore {
  readonly scheme: 'gs';
  /** Bucket region, lower-cased. Cached per process. */
  location(): Promise<string>;
  /** Absolute URI for a key relative to the configured prefix root. */
  uri(key: string): string;
  put(key: string, body: Readable | Uint8Array,
      opts?: { contentType?: string; bytes?: number }): Promise<string>;
  listJson(prefix: string): Promise<Array<{ key: string; uri: string; bytes: number }>>;
  readJson<T = unknown>(uri: string, opts?: { maxBytes?: number }): Promise<T>;
  deletePrefix(prefix: string): Promise<{ deleted: number }>;
  assertLifecycle(prefix: string): Promise<LifecycleCheck>;
}
```

Notes that matter:

- `readJson` is on the port, not in the provider. The provider is handed a reader; it never
  imports `@google-cloud/storage`. That keeps `batch.ts` testable against recorded fixtures and
  keeps exactly one file in the tree that knows what GCS is.
- The overview writes `fetchBatchResult?(cfg, op, req)`. The implemented third argument is
  `{ req, read }` where `read` is `StagingStore['readJson']`. Cosmetic widening of the same seam.
- The GCS adapter reuses the **same parsed service-account credentials** as `auth.ts`
  (`google.ts:51-77` is the ancestor of that resolution order). One credential, scopes
  `cloud-platform` + `devstorage.read_write`. A second credential setting would be a second thing
  for a newsroom admin to get wrong.
- `maxBytes` on `readJson` defaults to 256 MB and fails loudly above it. A 2-hour transcript is
  15–25 MB of JSON; a 200 MB read means something is wrong, and OOM is a worse way to find out.

### 5. Bucket validation, at settings-save time

Not at run time. The failure "your bucket is in the wrong region" must surface when the admin
pastes the bucket name, not ninety minutes into a job.

```ts
// staging/validate.ts
export async function validateStagingBucket(
  ctx, bucket: string, recognizerRegion: string
): Promise<ValidationReport>
```

Checks, in order, all reported together rather than short-circuiting:

| Check | Fail message |
|---|---|
| `bucket.getMetadata()` succeeds | `Cannot read bucket 'x'. The service account needs storage.buckets.get — run: gcloud storage buckets add-iam-policy-binding gs://x --member=serviceAccount:SA --role=roles/storage.legacyBucketReader` |
| `locationType === 'region'` | `Bucket 'x' is multi-region (US). batchRecognize requires the bucket and the recognizer to be co-located and a multi-region bucket cannot prove that. Create a regional bucket in <region>.` |
| `location.toLowerCase() === recognizerRegion` | `Bucket 'x' is in asia-southeast1 but the recognizer region is europe-west4. batchRecognize requires them to match. Create a bucket in europe-west4, or change the region in Settings → Providers.` |
| write + delete probe on `thibi-staging/.probe-<ts>` | `Cannot write to gs://x/thibi-staging/. The service account needs storage.objects.create and storage.objects.delete.` |
| `assertLifecycle('thibi-staging/')` | see §6 — reported here, refused at stage time |

**Measured 2026-08-10 — the first check is the one that fires, and the draft's remedy was
wrong.** Against the project's real bucket `gs://thibi-stt-staging-asse1`, the app service
account held `roles/storage.objectAdmin` and the results were:

```
getMetadata     403  storage.buckets.get denied
write probe     200
delete probe    204
```

It could write and delete freely and could not read the bucket's own region or lifecycle rule.
`roles/storage.objectAdmin` is the obvious least-privilege grant for a staging bucket and it does
**not** include `storage.buckets.get`; so a correctly-provisioned bucket fails validation on
check 1, and the check that matters most (§6's retention guarantee) can never be evaluated.

Two consequences, both now in the design:

- The remediation role is **`roles/storage.legacyBucketReader`**, which adds exactly
  `storage.buckets.get` and `storage.objects.list`. The draft said `roles/storage.admin`. Telling
  a newsroom to grant full bucket administration in order to read a metadata field is advice that
  gets copy-pasted and then lives in their IAM policy forever. After granting the narrow role all
  four checks pass: `location ASIA-SOUTHEAST1`, `locationType region`, `storageClass STANDARD`,
  `lifecycle Delete age=1`.
- `location` comes back **upper-cased** (`ASIA-SOUTHEAST1`). The `.toLowerCase()` in the table
  above is load-bearing, not defensive, and there is a test for it.

`toError` (`google.ts:131-152`) is ported, but the region hint at `:139-141` — *"Chirp 2 and
Burmese only overlap in asia-southeast1 and europe-west4"* — is **deleted on sight**; the research
disproved it. Its replacement is a staging hint: a `PERMISSION_DENIED` whose message mentions
`storage.objects` or `gcp-sa-speech` prints the `gcloud storage buckets add-iam-policy-binding`
line for the Speech service agent
(`service-<PROJECT_NUMBER>@gcp-sa-speech.iam.gserviceaccount.com`), a distinct principal from the
caller.

**Measured 2026-08-10 — but that hint is for the cross-project case only.** The draft called the
service agent "the second-most-common first-run failure after region mismatch". On the project
that ran spike S3 the agent does not appear in the bucket's IAM policy at all, and batch worked
anyway: the project policy carries an automatic

```
roles/speech.serviceAgent  service-477538743654@gcp-sa-speech.iam.gserviceaccount.com
```

binding, created when the Speech API was enabled, and it covers every bucket in that project.
**When the staging bucket lives in the same project as the recognizer — the default, and what the
setup wizard will tell people to do — there is nothing to grant.** The hint stays because a
newsroom with a shared central bucket in another project hits the real thing, but it is a
cross-project hazard and the wording says so. The hint cannot compute `<PROJECT_NUMBER>` itself:
the app service account gets a 403 on `cloudresourcemanager.projects.get`, so the message prints
the `gcloud projects describe` line that produces it rather than making a second API call behind
a permission we do not have.

Multi-region and dual-region are **refused**, with `google_gcs_staging_allow_multiregion=true` as
a documented escape hatch for an admin who already has one and accepts the risk. Being opinionated
here is cheaper than debugging an `INVALID_ARGUMENT` from Google that says nothing about location.

### 6. The lifecycle assertion

GCS lifecycle rules are bucket-scoped but support a `matchesPrefix` condition, so the rule we
require is prefix-targeted and cannot delete anything else the newsroom keeps in that bucket.

```ts
export type LifecycleCheck =
  | { ok: true; rule: { ageDays: number; prefixes: string[] } }
  | { ok: false; reason: 'missing' | 'too-long' | 'no-permission'; command: string; lifecycleJson: string };
```

Acceptance rule: **any** `Delete` action whose condition has `age <= 7` and whose `matchesPrefix`
is absent or is a prefix of `thibi-staging/`. `age > 1` is accepted with a warning; anything else
is a refusal.

```
Staging refused: gs://thibi-stt-asia has no lifecycle rule covering thibi-staging/.

Without one, a failed run leaves the newsroom's raw audio in Google Cloud Storage
indefinitely. Fix it once:

  cat > lifecycle.json <<'JSON'
  {"rule":[{"action":{"type":"Delete"},
            "condition":{"age":1,"matchesPrefix":["thibi-staging/"]}}]}
  JSON
  gsutil lifecycle set lifecycle.json gs://thibi-stt-asia
  # or: gcloud storage buckets update gs://thibi-stt-asia --lifecycle-file=lifecycle.json

Then re-run. Or unset GOOGLE_GCS_STAGING_BUCKET and long files will be chunked instead.
```

`no-permission` is a refusal too, not a shrug. The point of the rule is a retention guarantee, and
we cannot make one we cannot verify. Result cached per bucket for one hour against `ctx.clock`.

Two surfaces, one rule, and the difference matters. `thibi settings set … --check` **reports**
every finding and still saves — an admin fixing IAM and lifecycle in either order should not be
blocked from recording the bucket name. `assertLifecycle` at **stage time refuses**, before a
single byte is uploaded. Saving a bucket name spends nothing; uploading a newsroom's raw audio
into a bucket with no proven retention rule is the thing the rule exists to prevent.

**Measured 2026-08-10.** The real bucket's rule is `{"action":{"type":"Delete"},
"condition":{"age":1}}` — age 1, and **no `matchesPrefix` at all**. The acceptance rule above
already admits that ("`matchesPrefix` is absent or is a prefix of `thibi-staging/`") and it is
the right call for a dedicated staging bucket, where a bucket-wide 1-day delete is a stronger
guarantee than a prefixed one, not a weaker one. The generated fix command still emits
`matchesPrefix` because the copy-pasteable form has to be safe in the other case — a bucket the
newsroom also keeps things in.

### 7. Routing

**Rewritten 2026-08-10. The draft's rule was measured wrong and is deleted, not softened.**

It read:

```
staging && caps.modes.includes('batch') && duration > batchMinMs → batch     ← WRONG
```

with `batchMinMs` a setting defaulting to 900 s, justified by "`batchRecognize` carries minutes of
queue latency, and below that eight parallel sync chunks finish sooner". The premise is that batch
overtakes chunked sync somewhere above fifteen minutes. Spike S3 measured that it never does:

| Input | `batchRecognize` | Chunked parallel sync, concurrency 8 | Sync advantage |
|---|---|---|---|
| 30 min | 305 s (5.9× realtime) | 43 s | **7.1×** |
| 2 h | 1211 s (5.94× realtime) | 338 s | **3.6×** |

Batch throughput is flat at 5.9× realtime, so the two curves never cross. There is no duration at
which batch is the faster choice, and therefore **no duration threshold**. `batchMinMs`,
`asr_batch_min_seconds` and `thibi bench route` are all deleted — the last of those existed to
tune a threshold that should not exist, and running the same asset both ways to rediscover a
settled measurement is not a feature. This is overview amendment 2, which was recorded on
2026-08-09 and never applied to this file.

The rule that replaces it:

```ts
export interface PlanInput {
  durationMs: number | null;                // null when ffprobe could not determine it
  bytes: number;
  caps: ProviderCapabilities;
  stagingConfigured: boolean;
  force?: 'sync' | 'sync_chunked' | 'batch';
}
export interface PlanDecision { mode: RunMode; reason: string; warnings: Warning[] }
```

```
force='batch'  → batch, or throw if caps or staging forbid it
force=other    → that mode, or throw if caps forbid it
duration known && ≤ caps.syncMaxSeconds && bytes ≤ syncMaxBytes → sync
otherwise      → sync_chunked
```

Batch is now reachable **only** through `force`. Nothing about a file's own properties selects it,
because nothing about a file's properties makes it the better choice — the trade is cost against
latency and only a human knows which one this job wants. `--mode batch` on the CLI is that human;
Phase 8's overnight-import flag and Phase 11's "cheaper, slower" checkbox are the same seam, and
both were already anticipated by `force` existing.

`reason` is stored in `runs.pipeline.planReason` and printed by the CLI, always. "Why did it pick
this?" should never require reading code:

```
plan: mode=sync         reason="42s fits one 55s request"
plan: mode=sync_chunked reason="7200s exceeds the 55s sync limit; batch was not requested"
plan: mode=batch        reason="requested explicitly; 5.3x cheaper than sync and about 5.9x realtime"
```

The `sync_chunked` reason names batch without recommending it. An operator reading it should be
able to tell that another mode exists and that not choosing it was deliberate.

No staging bucket is a supported configuration and, since S3, the *faster* one. `sync_chunked`
handles any length. The `warning.no_staging` event the draft specified is **deleted**: warning on
every long run that the user could have picked a slower path made sense when batch was the
long-file default and is nagging now that it is not. What survives is the inverse — `--mode batch`
without a staging bucket is a hard error naming the setting, because the user asked for something
that cannot be done.

### 8. Cost, and where it surfaces

| Path | $/min | 50 h/month | 200 h/month |
|---|---|---|---|
| sync / `sync_chunked` (Recognition) | 0.016 | **$48.00** | $192.00 |
| `batch` (Dynamic Batch) | 0.003 | **$9.00** | $36.00 |

**Confirmed 2026-08-10, and this was the phase's one unverified premise.** `spikes/RESULTS.md`
closed with *"Still unverified: the Dynamic Batch rate advantage. `totalBilledDuration` reports
audio duration, not price, so the API cannot confirm the $0.016-vs-$0.003 figure. Since cost is
now batch's only justification, confirm against the actual bill before writing the routing rule
into code."* The Cloud Billing Catalog API answers it without waiting for a bill —
`cloudbilling.googleapis.com/v1/services/63DE-82AB-F564/skus`, service *Cloud Speech API*, read
2026-08-10:

| SKU | unit | USD |
|---|---|---|
| Cloud Speech-to-Text Recognition | minute | **0.016** (0.010 above 500k min/mo, 0.008 above 1M, 0.004 above 2M) |
| Cloud Speech-to-Text Dynamic Batch Recognition | minute | **0.003** (flat) |
| Cloud Speech-to-Text Recognition (Logged) | minute | 0.012 |
| Cloud Speech-to-Text Dynamic Batch Recognition (Logged) | minute | 0.00225 |

The table above is right: **5.33× cheaper**, and the two seeded rates are exactly the catalog's.
Batch's only remaining justification survives measurement. Two things the catalog added:

- **Recognition is tiered and Dynamic Batch is flat.** The 5.33× ratio holds only in tier 0. A
  newsroom past 500k minutes a month — 8,300 hours — sees 0.010 vs 0.003, and past 2M minutes the
  gap closes to 0.004 vs 0.003. Nowhere near this product's scale, but the ratio is a property of
  the tier and not a constant, which is one more reason the numbers live in `rates` rather than in
  code.
- **There is a `(Logged)` SKU at 25% off both paths, and we must never quietly take it.** The
  discount is for opting into data logging, which lets Google retain the audio to improve its
  models. For a newsroom transcribing confidential sources that is not a 25% saving, it is a
  disclosure. Neither rate is seeded, no code sets the flag, and if it is ever offered it is an
  explicit admin choice with that sentence next to it — not a default and not a cost optimisation.

Both numbers are seeded into the `rates` table with `source='default'`, never hardcoded in code —
Google changes prices and an admin must be able to correct them without a deploy. Three surfaces:

1. `thibi transcribe --dry-run` and the Phase 11 `ConfirmRunDialog`:
   `120 min × $0.003 = $0.36 (sync would be $1.92)`.
2. The Phase 15 setup wizard's optional GCS step, with the table above — this is the sentence that
   decides whether an admin bothers creating a bucket.
3. `/settings/providers` shows a persistent info row when no staging bucket is set. Info, never
   an error: chunked sync is a legitimate choice.

After each batch run, `usage_records` gets the **actual** minutes billed and the resolved rate,
so the estimate can be checked against reality rather than believed.

### 9. Reading the output

Batch results land as JSON in GCS, not in the LRO body. The path is not guessable — Google appends
a uuid — so take it from the operation:

```ts
// poll response, done: true
{
  "name": "projects/P/locations/R/operations/1234",
  "done": true,
  "response": {
    "@type": "type.googleapis.com/google.cloud.speech.v2.BatchRecognizeResponse",
    "results": {
      "gs://b/thibi-staging/<runId>/audio.flac": {
        "uri": "gs://b/thibi-staging/<runId>/out/audio_transcript_8f3c….json"
      }
    },
    "totalBilledDuration": "7203s"
  }
}
```

Three distinct outcomes must not be conflated:

| Shape | Meaning | Handling |
|---|---|---|
| `done:false` | still running; `metadata.progressPercent` if populated | keep polling |
| `done:true` + `error` | operation failed | `BatchStatus.failed`, retry policy applies |
| `done:true` + `response.results[uri].error` | **per-file** failure inside a successful operation | `BatchStatus.failed` with the file error — this is the one that gets missed |
| `done:true` + `response.results[uri].uri` | success | fetch |

Fallback if `results` is missing the key (it should not be): `listJson(outputPrefix)`, expect
exactly one `.json`, fail explicitly on zero or many rather than picking one.

The body is a `BatchRecognizeResults` message whose `results[]` array is **the same shape** as the
sync `RecognizeResponse.results[]`. That is the load-bearing fact of this section:

```ts
// providers/google/parse.ts — one parser, two transports
export function parseRecognizeResults(
  results: GoogleResult[],
  opts: { offsetMs: number; durationMs: number | null }
): { segments: ProviderSegment[]; wordTimingQuality: WordTimingQuality }
```

`recognize.ts` calls it with the chunk's `offsetMs`; `batch.ts` calls it with `offsetMs: 0`
because batch is whole-file. `parseOffset` (`google.ts:37-41`) travels verbatim — Google returns
durations as `"1.500s"` strings and that is a real trap. The three-tier timestamp fallback from
`google.ts:214-215` is kept but now **records its outcome** as `wordTimingQuality` (`full` if every
segment has words, `partial` if some, `none` if none) instead of degrading silently.

Order of operations after a successful fetch, and it matters:

```
1. staging.readJson(outputUri)
2. store.put(`runs/${runId}/raw/batch.json`, body)      -- archive into OUR object store first
3. parseRecognizeResults(...)
4. persist segments + COPY words in one transaction
5. staging.deletePrefix(`thibi-staging/${runId}/`)      -- only now
```

If step 2 fails, step 5 never runs and the 1-day lifecycle rule cleans up. Copy out, then delete.

### 10. What Phase 9 changes: nothing in the provider

Phase 2 drives the loop in process:

```ts
// pipeline/batch-run.ts
const op = await provider.submitBatch!(cfg, req);
await persistOperation(ctx, runId, op);                    // §3, one transaction
const backoff = cappedBackoff({ startMs: 30_000, maxMs: 300_000, factor: 1.5, jitter: 'full' });
for (;;) {
  if (await cancelRequested(ctx, runId)) { await provider.cancelBatch!(cfg, op); throw new Cancelled(); }
  const status = await provider.pollBatch!(cfg, op);
  if (status.state !== 'running') break;
  await ctx.clock.sleep(backoff.next());
}
```

Phase 9 deletes that loop and replaces it with two `run_steps` — `asr.batch.submit` writing
`external_ref` and setting `awaiting_external`, and a self-rescheduling `asr.poll` — calling
**the same three methods with the same `BatchOp`**, rebuilt from `runs.operation_name` +
`runs.staging_prefix` + the run's region. The single constraint that buys this: **`BatchOp` is
plain JSON-serialisable data.** No clients, no closures, no timers, no `AbortController` on the
struct. `region` and `inputUri` are fields rather than recomputed values precisely so a worker
that has never seen the submit can poll. There is a test that round-trips `BatchOp` through
`JSON.parse(JSON.stringify(...))` and polls with the result.

Cancellation in Phase 2 is SIGINT → `cancelBatch` (best effort; a `DYNAMIC_BATCHING` operation may
already be running) → `deletePrefix` → exit non-zero. Phase 9 calls exactly the same path from
`runs.cancel_requested_at`.

## Porting notes

| Old | New | Treatment |
|---|---|---|
| `lib/providers/google.ts:89-94` `speechEndpoint` | `google/endpoints.ts` | Same idea, extended with batch + operation URLs |
| `lib/providers/google.ts:37-41` `parseOffset` | `google/parse.ts` | **Verbatim**, comment included |
| `lib/providers/google.ts:101-129` token cache | `google/auth.ts` | Ported in Phase 1 off the module global onto `ctx`; batch reuses it unchanged |
| `lib/providers/google.ts:131-152` `toError` | `google/errors.ts` | Ported **minus** `:139-141` |
| `lib/providers/google.ts:11-14` region doctrine comment | — | **Must not survive.** Overview says delete on sight |
| `lib/providers/google.ts:207-221` words used only for bounds | `google/parse.ts` | **Must not survive.** Phase 1 keeps the word array; batch inherits that |
| `lib/audio/chunk.ts:25-34` `normalize` | `media_derivatives` | Batch stages the cached `norm_16k_mono_flac`, never the original upload — a 2 GB MP4 is a slow upload of something Google will re-decode anyway |
| `lib/audio/chunk.ts:40-102` chunking | — | Not used on the batch path at all |
| `lib/queue.ts:52-69` `withRetry` / `RETRYABLE` | `util/retry.ts` | Generalised with full jitter and `Retry-After`; `asr.batch.submit` = 3 × 30 s |
| `lib/db.ts:63-66` boot sweep, `lib/db.ts:70` `DELETE FROM runs` | — | **Must not survive.** Named in the overview's carry-over hazards |

Retry classification specific to this phase: poll `404`/`503` are retryable transport errors; a
poll returning `done:true` with `error.code = 8` (RESOURCE_EXHAUSTED) is a *run-level* failure, not
a poll-level one — retrying the poll accomplishes nothing.

## Tests

Fixtures in `packages/engine/src/providers/google/__fixtures__/`:

| Fixture | Contents |
|---|---|
| `batch-submit-response.json` | `{name, metadata, done:false}` |
| `batch-poll-running.json` | `done:false`, `metadata.progressPercent: 40` |
| `batch-poll-running-noprogress.json` | `done:false`, no `progressPercent` (the likely real case) |
| `batch-poll-done-success.json` | `results` map keyed by input URI |
| `batch-poll-done-file-error.json` | `done:true`, `results[uri].error` INVALID_ARGUMENT |
| `batch-poll-done-op-error.json` | `done:true`, top-level `error` |
| `batch-output-my-2spk.json` | Trimmed real `chirp_2` output, ~30 results, words with confidence |
| `batch-output-no-words.json` | `words: []` throughout — the Oromo case |
| `sync-response-my.json` | Phase 1 fixture, reused for the equivalence test |
| `bucket-metadata-*.json` | 5 variants: regional match, regional mismatch, multi-region `US`, dual-region, 403 |
| `lifecycle-*.json` | none · Delete age 1 no prefix · Delete age 1 matching prefix · Delete age 30 · SetStorageClass only |
| `operations-list.json` | Two operations, one matching our input URI |

Unit cases:

- **One-parser equivalence.** `parseRecognizeResults` over `sync-response-my.json` and over the
  `results[]` of `batch-output-my-2spk.json` produce identical `ProviderSegment[]` given the same
  `offsetMs`. This asserts the claim rather than assuming it.
- `wordTimingQuality` is `none` for `batch-output-no-words.json` and segments still get bounds
  from `resultEndOffset`.
- `planMode` table test, 9 rows: sync; exactly `syncMaxSeconds` (→ sync); one byte over
  `syncMaxBytes` (→ sync_chunked); exactly `900_000 ms` (→ **sync_chunked**, the boundary is `>`);
  `900_001` with staging (→ batch); `900_001` without staging (→ sync_chunked + warning);
  `force:'batch'` without staging (→ throws); `force:'sync'` on a 2-hour file (→ throws on caps);
  provider without `'batch'` in `modes` (→ sync_chunked).
- `assertLifecycle` over all five lifecycle fixtures; the refusal message contains the literal
  `gsutil lifecycle set` line.
- `validateStagingBucket` over all five bucket fixtures; the mismatch message names **both**
  regions; the 403 case reports `no-permission` and still runs the remaining checks.
- Poll classification: three `done:true` fixtures map to `succeeded` / `failed(op)` /
  `failed(file)` distinctly.
- `BatchOp` survives `JSON.parse(JSON.stringify(op))` and still polls — the Phase 9 constraint as
  an executable test.
- `findOrphanOperation` matches by input URI against `operations-list.json` and returns `null`
  outside the lookback window.
- `readJson` rejects above `maxBytes` with a message naming the size.
- Cancel path: `deletePrefix` is called after `cancelBatch` even when `cancelBatch` throws.

Integration, with `FakeStagingStore` + `nock`-recorded Google HTTP: full submit → persist → poll ×3
→ fetch → archive → sweep against a throwaway Postgres, asserting `runs.operation_name` is set
**before** the first poll and `staging_prefix` is empty afterwards.

Live smoke behind `THIBI_LIVE=1`, `pnpm test:live:google-batch`, on a 20-minute file. Not in CI.

## Verification

```
$ thibi settings set google_gcs_staging_bucket thibi-stt-staging-asse1 --check
Bucket thibi-stt-staging-asse1
  location        asia-southeast1 (region)   ✓ matches recognizer region
  storage class   STANDARD
  write probe     ok
  lifecycle       Delete age=1  ✓
Saved.

$ thibi transcribe fixtures/2hr.mp3 --lang my --mode batch -v
plan: mode=batch  reason="requested explicitly; 5.3x cheaper than sync and about 5.9x realtime"
staged  gs://thibi-stt-staging-asse1/thibi-staging/6f2a…/audio.flac  (63.4 MB)
op      projects/…/locations/asia-southeast1/operations/1739…  [persisted]
poll    30s … 45s … 68s …
done    20m11s   segments=1442  words=78310  wordTimingQuality=full
cost    $0.36  (sync would have been $1.92)
staging deleted (2 objects)
```

`--mode auto` does not appear here, and that is the point of §7's correction: no automatic route
reaches batch. `-v` on an `auto` run of the same file prints
`plan: mode=sync_chunked reason="7200s exceeds the 55s sync limit; batch was not requested"`.

```
$ psql -c "select mode, operation_name is not null as op, staging_prefix, cost_usd
           from runs order by created_at desc limit 1"
 batch | t |  | 0.360000

$ psql -c "select kind, quantity, usd from usage_records order by created_at desc limit 1"
 asr_minutes | 120.05 | 0.360150

$ gcloud storage ls gs://thibi-stt-staging-asse1/thibi-staging/     # empty
```

**Crash test — the one that matters.** `kill -9` the CLI immediately after `[persisted]`, then:

```
$ thibi runs resume 6f2a…
resuming batch operation projects/…/operations/1739…   (no re-submit)
done    …
$ gcloud ... operations list --filter='...' | wc -l      # exactly 1
```

**Batch requested without a bucket — an error, not a downgrade.**

```
$ thibi settings unset google_gcs_staging_bucket
$ thibi transcribe fixtures/2hr.mp3 --lang my --mode batch
error: --mode batch needs a GCS staging bucket. Set google_gcs_staging_bucket, or drop
       --mode batch: chunked sync handles any length and spike S3 measured it 3.6-7x
       faster (it costs 5.3x more).
```

The draft verified the opposite — `--mode auto` silently falling back to `sync_chunked` with a
warning. There is nothing to fall back *from* now that duration never selects batch, and silently
substituting a mode the user did not ask for is worse than saying no.

**Lifecycle refusal.** Remove the rule, re-run, confirm the run refuses *before* uploading
anything and prints the `gsutil` line. Then remove `roles/storage.legacyBucketReader` from the
service account and confirm the `no-permission` refusal names that role — the case §5 measured.

## Risks and open questions

1. **`processingStrategy: DYNAMIC_BATCHING` may not be accepted** for `chirp_2` in every region,
   or the field name may differ in the shipped v2 surface. Mitigation: fall back to plain batch,
   record `pipeline.dynamicBatching=false`, and trust `usage_records` over the estimate. The cost
   argument weakens but batch is still the cheaper path. *Partly retired 2026-08-10: spike S3
   submitted with the field in `asia-southeast1` on `chirp_2` and it was accepted. One region, one
   model, one day — the fallback stays.*
2. **Dynamic batching has no latency SLA.** Google may take hours. *Rewritten 2026-08-10: this
   risk no longer threatens a threshold, because §7 no longer has one.* What it threatens is the
   admin's expectation. S3 measured 5.9× realtime twice, but that is two samples on one day and
   the SKU makes no promise. Record `submittedAtMs → doneAtMs` in `runs.pipeline.batch` on **every**
   batch run from day one, so Phase 9 and Phase 11 can quote a real p50/p90 — "about 20 minutes,
   based on your last 14 runs" — instead of a spinner. The measured latency of this phase's live
   run goes in the work diary.
3. **No partial results.** Batch is all-or-nothing, so a 2-hour run shows 0% until it does not.
   `metadata.progressPercent` may always be absent — verify on the first live run. If it is, the UI
   shows elapsed time plus an estimate from prior runs rather than a fake bar.
4. **Refusing multi-region buckets** will annoy an admin who already has one. The escape hatch
   exists; the default stays strict because the alternative failure is opaque.
5. **The Speech service agent is a separate principal** from the calling service account.
   *Downgraded 2026-08-10, not deleted.* Measured: for a bucket in the same project as the
   recognizer the automatic project-level `roles/speech.serviceAgent` binding already covers it and
   nothing needs granting — which is why spike S3 worked with the agent absent from the bucket
   policy entirely. The failure is real only for a bucket in another project. The error hint and
   `thibi doctor` (Phase 15) still name it, worded as the cross-project case. **The one that
   actually fires is the caller's own account** — see §5.
6. **Open:** should `batchRecognize` be used for an overnight import (Phase 8)? *Sharpened
   2026-08-10: the question is no longer "below 15 minutes", since duration no longer routes
   anything. It is simply whether Phase 8's importer sets `force: 'batch'` by default.* Probably
   yes: an import nobody is waiting on is exactly the job whose latency is worth 5.33× less money.
   Deferred to Phase 8; `planMode` takes `force`, so the seam exists.
7. **Open:** whether inline phrase sets are accepted on the batch path if S1 said yes on sync.
   Untested — and academic for Google, since S1 measured adaptation inert on `chirp_2`.
   `BatchRequest.phraseSet` is plumbed but unused until a provider where it works arrives.
8. **New, 2026-08-10 — the estimate and the bill are still not reconciled.** §8's rates now come
   from the Cloud Billing Catalog rather than from documentation, and `usage_records` will store
   `totalBilledDuration × rate`. That is the *catalog price for the SKU we believe we used*, not
   the invoice. Nothing yet proves a `DYNAMIC_BATCHING` submission is billed against the Dynamic
   Batch SKU rather than Recognition. The check is one line of BigQuery billing export against a
   run id, it cannot be done until a bill exists, and it belongs to whoever picks up Phase 14.

## Definition of done

Two items changed on 2026-08-10 to match the corrections above; both are marked.

- [ ] `StagingStore` port with GCS and in-memory adapters; nothing outside `staging/gcs.ts`
      imports `@google-cloud/storage`.
- [ ] `thibi settings set google_gcs_staging_bucket … --check` runs region, storage-class,
      write-probe and lifecycle checks, reports all of them together rather than stopping at the
      first, and names **both** regions on a mismatch.
- [ ] The engine refuses to stage without a verifiable ≤7-day Delete lifecycle rule covering
      `thibi-staging/`, and prints a copy-pasteable `gsutil lifecycle set` command. A
      `no-permission` result is a refusal, and its message names
      `roles/storage.legacyBucketReader` — **not** `roles/storage.admin`, which is what the draft
      said and which grants far more than reading a metadata field needs.
- [ ] `submitBatch` / `pollBatch` / `fetchBatchResult` / `cancelBatch` implemented on the Google
      provider; `BatchOp` is plain JSON and has a round-trip test.
- [ ] `runs.operation_name` and `runs.pipeline.batch` are written in one transaction before any
      poll, and `runs.mode='batch'` is set before the upload; `thibi runs resume` re-polls without
      re-submitting, proven by `kill -9`.
      *(Amended: the draft paired this with `run_steps.external_ref`, a column that does not
      exist until Phase 9.)*
- [ ] `planMode` returns `batch` **only** when explicitly forced, never from duration; it throws
      when `force:'batch'` is given without a staging bucket; and it always returns a `reason`
      that the CLI prints.
      *(Amended: the draft required `batch` above 900 s, which spike S3 disproved.)*
- [ ] Batch output is read from the URI in the LRO response, archived to MinIO before parsing, and
      parsed by the same `parseRecognizeResults` as the sync path — asserted by an equivalence test.
- [ ] A per-file `results[uri].error` under `done:true` is classified as a failure, not a success.
      S3 hit it in 1 run of 5.
- [ ] Staging prefix is deleted after a successful archive; the lifecycle rule is the backstop.
- [ ] `--dry-run` prints the batch-vs-sync cost comparison from the `rates` table, and
      `usage_records` records actual spend after the run.
- [ ] `thibi transcribe --mode batch` completes end to end on real audio, and the measured batch
      latency is recorded for Phase 9 to use.
- [ ] No file in the tree contains the stale region doctrine or the `DELETE FROM runs` sweep.

