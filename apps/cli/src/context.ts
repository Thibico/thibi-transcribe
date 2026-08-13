import { accessSync, constants, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { S3Client } from '@aws-sdk/client-s3';
import { closeDb, createDb, type Db } from '@thibi/db';
import { createRegistry, type LanguageRegistry } from '@thibi/languages';
import {
  createTempDirPort,
  FsObjectStore,
  MemoryObjectStore,
  S3ObjectStore,
  type ObjectStore,
} from '@thibi/storage';
import {
  createFfmpegPort,
  createGcsStaging,
  createMemorySettings,
  createSettings,
  createTokenCache,
  NotConfiguredError,
  systemClock,
  type EngineContext,
  type EventSink,
  type Logger,
  type SettingsPort,
  type StagingStore,
} from '@thibi/engine';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from './config.js';

/**
 * **The only file in the repository that reads the environment.**
 *
 * Everything the engine needs is assembled here and handed down through one
 * `EngineContext`. An ESLint rule and a CI grep keep it that way, and the payoff is
 * concrete: the Google provider cannot read `GOOGLE_APPLICATION_CREDENTIALS`, so it is
 * testable without a filesystem, runnable in a worker with settings from Postgres, and
 * configurable from a browser in Phase 10 — which the overview names as a hard requirement.
 *
 * The list below is exhaustive and reviewed. Adding to it is a deliberate act.
 */
const ENV_KEYS = [
  'DATABASE_URL',
  'STORAGE_DRIVER',
  'S3_ENDPOINT',
  // The endpoint the *sidecar* reaches MinIO on, when it differs from ours. SigV4 signs the
  // Host header, so a presigned URL minted against `http://localhost:9000` by a CLI on a
  // laptop is rejected 403 the moment a container fetches it as `http://minio:9000`.
  // Unset is correct whenever both sides see the same host — an engine running inside
  // compose, or an S3 with one real address. See `buildStore`.
  'S3_INTERNAL_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'STORAGE_FS_ROOT',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'GOOGLE_SA_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_PROJECT_ID',
  'GOOGLE_REGION',
  'GOOGLE_MODEL',
  // Unset means long files use chunked parallel sync, which spike S3 measured faster than
  // batchRecognize at every duration. Setting it opts into the cheaper, slower path.
  'GOOGLE_GCS_STAGING_BUCKET',
  'OPENAI_API_KEY',
  'OPENAI_ORGANIZATION',
  'GROQ_API_KEY',
  // 'free' (default) or 'dev'. The only thing it changes is the request byte cap — 25 MB
  // against 100 MB — and it defaults pessimistic: a free key that assumed 100 MB fails every
  // chunk, while a dev key that assumed 25 MB just sends more chunks than it had to.
  'GROQ_TIER',
  // Where the Python sidecar listens, e.g. http://localhost:8081. Unset means this box
  // does no diarization, which is a supported configuration and not a broken one — the
  // compose service is behind a profile.
  'SIDECAR_URL',
  'THIBI_TMP_DIR',
  'LOG_LEVEL',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export function readEnvironment(): Partial<Record<EnvKey, string>> {
  const out: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * A logger that writes human-readable progress to **stderr**, leaving stdout clean for the
 * transcript JSON. `thibi transcribe … > out.json` must produce a parseable file.
 */
export function createCliLogger(level: Level = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level];
  const write = (l: Level, o: object, msg?: string): void => {
    if (LEVELS[l] < threshold) return;
    const merged = { ...bindings, ...o } as Record<string, unknown>;
    const err = merged['err'];
    const context = Object.entries(merged)
      .filter(([k]) => k !== 'err')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    const detail = err instanceof Error ? ` — ${err.message}` : '';
    process.stderr.write(`${msg ?? ''}${context ? ` (${context})` : ''}${detail}\n`);
  };

  return {
    child: (extra) => createCliLogger(level, { ...bindings, ...extra }),
    debug: (o, m) => write('debug', o, m),
    info: (o, m) => write('info', o, m),
    warn: (o, m) => write('warn', o, m),
    error: (o, m) => write('error', o, m),
  };
}

/** Progress to stderr. Phase 9's worker inserts `run_events` and NOTIFYs instead. */
export function createCliEvents(logger: Logger): EventSink {
  return {
    emit(event) {
      logger.debug({ ...event.data }, `event: ${event.kind}`);
    },
  };
}

export interface BuildContextOptions {
  /** Skip Postgres and MinIO entirely: memory store, no persistence. */
  noDb?: boolean;
  logLevel?: Level;
  concurrency?: number;
  signal?: AbortSignal;
  engineVersion: string;
}

export interface CliContext {
  ctx: EngineContext;
  db: Db | null;
  languages: LanguageRegistry;
  settings: SettingsPort;
  /** Null when no staging bucket is configured — a supported and, since S3, faster setup. */
  staging: StagingStore | null;
  /** Null when `SIDECAR_URL` is unset: this box cannot diarize, and says so rather than hanging. */
  sidecarUrl: string | null;
  close: () => Promise<void>;
}

/** The `client_email` from a service-account key, for IAM remediation messages. */
export function serviceAccountEmailOf(serviceAccountJson: string): string | null {
  try {
    return (JSON.parse(serviceAccountJson) as { client_email?: string }).client_email ?? null;
  } catch {
    return null;
  }
}

function buildStore(env: Partial<Record<EnvKey, string>>, noDb: boolean): ObjectStore {
  if (noDb) return new MemoryObjectStore();

  const driver = env.STORAGE_DRIVER ?? (env.S3_ENDPOINT ? 's3' : 'fs');
  if (driver === 'fs') {
    return new FsObjectStore(env.STORAGE_FS_ROOT ?? './data/objects');
  }
  if (!env.S3_BUCKET) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET. See .env.example.');
  }
  const client = (endpoint: string | undefined): S3Client =>
    new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region: env.S3_REGION ?? 'us-east-1',
      // MinIO serves path-style; virtual-host style needs DNS per bucket.
      forcePathStyle: true,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });

  /**
   * Two clients when the sidecar reaches MinIO on a different host than we do.
   *
   * **SigV4 signs the `Host` header.** A URL presigned against `http://localhost:9000` by a
   * CLI running on a developer's laptop comes back **403 `audio_unreachable`** the instant
   * the sidecar requests it as `http://minio:9000` — measured, and it was the first failure
   * of the first real diarization (spike S8, overview amendment 43). Phase 3 §1 says the URL
   * is minted "with the `s3` client at `http://minio:9000`", which is true only when the
   * engine also runs inside compose.
   *
   * `signingClient` is the seam `S3ObjectStore` already had. Its own doc describes the
   * mirror-image case — signing for a *public* URL through Caddy so a browser can fetch
   * audio, Phase 10 — and the two never collide, because only one consumer of a presigned
   * URL exists at a time: Phase 3's sidecar now, a browser later. If both ever need one at
   * once, this becomes two methods rather than two clients.
   */
  return new S3ObjectStore({
    bucket: env.S3_BUCKET,
    client: client(env.S3_ENDPOINT),
    ...(env.S3_INTERNAL_ENDPOINT
      ? { signingClient: client(env.S3_INTERNAL_ENDPOINT) }
      : {}),
  });
}

/**
 * Resolve the Google service account to a JSON *string*.
 *
 * Ported out of the engine from `lib/providers/google.ts:43-66`, keeping its ergonomics:
 * accept either the JSON itself or a path to it, because both are things people paste.
 */
export async function resolveServiceAccountJson(
  env: Partial<Record<EnvKey, string>>,
): Promise<string | null> {
  const inline = env.GOOGLE_SA_JSON;
  if (inline) {
    return inline.trim().startsWith('{') ? inline : readFile(inline.trim(), 'utf8');
  }
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) return readFile(path, 'utf8');
  return null;
}

/**
 * Validate `THIBI_TMP_DIR` up front, because `mkdtemp` does not create its parent.
 *
 * Unset is the ordinary case and means the system temp directory. Set-but-wrong used to
 * surface as a raw `ENOENT: no such file or directory, mkdtemp …` stack trace from three
 * stages into a pipeline — after the probe, after normalize decided what it wanted, and in a
 * CLI whose entire error taxonomy exists so an operator never reads a trace.
 *
 * Checked here rather than at first use so the failure lands **before** any work: a bad
 * temp directory cannot be discovered halfway through a job that has already spent money.
 *
 * It is deliberately **not** created for you. `THIBI_TMP_DIR` is set by an operator, so a
 * missing directory is either a typo or a volume that failed to mount — and silently
 * creating it inside a container is how a missing mount becomes a disk that fills up
 * instead of an error someone reads.
 */
export function resolveTempRoot(configured: string | undefined): string {
  const dir = configured?.trim();
  if (!dir) return tmpdir();

  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new NotConfiguredError(`THIBI_TMP_DIR is set to a path that does not exist: ${dir}`, {
      hint:
        `Create it, or unset THIBI_TMP_DIR to use the system temp directory.\n` +
        `  mkdir -p ${dir}`,
    });
  }
  if (!stat.isDirectory()) {
    throw new NotConfiguredError(`THIBI_TMP_DIR is set to something that is not a directory: ${dir}`, {
      hint: 'Point it at a directory, or unset it to use the system temp directory.',
    });
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new NotConfiguredError(`THIBI_TMP_DIR is set to a directory that is not writable: ${dir}`, {
      hint: 'Grant write permission, or unset it to use the system temp directory.',
    });
  }
  return dir;
}

export async function buildContext(options: BuildContextOptions): Promise<CliContext> {
  const env = readEnvironment();
  const logLevel = options.logLevel ?? (env.LOG_LEVEL as Level | undefined) ?? 'info';
  const logger = createCliLogger(logLevel);

  const noDb = options.noDb ?? false;
  let db: Db | null = null;
  if (!noDb) {
    if (!env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set. Start the dev stack with\n' +
          '  docker compose -f infra/compose.dev.yml up -d\n' +
          'or pass --no-db to run without persistence.',
      );
    }
    db = createDb({ url: env.DATABASE_URL, max: 6, applicationName: 'thibi-cli' });
  }

  const settings = db
    ? createSettings({
        db,
        // Precedence is DB row → environment → default. The environment wins over a
        // stored row so an operator can override without a migration.
        envOverrides: {
          'google.project_id': env.GOOGLE_PROJECT_ID,
          'google.region': env.GOOGLE_REGION,
          'google.model': env.GOOGLE_MODEL,
          'google.gcs_staging_bucket': env.GOOGLE_GCS_STAGING_BUCKET,
        },
        defaults: {
          'google.region': DEFAULT_GOOGLE_REGION,
          'google.model': DEFAULT_GOOGLE_MODEL,
        },
      })
    : createMemorySettings({
        ...(env.GOOGLE_PROJECT_ID ? { 'google.project_id': env.GOOGLE_PROJECT_ID } : {}),
        'google.region': env.GOOGLE_REGION ?? DEFAULT_GOOGLE_REGION,
        'google.model': env.GOOGLE_MODEL ?? DEFAULT_GOOGLE_MODEL,
        ...(env.GOOGLE_GCS_STAGING_BUCKET
          ? { 'google.gcs_staging_bucket': env.GOOGLE_GCS_STAGING_BUCKET }
          : {}),
      });

  const languages = createRegistry();
  const concurrency = options.concurrency ?? 8;

  /**
   * The staging bucket, when one is configured.
   *
   * Built here and not in the engine for the usual reason — this is the only file that reads
   * the environment — but also because the token it needs is the *same* Google credential
   * the Speech provider uses. One credential, one token cache, one thing for an admin to get
   * right. A second staging credential setting would be a second thing to get wrong.
   */
  const serviceAccountJson = await resolveServiceAccountJson(env);
  const stagingBucket =
    (await settings.get('google.gcs_staging_bucket')) ?? env.GOOGLE_GCS_STAGING_BUCKET ?? null;

  let staging: StagingStore | undefined;
  if (stagingBucket && serviceAccountJson) {
    const tokens = createTokenCache({ clock: systemClock() });
    staging = createGcsStaging({
      bucket: stagingBucket,
      getToken: () => tokens.get(serviceAccountJson),
      clock: systemClock(),
      ...(serviceAccountEmailOf(serviceAccountJson)
        ? { serviceAccountEmail: serviceAccountEmailOf(serviceAccountJson)! }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } else if (stagingBucket && !serviceAccountJson) {
    logger.warn(
      {},
      'GOOGLE_GCS_STAGING_BUCKET is set but there are no Google credentials, so --mode batch ' +
        'is unavailable.',
    );
  }

  const ctx: EngineContext = {
    // A NullDb is not worth inventing: no stage in Phase 1 reads the database except
    // persist, which the caller simply does not run under --no-db.
    db: db as Db,
    store: buildStore(env, noDb),
    ...(staging ? { staging } : {}),
    settings,
    ffmpeg: createFfmpegPort({
      ffmpeg: env.FFMPEG_PATH ?? 'ffmpeg',
      ffprobe: env.FFPROBE_PATH ?? 'ffprobe',
    }),
    clock: systemClock(),
    logger,
    events: createCliEvents(logger),
    languages,
    concurrency: { asrChunks: concurrency, ffmpeg: Math.max(2, concurrency) },
    tmp: createTempDirPort(resolveTempRoot(env.THIBI_TMP_DIR)),
    ...(options.signal ? { signal: options.signal } : {}),
    engineVersion: options.engineVersion,
  };

  return {
    ctx,
    db,
    languages,
    settings,
    staging: staging ?? null,
    sidecarUrl: env.SIDECAR_URL ?? null,
    async close() {
      if (db) await closeDb(db);
    },
  };
}
