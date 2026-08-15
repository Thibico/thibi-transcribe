/**
 * The application boundary. `apps/*` may read `process.env`; the engine packages may not,
 * and an ESLint rule enforces that. Everything ambient is read here and passed down.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from '@thibi/runtime';

/**
 * The Google defaults live in `@thibi/runtime`, which is the only file in source permitted to
 * name a region — and they moved there the day the worker needed them too. Re-exported rather
 * than re-declared: two constants copied into two apps is how the *No region doctrine* grep
 * came to fail on `main`.
 */
export { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION };

/** Load `.env` from the repo root if present. Node's own loader; no dotenv dependency. */
export function loadDotEnv(cwd: string = process.cwd()): void {
  for (const dir of [cwd, resolve(cwd, '..'), resolve(cwd, '../..')]) {
    const path = resolve(dir, '.env');
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

export interface CliEnv {
  googleCredentialsPath: string | undefined;
  googleProjectId: string | undefined;
  googleRegion: string;
  googleModel: string;
  openaiApiKey: string | undefined;
  groqApiKey: string | undefined;

  /**
   * This instance's signing secret. Phase 15's `./thibi init` will own generating it; until
   * then an operator makes one with `openssl rand -base64 48`.
   *
   * Only URL import needs it today, to sign the resolve token that pins the cost a user
   * approved. Phase 10 reuses it for provider credentials, which is why losing it is
   * documented as unrecoverable rather than inconvenient.
   */
  appSecretKey: string | undefined;

  /** URL import is off unless yt-dlp is available and the operator has not disabled it. */
  ingestUrlEnabled: boolean;
  ingestUrlAllowedHosts: readonly string[];
  ytDlpPath: string;
  maxUploadBytes: number;
}

export function readEnv(): CliEnv {
  return {
    googleCredentialsPath: process.env['GOOGLE_APPLICATION_CREDENTIALS'],
    googleProjectId: process.env['GOOGLE_PROJECT_ID'],
    googleRegion: process.env['GOOGLE_REGION'] ?? DEFAULT_GOOGLE_REGION,
    googleModel: process.env['GOOGLE_MODEL'] ?? DEFAULT_GOOGLE_MODEL,
    openaiApiKey: process.env['OPENAI_API_KEY'],
    groqApiKey: process.env['GROQ_API_KEY'],
    appSecretKey: process.env['APP_SECRET_KEY'],
    // Opt-out rather than opt-in: the capability is a normal part of the product, and an
    // operator who wants it gone sets this to `false` and gets the routes and the CLI flag
    // gone with it.
    ingestUrlEnabled: process.env['INGEST_URL_ENABLED'] !== 'false',
    ingestUrlAllowedHosts: (process.env['INGEST_URL_ALLOWED_HOSTS'] ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    ytDlpPath: process.env['YT_DLP_PATH'] ?? 'yt-dlp',
    maxUploadBytes: Number(process.env['INGEST_MAX_UPLOAD_BYTES'] ?? 2 * 1024 * 1024 * 1024),
  };
}
