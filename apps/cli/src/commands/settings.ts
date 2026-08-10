import { Command } from 'commander';
import { createGcsStaging, createTokenCache, systemClock, validateStagingBucket } from '@thibi/engine';
import type { ValidationReport } from '@thibi/engine';
import { buildContext, resolveServiceAccountJson, readEnvironment, serviceAccountEmailOf } from '../context.js';
import { DEFAULT_GOOGLE_REGION } from '../config.js';
import { EXIT } from '../output.js';

/**
 * `thibi settings` — read and write instance configuration.
 *
 * The interesting part is `--check` on the staging bucket. "Your bucket is in the wrong
 * region" must surface when the admin pastes the bucket name, not ninety minutes into a
 * two-hour job by which point the audio is uploaded and the money is spent.
 */

/** Setting keys the CLI will accept. Typos become an error rather than a silent orphan row. */
const KNOWN_KEYS = [
  'google.project_id',
  'google.region',
  'google.model',
  'google.gcs_staging_bucket',
  'google.gcs_staging_allow_multiregion',
] as const;

/** `thibi settings set google_gcs_staging_bucket …` reads better than the dotted form. */
function canonicalKey(input: string): string | null {
  const dotted = input.replace(/_/g, '.').toLowerCase();
  const direct = KNOWN_KEYS.find((k) => k === input.toLowerCase());
  if (direct) return direct;
  // `google_gcs_staging_bucket` → `google.gcs.staging.bucket`, which is not the stored key.
  // Match on the underscore-flattened form of each known key instead of guessing.
  const flattened = KNOWN_KEYS.find((k) => k.replace(/[._]/g, '') === dotted.replace(/[._]/g, ''));
  return flattened ?? null;
}

function unknownKey(input: string): string {
  return (
    `Unknown setting '${input}'. Known keys:\n` + KNOWN_KEYS.map((k) => `  ${k}`).join('\n')
  );
}

export function settingsCommand(): Command {
  const command = new Command('settings').description('Read and write instance configuration');

  command
    .command('list')
    .description('Show every known setting and its current value')
    .action(async () => {
      const cli = await buildContext({ engineVersion: '0.1.0' });
      try {
        for (const key of KNOWN_KEYS) {
          const value = await cli.settings.get(key);
          process.stdout.write(`${key.padEnd(38)} ${value ?? '(unset)'}\n`);
        }
      } finally {
        await cli.close();
      }
    });

  command
    .command('get')
    .argument('<key>')
    .action(async (key: string) => {
      const canonical = canonicalKey(key);
      if (!canonical) {
        process.stderr.write(`${unknownKey(key)}\n`);
        process.exitCode = EXIT.usage;
        return;
      }
      const cli = await buildContext({ engineVersion: '0.1.0' });
      try {
        const value = await cli.settings.get(canonical);
        if (value === null) {
          process.stderr.write(`${canonical} is not set.\n`);
          process.exitCode = EXIT.usage;
          return;
        }
        process.stdout.write(`${value}\n`);
      } finally {
        await cli.close();
      }
    });

  command
    .command('set')
    .argument('<key>')
    .argument('<value>')
    .option(
      '--check',
      'For google_gcs_staging_bucket: verify region, storage class, write access and the ' +
        'lifecycle rule against the live bucket before saving.',
    )
    .action(async (key: string, value: string, opts: { check?: boolean }) => {
      const canonical = canonicalKey(key);
      if (!canonical) {
        process.stderr.write(`${unknownKey(key)}\n`);
        process.exitCode = EXIT.usage;
        return;
      }

      const cli = await buildContext({ engineVersion: '0.1.0' });
      try {
        if (canonical === 'google.gcs_staging_bucket' && opts.check) {
          const report = await checkBucket(value, await cli.settings.get('google.region'));
          if (report === null || report.missing) {
            // The one failure that is not worth saving. Every other one is a grant or a
            // rule the admin goes and fixes against a bucket that exists; this is a name to
            // correct, and storing it would just make the next command fail further away
            // from the typo.
            process.stderr.write(`Not saved.\n`);
            process.exitCode = EXIT.notConfigured;
            return;
          }
          // Saved even when checks failed. Recording a bucket name spends nothing, and an
          // admin fixing IAM and lifecycle in either order should not be locked out of the
          // first step. `ensureStageable` is what refuses, before a single byte is uploaded.
          if (!report.ok) process.exitCode = EXIT.notConfigured;
        }

        await cli.settings.set(canonical, value);
        process.stdout.write(`Saved ${canonical}.\n`);
      } finally {
        await cli.close();
      }
    });

  command
    .command('unset')
    .argument('<key>')
    .action(async (key: string) => {
      const canonical = canonicalKey(key);
      if (!canonical) {
        process.stderr.write(`${unknownKey(key)}\n`);
        process.exitCode = EXIT.usage;
        return;
      }
      const cli = await buildContext({ engineVersion: '0.1.0' });
      try {
        if (!cli.db) throw new Error('settings unset needs a database.');
        await cli.db.$client.query('delete from settings where key = $1', [canonical]);
        process.stdout.write(`Unset ${canonical}.\n`);
        const env = readEnvironment();
        if (canonical === 'google.gcs_staging_bucket' && env.GOOGLE_GCS_STAGING_BUCKET) {
          // Precedence is environment over stored row, so deleting the row changes nothing
          // while the variable is set. Saying so beats letting them wonder.
          process.stderr.write(
            `note: GOOGLE_GCS_STAGING_BUCKET=${env.GOOGLE_GCS_STAGING_BUCKET} is still set in ` +
              `the environment and takes precedence over the stored row.\n`,
          );
        }
      } finally {
        await cli.close();
      }
    });

  return command;
}

/** Build a staging store for a bucket that is not (yet) the configured one, and report. */
async function checkBucket(bucket: string, region: string | null): Promise<ValidationReport | null> {
  const env = readEnvironment();
  const serviceAccountJson = await resolveServiceAccountJson(env);
  if (!serviceAccountJson) {
    process.stderr.write(
      'Cannot check the bucket without Google credentials. Set ' +
        'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SA_JSON.\n',
    );
    return null;
  }

  const clock = systemClock();
  const tokens = createTokenCache({ clock });
  const email = serviceAccountEmailOf(serviceAccountJson);
  const staging = createGcsStaging({
    bucket,
    getToken: () => tokens.get(serviceAccountJson),
    clock,
    ...(email ? { serviceAccountEmail: email } : {}),
  });

  const report = await validateStagingBucket(
    staging,
    region ?? env.GOOGLE_REGION ?? DEFAULT_GOOGLE_REGION,
  );
  printReport(report);
  return report;
}

const LABEL: Record<string, string> = {
  metadata: 'bucket',
  'location-type': 'location type',
  region: 'region',
  'write-probe': 'write probe',
  lifecycle: 'lifecycle',
};

export function printReport(report: ValidationReport): void {
  process.stdout.write(`Bucket ${report.bucket}\n`);
  for (const check of report.checks) {
    const mark = check.ok ? '✓' : '✗';
    process.stdout.write(`  ${LABEL[check.id]?.padEnd(15)} ${check.detail}  ${mark}\n`);
  }

  // Every failing check's message, not just the first. An admin should see the whole list
  // once rather than turn one round of configuration into four.
  for (const check of report.checks) {
    if (check.message === undefined) continue;
    process.stdout.write(`\n${check.ok ? 'note' : LABEL[check.id]}: ${check.message}\n`);
  }

  if (!report.ok && !report.fixable && !report.missing) {
    process.stdout.write(
      `\nThis bucket cannot be used with the current recognizer region. That needs a ` +
        `different bucket, not a different permission.\n`,
    );
  }
}
