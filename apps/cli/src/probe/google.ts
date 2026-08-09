import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import type { CliEnv } from '../config.js';
import { ProbeAbort, parseRetryAfter, type ProbeOutcome, type ProbeProvider } from './types.js';

/**
 * Google Speech-to-Text v2, `recognize` with inline content.
 *
 * `config.adaptation` is deliberately never sent. Spike S1 (2026-08-09) measured that
 * `chirp_2` does not honour an inline phrase set — boost 0, 10 and 20 produced byte-
 * identical output and relevant keyterms produced zero lexical change — while an
 * *irrelevant* phrase set corrupted အာဆီယံ into အာစီယံ in all five occurrences of a word
 * the baseline got right. Supplying a phrase set is not free, so we supply none. See
 * plans/phase-00-spike-results.md.
 */
export const CHIRP_ADAPTATION = 'none' as const;

interface RecognizeResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      words?: Array<{ word?: string; startOffset?: string; endOffset?: string }>;
    }>;
  }>;
  error?: { message?: string };
}

/** Whisper endpoints want a bare ISO code; Google wants the full tag it published. */
export function createGoogleProbe(env: CliEnv, region: string, model: string): ProbeProvider {
  let auth: GoogleAuth | null = null;
  let projectId = env.googleProjectId;

  return {
    id: 'google',
    models: [model],
    defaultConcurrency: 4,
    providerCode: (code) => code,

    async configure() {
      if (!env.googleCredentialsPath) {
        throw new ProbeAbort(
          'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a service-account JSON ' +
            'with roles/speech.client.',
        );
      }
      auth = new GoogleAuth({
        keyFile: env.googleCredentialsPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      if (!projectId) {
        const raw = JSON.parse(readFileSync(env.googleCredentialsPath, 'utf8')) as {
          project_id?: string;
        };
        projectId = raw.project_id;
      }
      if (!projectId) {
        throw new ProbeAbort('No project id: set GOOGLE_PROJECT_ID or use a key with project_id.');
      }
      // Fail here rather than on the first of 117 requests.
      await auth.getAccessToken();
    },

    async probe({ code, clip }): Promise<ProbeOutcome> {
      const token = await auth!.getAccessToken();
      const url =
        `https://${region}-speech.googleapis.com/v2/projects/${projectId}` +
        `/locations/${region}/recognizers/_:recognize`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            autoDecodingConfig: {},
            languageCodes: [code],
            model,
            features: { enableWordTimeOffsets: true, enableWordConfidence: true },
          },
          content: clip.toString('base64'),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as RecognizeResponse;
      const alternatives = (body.results ?? []).flatMap((r) => r.alternatives ?? []);
      const transcript = alternatives
        .map((a) => a.transcript ?? '')
        .join(' ')
        .trim();
      const words = alternatives.flatMap((a) => a.words ?? []);

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return {
        httpStatus: response.status,
        transcript,
        hasWords: transcript.length === 0 ? null : words.length > 0,
        ...(body.error?.message ? { errorMessage: body.error.message } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    },
  };
}
