import type { LifecycleCheck } from './types.js';
import { STAGING_ROOT } from './types.js';

/**
 * The retention assertion.
 *
 * Staging uploads a newsroom's raw audio into Google Cloud Storage. A run that crashes
 * between the upload and the sweep leaves it there, and nothing in this codebase will ever
 * look at that prefix again. The lifecycle rule is the only thing that eventually deletes
 * it, so the engine refuses to stage until it can *see* one. This is the one place the
 * product is deliberately more opinionated than the API requires.
 *
 * GCS lifecycle rules are bucket-scoped but support a `matchesPrefix` condition, so the rule
 * we ask for is prefix-targeted and cannot delete anything else the newsroom keeps there.
 */

/** Anything longer than this is refused: it is a retention policy, not a cleanup rule. */
export const MAX_AGE_DAYS = 7;
/** Accepted, with a warning. One day is what the fix command writes. */
export const PREFERRED_AGE_DAYS = 1;

/** The shape GCS returns under `bucket.lifecycle`. */
export interface RawLifecycle {
  rule?: Array<{
    action?: { type?: string; storageClass?: string };
    condition?: {
      age?: number;
      matchesPrefix?: string[];
      createdBefore?: string;
      numNewerVersions?: number;
      isLive?: boolean;
      [key: string]: unknown;
    };
  }>;
}

const FIX_LIFECYCLE_JSON = JSON.stringify(
  { rule: [{ action: { type: 'Delete' }, condition: { age: 1, matchesPrefix: [STAGING_ROOT] } }] },
  null,
  2,
);

export function fixCommand(bucket: string): string {
  return (
    `cat > lifecycle.json <<'JSON'\n` +
    `{"rule":[{"action":{"type":"Delete"},\n` +
    `          "condition":{"age":1,"matchesPrefix":["${STAGING_ROOT}"]}}]}\n` +
    `JSON\n` +
    `gcloud storage buckets update gs://${bucket} --lifecycle-file=lifecycle.json\n` +
    `# or: gsutil lifecycle set lifecycle.json gs://${bucket}`
  );
}

/**
 * The IAM fix, and the reason it is a separate message.
 *
 * Measured 2026-08-10: `roles/storage.objectAdmin` — the obvious least-privilege grant for a
 * staging bucket — can write and delete objects but gets a 403 on `storage.buckets.get`, so
 * the lifecycle rule cannot be read at all. The bucket may be perfectly configured; we
 * simply cannot see it, and a retention guarantee we cannot verify is not one.
 *
 * The role named is `legacyBucketReader`, which adds `storage.buckets.get` and
 * `storage.objects.list` and nothing else. The phase plan's draft said `roles/storage.admin`;
 * granting full bucket administration to read one metadata field is advice that gets pasted
 * once and then lives in an IAM policy forever.
 */
export function iamFixCommand(bucket: string, serviceAccount = '<SERVICE_ACCOUNT_EMAIL>'): string {
  return (
    `gcloud storage buckets add-iam-policy-binding gs://${bucket} \\\n` +
    `  --member=serviceAccount:${serviceAccount} \\\n` +
    `  --role=roles/storage.legacyBucketReader`
  );
}

/**
 * Does a rule's prefix condition cover our staging root?
 *
 * Absent means the rule applies to the whole bucket, which covers `thibi-staging/` by
 * definition — and for a dedicated staging bucket a bucket-wide delete is a *stronger*
 * guarantee than a prefixed one, not a weaker one. Measured 2026-08-10: the real bucket's
 * rule is exactly this shape.
 */
function coversStagingRoot(prefixes: string[] | undefined): boolean {
  if (prefixes === undefined || prefixes.length === 0) return true;
  return prefixes.some((p) => STAGING_ROOT.startsWith(p));
}

/**
 * Evaluate a bucket's lifecycle configuration against the acceptance rule.
 *
 * **Any** `Delete` action whose condition has `age <= 7` and whose `matchesPrefix` is absent
 * or is a prefix of `thibi-staging/`. A rule carrying extra conditions is ignored rather than
 * accepted: `numNewerVersions` or `isLive` narrows *when* the delete fires, and a rule that
 * only deletes non-current versions guarantees nothing about the object we just uploaded.
 * Refusing to reason about them is the safe direction — the operator adds one plain rule and
 * everything is legible again.
 *
 * `SetStorageClass` actions are not deletes and are skipped silently; a bucket that ages
 * objects to Coldline still keeps them forever.
 */
export function assertLifecycle(
  bucket: string,
  lifecycle: RawLifecycle | null,
  options: { permitted: boolean; serviceAccount?: string },
): LifecycleCheck {
  if (!options.permitted) {
    return {
      ok: false,
      reason: 'no-permission',
      message:
        `Cannot read the lifecycle configuration of gs://${bucket}: the service account is ` +
        `not permitted to call storage.buckets.get.\n\n` +
        `Staging uploads raw audio into this bucket, and the lifecycle rule is the only ` +
        `thing that deletes it if a run fails. We will not stage into a bucket whose ` +
        `retention we cannot verify — the bucket may well be configured correctly, but ` +
        `"probably" is not a guarantee to make with someone's source recordings.\n\n` +
        `Grant the narrow read role:\n\n` +
        indent(iamFixCommand(bucket, options.serviceAccount)),
      command: '',
      lifecycleJson: FIX_LIFECYCLE_JSON,
    };
  }

  const rules = lifecycle?.rule ?? [];
  const deletes = rules.filter((r) => r.action?.type === 'Delete' && r.condition?.age !== undefined);

  // Only rules whose sole condition is age (+ an optional prefix) are legible. See above.
  const plain = deletes.filter((r) => {
    const keys = Object.keys(r.condition ?? {});
    return keys.every((k) => k === 'age' || k === 'matchesPrefix');
  });

  const covering = plain.filter((r) => coversStagingRoot(r.condition?.matchesPrefix));
  const withinLimit = covering.filter((r) => (r.condition?.age ?? Infinity) <= MAX_AGE_DAYS);

  if (withinLimit.length > 0) {
    // The tightest rule is the one that actually governs, so report that one.
    const best = withinLimit.reduce((a, b) =>
      (a.condition?.age ?? Infinity) <= (b.condition?.age ?? Infinity) ? a : b,
    );
    const ageDays = best.condition?.age ?? 0;
    const prefixes = best.condition?.matchesPrefix ?? [];
    return {
      ok: true,
      rule: { ageDays, prefixes },
      ...(ageDays > PREFERRED_AGE_DAYS
        ? {
            warning:
              `gs://${bucket} deletes staged audio after ${ageDays} days. That is within the ` +
              `${MAX_AGE_DAYS}-day limit, but a failed run's audio sits in Google Cloud Storage ` +
              `for ${ageDays} days before anything removes it. One day is enough for staging.`,
          }
        : {}),
    };
  }

  // A covering delete exists but is too slow: say so precisely rather than "missing".
  if (covering.length > 0) {
    const ageDays = Math.min(...covering.map((r) => r.condition?.age ?? Infinity));
    return {
      ok: false,
      reason: 'too-long',
      message:
        `Staging refused: gs://${bucket} deletes objects under ${STAGING_ROOT} after ` +
        `${ageDays} days, and the limit is ${MAX_AGE_DAYS}.\n\n` +
        `A rule that long is a retention policy, not a cleanup rule; a failed run's raw ` +
        `audio would sit in Google Cloud Storage for ${ageDays} days. Tighten it:\n\n` +
        indent(fixCommand(bucket)) +
        `\n\nThen re-run. Or drop --mode batch: chunked sync stages nothing.`,
      command: fixCommand(bucket),
      lifecycleJson: FIX_LIFECYCLE_JSON,
    };
  }

  const near =
    deletes.length > plain.length
      ? `\n(gs://${bucket} has a Delete rule with conditions beyond age and matchesPrefix. ` +
        `Those narrow when the delete fires, so they cannot guarantee a staged object is ` +
        `removed. Add one plain age rule alongside it.)\n`
      : '';

  return {
    ok: false,
    reason: 'missing',
    message:
      `Staging refused: gs://${bucket} has no lifecycle rule covering ${STAGING_ROOT}.\n` +
      near +
      `\nWithout one, a failed run leaves the newsroom's raw audio in Google Cloud Storage\n` +
      `indefinitely. Fix it once:\n\n` +
      indent(fixCommand(bucket)) +
      `\n\nThen re-run. Or drop --mode batch and long files are chunked instead — spike S3\n` +
      `measured chunked sync 3.6-7x faster, at 5.3x the cost.`,
    command: fixCommand(bucket),
    lifecycleJson: FIX_LIFECYCLE_JSON,
  };
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
