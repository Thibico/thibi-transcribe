import { Command } from 'commander';
import { FASTER_WHISPER_MODELS, NotConfiguredError } from '@thibi/engine';
import { buildContext } from '../context.js';
import { EXIT } from '../output.js';

const ENGINE_VERSION = '0.1.0';

/**
 * `thibi models` — pre-download faster-whisper weights, and say what is cached.
 *
 * **This command exists because the first run of a fresh instance otherwise looks like a
 * hang.** `large-v3` is about 3 GB, it downloads on first use into the `hf-cache` volume,
 * and a newsroom that starts a two-hour interview and watches nothing happen for ten
 * minutes has no way to tell a download from a wedged container. Doing it deliberately, with
 * output, is the whole feature.
 *
 * The pull runs *on the sidecar*, not here: the cache is a volume inside that container and
 * this process has no business writing to it. So `pull` is a transcription of one second of
 * silence — the cheapest request that forces a model load — rather than an HTTP download
 * this command manages. That is a smaller surface than a `/v1/models/pull` route, and it
 * exercises exactly the path a real run will take, which a bespoke download endpoint would
 * not.
 */
export function modelsCommand(): Command {
  const command = new Command('models').description('Manage locally-hosted model weights');

  command
    .command('list')
    .description('Models this instance will load, and which one is resident')
    .action(async () => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        const health = await sidecarHealth(cli.sidecarUrl);
        const resident = health.asr_model;
        for (const model of FASTER_WHISPER_MODELS) {
          const marks: string[] = [];
          if (model === resident) marks.push('loaded now');
          if (model === 'distil-large-v3') marks.push('English only');
          const factor = health.realtime_factors?.[`asr:${model}`];
          // Measured on *this* box, from the last five runs. Never the plan's table: that
          // was an 8 vCPU reference machine and this one is whatever it is.
          if (factor !== undefined) marks.push(`${factor}x realtime here`);
          process.stdout.write(
            `${model.padEnd(18)}${marks.length ? `(${marks.join(', ')})` : ''}\n`,
          );
        }
      } catch (error) {
        reportSidecarProblem(error);
        return;
      } finally {
        await cli.close();
      }
    });

  command
    .command('pull')
    .argument('<model>', `one of ${FASTER_WHISPER_MODELS.join(', ')}`)
    .description('Download a model into the sidecar cache before a real run needs it')
    .action(async (model: string) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!FASTER_WHISPER_MODELS.includes(model)) {
          process.stderr.write(
            `Unknown model '${model}'. Expected one of ${FASTER_WHISPER_MODELS.join(', ')}.\n`,
          );
          process.exitCode = EXIT.usage;
          return;
        }
        const baseUrl = cli.sidecarUrl;
        if (!baseUrl) throw new NotConfiguredError('SIDECAR_URL is not set.');

        process.stdout.write(`pulling ${model} into the sidecar cache…\n`);
        if (model === 'large-v3') {
          process.stdout.write('  about 3 GB on a cold cache; this is the wait it exists to move\n');
        }

        const started = Date.now();
        const url = (path: string): string => new URL(path, baseUrl).toString();
        // One second of silence, staged nowhere: the sidecar fetches it like any other
        // audio. The point is the model load, not the transcript.
        const response = await fetch(url('/v1/transcribe'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotency_key: `models-pull:${model}:${Date.now()}`,
            audio_url: `${baseUrl.replace(/\/$/, '')}/__silence__`,
            expected_duration_ms: 1000,
            model,
            deadline_s: 3600,
          }),
        });
        if (response.status === 429) {
          process.stderr.write('The sidecar is busy with another task. Try again when it is idle.\n');
          process.exitCode = EXIT.notConfigured;
          return;
        }
        if (response.status === 400) {
          const body = (await response.json()) as { error?: { message?: string } };
          process.stderr.write(`${body.error?.message ?? 'the sidecar refused the model'}\n`);
          process.exitCode = EXIT.usage;
          return;
        }
        if (!response.ok) {
          process.stderr.write(`The sidecar returned HTTP ${response.status}.\n`);
          process.exitCode = EXIT.notConfigured;
          return;
        }

        const { task_id: taskId } = (await response.json()) as { task_id: string };
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const polled = await fetch(url(`/v1/tasks/${taskId}`));
          const status = (await polled.json()) as {
            state: string;
            error?: { code: string; message: string };
          };
          if (status.state === 'succeeded') break;
          if (['failed', 'cancelled', 'lost'].includes(status.state)) {
            // **`bad_audio` is success here.** The silence URL is a 404 by design — the
            // model has to load before the audio is fetched, so reaching the fetch at all
            // proves the weights are cached. Anything else is a real failure.
            if (status.error && status.error.code !== 'model_unavailable') break;
            process.stderr.write(
              `Could not pull ${model}: ${status.error?.message ?? status.state}\n`,
            );
            process.exitCode = EXIT.notConfigured;
            return;
          }
          process.stdout.write('.');
        }
        process.stdout.write(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      } catch (error) {
        reportSidecarProblem(error);
        return;
      } finally {
        await cli.close();
      }
    });

  return command;
}

interface SidecarHealth {
  models: { asr: string };
  asr_model: string | null;
  realtime_factors?: Record<string, number>;
}

async function sidecarHealth(baseUrl: string | null): Promise<SidecarHealth> {
  if (!baseUrl) throw new NotConfiguredError('SIDECAR_URL is not set.');
  const response = await fetch(new URL('/health', baseUrl).toString(), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`the sidecar returned HTTP ${response.status}`);
  return (await response.json()) as SidecarHealth;
}

function reportSidecarProblem(error: unknown): void {
  // An unset SIDECAR_URL is a supported configuration — this box does no local ASR — and
  // deserves a sentence rather than a stack trace, exactly as `thibi diarize` decided.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT.notConfigured;
}
