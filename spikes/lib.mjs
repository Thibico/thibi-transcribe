import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

/**
 * Shared plumbing for the Phase 0 spike scripts.
 *
 * These are recorded instruments, not product code: they exist so that any number in
 * RESULTS.md can be re-measured rather than taken on trust. Keep them small and obvious.
 */

export const env = {
  project: process.env.GOOGLE_PROJECT_ID,
  region: process.env.GOOGLE_REGION ?? 'asia-southeast1',
  model: process.env.GOOGLE_MODEL ?? 'chirp_2',
  bucket: process.env.GOOGLE_GCS_STAGING_BUCKET,
  credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
};

export async function accessToken() {
  if (!env.credentials) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. See .env.example.');
    process.exit(2);
  }
  const key = JSON.parse(fs.readFileSync(env.credentials, 'utf8'));
  env.project ??= key.project_id;
  const auth = new GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const { token } = await (await auth.getClient()).getAccessToken();
  return token;
}

export const speechUrl = (verb) =>
  `https://${env.region}-speech.googleapis.com/v2/projects/${env.project}` +
  `/locations/${env.region}/recognizers/_:${verb}`;

export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The request body every spike sends, minus whatever that spike is varying. */
export function baseConfig(languageCode = 'my-MM') {
  return {
    autoDecodingConfig: {},
    languageCodes: [languageCode],
    model: env.model,
    features: {
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      enableWordConfidence: true,
    },
  };
}

export function words(response) {
  return (response.results ?? []).flatMap((r) => r.alternatives?.[0]?.words ?? []);
}

export function transcript(response) {
  return (response.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript ?? '')
    .join('')
    .trim();
}
