# Phase 14 — UI: settings and admin

## Goal

At the end of this phase **an administrator can configure, operate and account for the instance
without a terminal**. Every provider credential, every per-pass model choice, every enabled
language, every user, the retention policy, the cost rate table, the queue and the health of
every service is a page in the browser. This phase also retires the Cloud Billing catalog
scraper in favour of a plain rate table plus recorded spend. It comes after the editor because
until Phase 13 there was nothing worth configuring, and before Phase 15 because the deployment
story ("first run must be one question") is only true if everything else is reachable in the
UI — Phase 15's `/setup` wizard hands off to these pages.

## Prerequisites

| Needs | From |
|---|---|
| `settings` with AES-256-GCM ciphertext, precedence, masking, `hint`; `requireAdmin()`; users, sessions, invites | Phase 10 |
| `model_profiles`, prompt files with versions, `editorial_passes` | Phase 6 |
| `language_support` + `packages/eval/results/tiers.json` | Phase 5 |
| `run_steps`, `run_chunks`, dead-letter, reconcile, cancel | Phase 9 |
| `usage_records` written by ASR and LLM steps | **Phase 2** for ASR (both SKUs, from Google's own reported `totalBilledDuration`); Phases 4 and 6 for the rest |
| `audit_log`, `media_access_log`, `segment_revisions` | Phases 10–13 |
| shadcn `Tabs`, `Table`, `Switch`, `Dialog`, `Select`, `Badge`, `Toast` | Phase 11 |

## Deliverables

### Migrations

| Path | Purpose |
|---|---|
| `packages/db/migrations/0016_retention.sql` | `media_assets.legal_hold bool default false`, `deleted_at`, `deleted_reason`; `settings` seeds for the retention keys |
| ~~`packages/db/migrations/0017_rates_seed.sql`~~ | **Not needed.** `rates` and `usage_records` ship in Phase 2's `0001_spend.sql`, seeded by `seedRates()` from `packages/db/src/seed/rates.ts`. See the reconciliation note in Design §Rates. |
| `packages/db/migrations/0018_probe_cache.sql` | `service_probes(service, ok, version, detail jsonb, latency_ms, probed_at)` |

### Web — settings

| Path | Purpose |
|---|---|
| `apps/web/app/(app)/settings/layout.tsx` | sidebar nav + `requireAdmin()` |
| `apps/web/app/(app)/settings/providers/page.tsx` | nine provider cards |
| `apps/web/components/settings/provider-card.tsx` | the ported Save / Test / result pattern, per-card busy state |
| `apps/web/components/settings/secret-field.tsx` | masking, `hint`, "set in .env" badge, override button |
| `apps/web/app/(app)/settings/models/page.tsx` | one row per editorial pass |
| `apps/web/components/settings/prompt-viewer.tsx` | read-only prompt + version + changelog line |
| `apps/web/components/settings/test-on-segments.tsx` | 3-segment dry run with entity-drift diff |
| `apps/web/app/(app)/settings/languages/page.tsx` | `tiers.json` as a table with toggles and anchors |
| `apps/web/app/(app)/settings/users/page.tsx` | list, invite, role, reset, deactivate |
| `apps/web/app/(app)/settings/retention/page.tsx` | two policies, legal hold, dry run, shred |
| `apps/web/app/(app)/settings/spend/page.tsx` | tabs: Rates · Spend |
| `apps/web/app/api/settings/route.ts` | GET returns `{value, source, hint}` per key; PUT applies |
| `apps/web/app/api/settings/test/route.ts` | one probe per provider |

### Web — admin

| Path | Purpose |
|---|---|
| `apps/web/app/(app)/admin/queue/page.tsx` | running / pending / failed / dead / scheduled |
| `apps/web/app/(app)/admin/system/page.tsx` | the service matrix + Copy diagnostics |
| `apps/web/app/(app)/admin/audit/page.tsx` | tabs: Edits · Exports · Media access |
| `apps/web/app/actions/{settings,users,retention,queue}.ts` | server actions |

### Engine

| Path | Purpose |
|---|---|
| `packages/engine/src/settings/schema.ts` | the key registry replacing `lib/settings.ts`'s `SETTING_KEYS` |
| `packages/engine/src/providers/*/probe.ts` | one `probe(cfg)` per provider, shared by the UI, the CLI and `/admin/system` |
| `packages/engine/src/pricing/rates.ts` | rate lookup, estimate, `recordUsage` — **a refactor, not a build**: `resolveRate`/`unitForMode` already live in `@thibi/db` and `recordUsage` in `pipeline/batch-persist.ts`, both shipped in Phase 2 |
| `packages/engine/src/pricing/rollup.ts` | spend by month / project / user |
| `packages/engine/src/retention/sweep.ts` | `maintenance.retention` handler + `dryRun()` returning the same shape |
| `packages/engine/src/system/probes.ts` | postgres, minio, staging, sidecar, workers |
| `packages/engine/data/rates.default.json` | seeded rates with a `pricedOn` date — **exists as `packages/db/src/seed/rates.ts`**, dated and with per-row provenance; convert to JSON only if the admin UI needs to diff it |
| `packages/engine/data/model-profiles.default.json` | seeded per-pass model choices, pinned and dated |

### Deleted

| Path | Why |
|---|---|
| `lib/pricing/catalog.ts` (200 lines) | not ported — see §6 |
| `lib/pricing/resolve.ts` | not ported |
| `app/api/pricing/route.ts` | not ported |
| `app/settings/page.tsx:237-327` "Cost estimates" card | replaced by `/settings/spend` |

---

## Design

### 1. `/settings/providers`

#### What is ported, and why it is good

`app/settings/page.tsx` gets the shape right. Three things carry over unchanged in spirit:

1. **Card → fields → Save → Test connection → inline result** (`:143-171`). Each provider is
   self-contained; you configure one thing and immediately find out whether it works.
2. **Test surfaces the provider's own error text** (`app/api/settings/test/route.ts:49-58`
   parses `error.message` out of the response body). Google's
   *"Cloud Speech-to-Text API has not been used in project X before or it is disabled. Enable it
   by visiting https://console.developers.google.com/apis/api/…"* is more useful than anything
   we could write, and it contains the fix as a link. Do not wrap provider errors in our own
   prose.
3. **"Nothing configured" is distinguished from "configured but unreadable"** (`:23-31`). A
   typo'd credential path must not look identical to an empty setup.

One structural change: `busy` is a single string in the old page, so saving one card disables
every button on the page. With nine cards that is wrong. Busy state moves into `<ProviderCard>`.

```tsx
<ProviderCard
  id="google"
  title="Google Speech-to-Text v2"
  blurb="Primary ASR. 107 languages, including 44 that no OpenAI model accepts."
  fields={GOOGLE_FIELDS}
  testLabel="Test connection"
/>
```

#### Delete on sight

| Delete | Where | Why |
|---|---|---|
| `"Chirp 2 and Burmese only overlap in asia-southeast1 and europe-west4. us-central1 will not work."` | `app/settings/page.tsx:27` | **The research disproved it.** `my-MM` returns identical correct output from all three regions |
| the `SETTING_DEFAULTS` doc comment repeating the same claim | `lib/settings.ts:29-35` | same |
| `"chirp_2 is the model with documented my-MM support."` | `app/settings/page.tsx:33` | true but Burmese-specific; the model select is now driven by `provider-matrix.json` per language |
| `"Secrets are stored in plaintext in ./data/app.db … don't deploy it as-is."` | `app/settings/page.tsx:329-333` | false here, and the replacement is the real threat model, below |
| the entire Cost estimates section | `app/settings/page.tsx:237-327` | §6 |

Region becomes a `Select` over the regions in `provider-matrix.json`, with the hint replaced by
the thing that *is* true:

> Any region works for the languages we have measured. Choose the one nearest your newsroom for
> latency. **If you configure a staging bucket below, its location must match this region** —
> `batchRecognize` rejects a cross-location bucket.

The secrets footnote is replaced with the README's threat model, verbatim, because it is the
sentence that determines whether an admin trusts the box:

> Credentials are encrypted with AES-256-GCM using `APP_SECRET_KEY`. This protects you if a
> database backup leaks — the realistic failure, since `pg_dump` output ends up in Dropbox. It
> does not protect you from someone with root on this host.

#### Cards

| Card | Fields | Test probe |
|---|---|---|
| Google Speech-to-Text v2 | SA JSON 🔒, project id, region, default model | mint token, `GET .../recognizers` — ported from `test/route.ts:40-61` |
| **Google staging bucket** | bucket, (location shown, read from the bucket) | `HEAD` bucket → read location → compare to region → `GET ?lifecycle` → assert a ≤1-day rule covering `thibi-staging/` |
| OpenAI | api key 🔒, base URL | `GET /v1/models` |
| Groq | api key 🔒 | `GET /openai/v1/models` |
| OpenRouter | api key 🔒 | `GET /api/v1/key` — returns remaining credit; show it |
| Anthropic | api key 🔒 | `GET /v1/models` — ported from `test/route.ts:75-79` |
| ~~ElevenLabs~~ | — | **Dropped 2026-08-12**, overview amendment 48. No card, no key, and no "diarization fallback" copy anywhere in Settings |
| faster-whisper / sidecar | base URL, shared token 🔒 | `GET /healthz` → render device, torch version, models loaded |
| yt-dlp ingest | domain allowlist, max filesize, max duration | none (local) |

The staging-bucket card carries the arithmetic, because this is the one optional setting with a
number attached:

> Long files can be staged to Google Cloud Storage and transcribed with `batchRecognize`
> instead of being split into parallel chunks. **Recognition is \$0.016/min; Dynamic Batch is
> \$0.003/min — 50 hours a month is \$48 versus \$9.** Leave it blank and long files are chunked
> instead; nothing breaks, it just costs more.
>
> The bucket must be in the same location as your recognizer region (`asia-southeast1`), and it
> must have a lifecycle rule deleting objects under `thibi-staging/` after 1 day. Test connection
> checks both and prints the `gsutil lifecycle set` command if the rule is missing.

Location validation runs twice: client-side against the region select before Save (instant, and
catches the typo), and server-side by actually reading the bucket's location in the probe
(authoritative). Refusing to stage without the lifecycle rule is engine behaviour from the
overview; the card just makes the failure legible before the first 2-hour file.

#### Env-sourced values

`GET /api/settings` returns, per key:

```json
{ "google_project_id": { "value": "thibi-prod", "source": "db",  "hint": null },
  "anthropic_api_key":  { "value": null,        "source": "env", "hint": "sk-ant-…4f2a",
                          "env": "ANTHROPIC_API_KEY" } }
```

Precedence is unchanged from `lib/settings.ts:47-54`: **db → env → default**. What changes is
that the UI says so. Today an env-provided key renders as an empty password box; an admin types
a new key, saves, and now has a database value shadowing an env value with no indication that
either exists. So:

- `source === 'env'` → the field is **read-only**, shows the `hint`, and carries a
  `set in .env` badge whose tooltip names the variable.
- An **Override in database** button unlocks it and shows one line: "A value saved here takes
  precedence over `ANTHROPIC_API_KEY`. The environment variable will be ignored until you clear
  this."
- `source === 'default'` → placeholder styling, badge reads `default`.

Masking behaviour is ported exactly from `lib/settings.ts:72-80`: PUT only writes values that
are non-empty and not the mask sentinel, so an untouched masked field never clobbers a stored
secret. Add the `hint` (`sk-ant-…4f2a`, last four characters) so the field is identifiable
rather than eight anonymous dots — "is this the right key" is otherwise unanswerable without
re-pasting it.

---

### 2. `/settings/models`

One row per editorial pass, backed by `model_profiles`.

| Pass | Provider | Model | Temp | Batch | |
|---|---|---|---|---|---|
| Cleanup | ▾ | ▾ | 0 | 25 | [Test on 3 segments] |
| Translate | ▾ | ▾ | 0.2 | 15 | [Test on 3 segments] |
| Entities | ▾ | ▾ | 0 | 40 | [Test on 3 segments] |
| Document | ▾ | ▾ | 0.3 | — | [Test on 3 segments] |

The provider select lists **all** LLM providers; unconfigured ones appear disabled with
"configure on Providers →" rather than being hidden. A missing option is indistinguishable from
an unsupported one.

Seeded defaults live in `packages/engine/data/model-profiles.default.json`, pinned with a
`pinnedOn` date and a comment. **This plan deliberately does not name model ids or prices**: a
document that hardcodes them is wrong within a quarter, and the seed file plus the eval report
is the thing that gets updated. The migration seeds from the file; the page shows the pinned
date next to a "Reset to defaults" link.

Help text under the table, carrying the research:

> **Cleanup wants restraint, not capability.** Scored as CER against a punctuated reference with
> "do nothing" as the control, the previous prompt was worse than doing nothing in every language
> tested — Burmese 0.016 → 0.033, Yoruba 0.059 → 0.148 — because a capable model rewrites what it
> thinks is wrong. A small model at temperature 0 stays closer to what was said. Default to the
> smallest model that punctuates well.
>
> **Translation is the reverse.** chrF2 rises with model capability; use the best one you are
> willing to pay for. [See the eval report →](/settings/languages#report)

#### "Test on 3 segments"

Picks the **three longest** segments of the most recent completed run in the instance (longest,
because short segments hide every failure mode), calls the pass with `dryRun: true` so nothing
is persisted, and renders:

```
Segment 412  (18.4 s)
  before  ကျွန်တော်တို့ NLD ကို ၂၀၁၅ မှာ …
  after   ကျွန်တော်တို့ NLD ကို ၂၀၁၅ မှာ …
  ✓ no entity drift · +3 characters

Segment 88   (16.1 s)
  before  … the UN said …
  after   … they said …
  ⚠ entity drift: "UN" removed
```

Entity drift is the same metric as `thibi eval cleanup` — Latin-script tokens and digit strings
added, removed or changed — imported from `packages/core/src/metrics`. That is the whole reason
the metric lives in core rather than in the harness: the eval and the settings page must agree
on what "damaged a quote" means. Footer prints tokens in/out, cost for the three segments, and
the extrapolation to a full run of that length.

#### The prompt, read-only

```tsx
<PromptViewer id="cleanup" />
```

Renders the prompt text from `packages/engine/src/llm/prompts/cleanup.md` with a version pill
(`cleanup@v3`), the `prompt_version` currently recorded on new passes, and a one-line changelog
(`v3: removed "fix obvious spelling and Unicode normalization errors" — the measured cause of
the CER regression`). Copy button.

Read-only is a decision, not a stub. Prompts ship with the image, are version-controlled, and
are gated in CI by `thibi eval cleanup`, which exits non-zero if any language's prompt CER
exceeds its do-nothing control. **A text box here would route around the only guard that
exists**, and the regression the whole project is built to avoid would come straight back.
Showing the prompt still serves the real need: an operator who can read it can report
misbehaviour precisely, quoting the clause.

---

### 3. `/settings/languages`

`language_support` joined with the static registry, rendered as one table. Without this page a
107-row picker is unusable for a newsroom that works in three languages.

| Language | Script | Tier | CER | ×my | n | Evaluated | Provider | On |
|---|---|---|---|---|---|---|---|---|
| မြန်မာ · Burmese | Mymr | ● verified | 0.094 | 1.00 | 61 | 2026-07-28 | google/chirp_2 | ☑ |
| Hausa · Hausa | Latn | ● verified | 0.101 | 1.07 | 42 | 2026-07-28 | google/chirp_2 | ☑ |
| አማርኛ · Amharic | Ethi | ◐ beta | 0.152 | 1.62 | 30 | 2026-07-28 | google/chirp_2 | ☑ |
| Afaan Oromoo · Oromo | Latn | ○ experimental | 0.410 | 4.36 | 30 | 2026-07-28 | google/chirp_2 | ☐ |
| සිංහල · Sinhala | Sinh | ○ experimental — no eval set | — | — | — | — | google/chirp_2 | ☐ |

Rules:

- **Tier pills are green-outline / amber / dotted-grey. Never red.** These are honest quality
  statements about what we measured, not errors. A red pill tells a journalist the tool is
  broken; a dotted-grey one tells them to expect more corrections, which is true.
- Every row carries `id={code}` with `scroll-margin-top` clearing the sticky header. The
  picker's inline note links to `/settings/languages#am-ET`, which lands on the row and pulses a
  ring for 2 s. The whole point of the tier system is that the warning traces to a number you can
  click.
- Defaults: **verified + beta enabled; experimental off**, behind a `Show experimental (63)`
  toggle. `unsupported` rows are always listed but permanently disabled, showing the reason
  ("code rejected by provider", "script integrity 0.31 — output is romanized").
- The toggle writes `language_support.enabled`. A disabled language disappears from the picker
  but **never from an existing job** — disabling must not break a transcript already in flight.
  Attempting to disable a language with active runs shows the count and asks for confirmation.
- **Recompute from `tiers.json`** re-imports `packages/eval/results/tiers.json` shipped in the
  image, and shows a diff before applying, with tier changes at the top in the same shape as the
  dated report:

```
  ha-NG   beta → verified      CER 0.101 (was 0.118), n 42 (was 30)
  om-ET   experimental → beta  CER 0.410 → 0.339
  ps-AF   verified → beta      CER 0.131 → 0.221   ⚠ regression
  61 languages unchanged.
```

- Footer states the rule verbatim so the numbers are interpretable in place:

```
verified      ratio ≤ 1.15 and CER ≤ 0.20 and n ≥ 30, 95% bootstrap CI clear of the beta
              line, and a human sign-off. The harness can never award this on its own.
beta          ratio ≤ 2.0 and CER ≤ 0.35
experimental  correct script, worse
unsupported   code rejected, or script integrity < 0.8, or CER > 0.6
```

- Filter by tier, script, provider, enabled; search across endonym, English name and code.
- A `#report` anchor at the bottom links to the dated ASR and LLM reports bundled in the image.

---

### 4. `/settings/users`

Table: username · display name · role · status · last seen · created.

| Action | Behaviour |
|---|---|
| **Invite** | creates an `invites` row (sha256 of the token, role, expires in 7 days, `created_by`) and shows the URL **once**, with Copy. No SMTP: a self-hosted box behind a home ISP cannot reliably send mail, and shipping a broken email flow is worse than not shipping one. The dialog says: *"This link is a credential. Send it the way you would send a password."* |
| **Reset password** | same mechanism, single-use, 24 h. Alternative: set a temporary password with `must_change_pw = true` (the column exists), for handing over in person |
| **Change role** | admin / editor. Demoting the last admin is blocked under `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, the same guard family as `/setup` |
| **Deactivate** | sets `disabled_at` **and deletes every session for that user**. The confirm dialog says "This ends their active sessions immediately." This is the concrete reason auth is server-side sessions rather than JWT: an admin disabling a compromised account expects it dead now, not in fifteen minutes |
| **Delete** | does not exist. Edits are attributed (`segment_texts.author_id`, `segment_revisions.author_id`, `audit_log.user_id`); deleting a user either orphans that history or rewrites it. Deactivate, and say so in the UI |

Invite acceptance is `/invite/[token]` → choose username + password (argon2id via
`@node-rs/argon2`) → session created → land on the job list. Rate-limited per token and per IP,
same limiter as login.

---

### 5. `/settings/retention`

**Both policies off by default.** This page can destroy a newsroom's source material; every
control on it is built around that.

| Setting | Default | Deletes | Keeps |
|---|---|---|---|
| `retention_audio_days` | **off** | the object bytes for `media_assets` and their derivatives | the row, with `deleted_at` and `deleted_reason`, so the job page says "source audio deleted per policy on 2026-05-01" instead of showing a broken player |
| `retention_transcript_days` | **never** | segments, words, `segment_texts`, documents, exports | the job and run rows as tombstones |

They are separate because the reason to delete audio (storage, and a source who asked) is not
the reason to delete a transcript (a legal policy), and the sensible settings are usually
90 days and never.

**Legal hold.** `media_assets.legal_hold` exempts an asset from every sweep *and* from manual
shred. Set per asset from the job page, or in bulk for a project. A banner on this page shows
`7 recordings are on legal hold and will never be deleted automatically.`

**The mandatory dry run.** The Save button is disabled until a dry run has been executed against
the *current* form values. `retention_dryrun_at` and a hash of the policy are stored; changing
any field invalidates it and disables Save again.

```
Dry run — 2026-08-09 14:02

  This policy would delete 34 recordings totalling 8.2 GB tonight.
  3 more match but are on legal hold and will be kept.

  Oldest:   2024-11-02  "Mandalay interview 03"        1.1 GB
  Newest:   2026-05-11  "Election press conference"    280 MB
  Projects: Election 2026 (21) · Unfiled (13)

  [ Show all 34 ]  [ Download CSV ]
```

`dryRun()` and the real sweep are **the same function** with a flag, returning the same shape.
A dry run computed by different code than the sweep is worse than no dry run.

**Shred now**, per media asset, from the job page and from this page's search: deletes the
objects immediately, writes `audit_log`, keeps the row with `deleted_reason = 'manual shred by
<user>'`. Confirmation requires typing the filename — this is the one place a confirmation
dialog earns its friction.

**The versioning conflict, documented rather than hidden.** If MinIO bucket versioning is
enabled, `DeleteObject` writes a delete marker and the bytes remain retrievable. "Shred now"
would then be a lie. So:

- Versioning is a deploy-time choice: `MINIO_VERSIONING=off|on` in `.env`, **off by default**,
  documented in the README as a tradeoff (accidental-deletion protection versus the ability to
  actually destroy something on request).
- The page probes `GetBucketVersioning` on load. With versioning on, the button reads
  **"Shred now (purges all versions)"** and the engine issues versioned deletes; if the
  credentials cannot do that, the button is disabled with the reason. It is never a silent
  no-op.

**Surfacing the policy where it bites.** The job list shows a one-line banner —
`Media older than 90 days is deleted automatically. Transcripts are kept indefinitely.` — and
each affected row gets an `audio deleted 2026-05-01` chip. Nobody should discover the retention
policy by finding a missing file.

The sweep runs as `maintenance.retention` on the queue, nightly, and writes a summary to
`audit_log` that `/admin/system` surfaces as "last sweep: 6 hours ago, 4 recordings, 0.9 GB".

---

### 6. Cost and spend

#### The catalog scraper is dropped. Say it plainly.

`lib/pricing/catalog.ts` (200 lines) plus `lib/pricing/resolve.ts` (118) exist to guess which of
roughly a dozen Speech-to-Text SKUs applies to a given account. Its own header comment concedes
the problem: *"picking 'the' SKU is a judgement call — Recognition, Recognition (Logged) and
Dynamic Batch Recognition are all legitimate answers depending on the account."* To make that
guess it needs the Cloud Billing API enabled, an extra IAM permission, and a walk through ~1,800
services; it cannot see volume tiers (`resolve.ts:12-13` says so); and after all of it the UI
still needs a manual override that wins over everything (`resolve.ts:90-91`) — which is what
anyone who cares about the number ends up using. With five providers instead of one, that is
five scrapers, five auth paths and five judgement calls.

It is not ported. In its place, two tables that were already in the data model:

```
rates          provider, model, unit, usd_per_unit, source (default|override)
usage_records  run_id, step_id, kind (asr_minutes|llm_tokens), quantity, usd
```

> **Both tables already exist — Phase 2 built them, 2026-08-10.** Not a land-grab: Phase 2's
> entire justification is a price difference (`batchRecognize` is *slower* than chunked sync at
> every duration and worth using only because it is 5.33× cheaper), and a cost argument with no
> ledger behind it is a claim. Its definition of done required `--dry-run` to cost from the table
> and `usage_records` to hold actual spend, so the table came with it.
>
> Reconcile this phase against what shipped rather than building it twice:
>
> | This plan says | What exists |
> |---|---|
> | migration `0017_rates_seed.sql` | `0001_spend.sql`, applied. This phase adds no migration for these two tables. |
> | `packages/engine/data/rates.default.json` with a `pricedOn` date | `packages/db/src/seed/rates.ts` — a typed `DEFAULT_RATES` array with the provenance in each row's `note` and the date in the file header. Move it to JSON if the admin UI wants to diff it; the dating requirement is already met. |
> | `packages/engine/src/pricing/rates.ts` — lookup, estimate, `recordUsage` | `resolveRate` and `unitForMode` in `@thibi/db`, `recordUsage` in `packages/engine/src/pipeline/batch-persist.ts`. Both want moving into a `pricing/` module here; that is a refactor, not a build. |
> | unit `audio_minute` (see the Rates tab table below) | **`minute` and `batch_minute`.** Two units rather than one, because they are two SKUs at different prices for the same physical minute, which keeps the lookup a single equality instead of a nullable `sku` column. The tab below must render `google · chirp_2 · batch_minute`, not a synthesised "chirp_2 · batch" row. |
> | — | A `*` model wildcard row per provider, so a run on a model nobody priced is costed rather than silently free. The grid has to show and allow editing those. |
>
> `resolveRate` returns **null**, never 0, when nothing matches, and `recordUsage` writes no row —
> "we do not know what this cost" and "$0.00" are different facts and only one of them is
> honest. The Rates tab and the confirm dialog both have to carry that distinction through.
>
> One rate the seed deliberately omits, and the tab should explain rather than offer: Google
> publishes `Cloud Speech-to-Text Recognition (Logged)` at $0.012/min and
> `Dynamic Batch Recognition (Logged)` at $0.00225 — **25% off both, in exchange for Google
> retaining the audio to improve its models.** For a newsroom transcribing confidential sources
> that is a disclosure and not a saving. Nothing in the codebase sets the flag that earns it. If
> this phase surfaces it at all it is as an explicit choice with that sentence beside it, never
> as a default and never framed as a cost optimisation.

The rate table is **configuration**, seeded with committed defaults and editable in one grid.
The usage table is **fact**, written by each step from the provider's own reported usage —
Google returns billed duration, the AI SDK returns token counts. That is the number that
matters, and no catalog can produce it.

#### `/settings/spend` — Rates tab

| Provider | Model | Unit | USD per unit | Source | |
|---|---|---|---|---|---|
| google | chirp_2 | audio_minute | 0.016 | default | ✎ |
| google | chirp_2 · batch | audio_minute | 0.003 | default | ✎ |
| openai | whisper-1 | audio_minute | 0.006 | default | ✎ |
| groq | whisper-large-v3 | audio_minute | 0.00185 | default | ✎ |
| faster-whisper | * | audio_minute | 0.000 | default | ✎ |
| anthropic | *(per model)* | input_token / output_token | *(from seed)* | default | ✎ |

Editing sets `source = 'override'` and stamps `updated_by`. A "Reset to defaults" per row
restores the seed. The seed file carries `pricedOn`; the page shows
`Defaults priced 2026-06-01 — check your provider's current pricing.` **Exact per-token prices
are not written into this plan** for the same reason model ids are not: they belong in
`rates.default.json` with a date, not in a document that will be read a year from now.

One line at the top of the tab, and it matters:

> These are your numbers, used for estimates and for the spend report. They are not an invoice.
> Your provider's bill is the only authoritative figure.

#### `/settings/spend` — Spend tab

`usage_records` rolled up three ways, plain tables, no charts:

| By month | ASR minutes | ASR \$ | LLM tokens | LLM \$ | Total |
| By project | … | | | | |
| By user | … | | | | |

"By user" is the person who started the run (`runs.created_by`), which is what a newsroom
manager is actually asking. Date-range filter, CSV export, and a `This month: $41.20` figure in
the admin nav.

#### The pre-run estimate stays

`ConfirmRunDialog` (`job-detail.tsx:112-212`) is kept — it is the last point before a charge and
the Escape/focus behaviour is already right. Extended to itemise:

```
  Provider           Google Speech-to-Text (chirp_2, batch)
  Audio length       118.4 min
  Transcription      $0.36
  Clean up           ~$0.04   (≈ 31k in / 31k out)
  Translate → en     ~$0.61   (≈ 31k in / 34k out)
  ──────────────────────────────
  Estimated total    $1.01

  Rates last edited 2026-06-01 · these are your configured rates, not a quote.
```

and the job page afterwards shows both: `estimated $1.01 · actual $1.08`. A visible gap between
the two is how anyone discovers the rate table is stale — which the catalog scraper never
achieved despite 320 lines of trying.

`durationSec == null` keeps its amber warning from `:188-192`. The "this file already has N
runs — transcribing again is charged again" warning at `:181-186` also stays; it is the single
most useful line in that dialog.

---

### 7. `/admin/queue` and `/admin/system`

#### `/admin/queue`

Tabs: **Running · Ready · Failed · Dead · Scheduled**, counts in the tab labels. Polls every
5 s — this page needs a table refresh, not per-event streaming, and SSE here would be
complexity for nothing.

| Run | Step | Shard | State | Attempt | Age | Heartbeat | External ref | |
|---|---|---|---|---|---|---|---|---|
| `a3f…` interview.wav | `asr.chunk` | 7 | failed | 5/5 | 12m | — | — | ⋯ |
| `b81…` speech.mp3 | `asr.poll` | — | awaiting_external | 1/3 | 41m | 30 s | `…/operations/1234` | ⋯ |

Row expands to `input`, `output` and `error` as pretty-printed JSON in a `<pre>` with a Copy
button. That payload is what gets pasted into a bug report; make it copyable, not screenshot-only.

Actions:

| Action | Semantics |
|---|---|
| Retry step | `attempt + 1`, state → `pending`, `reconcile(runId)` |
| Retry all dead in run | same, batched, one advisory-locked transaction |
| Retry chunk | also reachable from the run page next to the placeholder segment, since a chunk past `max_attempts` marks the run `partial`, not `failed` |
| Cancel run | `cancel_requested_at` + NOTIFY |

**The one rule this page must not get wrong:** a step in `awaiting_external` is **re-polled,
never reset**. Its Retry button issues a poll against the persisted `external_ref`; it does not
resubmit. Resubmitting a completed `batchRecognize` bills a second time for work already paid
for. The button is labelled **Poll now** for those rows, and the confirm for anything that would
resubmit spells out the cost.

A "possibly stuck" banner: steps `running` with `heartbeat_at` older than 90 s, and steps
`awaiting_external` with no poll in 10 minutes — with a note that the worker's own 60 s sweep
will handle the first case, so the banner is information, not a call to action.

#### `/admin/system`

**The page an admin screenshots when asking for help.** Optimise for exactly that.

| Service | OK | Version | Detail | Probed | ms |
|---|---|---|---|---|---|
| Postgres | ✓ | 17.2 | migration `0018` · 412 MB · 11/200 connections | 4 s ago | 3 |
| MinIO | ✓ | RELEASE.2026-05-… | bucket `thibi` · versioning **off** · 12,904 objects · 38.4 GB · lifecycle on `scratch/` ✓ | 4 s ago | 6 |
| GCS staging | ✓ | — | `thibi-staging-sg` · `asia-southeast1` ✓ matches region · 1-day lifecycle ✓ | 4 s ago | 210 |
| Sidecar | ✓ | 0.4.1 | `cuda:0` · torch 2.6 · pyannote 3.1 ✓ · distil-large-v3 ✓ · large-v3 ✗ · hf-cache 9.1 GB | 4 s ago | 14 |
| Queue | ✓ | pg-boss 10 | 3 running · 0 dead · oldest pending 4 s | 4 s ago | 2 |
| web | ✓ | engine 1.4.2 | 1 instance | — | — |
| worker | ✓ | engine 1.4.2 | queues `media,asr.cloud,…` · concurrency 6 · heartbeat 8 s | — | — |
| worker-heavy | ⚠ | engine **1.4.1** | **version mismatch with web** | — | — |
| Google STT | ✓ | v2 | project `thibi-prod` · `asia-southeast1` | 4 s ago | 180 |
| Anthropic | ✓ | — | key `sk-ant-…4f2a` | 4 s ago | 240 |

The engine-version mismatch row is deliberate: it is the exact symptom of a half-finished
upgrade (`docker compose up -d` that failed on one service), and it is otherwise invisible until
a step fails with a schema error.

Probes run server-side, in parallel, 3 s timeout each, cached in `service_probes` for at most
30 s, with a Refresh button. They reuse the **same** `probe()` functions as `/settings/providers`
and `./thibi doctor` — three surfaces, one implementation.

**Copy diagnostics** produces a redacted markdown block sized for a support message: every row
above, plus image tags, `.env` keys present (names only, never values), container uptimes, disk
free on each volume, and the last 20 error-level log lines with secrets redacted. Text beats a
screenshot: it is searchable, and it cannot be cropped in a way that hides the answer.

---

### 8. Audit views

`/admin/audit`, three tabs over three existing sources. Admin only in v1 (an editor asking to
see their own edit history is a reasonable future request; it is not v1).

| Tab | Source | Columns |
|---|---|---|
| Edits | `segment_revisions` | when · who · job / run / segment idx · layer · `prev → next` inline diff · source (human / llm / rule) |
| Exports | `audit_log` where `kind='export'` | when · who · run · format · layer · target lang · bytes |
| Media access | `media_access_log` | when · who · asset · mode (presigned / proxy) · IP · bytes (proxy only) |

Filters: user, date range, project, free-text over segment text. CSV export of the filtered
view — these tables exist because someone external asked a question, and the answer usually has
to leave the building.

One honesty note rendered on the Media access tab: in `presigned` mode the log records **who
minted a URL**, not how many bytes were served, because the bytes come from MinIO directly. In
`proxy` mode it records both. The distinction matters if the log is ever evidence.

The logs have their own retention key, `retention_audit_days`, defaulting to **never**, and it
is deliberately not covered by the media or transcript policies. An audit log that gets swept by
the same policy it is auditing is worse than no audit log.

---

## Porting notes

| From | To | Verbatim? | Notes |
|---|---|---|---|
| `app/settings/page.tsx:143-171` `actions()` | `components/settings/provider-card.tsx` | **verbatim in spirit** | Save + Test + inline ✓/✗ result. Change: per-card busy state instead of one page-wide `busy` string |
| `app/settings/page.tsx:124-141` `test()` | `provider-card.tsx` | verbatim | including rendering `✗ ${body.error}` unmodified |
| `app/api/settings/test/route.ts:49-58` error unwrapping | `packages/engine/src/providers/*/probe.ts` | **verbatim** | parse `error.message` from the body, fall back to `HTTP ${status}`. This is the most useful 10 lines in the old settings code |
| `app/api/settings/test/route.ts:23-38` empty-vs-unreadable | same | verbatim | generalised: every provider distinguishes "not configured", "configured but malformed", "configured but rejected" |
| `app/api/settings/test/route.ts:40-47` Google token + recognizers | `providers/google/probe.ts` | verbatim | cheapest authenticated call that proves the credential, the API enablement and the region |
| `app/api/settings/test/route.ts:70-86` Anthropic | `providers/anthropic/probe.ts` | verbatim | `GET /v1/models` |
| `lib/settings.ts:47-54` precedence | `packages/engine/src/settings/get.ts` | verbatim | db → env → default |
| `lib/settings.ts:60-68` `maskedSettings` | same | changed | now returns `{value, source, hint}`; secrets return `hint`, never the value |
| `lib/settings.ts:72-80` `applySettings` | same | **verbatim** | only writes non-empty, non-mask values. Do not "improve" this; it is what stops a masked field from wiping a secret |
| `app/settings/page.tsx:27` region hint | — | **must not survive** | disproved |
| `lib/settings.ts:29-35` region doctrine comment | — | **must not survive** | disproved |
| `app/settings/page.tsx:329-333` plaintext footnote | — | **must not survive** | replaced with the real threat model |
| `lib/pricing/catalog.ts` (whole file) | — | **not ported** | §6 |
| `lib/pricing/resolve.ts` (whole file) | — | **not ported** | §6 |
| `lib/pricing/format.ts` `formatEstimate` / `describeRate` | `packages/core/src/pricing/format.ts` | verbatim | the formatting is fine; only the source of the rate changes |
| `job-detail.tsx:112-212` `ConfirmRunDialog` | `components/confirm-run-dialog.tsx` | verbatim, extended | itemised passes; keep the Escape handler, focused Confirm, and both amber warnings |
| `lib/db.ts:70` `DELETE FROM runs WHERE provider NOT IN ('google')` | — | **must not survive** | destroys data at boot; called out in the overview's carry-over hazards |

---

## Tests

### Engine

| File | Cases |
|---|---|
| `settings/__tests__/precedence.test.ts` | db beats env beats default; clearing a db value falls back to env; `source` is reported correctly for all three |
| `settings/__tests__/mask.test.ts` | PUT with the mask sentinel is a no-op; PUT with `''` is a no-op; PUT with a real value rotates the ciphertext and the `hint`; AAD binding rejects a ciphertext moved to another key name |
| `pricing/__tests__/estimate.test.ts` | fixture `rates-seed.json`: 118.4 min on `chirp_2 batch` → `$0.36`; an unknown `(provider, model)` returns `null` and the dialog says "unknown", never `$0.00` |
| `pricing/__tests__/rollup.test.ts` | fixture `usage-3months.sql`: month × provider, project and user totals sum to the same grand total |
| `retention/__tests__/sweep.test.ts` | `dryRun()` and `sweep()` select the identical asset set on fixture `retention-mixed.sql` (34 eligible, 3 on hold, 2 already deleted); hold is never swept; `deleted_at` and `deleted_reason` are set and the row survives; transcript policy off means segments untouched |
| `retention/__tests__/versioning.test.ts` | with versioning on, shred issues versioned deletes; without the permission it throws `SHRED_UNAVAILABLE` rather than reporting success |
| `system/__tests__/probes.test.ts` | each probe times out at 3 s against a fixture server that never responds; a 500 with a JSON error body surfaces `error.message` |

### Web

| File | Cases |
|---|---|
| `settings/__tests__/provider-card.test.tsx` | saving card A does not disable card B; a failed test renders the provider's raw error text |
| `settings/__tests__/secret-field.test.tsx` | `source='env'` renders read-only with the badge and the variable name; Override unlocks and warns |
| `settings/__tests__/languages.test.tsx` | `#am-ET` scrolls and highlights; disabling a language with active runs asks for confirmation; no tier pill uses a red token (asserted against the class list) |
| `settings/__tests__/retention.test.tsx` | Save is disabled until a dry run; editing any field re-disables it |
| `admin/__tests__/queue.test.tsx` | an `awaiting_external` row's action reads "Poll now" and calls the poll endpoint, never submit |

### Fixtures

`rates-seed.json`, `usage-3months.sql`, `retention-mixed.sql`, `tiers-diff.json`
(before/after for the recompute preview), `probe-responses/` (recorded 200/401/403/500 bodies
per provider, including Google's "API has not been used in project" text so the unwrapping is
tested against the real string).

---

## Verification

1. Fresh instance, no `.env` provider keys. `/settings/providers` → paste Google SA JSON →
   Save → **Test connection** → ✓. Deliberately break the project id → the error shown is
   Google's own sentence, including the enable URL.
2. Set `ANTHROPIC_API_KEY` in `.env`, restart, reload the page: the field is read-only, badged
   `set in .env`, shows `sk-ant-…4f2a`. Click Override, save a different key, confirm the db
   value now wins (`thibi settings get anthropic_api_key --source`).
3. Save a card with the secret field untouched (still masked). `SELECT secret_ct FROM settings`
   is byte-identical. This is the regression that `applySettings` exists to prevent.
4. Configure a staging bucket in the **wrong** location. Save is blocked client-side; force it
   via the API and Test connection reports the mismatch and prints the `gsutil` command for the
   missing lifecycle rule.
5. `/settings/models` → change the cleanup model → **Test on 3 segments** → a before/after diff
   appears with entity drift flagged, and nothing is written (`SELECT count(*) FROM
   segment_texts` unchanged).
6. The cleanup prompt renders with `cleanup@v3` and cannot be edited — no input element in the
   subtree.
7. `/settings/languages` → the count of enabled languages matches the picker's. Follow a "see
   the measurement" link from the picker; the correct row is scrolled to and highlighted.
   Recompute from `tiers.json` shows a diff before applying.
8. Invite a user; the link works once and is dead on the second use. Deactivate them while they
   have an open tab; their next request redirects to login.
9. Demote the only admin → blocked with a clear message.
10. `/settings/retention` → set audio to 90 days → Save is disabled → run the dry run → the
    count matches `SELECT count(*) FROM media_assets WHERE created_at < now() - interval '90
    days' AND legal_hold = false AND deleted_at IS NULL` → Save enables. Change the number →
    Save disables again.
11. Trigger the sweep manually. Objects are gone, rows remain, the job page says "source audio
    deleted per policy on …", the player is replaced by that sentence rather than a broken
    element.
12. Put an asset on legal hold, sweep again: untouched, and the dry run counts it separately.
13. With `MINIO_VERSIONING=on`, Shred now says "purges all versions" and `mc ls --versions`
    afterwards is empty.
14. Run a job with cleanup and translate. Confirm dialog itemises three lines; afterwards the
    job shows estimated vs actual and `usage_records` has one ASR row and two LLM rows.
15. `/settings/spend` totals reconcile: month total = sum of projects = sum of users.
16. Kill a worker mid-chunk. `/admin/queue` shows the stale heartbeat, the sweep recovers it,
    the attempt counter incremented by exactly one.
17. Force a chunk to `max_attempts`. Run state is `partial`, the run page shows a placeholder
    segment with a Retry, and `/admin/queue` lists it under Dead with the full error payload.
18. `/admin/system` with the sidecar profile off: the sidecar row is ⚠ "not running (profile
    `local-models` is disabled)" — not a scary red failure. Copy diagnostics produces markdown
    with no secret values (`grep -E 'sk-|BEGIN PRIVATE KEY'` finds nothing).
19. Start `worker` from a different `IMAGE_TAG`; the version-mismatch warning appears.
20. `/admin/audit` → edit a segment, export a file, play some audio → all three appear in their
    tabs with the right user. CSV export opens in Excel with correct UTF-8.

---

## Risks and open questions

1. **Eight provider cards is a long page** — nine until ElevenLabs was dropped (amendment 48).
   Group them: ASR (Google, OpenAI, Groq,
   faster-whisper), Diarization (sidecar), LLM (Anthropic, OpenAI, OpenRouter),
   Storage (GCS staging), Ingest (yt-dlp) — with configured ones collapsed to a one-line summary.
   If it still sprawls, split into `/settings/providers/{asr,llm,other}` and keep the anchors.
2. **Probe latency blocks page load.** `/admin/system` runs ten network probes. They are
   parallel with a 3 s timeout and cached 30 s, but the first load after a restart is still
   ~3 s worst case. Stream the page (Suspense per row) rather than waiting for all of them.
3. **`Test on 3 segments` needs a run.** On a brand-new instance there is none. Fall back to
   three built-in fixture segments per script class, clearly labelled as samples.
4. **The rate table will go stale.** Nothing detects it. The estimated-vs-actual gap on the job
   page is the only signal, and it only works if actuals are recorded correctly. Consider a soft
   warning when a provider's median `actual / estimate` exceeds 1.25 over 20 runs — cheap, and
   it turns a silent drift into a prompt.
5. **Retention dry run against a huge instance.** Counting bytes across 12,000 objects is a
   `sum(bytes)` over `media_assets`, not an object-store walk, so it is fast — but it is
   therefore only as accurate as the recorded sizes. State the number as "approximately" and
   reconcile after the first real sweep.
6. **Open question — who may see `/admin/audit`?** v1: admin only. An editor wanting their own
   history is reasonable and cheap (`WHERE user_id = me`), but "who listened to this recording"
   must stay admin-only. Decide before the first newsroom asks.
7. **Open question — per-project model profiles.** `model_profiles` is instance-wide. A
   newsroom running an English desk and a Burmese desk may want different translate models. One
   nullable `project_id` column and a resolution order would do it; deliberately not in v1.
8. **`/settings/languages` recompute needs `tiers.json` in the image.** If a newsroom wants to
   run their own eval and import the result, they need a file upload path. Out of scope here;
   `thibi lang import ./tiers.json` from the CLI covers it and is one line.

---

## Definition of done

- [ ] Every provider credential in `SETTING_KEYS` is settable and testable in the browser; none
      requires editing `.env`.
- [ ] Test connection surfaces the provider's own error text, unmodified.
- [ ] Saving a card with a masked secret untouched leaves the ciphertext byte-identical.
- [ ] Env-sourced values render read-only with a `set in .env` badge naming the variable, and an
      explicit override path.
- [ ] The stale region hint does not exist anywhere in the repo (`grep -r 'asia-southeast1 or'`
      is empty; the only remaining mention of region is the staging-bucket location rule).
- [ ] The staging-bucket card states the \$48-vs-\$9 arithmetic and validates location + lifecycle.
- [ ] `/settings/models` has one row per pass, a working 3-segment dry run with entity-drift
      diff, and the cleanup prompt read-only with a version label.
- [ ] `/settings/languages` renders every row of `tiers.json` with tier, CER, ratio, n, date and
      provider; toggles persist; `#code` anchors land correctly; no red tier pills.
- [ ] Users can be invited by link, have their role changed, and be deactivated with immediate
      session termination. The last admin cannot be demoted. No delete.
- [ ] Both retention policies default to off/never; Save is impossible before a dry run; legal
      hold is honoured by sweep and by shred; the job list surfaces the policy.
- [ ] The MinIO versioning conflict is detected at runtime and either handled or disabled with a
      reason — never a silent no-op.
- [ ] `lib/pricing/catalog.ts` and `lib/pricing/resolve.ts` have no counterpart in this repo, and
      the plan says why.
- [ ] `rates` is editable and seeded; `usage_records` is written by every billable step;
      `/settings/spend` reconciles across all three rollups.
- [ ] The pre-run estimate itemises ASR and each selected pass; the job page shows estimated vs
      actual.
- [ ] `/admin/queue` shows running, failed and dead steps with copyable payloads, retries a
      single chunk, and **polls rather than resubmits** `awaiting_external` steps.
- [ ] `/admin/system` shows every service with version and detail, flags an engine-version
      mismatch, and produces a secret-free diagnostics block.
- [ ] `/admin/audit` answers who edited what, who exported what, and who listened to what, with
      CSV export and an honest note about presigned-mode byte counts.

