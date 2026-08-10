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
  createMemorySettings,
  createSettings,
  systemClock,
  type EngineContext,
  type EventSink,
  type Logger,
  type SettingsPort,
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
  close: () => Promise<void>;
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
  return new S3ObjectStore({
    bucket: env.S3_BUCKET,
    client: new S3Client({
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
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
    }),
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
      });

  const languages = createRegistry();
  const concurrency = options.concurrency ?? 8;

  const ctx: EngineContext = {
    // A NullDb is not worth inventing: no stage in Phase 1 reads the database except
    // persist, which the caller simply does not run under --no-db.
    db: db as Db,
    store: buildStore(env, noDb),
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
    tmp: createTempDirPort(env.THIBI_TMP_DIR ?? tmpdir()),
    ...(options.signal ? { signal: options.signal } : {}),
    engineVersion: options.engineVersion,
  };

  return {
    ctx,
    db,
    languages,
    settings,
    async close() {
      if (db) await closeDb(db);
    },
  };
}
