# Phase 15 — Deployment and operations

## Goal

At the end of this phase a person who is not a systems administrator can put thibi-transcribe on
a clean VPS by cloning a repository, answering **one question**, and running two commands — and
can then back it up, restore it, upgrade it, and diagnose it when it breaks. Everything before
this phase is software; this phase is the difference between software and something a newsroom
can actually run. It is last because it packages what the previous fifteen phases built, and
because the honest resource numbers it has to publish (particularly: pyannote on CPU takes hours)
are only knowable once the pipeline exists and has been measured.

## Prerequisites

| Needs | From |
|---|---|
| `apps/web` production build (`output: 'standalone'`), `apps/worker`, `apps/cli` | Phases 9–14 |
| `services/sidecar` FastAPI image | Phases 3–4 |
| committed SQL migrations + `dist/migrate.js` runner | Phase 1 onward |
| `packages/storage` S3 adapter | Phase 1 |
| encrypted settings + `APP_SECRET_KEY` | Phase 10 |
| `/setup` token flow, `requireAdmin()` | Phase 10 |
| `/settings/*`, `/admin/system` probes | Phase 14 |

## Deliverables

| Path | Purpose |
|---|---|
| `Dockerfile` | the one Node image: web, worker, migrate, cli |
| `services/sidecar/Dockerfile` | the one Python image: pyannote + faster-whisper |
| `infra/compose.yml` | the full topology |
| `infra/compose.gpu.yml` | GPU overlay (Linux only) |
| `infra/Caddyfile` | TLS + `handle_path /s3/*` |
| `infra/thibi` | the wrapper script |
| `infra/scripts/init.sh` | first-run generator |
| `infra/scripts/backup.sh`, `restore.sh`, `verify.sh` | the three-thing backup |
| `infra/minio/init.sh` | bucket + lifecycle on `scratch/` |
| `infra/.env.example` | annotated, five real settings |
| `apps/cli/src/commands/{models,secrets,doctor,run-inspect}.ts` | pre-warm, rotate, probe, inspect |
| `apps/web/app/api/health/route.ts` | `{ ok, migration, engine }` |
| `packages/storage/src/s3.ts` *(modified)* | the two-client split |
| `apps/web/app/api/media/[assetId]/url/route.ts` | presigned mint + `media_access_log` |
| `apps/web/app/api/media/[assetId]/stream/route.ts` | `MEDIA_SERVING=proxy` Range handler |
| `packages/engine/src/log/logger.ts` | pino + `AsyncLocalStorage` + redaction |
| `README.md` | the sections in §10 |
| `docs/RUNBOOK.md` | §11 plus the standard failures |
| `docs/RELEASING.md` | the release-notes contract |

---

## Design

### 1. Compose topology

#### One Node image, two commands

`web`, `worker`, `worker-heavy`, `migrate` and every `thibi` CLI invocation run the **same
image** with different commands. The reason is not build time (though it halves it): it is that
the engine version in the worker is then always identical to what the UI thinks it is talking
to. A separate worker image makes "the worker is running last week's reconciler" a possible
state, and that state fails in ways that look like data corruption. `/admin/system` can assert
`web.engine === worker.engine` precisely because a mismatch is only reachable mid-upgrade.

The image bakes in `ffmpeg`, `ffprobe`, `yt-dlp`, `postgresql-client-17` and `mc`. That is about
250 MB on top of `node:22-slim`, and it buys: normalization and probing in the worker, URL
ingest, `pg_dump`/`pg_restore` for backup and restore, and `mc mirror` for objects — all from
one image with one pinned tag. Four small images would be smaller and would give four things to
version, four things to patch, and a backup that can silently use a `pg_dump` older than the
server.

#### `infra/compose.yml`

```yaml
name: thibi

x-node: &node
  image: ghcr.io/thibi/transcribe:${IMAGE_TAG:?IMAGE_TAG is not set — run ./thibi init}
  restart: unless-stopped
  logging: &logging
    driver: json-file
    options: { max-size: "10m", max-file: "5" }

x-node-env: &node-env
  NODE_ENV: production
  DATABASE_URL: postgres://thibi:${POSTGRES_PASSWORD}@postgres:5432/thibi
  APP_SECRET_KEY: ${APP_SECRET_KEY:?run ./thibi init}
  PUBLIC_URL: ${PUBLIC_URL:?}
  S3_ENDPOINT: http://minio:9000            # server-side I/O
  S3_PUBLIC_ENDPOINT: ${PUBLIC_URL}/s3      # signing only — see §3
  S3_BUCKET: thibi
  S3_ACCESS_KEY: ${MINIO_ROOT_USER}
  S3_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
  S3_FORCE_PATH_STYLE: "true"
  SIDECAR_URL: http://sidecar:8000
  MEDIA_SERVING: ${MEDIA_SERVING:-presigned}
  UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-5368709120}
  LOG_LEVEL: ${LOG_LEVEL:-info}

services:

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    logging: *logging
    ports: ["80:80", "443:443", "443:443/udp"]
    environment:
      PUBLIC_HOST: ${PUBLIC_HOST:?}
      ACME_EMAIL: ${ACME_EMAIL:-}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      web: { condition: service_healthy }

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    logging: *logging
    environment:
      POSTGRES_USER: thibi
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
      POSTGRES_DB: thibi
    command:
      - postgres
      - -c
      - max_connections=200
      - -c
      - shared_buffers=${PG_SHARED_BUFFERS:-512MB}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U thibi -d thibi"]
      interval: 5s
      timeout: 3s
      retries: 24
      start_period: 30s

  minio:
    image: minio/minio:${MINIO_TAG:-RELEASE.2026-05-01T00-00-00Z}
    restart: unless-stopped
    logging: *logging
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?}
    volumes: [minio-data:/data]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 24
      start_period: 20s

  minio-init:
    image: minio/mc:${MC_TAG:-latest}
    restart: "no"
    logging: *logging
    depends_on:
      minio: { condition: service_healthy }
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_VERSIONING: ${MINIO_VERSIONING:-off}
    entrypoint: ["/bin/sh", "/init.sh"]
    volumes: ["./minio/init.sh:/init.sh:ro"]

  migrate:
    <<: *node
    restart: "no"
    command: ["node", "dist/migrate.js"]
    environment: *node-env
    depends_on:
      postgres: { condition: service_healthy }

  web:
    <<: *node
    command: ["node", "apps/web/server.js"]
    environment: *node-env
    expose: ["3000"]
    stop_grace_period: 30s
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_healthy }
      migrate:  { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e",
             "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s

  worker:
    <<: *node
    command: ["node", "dist/worker.js"]
    environment:
      <<: *node-env
      WORKER_QUEUES: media,asr.cloud,asr.poll,diarize.cloud,editorial,export,maintenance
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-6}
    stop_grace_period: 120s
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_healthy }
      migrate:  { condition: service_completed_successfully }

  worker-heavy:
    <<: *node
    profiles: [local-models]
    command: ["node", "dist/worker.js"]
    environment:
      <<: *node-env
      WORKER_QUEUES: diarize.local,asr.local
      WORKER_CONCURRENCY: "1"
    stop_grace_period: 120s
    depends_on:
      migrate: { condition: service_completed_successfully }
      sidecar: { condition: service_healthy }

  sidecar:
    profiles: [local-models]
    image: ghcr.io/thibi/sidecar:${IMAGE_TAG}
    restart: unless-stopped
    logging: *logging
    environment:
      HF_HOME: /hf-cache
      HF_TOKEN: ${HF_TOKEN:-}
      SIDECAR_TOKEN: ${SIDECAR_TOKEN}
      PYANNOTE_PIPELINE: ${PYANNOTE_PIPELINE:-pyannote/speaker-diarization-3.1}
      WHISPER_MODEL: ${WHISPER_MODEL:-distil-large-v3}
      WHISPER_DEVICE: ${WHISPER_DEVICE:-cpu}
      WHISPER_COMPUTE_TYPE: ${WHISPER_COMPUTE_TYPE:-int8}
      OMP_NUM_THREADS: ${SIDECAR_THREADS:-8}
    volumes: [hf-cache:/hf-cache]
    expose: ["8000"]
    stop_grace_period: 60s
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8000/healthz"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 300s      # first boot may be downloading ~4 GB of weights

  backup:
    <<: *node
    profiles: [backup]
    restart: unless-stopped
    entrypoint: ["/bin/sh", "/scripts/cron.sh"]
    environment:
      <<: *node-env
      BACKUP_CRON: ${BACKUP_CRON:-0 2 * * *}
      BACKUP_KEEP: ${BACKUP_KEEP:-14}
      BACKUP_KEEP_MONTHLY: ${BACKUP_KEEP_MONTHLY:-6}
      BACKUP_VERIFY_CRON: ${BACKUP_VERIFY_CRON:-0 4 1 * *}
    volumes:
      - ./scripts:/scripts:ro
      - backups:/backups
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_healthy }

volumes:
  pgdata: {}
  minio-data: {}
  caddy-data: {}
  caddy-config: {}
  hf-cache: {}
  backups: {}
```

#### depends_on, and the two gotchas

| Service | Waits for | Condition |
|---|---|---|
| `migrate` | postgres | `service_healthy` |
| `web`, `worker` | postgres, minio, migrate | healthy, healthy, `service_completed_successfully` |
| `worker-heavy` | migrate, sidecar | completed, healthy |
| `caddy` | web | `service_healthy` |
| `minio-init` | minio | `service_healthy` |

1. **`restart: "no"` on one-shots is mandatory.** With the default policy inherited from the
   anchor, Compose restarts `migrate` after it exits 0 and `service_completed_successfully`
   never settles. This is a five-minute bug that looks like a ten-hour one.
2. **`migrate` re-runs on every `up`.** That is intended: migrations are idempotent, the
   advisory lock (§6) makes concurrent runs safe, and it means "start the stack" and "apply
   pending migrations" are the same operation. If it fails, `web` and `worker` never start and
   `docker compose up` exits non-zero — the correct blast radius. `./thibi up` detects that exit
   and automatically prints `docker compose logs migrate`, because the default output buries the
   reason.

#### Why `sidecar` and `worker-heavy` share a profile

`worker-heavy` only subscribes to `diarize.local` and `asr.local`, both of which are sidecar
calls. With no sidecar it would idle forever holding ~80 MB, which matters on the 4 GB tier.

> **Amended 2026-08-12 — overview amendment 48.** This paragraph used to end "cloud
> diarization (ElevenLabs Scribe) is `diarize.cloud` and runs on the normal `worker`, so a
> small install still has a diarization path without the profile." **It does not.** Scribe is
> dropped, `diarize.cloud` has no implementation, and a small install without the profile has
> **no diarization at all**. That is a supported configuration and must be stated as one — an
> unset `SIDECAR_URL` already prints a remediation rather than a stack trace — but the
> install docs may not imply a cloud path exists.

Consequence, stated in the README: **a default install does cloud ASR only.** Set
`PROFILES=local-models` to get pyannote and faster-whisper, and read §5 first.

#### `infra/compose.gpu.yml`

```yaml
services:
  sidecar:
    environment:
      WHISPER_DEVICE: cuda
      WHISPER_COMPUTE_TYPE: float16
      PYANNOTE_DEVICE: cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

An **overlay**, not a profile, for three reasons:

- A profile decides whether a *service runs*. GPU changes *fields inside* a service that is
  already running.
- The stanza differs per service — only the sidecar gets a device, and if local Whisper ever
  moves into `worker-heavy` its stanza would differ again.
- `deploy.resources.reservations.devices` is **silently ignored** on Docker Desktop for macOS
  and Windows. It has to be opt-in per host, not baked into the install.

Compose merges `-f compose.yml -f compose.gpu.yml` field-wise, which is exactly the semantics
needed. `GPU=1` in `.env` adds the `-f`.

#### `infra/thibi`

The wrapper exists because assembling `-f` and `--profile` by hand is the thing a non-sysadmin
gets wrong — and the failure mode is silent: forget `--profile local-models` on a `down` and the
sidecar keeps running against a torn-down database.

```sh
#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env here. Run:  ./thibi init"; exit 1; }
set -a; . ./.env; set +a

FILES="-f compose.yml"
[ "${GPU:-0}" = "1" ] && FILES="$FILES -f compose.gpu.yml"
[ -f compose.override.yml ] && FILES="$FILES -f compose.override.yml"

PROFILE_FLAGS=""
for p in $(printf '%s' "${PROFILES:-}" | tr ',' ' '); do
  [ -n "$p" ] && PROFILE_FLAGS="$PROFILE_FLAGS --profile $p"
done

dc() { docker compose $FILES $PROFILE_FLAGS "$@"; }
cli() { dc run --rm --no-deps -T web node dist/cli.js "$@"; }

cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  init)          exec ./scripts/init.sh "$@" ;;
  up)            dc up "$@" || { echo; echo "--- migrate log ---"; dc logs migrate; exit 1; } ;;
  down|ps|logs|restart|pull|stop|start|config|exec)
                 dc "$cmd" "$@" ;;
  setup-link)    cli setup-link ;;
  backup)        dc run --rm -T backup /scripts/backup.sh "$@" ;;
  restore)       dc run --rm -T backup /scripts/restore.sh "$@" ;;
  upgrade)       exec ./scripts/upgrade.sh "$@" ;;
  doctor)        cli doctor "$@" ;;
  models)        dc run --rm -T sidecar python -m sidecar.models "$@" ;;
  help|-h|--help) sed -n '2,40p' ./docs/thibi-help.txt ;;
  *)             cli "$cmd" "$@" ;;          # transcribe, eval, pass, export, secrets, lang …
esac
```

The last line is the important one: **there is only one `thibi`.** Subcommands the wrapper does
not know about are forwarded into the image's CLI, so `./thibi transcribe file.m4a --lang my`
works on a deployed box exactly as documented in Phases 1–8, with no second binary to install
and no version skew between the CLI and the running engine.

`./thibi doctor` runs the same probe functions as `/admin/system` from the shell — for the case
where `web` will not start, which is exactly when you most need them.

Its staging probe is `validateStagingBucket` (Phase 2), which already reports all five checks
together rather than stopping at the first. Two things `doctor` should add on top of it, because
they are the failures a probe against *our* credentials cannot see:

- **The Speech service agent, for a cross-project bucket.** Measured 2026-08-10: a same-project
  bucket needs no grant at all — the project-level `roles/speech.serviceAgent` binding created
  with the API covers it, which is why spike S3 worked with the agent absent from the bucket
  policy. When the bucket's project differs from the recognizer's, print the
  `service-<PROJECT_NUMBER>@gcp-sa-speech.iam.gserviceaccount.com` grant. `doctor` cannot look
  the number up — the app service account gets a 403 on `cloudresourcemanager.projects.get` —
  so print the `gcloud projects describe` line that produces it.
- **Runs stranded in `mode='batch'` with a non-null `staging_prefix`.** That is audio sitting in
  someone else's bucket with nothing left to sweep it but the lifecycle rule. One query, and it
  is the thing an operator would never think to look for.

---

### 2. Caddyfile

```caddyfile
{
	email {$ACME_EMAIL}
}

{$PUBLIC_HOST} {
	encode zstd gzip

	request_body {
		max_size {$UPLOAD_MAX_SIZE:5GB}
	}

	# MinIO, same-origin. handle_path strips the /s3 prefix.
	handle_path /s3/* {
		reverse_proxy minio:9000 {
			flush_interval -1
		}
	}

	handle {
		reverse_proxy web:3000 {
			flush_interval -1
		}
	}
}
```

**`handle_path`, not `handle`.** `handle_path /s3/*` strips the prefix, so MinIO receives
`/thibi/<key>` — an ordinary path-style S3 request. With plain `handle` + `reverse_proxy`,
MinIO receives `/s3/thibi/<key>`, treats `s3` as the bucket, and returns
`NoSuchBucket` or a signature failure depending on the request. One word, and the entire audio
path works or does not.

What same-origin buys, and why this is three lines instead of a subsystem:

- **No CORS configuration on MinIO.** The browser is fetching from the same origin it loaded the
  page from.
- **No second certificate and no second DNS name** for the object store.
- Range requests, cookies and CSP all behave as if the media were served by the app.

`flush_interval -1` disables response buffering. Caddy auto-detects `text/event-stream` and does
this already, but the detection depends on the Content-Type header arriving before the first
flush, and the SSE route also sets `X-Accel-Buffering: no` for anyone who fronts this with nginx
instead. Belt and braces; without it the progress bar appears frozen and the bug looks like the
worker.

`request_body max_size` — Caddy's default is unlimited. Uploads go to MinIO by presigned PUT,
which means they traverse `/s3/*` and are governed by this limit, so it must match
`UPLOAD_MAX_BYTES` in the app. Both read the same `.env` variable; a mismatch produces a
Caddy 413 after a journalist has waited twenty minutes for a 6 GB upload.

`443:443/udp` in compose enables HTTP/3, which measurably helps scrubbing over a poor connection.

**Local / evaluation mode.** `./thibi init --local` writes `PUBLIC_HOST=localhost` and
`PUBLIC_URL=http://localhost`, and the init script appends `auto_https off` to a
`compose.override.yml`-mounted Caddyfile fragment. Needed because someone will evaluate this on
a laptop before they buy a domain, and an ACME failure at that moment ends the evaluation.

---

### 3. Audio serving

#### The two S3 clients

```ts
// packages/storage/src/s3.ts
export interface S3Pair {
  /** Server-side I/O. Reaches minio:9000 inside the compose network. */
  s3: S3Client;
  /** Signing ONLY. Never used to send a request. */
  s3Public: S3Client;
}

export function makeS3(cfg: S3Config): S3Pair {
  const common = {
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  };
  return {
    s3:       new S3Client({ ...common, endpoint: cfg.endpoint }),        // http://minio:9000
    s3Public: new S3Client({ ...common, endpoint: cfg.publicEndpoint }),  // https://host/s3
  };
}
```

**Why.** SigV4's canonical request includes the `Host` header. A URL signed against
`minio:9000` and then opened at `https://transcribe.example.org/s3/...` presents a different
Host; MinIO recomputes the signature, gets a different value, and returns
`403 SignatureDoesNotMatch`. The error names neither the endpoint nor the Host header. It is
indistinguishable from a wrong secret key, and people spend a day rotating credentials.

Guard it in the type system as well as the comment: `s3Public` is exposed as a branded type
whose only exported operation is `presign()`, so `s3Public.send(...)` does not compile.

#### The day-one check

Before writing any UI against this, on the actual deployment:

```
$ ./thibi media presign <assetId>
https://transcribe.example.org/s3/thibi/media/9f/9f2c….flac?X-Amz-Algorithm=…

$ curl -s -D- -o /dev/null -r 0-1023 "https://transcribe.example.org/s3/thibi/…"
HTTP/2 206
content-range: bytes 0-1023/48210332
accept-ranges: bytes
content-length: 1024
```

| Symptom | Cause |
|---|---|
| `403 SignatureDoesNotMatch` | `S3_PUBLIC_ENDPOINT` wrong, or Caddy is using `handle` instead of `handle_path` |
| `404 NoSuchBucket` (bucket = `s3`) | `handle` instead of `handle_path`, confirmed |
| `200` with the whole file | Range is not surviving the proxy; scrubbing a 90-minute file will download all of it |
| `HTTP/2 206` as above | correct |

This goes in the runbook and in the first-run checklist, because it fails **silently** in the
sense that everything else works: uploads succeed, transcription succeeds, and only the player
is broken.

#### Minting

`GET /api/media/[assetId]/url` — authenticated, `requireUser()`, checks project access, then:

```ts
const url = await getSignedUrl(s3Public, new GetObjectCommand({ Bucket, Key }), { expiresIn: 900 });
await db.insert(mediaAccessLog).values({ userId, assetId, mode: 'presigned', ip, at: clock.now() });
return Response.json({ url, expiresAt });
```

**15 minutes.** Long enough that a scrubbing session reuses one URL across hundreds of Range
requests; short enough that a URL pasted into Slack is dead before anyone clicks it. The player
refreshes at 10 minutes and on any 403.

Two honest statements that belong in the UI and the README:

- **A presigned URL is a bearer token.** Anyone who has it can fetch the recording for 15
  minutes with no session. Do not paste them.
- `media_access_log` in presigned mode records **who asked for access**, not how many bytes were
  served, because the bytes come from MinIO directly. "Who listened to this recording" is
  answered by the mint log. Byte-level truth would require MinIO audit webhooks and is out of
  scope.

#### `MEDIA_SERVING=proxy`

For newsrooms whose lawyer requires that media is never reachable without a session cookie. The
Range logic ports from `app/api/jobs/[id]/audio/route.ts:18-60` essentially unchanged — that
code is correct, including the `^bytes=(\d*)-(\d*)$` parse, the `start > end || start >= size`
416 with `Content-Range: bytes */size`, and the `Content-Length: end - start + 1` arithmetic.

Two substitutions:

```ts
const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
const size = head.ContentLength!;                       // was fs.statSync(job.path).size

const obj = await s3.send(new GetObjectCommand({
  Bucket, Key, Range: `bytes=${start}-${end}`,
}));
return new Response(obj.Body as unknown as ReadableStream, { status, headers });
```

and **delete the hand-rolled `ReadableStream` bridge at `:40-51`** — the v3 SDK already returns
a web stream on Node 18+, and the manual `controller.enqueue` version leaks the read stream if
the client disconnects without triggering `cancel`.

Cost, documented: one Node connection held for the duration of every listen. A 90-minute
interview scrubbed by three editors is three long-lived connections doing nothing but copying
bytes. Fine for a small newsroom, wrong as a default.

---

### 4. First-run experience

#### The transcript

```
$ git clone https://github.com/thibi/transcribe-deploy.git
$ cd transcribe-deploy
$ ./thibi init

  thibi-transcribe — first run
  ────────────────────────────

  What is the public URL for this instance?
  A hostname gets a real certificate automatically (make sure its DNS
  already points here, and that ports 80 and 443 are open).
  Use http://localhost to try it out on this machine.

  > https://transcribe.example.org

  Generating secrets…
    POSTGRES_PASSWORD     ✓  32 bytes
    MINIO_ROOT_PASSWORD   ✓  32 bytes
    SIDECAR_TOKEN         ✓  32 bytes
    APP_SECRET_KEY        ✓  32 bytes   ← see below
    SETUP_TOKEN           ✓  32 bytes

  Wrote .env  (chmod 600)
  Pinned IMAGE_TAG=1.4.2

  ┌────────────────────────────────────────────────────────────────┐
  │  APP_SECRET_KEY encrypts every provider credential in the      │
  │  database. It is deliberately NOT included in backups.         │
  │                                                                │
  │    APP_SECRET_KEY=3b9f…c07e                                    │
  │                                                                │
  │  Put it in your password manager now. If you lose it, every    │
  │  stored API key must be re-entered by hand. Nothing else is    │
  │  lost — transcripts, audio and users are unaffected.           │
  └────────────────────────────────────────────────────────────────┘

  Press Enter once you have saved it. ⏎

  Next:  ./thibi up -d

$ ./thibi up -d

  [+] Pulling 3/3
   ✔ ghcr.io/thibi/transcribe:1.4.2
   ✔ postgres:17-alpine
   ✔ minio, caddy
  [+] Running 7/7
   ✔ postgres      Healthy                                    11.4s
   ✔ minio         Healthy                                     6.2s
   ✔ minio-init    Exited (0)   bucket thibi · lifecycle scratch/ 1d
   ✔ migrate       Exited (0)   18 migrations applied         3.1s
   ✔ web           Healthy                                    14.8s
   ✔ worker        Started
   ✔ caddy         Started

  Finish setup in your browser. This link works once and expires in 60 minutes:

      https://transcribe.example.org/setup?token=9f2c8a1d…

  Lost it?  ./thibi setup-link
```

Then, in the browser, four steps and none of them is a file:

1. **Create the admin account** — username, display name, password. `/setup` requires the token
   *and* zero users under `LOCK TABLE users`, so whoever port-scans the VPS first does not become
   admin.
2. **Add a transcription provider** — the Google card, paste the service-account JSON, **Test
   connection**, green tick. (Or OpenAI/Groq; the wizard shows which languages each covers.)
3. **Which languages do you work in?** Pre-checks verified + beta, links to
   `/settings/languages`. Sets `language_support.enabled` so the picker is three rows, not 107.
4. **Optional, with Skip on both:** the GCS staging bucket (with the \$48-vs-\$9 arithmetic) and
   local models (with §5's honest pyannote number and the `PROFILES=local-models` +
   `./thibi models pull` instructions).

   **The GCS step must present the trade honestly, and it is not the one the overview assumed.**
   Skipping it is the *faster* configuration, not a degraded one: spike S3 measured chunked
   parallel sync 3.6–7× faster than `batchRecognize` at every duration, so the bucket buys 5.33×
   less money at roughly 5× the wall-clock. Word it that way round. It should also reuse
   `validateStagingBucket` rather than accepting a name — the same five checks
   `thibi settings set … --check` runs, reported together — because the two failures a newsroom
   will actually hit are both silent otherwise:

   - **`roles/storage.objectAdmin` cannot read bucket metadata.** Measured 2026-08-10: write 200,
     delete 204, `storage.buckets.get` **403**. It is the obvious grant and it leaves the region
     and the lifecycle rule unverifiable. The remediation the wizard prints is
     `roles/storage.legacyBucketReader` — **never `roles/storage.admin`**.
   - **A bucket name that does not exist** must say so and refuse to save, with no IAM advice
     attached. Answering a typo with "grant a role" is the same class of mistake as the region
     doctrine this codebase deleted.

   What the wizard does **not** need to mention: the Speech service agent. Measured the same day
   — for a staging bucket in the same project as the recognizer, the project-level
   `roles/speech.serviceAgent` binding created when the Speech API was enabled already covers it,
   and nothing needs granting. It is a cross-project hazard only, and `thibi doctor` is the right
   place for it (§below), not a step everyone walks through.

Then: **Upload your first file.**

#### The bar

> **Any flow that forces an admin back into `.env` to add a provider key is a design failure.**

`.env` contains exactly: the public URL, the five generated secrets, and the deployment toggles
(`IMAGE_TAG`, `PROFILES`, `GPU`, `MEDIA_SERVING`, `MINIO_VERSIONING`, backup schedule). Nothing
a person configures while *using* the product lives there.

Environment variables remain a *supported* source for credentials (the precedence chain from
Phase 10, for people automating deployments), and Phase 14 renders those read-only with a badge —
but they are never *required*. CI asserts it: a test walks the settings key registry and fails if
any key marked `requiredForOperation` is absent from the settings UI, and `.env.example` is
checked for keys that overlap the credential registry.

---

### 5. Resource requirements

| Tier | vCPU | RAM | Disk | GPU | Runs | Profiles |
|---|---|---|---|---|---|---|
| **small** | 2 | 4 GB | 40 GB + media | — | cloud ASR + cloud LLM only. No pyannote, no local Whisper | *(none)* |
| **medium** | 8 | 16 GB | 100 GB + media | — | + faster-whisper CPU, + pyannote CPU | `local-models` |
| **fast** | 8 | 24 GB | 200 GB + media | 1 × 12 GB | both on GPU | `local-models`, `GPU=1` |

Both pyannote 3.1 and faster-whisper `large-v3` fit comfortably in 12 GB together.

#### Throughput — the honest numbers

| Workload | Rate | 1 hour of audio takes |
|---|---|---|
| Cloud ASR, 8 parallel chunks | — | **2–4 minutes** (dominated by upload and provider queueing) |
| Cloud ASR via `batchRecognize` | ~5–6× realtime, flat | **~10–13 minutes.** Corrected 2026-08-10: measured 258 s for a 20-minute file (4.65× realtime), and spike S3 measured 5.9× at both 30 minutes and 2 hours. There is **no sync/batch threshold** — that clause is deleted. Chunked sync is faster at every duration; batch is an opt-in choice that trades this row against the one above it for 5.33× less money |
| faster-whisper `large-v3` int8, CPU, 8 cores | 1–2× realtime | **30–60 minutes** |
| faster-whisper `distil-large-v3` int8, CPU, 8 cores | ~2.5–4× realtime | 15–25 minutes |
| faster-whisper `large-v3` float16, GPU | ~20–30× realtime | 2–4 minutes |
| **pyannote 3.1, CPU** | **0.56–0.61× realtime** (measured ×2, S6) | **~1 h 40 m** |
| pyannote 3.1, GPU | ~10–20× realtime *(inherited, **never measured** — do not publish until it is)* | 3–6 minutes |

**The pyannote CPU number is the one that surprises people, and it is why several other
decisions look the way they do:** `worker-heavy` runs at concurrency 1 with a global advisory
slot; the UI shows an estimate before you start; diarization polls rather than holding a worker
slot; and the sidecar is behind a profile so a small install cannot accidentally queue a job
that will still be running tomorrow. A newsroom that needs diarization against a deadline
**needs a GPU** — that is the whole list since 2026-08-12 dropped Scribe (amendment 48), and
it is the reason overview open question 1 (typical recording length and deadline pressure) has
to be answered before this phase prices a tier. *2026-08-13: hosted diarization is reopened as
an **evaluation** (amendment 71, Phase 3 open question 7). The list is still one item long, and
this tier table may not price or promise a hosted option until one is built and measured —
including the residency question, since a hosted diarizer sends audio out of the building.*

Print the realtime factor in the model picker, measured on this host after the first run, not
from this table.

#### Storage

| What | Size |
|---|---|
| `hf-cache` | **~10 GB** — pyannote 3.1 + segmentation + embedding ≈ 1 GB; `large-v3` int8 ≈ 1.5 GB (float16 ≈ 3 GB); `distil-large-v3` ≈ 0.8 GB; plus HF's blob/snapshot duplication. **Provision 15 GB.** |
| Normalized derivative | **~68 MB per audio-hour** (16 kHz mono FLAC, measured 2026-08-10: 22.7 MB for 20 minutes, 59% of raw 16-bit). The old ~30 MB figure was a guess and is low by 2.3×. One clip, so re-measure on the Phase 5 corpus; provision from 68 |
| Waveform peaks | ~144 KB per hour |
| Postgres | ~10k word rows per audio-hour → 1,000 hours ≈ 10M rows ≈ 2–3 GB with indexes |
| Raw provider responses | ~1–3 MB per hour, kept under `runs/{id}/raw/` |

#### `thibi models pull`

```
$ ./thibi models pull --dry-run
  pyannote/speaker-diarization-3.1    ~1.0 GB   not cached
  Systran/faster-distil-whisper-large-v3  ~0.8 GB   not cached
  Total to download: 1.8 GB into volume hf-cache (14.2 GB free)

$ ./thibi models pull
  Checking Hugging Face token…            ✓
  Checking licence acceptance for pyannote/speaker-diarization-3.1 …  ✓
  Downloading …
```

Pre-warming is deliberate, not incidental. Two reasons:

1. **pyannote 3.1 is gated.** Using it requires accepting the model licence on
   huggingface.co while logged in, and supplying `HF_TOKEN`. Discovering that at 2 a.m. mid-deadline,
   as a 401 buried in a sidecar log, is the exact failure this command exists to prevent — so the
   token and the licence acceptance are checked **before** any bytes are downloaded, with a link
   to the page you have to click.
2. A first run that silently downloads 4 GB looks like a hang.

`./thibi up` warns — never auto-downloads — if `PROFILES` includes `local-models` and the cache
is empty.

---

### 6. Migrations

- `drizzle-kit generate` emits plain SQL; files are **committed**. The `migrate` service runs
  `node dist/migrate.js`, which applies anything not in `_migrations` in filename order.
- **Belt and braces:** the runner takes `pg_advisory_lock(hashtext('thibi.migrate'))` for the
  duration of its transaction. `depends_on: service_completed_successfully` already serializes
  the normal path, but `docker compose up -d` racing a `./thibi upgrade`, or two operators in two
  SSH sessions, is a real scenario. The lock turns it into "the second one waits", not "both
  apply `0019`".
- Each file applies in its own transaction; the runner prints
  `✓ 0018_probe_cache.sql (312 ms)` and exits non-zero on the first failure, leaving prior
  migrations applied and `_migrations` accurate.
- **Forward-only.** No `down` files. They are written once, never executed, and by the time you
  need one the schema has drifted past what they assume. Rollback is restore-from-backup, and
  that path is exercised monthly by `thibi backup --verify` (§7) rather than being theoretical.
- **Destructive changes use expand/contract across releases:**

| Release | Action |
|---|---|
| R1 | add the new column/table; dual-write; backfill in a `maintenance.backfill` step so it does not block startup |
| R2 | stop reading the old column; release notes state that R2 requires R1 |
| R3 | drop the old column |

  Two releases between "we changed our mind" and "your data is gone" means a restore from any
  backup taken in the window still works.
- `GET /api/health` returns `{ ok, migration: '0018', engine: '1.4.2' }`. `web` **refuses to
  serve** if the applied migration number is lower than the one compiled into the image — which
  catches an operator starting a new `web` against a database that has not been migrated, a state
  that otherwise produces a scatter of column-does-not-exist errors in the UI.

---

### 7. Backup and restore

#### Three things to capture

| # | What | How | Size, order of magnitude |
|---|---|---|---|
| 1 | Postgres | `pg_dump -Fc` | hundreds of MB — the entire state machine, transcripts, words, settings ciphertext |
| 2 | Objects | `mc mirror --overwrite` | tens of GB — media, derivatives, raw provider responses |
| 3 | `APP_SECRET_KEY` | **not captured** | 32 bytes, in a human's password manager |

#### DB first, then objects

Object rows (`media_assets.storage_key`, `run_chunks.storage_key`, `runs.staging_prefix`) are
written **after** the upload completes. So a database snapshot taken at time *T* can only
reference objects that already existed at *T*, and mirroring objects afterwards can only ever
capture extras — never miss one. Do it the other way round and any upload that lands between the
mirror and the dump produces a row pointing at an object that was never backed up: dangling
media, discovered months later by someone who needs it.

One rule, one paragraph, and it is invisible unless it is written down.

#### `thibi backup`

```
$ ./thibi backup
  1/3  Postgres … pg_dump -Fc                       412 MB   38 s
  2/3  Objects  … mc mirror minio/thibi             38.4 GB  4m 12s   (12,904 objects)
  3/3  Manifest … sha256 + row counts                        2 s

  → /backups/2026-08-09T0200Z/
       db.dump
       objects/
       manifest.json

  ⚠  APP_SECRET_KEY is NOT in this backup, by design.
     Without it, every provider credential inside db.dump is undecryptable.
     Confirm it is in your password manager.  (thibi restore will verify.)

  ⚠  This backup is on the same host as the data it protects.
     Copy /backups off this machine.  See README → Backups.
```

`manifest.json` carries: engine version, migration number, row counts per table, object count
and total bytes, and a sha256 of `db.dump`.

Retention: `BACKUP_KEEP=14` dailies plus `BACKUP_KEEP_MONTHLY=6`. Off-box copy is the operator's
job and the README says so plainly — a backup on the same VPS is not a backup.

#### `thibi restore`

```
$ ./thibi restore /backups/2026-08-09T0200Z

  Target database is not empty (14 tables, 31,402 rows).
  Refusing. Pass --force to drop and replace.

$ ./thibi restore /backups/2026-08-09T0200Z --force
  1/5  Verifying manifest …                        ✓ sha256 matches
  2/5  pg_restore …                                ✓ 18 migrations, 31,402 rows
  3/5  Probing decryption …                        ✗

  APP_SECRET_KEY does not match this backup.
  Provider credentials in db.dump cannot be decrypted with the key currently
  in .env. Nothing further has been changed.

  Fix the key and re-run, or pass --accept-lost-secrets to continue with all
  provider credentials cleared (transcripts, audio and users are unaffected).
```

**Step 3 is the point of the whole command.** It picks one `settings` row with
`is_secret = true`, attempts an AES-256-GCM decrypt with the current key and its AAD binding, and
stops on failure — in the first ten seconds, before the 38 GB object mirror. That turns a lost
`APP_SECRET_KEY` into a finding from a drill rather than a discovery during an incident, which is
the entire reason to run drills.

Steps 4–5: `mc mirror` back, then verify that every `media_assets.storage_key` with
`deleted_at IS NULL` exists in the bucket, and print the count of dangling references. With
DB-first backups this is 0; a non-zero number means someone reordered the backup script.

#### `thibi backup --verify`

Monthly, cron'd in the `backup` profile (`BACKUP_VERIFY_CRON`):

1. `createdb thibi_verify`, `pg_restore` the latest `db.dump` into it.
2. Run the manifest checks and the decryption probe against it.
3. Sample 100 object keys and compare size + etag.
4. `dropdb thibi_verify`.
5. Write the result to `audit_log`, so `/admin/system` can show **"last verified restore:
   6 days ago ✓"** — which is the only honest way to know a backup works.

A full object re-mirror is deliberately not part of verify; it would double the storage and take
hours, and sampling catches the failure modes that matter (empty mirror, truncated objects,
credentials rotated out from under `mc`).

---

### 8. Upgrade path

```
$ ./thibi upgrade --to 1.5.0

  Release 1.5.0
    Migration: yes (0019_project_model_profiles) — additive
    Reversible: no (restore from backup only)
    Breaking: no
    Requires: sidecar image re-pull (pyannote 3.1 → 3.2)
    Downtime: ~45 s

  Continue? [y/N] y

  1/5  Backup …                    ✓ /backups/2026-08-09T1130Z
  2/5  Pull 1.5.0 …                ✓
  3/5  Migrate …                   ✓ 0019 applied (410 ms)
  4/5  Restart …                   ✓
  5/5  Health …                    ✓ engine 1.5.0, migration 0019

  Previous tag kept as IMAGE_TAG_PREVIOUS=1.4.2
  To roll back:  ./thibi restore /backups/2026-08-09T1130Z --force \
                   && IMAGE_TAG=1.4.2 ./thibi up -d
```

Step 1 is not skippable: if the backup fails, the upgrade stops. Step 3 runs `migrate` alone and
exits non-zero on failure, so a bad migration never gets traffic.

- **`IMAGE_TAG` is pinned in `.env`. Never `latest`.** With `latest`, two containers pulled
  minutes apart can be different builds, `/admin/system`'s engine-mismatch warning becomes a
  permanent false alarm, and "which version is this" is unanswerable during an incident.
  `./thibi upgrade` rewrites the tag and keeps `IMAGE_TAG_PREVIOUS` for the rollback line it
  prints.
- **`stop_grace_period: 120s`** on `worker` and `worker-heavy`. On SIGTERM a worker: stops
  fetching new jobs, marks itself draining, lets in-flight steps reach their next `AbortSignal`
  checkpoint (between chunks), releases advisory locks, and exits. Anything that does not finish
  in 120 s is recovered by the stale-heartbeat sweep — so the grace period is a comfort, not a
  correctness requirement. `web` gets 30 s (in-flight HTTP). `sidecar` gets 60 s: a running
  pyannote inference genuinely cannot be interrupted mid-pass, but because diarization is a
  poll-based external step it simply returns to `awaiting_external` and is re-submitted, so the
  cost of killing it is wasted compute, not a broken run.
- **Release-notes contract** (`docs/RELEASING.md`, template-enforced in CI):

```markdown
## 1.5.0 — 2026-09-01

Migration:  yes (0019_project_model_profiles) — additive
Reversible: no (restore from backup only)
Breaking:   no
Requires:   sidecar image re-pull
Downtime:   ~45 s

### Added
### Changed
### Fixed
```

Those five lines come **before** the changelog, every time. An operator deciding whether to
upgrade on a Friday afternoon needs exactly "is there a migration" and "can I go back", and
should not have to read a feature list to find out.

---

### 9. Logging

- **pino, JSON, one line per event, to stdout.** Docker's `json-file` driver with
  `max-size: 10m, max-file: 5` on every service via the `x-logging` anchor — without it a chatty
  worker fills the disk, and Postgres is the first thing that dies when it does.
- **`AsyncLocalStorage` context.** `{ requestId, userId, jobId, runId, stepId }` is entered once
  per HTTP request and once per queue step; every `ctx.logger` call inherits it. So
  `docker compose logs worker | jq 'select(.runId == "a3f…")'` reconstructs a run without
  threading ids through twenty function signatures. The engine takes its logger from
  `EngineContext` and never touches a module global — the same rule as the rest of the engine.
- **Redaction, explicit:**

```ts
pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.apiKey', '*.api_key', '*.password', '*.passwordHash', '*.token', '*.secret',
      '*.google_sa_json', 'settings.*.value', '*.private_key',
      '*.url', '*.signedUrl',            // presigned URLs are credentials
    ],
    censor: '[redacted]',
  },
});
```

  `*.url` is the one people leave out. A presigned URL in a log line is a 15-minute bearer token
  for a source recording, and log excerpts get pasted into support tickets. Log the object key
  instead; it is more useful for debugging anyway.

- **Explicitly no Loki, no Grafana, no Prometheus.** Three more containers, a scrape config, a
  dashboard nobody owns, and — in eighteen months — an unpatched Grafana exposed on a newsroom's
  VPS. To answer "is this run stuck" and "why did this step fail", which `/admin/queue` and
  `/runs/:id/timeline` already answer directly against the source of truth, with the actual error
  payload rather than a counter. `docker compose logs -f worker | jq` covers everything else.

  If a newsroom already runs an observability stack, **JSON on stdout is the correct integration
  point** and they can ship it wherever they like. That is the whole argument for structured
  stdout: it makes the decision theirs instead of ours.

---

### 10. Documentation

The old repo's best habit is that its README says, in plain words, *"do not deploy this anywhere
public as-is."* That plainness is why the project is trusted. Carry it over: tradeoffs go in the
main text, at the point where they matter, not in a FAQ at the bottom.

Sections that must exist in `README.md`:

| Section | Must state |
|---|---|
| What this is / is not | one newsroom per instance; not multi-tenant; not a hosted service; no SSO |
| Requirements | the three-tier table from §5, verbatim |
| Install | the `./thibi init` transcript from §4, verbatim |
| Languages and tiers | what verified / beta / experimental mean, with the thresholds; **"a provider accepting a language code is not support"**, with the Groq romanized-Burmese example |
| Costs | the rate table is yours, not an invoice; the \$48-vs-\$9 batch arithmetic; each run is charged again |
| **Diarization is slower than realtime on CPU** | ~0.6× realtime (S6): a 1-hour interview is ~1 h 40 m, a 3-hour recording ~5 h. It runs in the background and never delays the transcript. Same-day work on long audio wants a GPU |
| **Losing `APP_SECRET_KEY` is unrecoverable** | what is lost (provider credentials) and what is not (transcripts, audio, users); it is not in backups, by design |
| **Presigned URLs are bearer tokens** | 15 minutes, no session required, do not paste them into chat |
| **Encryption at rest does nothing against root on this host** | it protects a leaked `pg_dump`, which is the realistic failure; it does not protect you from someone with root |
| **yt-dlp use is your legal responsibility** | we ship the tool; whether downloading a given URL is lawful depends on the source's terms and your jurisdiction; the domain allowlist is empty by default and you opt in |
| Privacy and data flow | exactly which bytes leave the box for each configured provider, and how to run fully local (`PROFILES=local-models`, no cloud keys) |
| Backups | the three things, the DB-first rule, the off-box warning, the monthly verify |
| Upgrading | pinned tags, the release-notes contract, the rollback line |
| Troubleshooting | pointers into `docs/RUNBOOK.md` |

`docs/RUNBOOK.md` carries §11 plus: audio 403s, disk full, migrate fails, sidecar OOM, Caddy
certificate failure (port 80 closed, or DNS not pointing here yet), MinIO out of space, a run
stuck in `awaiting_external`, and how to read `./thibi doctor`.

---

### 11. Runbook: interrupted mid-pipeline

*The worked example from the overview, as an operations entry.*

**Scenario.** A 2-hour interview. `batchRecognize` has been submitted to Google; diarization is
running on the sidecar; the VPS reboots at 03:00 for an unattended kernel update.

**State at the moment of the reboot:**

```
runs           state = running
run_steps
  media.normalize    done
  asr.batch.submit   done                external_ref = projects/…/operations/1234
  asr.poll           awaiting_external   heartbeat_at 02:58
  diarize            awaiting_external   external_ref = sidecar task 8f2c
  diarize.poll       pending
  reconcile          pending             depends_on [asr.poll, diarize.poll]
run_chunks     (none — batch mode)
```

**What happens on boot, in order:**

1. `postgres` becomes healthy → `migrate` exits 0 → `web`, `worker`, `worker-heavy` start.
2. The worker's boot sweep — the replacement for `lib/db.ts:63-66`, which must not survive the
   port — runs: steps in `running` with a stale `heartbeat_at` get `attempt + 1` and return to
   `pending`. Steps in **`awaiting_external` are re-polled, never reset.** `asr.poll` and
   `diarize` keep their `external_ref`.
3. `reconcile(runId)` runs under `pg_advisory_xact_lock` and re-sends the two poll jobs.
4. `asr.poll` calls Google with the persisted operation name. The operation completed while the
   box was off. Output JSON is read from `staging_prefix`, segments and words are written in one
   transaction, `usage_records` records the billed duration. **Google is not charged again** —
   the LRO was paid for at submit time, which is the whole reason `operation_name` is persisted
   on `runs`.
5. The sidecar restarted and lost task `8f2c`. `diarize.poll` gets a 404 and, because the step is
   idempotency-keyed on `step_id`, **re-submits** rather than failing the run. Diarization starts
   over. That cost is real and unavoidable — and it is why `stop_grace_period` on the sidecar is
   60 s rather than 5, so a *planned* restart at least lets a nearly-finished pass complete.
6. Both polls reach `done`; `reconcile` promotes `reconcile` → `ready`; then `normalize-text`,
   then persist. Run → `done`.
7. The journalist's browser reconnects its SSE stream with `Last-Event-ID: 4821`; `run_events`
   replays every row since, so the progress bar resumes rather than resetting to zero.

**Verify afterwards:**

```
$ ./thibi run inspect <runId>
  steps
    asr.batch.submit   done   attempt 1/3        ← must be 1
    asr.poll           done   attempt 1/…  polls 14
    diarize            done   attempt 2/2        ← 2 is expected: the sidecar lost the task
    reconcile          done
  usage
    asr_minutes  118.4   $0.36    ← exactly one ASR row
```

**What "wrong" looks like:** a second `usage_records` ASR row, or `asr.batch.submit` back in
`pending`. Either means the boot sweep reset an `awaiting_external` step — the exact bug the
sweep is written to avoid, and the reason it has a dedicated integration test
(`apps/worker/__tests__/boot-sweep.test.ts`, fixture `interrupted-batch.sql`).

---

## Porting notes

| From | To | Verbatim? | Notes |
|---|---|---|---|
| `app/api/jobs/[id]/audio/route.ts:18-38` Range parse + 416 | `app/api/media/[assetId]/stream/route.ts` | **verbatim** | the regex, the `start > end \|\| start >= size` guard and `Content-Range: bytes */${size}` are all correct |
| `:53-58` response headers | same | verbatim | `Accept-Ranges`, `Content-Length: end - start + 1`, `Content-Range` on 206 |
| `:39` `fs.createReadStream(path,{start,end})` | same | **changed** | `GetObjectCommand` with `Range: bytes=start-end` |
| `:11-14` `fs.existsSync` 404 | same | changed | `HeadObjectCommand`; a missing object with a live row means the retention sweep or a manual shred ran — return 410 with the reason from `media_assets.deleted_reason`, not a bare 404 |
| `:40-51` hand-rolled `ReadableStream` bridge | — | **must not survive** | the v3 SDK returns a web stream on Node 18+; the manual version leaks the underlying stream on a client disconnect that does not call `cancel` |
| `lib/db.ts:63-66` boot sweep | `apps/worker/src/sweep.ts` | **must not survive as written** | replaced by the heartbeat sweep that re-polls `awaiting_external` instead of resetting it |
| `lib/db.ts:70` `DELETE FROM runs WHERE provider NOT IN ('google')` | — | **must not survive** | deletes data at every startup |
| old README's plain-language warnings | `README.md` | **spirit, verbatim** | keep the habit of stating the downside in the same paragraph as the feature |

---

## Tests

### Compose and scripts

| File | Cases |
|---|---|
| `infra/__tests__/compose-config.test.sh` | `docker compose -f compose.yml config` is valid with a minimal `.env`; every `${VAR:?}` is present in `.env.example`; adding `-f compose.gpu.yml` merges the device reservation onto `sidecar` and changes no other service |
| `infra/__tests__/profiles.test.sh` | `PROFILES=` starts 7 services and no `sidecar`; `PROFILES=local-models` starts 9; `PROFILES=local-models,backup` starts 10; the wrapper emits exactly the expected `--profile` flags for each (assert on `dc config --services`) |
| `infra/__tests__/thibi-wrapper.test.sh` | unknown subcommand forwards to the CLI; `GPU=1` adds the overlay; a missing `.env` exits 1 with the init hint; `PROFILES` with spaces and trailing commas parses |
| `infra/__tests__/caddy.test.sh` | `caddy validate` passes; a request to `/s3/thibi/x` reaches MinIO as `/thibi/x` (assert against a stub upstream that echoes the path) |
| `infra/__tests__/init.test.sh` | generates 5 distinct 32-byte secrets; `.env` is `0600`; re-running refuses to overwrite an existing `.env`; `--local` produces `auto_https off` |

### Storage and media

| File | Cases |
|---|---|
| `packages/storage/__tests__/two-clients.test.ts` | a URL signed by `s3Public` contains the public host in its `X-Amz-SignedHeaders`/credential scope; a URL signed by `s3` does not verify against the public host (recorded MinIO fixture); `s3Public.send` fails to type-check (`expect-type` / `tsd`) |
| `web/__tests__/range-proxy.test.ts` | fixture `4mb.flac` in `MemoryObjectStore`: no Range → 200 full length; `bytes=0-1023` → 206 + correct `Content-Range`; `bytes=4000000-` → 206 to EOF; `bytes=9999999-` → 416 with `bytes */4194304`; malformed `bytes=abc` → 200 (ignored), matching the old behaviour |
| `web/__tests__/presign.test.ts` | TTL is 900 s; every mint writes `media_access_log`; a user without project access gets 403 and **no** log row |

### Migrations, backup, upgrade

| File | Cases |
|---|---|
| `packages/db/__tests__/migrate-lock.test.ts` | two concurrent runners against one database: both succeed, each migration applies exactly once, `_migrations` has no duplicates |
| `packages/db/__tests__/migrate-fail.test.ts` | a deliberately broken migration exits non-zero, leaves prior migrations applied, and `_migrations` accurate |
| `infra/__tests__/backup-restore.test.sh` | end-to-end in CI: seed 50 rows + 5 objects → `backup` → wipe → `restore` → row counts and object etags match; manifest sha256 mismatch is rejected |
| `infra/__tests__/restore-wrong-key.test.sh` | restore with a different `APP_SECRET_KEY` aborts **before** the object mirror and leaves the target untouched; `--accept-lost-secrets` clears secret rows and completes |
| `infra/__tests__/backup-order.test.sh` | asserts the script dumps the DB before mirroring objects (grep the script's step order **and** assert that an object uploaded between the two steps is present in the backup but absent from the dump — never the reverse) |
| `apps/worker/__tests__/boot-sweep.test.ts` | fixture `interrupted-batch.sql`: `awaiting_external` steps keep their `external_ref` and are re-polled; `running` steps with stale heartbeats get `attempt + 1`; **exactly one** `usage_records` ASR row after recovery |
| `apps/worker/__tests__/drain.test.ts` | SIGTERM stops fetching, finishes the in-flight step, releases advisory locks, exits 0 within the grace period |

### Docs

`docs/__tests__/release-notes.test.ts` — every entry in `CHANGELOG.md` has the five header lines
in order, and `Migration:` matches whether the release actually adds a file under
`packages/db/migrations`.

---

## Verification

On a **clean VPS** (2 vCPU / 4 GB, fresh Debian, Docker installed, DNS pointed at it):

1. `git clone && ./thibi init` — one question. `.env` is `0600`. The `APP_SECRET_KEY` warning
   appears and requires an acknowledgement.
2. `./thibi up -d` — every service healthy, `migrate` exits 0, the `/setup` link prints.
3. Open the link. Create an admin. Paste Google SA JSON. **Test connection** passes. Pick two
   languages. Skip both optional steps. Upload a file. **At no point was `.env` reopened.**
4. `curl -r 0-1023` on a presigned URL through Caddy → `HTTP/2 206` with `Content-Range`. Scrub a
   90-minute file in the editor and watch the network panel: many small Range requests, not one
   large one.
5. Break it deliberately: set `S3_PUBLIC_ENDPOINT=http://minio:9000`, restart `web`, retry the
   curl → `403 SignatureDoesNotMatch`. Confirm the runbook entry names this exact symptom.
6. `MEDIA_SERVING=proxy`, restart, repeat step 4. Range still works; `media_access_log` now has
   byte counts.
7. `./thibi doctor` from the shell and `/admin/system` in the browser report the same thing.
8. Stop the stack, `PROFILES=local-models`, `./thibi models pull --dry-run` then `pull`. Confirm
   it refuses without a valid `HF_TOKEN` and links to the licence page. `hf-cache` ends up ~2 GB
   for distil + pyannote.
9. Transcribe a 10-minute file with local models and time it. The realtime factors are within the
   §5 ranges — **if pyannote on this box is not ~0.6× realtime, fix the table, not the claim.**
   *(This instruction did its job on 2026-08-10: the table said 0.15–0.4×, S6 measured 0.56–0.79×,
   and the table was fixed. Expect this box to differ again — those numbers came off a 2018 laptop
   CPU pinned to pyannote 3.3.2, and a Linux sidecar on pyannote 4.x should beat them. Measure
   twice: run-to-run variance was 6–8%, enough to mislead a single sample.)*
10. Kill `worker` mid-`batchRecognize`; `./thibi up -d`. ASR is **not** repeated (one
    `usage_records` row), the poll resumes, and the browser's SSE replays from `Last-Event-ID`.
11. `./thibi backup`. Confirm order in the log: `pg_dump` before `mc mirror`. Confirm the
    `APP_SECRET_KEY` and off-box warnings both print.
12. `./thibi restore` into a **fresh stack** with the correct key → secrets decrypt, a transcript
    opens, audio plays. Then repeat with a wrong key → aborts in seconds, before the mirror.
13. `./thibi backup --verify` → passes, and `/admin/system` shows "last verified restore: today".
14. `./thibi upgrade --to <next>` → backup runs first, migration applies, health check confirms
    the new engine and migration numbers, and the rollback line is printed and works.
15. `docker compose logs worker | jq 'select(.runId=="…")'` reconstructs a full run. `grep -E
    'sk-ant|BEGIN PRIVATE KEY|X-Amz-Signature'` across all logs finds **nothing**.
16. Fill the disk to 95% and confirm the log rotation caps hold and Postgres is still up.
17. Read the README end to end as someone who has never seen the project. The five hard truths
    (CPU diarization, `APP_SECRET_KEY`, presigned URLs, encryption-vs-root, yt-dlp) are all
    findable in under a minute.

---

## Risks and open questions

1. **The `handle_path` / two-client interaction is the single most likely deployment failure.**
   It is silent, it looks like a credentials problem, and it only manifests in the browser. The
   day-one `curl` check, the runbook entry naming the exact symptom, and `./thibi doctor`
   performing the same check automatically are three overlapping mitigations because one is not
   enough.
2. **MinIO's licence and release cadence.** MinIO has changed its licensing and removed features
   from the community build before. `packages/storage` already abstracts the object store, and
   `STORAGE_DRIVER=fs` exists as the documented escape hatch (overview, cut list). Pin
   `MINIO_TAG` rather than tracking `latest`, and revisit before v2.
3. **`start_period: 300s` on the sidecar.** A first boot downloading 4 GB on a slow link can
   exceed it and Compose will report the service unhealthy while it is fine. `thibi models pull`
   before `up` is the intended path; the healthcheck should distinguish "downloading" from
   "broken" by having `/healthz` return 503 with `{"state":"loading","pct":42}` rather than
   failing to answer.
4. **Unattended kernel upgrades.** §11 handles them, but a reboot during a *local* diarization
   pass discards hours of compute. Recommend disabling unattended reboots, or scheduling them,
   in the README's requirements section.
5. **Backups on the same host.** The warning prints, and nobody will read it. Consider making
   `BACKUP_DEST` a required setting in the `backup` profile (an rclone remote or an SSH target)
   so enabling backups forces the question. Decide before the profile ships.
6. **`docker compose` version drift.** `service_completed_successfully`, `profiles` and
   `x-` anchors need Compose v2.20+. `./thibi` should check `docker compose version` on every run
   and refuse with a clear message rather than producing a confusing parse error.
7. **Open question — arm64.** A newsroom on an Ampere VPS or an Apple Silicon evaluation box
   needs multi-arch images. The Node image is straightforward; `faster-whisper`'s CTranslate2 and
   `pyannote`'s torch wheels are the risk. Build multi-arch for the Node image from day one;
   publish the sidecar as amd64-only until tested, and say so in the README.
8. **Open question — where do backups of `hf-cache` live?** Nowhere, deliberately: it is
   re-downloadable. Confirm that is acceptable for air-gapped installs, which cannot re-download.
   Those need a documented `docker save` / volume-tar path instead.

---

## Definition of done

- [ ] `git clone && ./thibi init && ./thibi up -d` on a clean VPS reaches a working `/setup` link,
      asking exactly one question.
- [ ] An administrator configures providers, models, languages, users, retention and rates
      entirely in the browser. `.env` is never reopened after `init`.
- [ ] `compose.yml` starts the full topology with healthchecks and correct `depends_on`
      conditions; one-shots are `restart: "no"`; a failed `migrate` blocks `web` and `worker` and
      `./thibi up` prints its log.
- [ ] `PROFILES=` and `GPU=` in `.env` produce the right `-f` and `--profile` flags with no
      manual docker invocation; unknown subcommands forward to the CLI inside the image.
- [ ] `compose.gpu.yml` merges cleanly and is documented as Linux-only.
- [ ] Caddy terminates TLS and `handle_path /s3/*` reaches MinIO with the prefix stripped;
      `caddy validate` is in CI.
- [ ] Two S3 clients exist, `s3Public` cannot send requests (compile-time), and
      `curl -r 0-1023` through Caddy returns `206` with a correct `Content-Range` on a real
      deployment.
- [ ] Presigned URLs expire in 15 minutes, every mint writes `media_access_log`, and
      `MEDIA_SERVING=proxy` serves Range requests correctly using the ported handler.
- [ ] The README publishes the three resource tiers and the honest throughput numbers, including
      **pyannote on CPU at ~0.6× realtime** — measured, not inherited, and re-measured on the
      deployment host rather than copied from S6's laptop.
- [ ] `thibi models pull` verifies the HF token and licence acceptance before downloading, and
      `--dry-run` reports total bytes against free space.
- [ ] Migrations are forward-only, guarded by an advisory lock, applied by a one-shot service, and
      `web` refuses to serve against an under-migrated database.
- [ ] `thibi backup` captures DB **then** objects, warns that `APP_SECRET_KEY` is excluded and
      that the backup is on the same host; `thibi restore` probes decryption before touching
      objects; `--verify` runs monthly and surfaces in `/admin/system`.
- [ ] `thibi upgrade` backs up, pulls, migrates, restarts, health-checks and prints a working
      rollback line. `IMAGE_TAG` is pinned; `latest` appears nowhere.
- [ ] Workers drain on SIGTERM within `stop_grace_period` and release their locks.
- [ ] Every release note states migration yes/no and reversible yes/no in its first five lines,
      enforced in CI.
- [ ] Logs are pino JSON on stdout with `AsyncLocalStorage` context and redaction; no secret and
      no presigned URL appears in any log line; no Loki/Grafana/Prometheus container exists.
- [ ] The README carries all five hard truths in plain language, and `docs/RUNBOOK.md` contains
      the interrupted-mid-pipeline entry with its verification commands and its "what wrong looks
      like" section.

