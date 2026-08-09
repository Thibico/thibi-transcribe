/**
 * The application boundary. `apps/*` may read `process.env`; the engine packages may not,
 * and an ESLint rule enforces that. Everything ambient is read here and passed down.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The default Google region.
 *
 * This is the ONLY file in source permitted to name a region, and CI enforces that. The
 * old app carried a doctrine that Chirp 2 plus my-MM worked only in a narrow overlap of
 * regions and that us-central1 failed outright — repeated in four places, including an
 * error-message hint. It is measured false twice: the 2026-07-30 provider probe accepted
 * all 117 locale codes in asia-southeast1, europe-west4 and us-central1, and spike S3 on
 * 2026-08-09 got a 200 with identical correct Burmese from all three.
 *
 * Region is a latency and data-residency choice. This value is simply the one nearest the
 * primary user. Do not restore the justification.
 */
export const DEFAULT_GOOGLE_REGION = 'asia-southeast1';

export const DEFAULT_GOOGLE_MODEL = 'chirp_2';

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
}

export function readEnv(): CliEnv {
  return {
    googleCredentialsPath: process.env['GOOGLE_APPLICATION_CREDENTIALS'],
    googleProjectId: process.env['GOOGLE_PROJECT_ID'],
    googleRegion: process.env['GOOGLE_REGION'] ?? DEFAULT_GOOGLE_REGION,
    googleModel: process.env['GOOGLE_MODEL'] ?? DEFAULT_GOOGLE_MODEL,
    openaiApiKey: process.env['OPENAI_API_KEY'],
    groqApiKey: process.env['GROQ_API_KEY'],
  };
}
