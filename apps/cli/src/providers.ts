import {
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
  type GoogleConfig,
  type GroqConfig,
  type OpenAiConfig,
  type ProviderConfig,
  type SettingsPort,
  type TranscriptionProvider,
} from '@thibi/engine';
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
      throw new NotConfiguredError(
        'faster-whisper runs on the Phase 3 sidecar, which is not built yet. Phase 4 shipped ' +
          'the HTTP half — google, openai and groq work today.',
      );
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
