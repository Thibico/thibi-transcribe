import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createFasterWhisperProvider,
  createGoogleProvider,
  createGroqProvider,
  createOpenAiProvider,
  systemClock,
  resolveModelWithReason,
  GROQ_DEFAULT_MODEL,
  GROQ_SYNC_MAX_BYTES_DEV,
  GROQ_SYNC_MAX_BYTES_FREE,
  NotConfiguredError,
  OPENAI_DEFAULT_MODEL,
  resolveFasterWhisperModel,
  type FasterWhisperConfig,
  type GoogleConfig,
  type GroqConfig,
  type OpenAiConfig,
  type ProviderConfig,
  type SettingsPort,
  type TranscriptionProvider,
} from '@thibi/engine';
import type { ObjectStore } from '@thibi/storage';
import { chooseProvider, PROVIDER_MATRIX, type ProviderId } from '@thibi/languages';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from './config.js';
import { resolveServiceAccountJson, type EnvKey } from './context.js';

/**
 * Build a provider from the environment.
 *
 * One place that knows how each provider is configured, because there are now three of them
 * and `transcribe` is no longer the only command that needs one. The engine still learns
 * nothing about the environment: this file reads what `context.ts` collected and hands the
 * result down as a `ProviderConfig`.
 */

export const PROVIDER_IDS = ['google', 'openai', 'groq', 'faster-whisper'] as const;

export interface BuiltProvider {
  provider: TranscriptionProvider;
  config: ProviderConfig;
  model: string;
  /**
   * Why this model, in a sentence. Printed on every run. A silent model choice is the same
   * support ticket as a silent provider choice.
   */
  modelReason: string;
}

export interface BuildProviderInput {
  id: string;
  env: Partial<Record<EnvKey, string>>;
  settings: SettingsPort;
  /** The registry code, already resolved. */
  languageCode: string;
  /** An explicit `--model`, if given. */
  model?: string | undefined;
  requireWordTimestamps: boolean;
  /**
   * Needed only by faster-whisper, which is the one provider whose audio has to be
   * *somewhere the sidecar can fetch it* rather than in this process's temp directory. The
   * store stays here rather than reaching the provider: `stageAudio` is built from it below
   * and handed down, so `faster-whisper.ts` never learns what S3 is.
   */
  store?: ObjectStore;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export async function buildProvider(input: BuildProviderInput): Promise<BuiltProvider> {
  switch (input.id) {
    case 'google':
      return buildGoogle(input);
    case 'openai':
      return buildOpenAi(input);
    case 'groq':
      return buildGroq(input);
    case 'faster-whisper':
      return buildFasterWhisper(input);
    default:
      throw new NotConfiguredError(
        `Unknown provider '${input.id}'. Expected one of ${PROVIDER_IDS.join(', ')}.`,
      );
  }
}

async function buildGoogle(input: BuildProviderInput): Promise<BuiltProvider> {
  const serviceAccountJson = await resolveServiceAccountJson(input.env);
  if (!serviceAccountJson) {
    throw new NotConfiguredError(
      'No Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account ' +
        'JSON with roles/speech.client, or GOOGLE_SA_JSON to its contents.',
    );
  }

  const projectId =
    (await input.settings.get('google.project_id')) ??
    (JSON.parse(serviceAccountJson) as { project_id?: string }).project_id;
  if (!projectId) {
    throw new NotConfiguredError('No Google project id: set GOOGLE_PROJECT_ID.');
  }

  const model =
    input.model ?? (await input.settings.get('google.model')) ?? DEFAULT_GOOGLE_MODEL;

  const config: GoogleConfig = {
    serviceAccountJson,
    projectId,
    region: (await input.settings.get('google.region')) ?? DEFAULT_GOOGLE_REGION,
    model,
  };

  return {
    provider: createGoogleProvider({ clock: systemClock() }),
    config,
    model,
    modelReason: input.model ? 'requested with --model' : `the configured default (${model})`,
  };
}

function buildOpenAi(input: BuildProviderInput): BuiltProvider {
  const apiKey = input.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new NotConfiguredError('OPENAI_API_KEY is not set.');
  }

  // The model is resolved from the matrix rather than defaulted, because for seven languages
  // the answer is "the only model that accepts this returns no timestamps" and that has to
  // reach the user as a sentence, not as a 400 later on.
  const resolved = resolveModelWithReason(input.languageCode, {
    requireWordTimestamps: input.requireWordTimestamps,
  });

  /**
   * **A null model is the answer, not a gap to paper over.**
   *
   * This was `?? OPENAI_DEFAULT_MODEL` for about an hour, and the fallback quietly undid the
   * entire point of the resolver: `--lang bn-IN` sent `whisper-1`, OpenAI answered
   * `400 Language 'bn' is not supported.`, and the user was told the language was unsupported
   * when in fact it is supported and merely cannot carry timestamps. The unit test on
   * `resolveModelWithReason` passed the whole time, because the null it returned was correct
   * and it was this line that threw it away. Running the command is what found it.
   *
   * An explicit `--model` still wins: someone who names a model has taken the decision.
   */
  if (!input.model && resolved.model === null) {
    // Name the provider that *can* do it. "Pick another provider" is advice; "google, chirp_2"
    // is the next command they type.
    const alternative = chooseProvider(input.languageCode, {
      requireWordTimestamps: input.requireWordTimestamps,
    });
    const suggestion =
      alternative && alternative.providerId !== 'openai'
        ? ` Try --provider ${alternative.providerId}${alternative.model ? ` --model ${alternative.model}` : ''}.`
        : '';
    throw new NotConfiguredError(`OpenAI cannot transcribe ${input.languageCode}.`, {
      hint: resolved.reason + suggestion,
    });
  }
  const model = input.model ?? resolved.model ?? OPENAI_DEFAULT_MODEL;

  const config: OpenAiConfig = {
    apiKey,
    model,
    ...(input.env.OPENAI_ORGANIZATION ? { organization: input.env.OPENAI_ORGANIZATION } : {}),
  };

  return {
    provider: createOpenAiProvider(),
    config,
    model,
    modelReason: input.model ? 'requested with --model' : resolved.reason,
  };
}

/**
 * Where a staged clip lives, and why it is deleted.
 *
 * A scratch prefix rather than the content-addressed `assets/` tree: this object exists for
 * the seconds between "the sidecar needs a URL" and "the sidecar has the bytes", and putting
 * a transient copy of an interview in the same place as the durable one would make the
 * dedupe path's `delete` a hazard (see the two-key-schemes note in the handoff).
 */
const ASR_SCRATCH_PREFIX = 'scratch/asr';

function buildFasterWhisper(input: BuildProviderInput): BuiltProvider {
  const baseUrl = input.env.SIDECAR_URL;
  if (!baseUrl) {
    throw new NotConfiguredError('SIDECAR_URL is not set, so this box cannot run faster-whisper.', {
      hint:
        'Start it with `docker compose --env-file .env -f infra/compose.dev.yml --profile ' +
        'diarize up -d sidecar` and set SIDECAR_URL=http://localhost:8081, or use ' +
        '--provider google.',
    });
  }
  const store = input.store;
  if (!store) {
    // Not a user error: a caller wired this wrong. Say so plainly rather than failing later
    // with a URL that was never minted.
    throw new NotConfiguredError(
      'faster-whisper needs an object store to stage audio for the sidecar, and none was ' +
        'provided to buildProvider.',
    );
  }

  const model = input.model ?? resolveFasterWhisperModel(input.languageCode);

  const config: FasterWhisperConfig = {
    baseUrl,
    model,
    /**
     * Upload, presign, and hand back the URL plus the way to undo it.
     *
     * `presignGet` mints against the **internal** endpoint when `S3_INTERNAL_ENDPOINT` is
     * set, because SigV4 signs `Host`: a URL signed for `localhost:9000` comes back 403 the
     * moment the sidecar asks for it as `minio:9000`. That is overview amendment 43, and it
     * cost the first real diarization.
     */
    stageAudio: async (localPath: string) => {
      const key = `${ASR_SCRATCH_PREFIX}/${randomUUID()}/${basename(localPath)}`;
      await store.putStream(key, createReadStream(localPath));
      const url = await store.presignGet(key, 6 * 3600);
      return { url, release: async () => void (await store.delete(key)) };
    },
  };

  return {
    provider: createFasterWhisperProvider(),
    config,
    model,
    modelReason: input.model
      ? 'requested with --model'
      : `${model}, chosen for ${input.languageCode}` +
        (model === 'distil-large-v3'
          ? ' (English only — a distillation of English data, so never the non-English default)'
          : ' (large-v3; --model large-v3-turbo trades accuracy for ~2x speed)'),
  };
}

function buildGroq(input: BuildProviderInput): BuiltProvider {
  const apiKey = input.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new NotConfiguredError('GROQ_API_KEY is not set.');
  }

  const dev = input.env.GROQ_TIER === 'dev';
  const model = input.model ?? PROVIDER_MATRIX[input.languageCode]?.groq?.models?.[0] ?? GROQ_DEFAULT_MODEL;
  const config: GroqConfig = { apiKey, model };

  return {
    provider: createGroqProvider({
      syncMaxBytes: dev ? GROQ_SYNC_MAX_BYTES_DEV : GROQ_SYNC_MAX_BYTES_FREE,
    }),
    config,
    model,
    modelReason: input.model
      ? 'requested with --model'
      : `${model}, the model the probe accepted for this language` +
        (dev ? ' (dev tier: 100 MB requests)' : ' (free tier: 25 MB requests)'),
  };
}
