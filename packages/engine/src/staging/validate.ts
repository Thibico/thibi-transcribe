import { StagingRefusedError } from '../errors.js';
import { BucketNotFound } from './gcs.js';
import { iamFixCommand } from './lifecycle.js';
import { STAGING_ROOT, type LifecycleCheck, type StagingStore } from './types.js';

/**
 * Bucket validation, at settings-save time.
 *
 * Not at run time. "Your bucket is in the wrong region" must surface when the admin pastes
 * the bucket name, not ninety minutes into a two-hour job — by which point the audio is
 * already uploaded and the money is already spent.
 *
 * **Every check runs.** Reporting only the first failure turns one round of configuration
 * into four: fix the IAM, discover the region is wrong, fix the region, discover the
 * lifecycle rule is missing. An admin should see the whole list once.
 */

export type CheckId = 'metadata' | 'location-type' | 'region' | 'write-probe' | 'lifecycle';

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** One line for the report table, e.g. `asia-southeast1 (region)`. */
  detail: string;
  /** Present when `ok` is false, or when it passed with a caveat. */
  message?: string;
}

export interface ValidationReport {
  bucket: string;
  recognizerRegion: string;
  checks: CheckResult[];
  /** False when any check failed. Advisory: the CLI still saves. See below. */
  ok: boolean;
  /** True when the failures are all things a re-run could fix without changing the bucket. */
  fixable: boolean;
  /**
   * The bucket is not there at all — almost always a typo.
   *
   * Separate from `ok` because it is the one outcome where saving the value is wrong: every
   * other failure is a grant or a rule the admin can go and fix against a bucket that exists,
   * and this one is a name to correct.
   */
  missing: boolean;
}

export interface ValidateOptions {
  /** `true` lets a multi-region bucket through. `google_gcs_staging_allow_multiregion`. */
  allowMultiRegion?: boolean;
  serviceAccountEmail?: string;
  /** Injectable so the write-probe key is deterministic in tests. */
  now?: () => number;
}

/**
 * Validate a staging bucket against a recognizer region.
 *
 * Saving is **not** blocked by a failure here, and staging **is**. The asymmetry is
 * deliberate: recording a bucket name costs nothing and an admin fixing IAM and lifecycle in
 * either order should not be locked out of the first step, whereas uploading a newsroom's
 * raw audio into a bucket with no proven retention rule is the exact thing §6 exists to
 * prevent. The CLI prints this report and saves; `ensureStageable` below is what refuses.
 */
export async function validateStagingBucket(
  staging: StagingStore,
  recognizerRegion: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const checks: CheckResult[] = [];
  const region = recognizerRegion.toLowerCase();
  const sa = options.serviceAccountEmail;

  // ---- metadata, and the two checks that depend on it --------------------------------
  let metadataOk = false;
  let missing = false;
  try {
    const info = await staging.info();
    metadataOk = true;
    checks.push({
      id: 'metadata',
      ok: true,
      detail: `${info.location} (${info.locationType}), ${info.storageClass}`,
    });

    const isSingleRegion = info.locationType === 'region';
    checks.push({
      id: 'location-type',
      ok: isSingleRegion || options.allowMultiRegion === true,
      detail: info.locationType,
      ...(isSingleRegion
        ? {}
        : {
            message:
              `Bucket '${staging.bucket}' is ${info.locationType} (${info.location.toUpperCase()}). ` +
              `batchRecognize requires the bucket and the recognizer to be co-located, and a ` +
              `${info.locationType} bucket cannot prove that. Create a regional bucket in ` +
              `${region}` +
              (options.allowMultiRegion === true
                ? ` — permitted here only because google_gcs_staging_allow_multiregion is set.`
                : `, or set google_gcs_staging_allow_multiregion=true to accept the risk.`),
          }),
    });

    // Case-folded on both sides. GCS returns ASIA-SOUTHEAST1; measured 2026-08-10. The port
    // already lower-cases `location`, and this second fold is the belt to that braces —
    // a future adapter that forgets must not silently mismatch every bucket.
    const matches = info.location.toLowerCase() === region;
    checks.push({
      id: 'region',
      ok: matches,
      detail: matches ? `${info.location} matches the recognizer region` : info.location,
      ...(matches
        ? {}
        : {
            // Both regions, always. "Region mismatch" alone sends people to the wrong setting.
            message:
              `Bucket '${staging.bucket}' is in ${info.location} but the recognizer region is ` +
              `${region}. batchRecognize requires them to match. Create a bucket in ${region}, ` +
              `or change the region in Settings → Providers.`,
          }),
    });
  } catch (err) {
    missing = err instanceof BucketNotFound;
    checks.push({
      id: 'metadata',
      ok: false,
      detail: missing ? 'does not exist' : 'denied',
      message: missing
        ? // No IAM advice here, deliberately. Answering a typo with "grant a role" is the
          // same class of mistake as the old app's region hint, and it was in this function
          // until running it against a made-up name showed the output.
          `There is no bucket named '${staging.bucket}' that this service account can see. ` +
          `Check the spelling. If it exists in another Google Cloud project, the service ` +
          `account needs access to it there — and note that a cross-project staging bucket ` +
          `also needs a grant for the Speech service agent, which a same-project bucket does ` +
          `not.`
        : // The measured first-run case: objectAdmin without legacyBucketReader.
          `Cannot read bucket '${staging.bucket}'. The service account needs ` +
          `storage.buckets.get, which roles/storage.objectAdmin does not include:\n\n` +
          iamFixCommand(staging.bucket, sa) +
          `\n\n(${err instanceof Error ? err.message : String(err)})`,
    });
    const notChecked = missing
      ? 'Not checked: the bucket does not exist.'
      : 'Not checked: the bucket metadata could not be read.';
    checks.push({ id: 'location-type', ok: false, detail: 'unknown', message: notChecked });
    checks.push({ id: 'region', ok: false, detail: 'unknown', message: notChecked });
  }

  // ---- write probe: independent of metadata, and it is the one that usually passes -----
  // Skipped when the bucket does not exist: a 404 on a write tells the operator nothing the
  // first check did not already say, and printing it twice makes the real message harder to
  // find.
  const probeKey = `${STAGING_ROOT}.probe-${options.now?.() ?? Date.now()}`;
  if (missing) {
    checks.push({
      id: 'write-probe',
      ok: false,
      detail: 'skipped',
      message: 'Not checked: the bucket does not exist.',
    });
  } else {
  try {
    await staging.put(probeKey, new Uint8Array(Buffer.from('thibi staging probe')), {
      contentType: 'text/plain',
    });
    const { deleted } = await staging.deletePrefix(probeKey);
    checks.push({
      id: 'write-probe',
      ok: true,
      detail: deleted > 0 ? 'write and delete ok' : 'write ok, delete returned nothing',
    });
  } catch (err) {
    checks.push({
      id: 'write-probe',
      ok: false,
      detail: 'failed',
      message:
        `Cannot write to gs://${staging.bucket}/${STAGING_ROOT}. The service account needs ` +
        `storage.objects.create and storage.objects.delete — roles/storage.objectAdmin ` +
        `grants both.\n\n(${err instanceof Error ? err.message : String(err)})`,
    });
  }
  }

  // ---- lifecycle: reported here, enforced at stage time --------------------------------
  let lifecycle: LifecycleCheck;
  try {
    lifecycle = await staging.assertLifecycle(STAGING_ROOT);
  } catch (err) {
    lifecycle = {
      ok: false,
      reason: missing ? 'missing' : 'no-permission',
      message: missing
        ? 'Not checked: the bucket does not exist.'
        : err instanceof Error
          ? err.message
          : String(err),
      command: '',
      lifecycleJson: '',
    };
  }
  checks.push({
    id: 'lifecycle',
    ok: lifecycle.ok,
    detail: lifecycle.ok
      ? `Delete age=${lifecycle.rule.ageDays}` +
        (lifecycle.rule.prefixes.length > 0
          ? ` matchesPrefix=[${lifecycle.rule.prefixes.join(', ')}]`
          : ' (whole bucket)')
      : lifecycle.reason,
    ...(lifecycle.ok
      ? lifecycle.warning !== undefined
        ? { message: lifecycle.warning }
        : {}
      : { message: lifecycle.message }),
  });

  const failed = checks.filter((c) => !c.ok);
  return {
    bucket: staging.bucket,
    recognizerRegion: region,
    checks,
    ok: failed.length === 0,
    // A wrong region means a different bucket; everything else is a grant or a rule away.
    // When metadata was merely unreadable the region is unknown rather than wrong, so it
    // stays fixable: granting legacyBucketReader may reveal a perfectly good bucket. A
    // bucket that does not exist is not fixable by any grant.
    fixable:
      !missing && (!metadataOk || !failed.some((c) => c.id === 'region' || c.id === 'location-type')),
    missing,
  };
}

/**
 * The gate the engine calls before uploading a single byte.
 *
 * Distinct from `validateStagingBucket` on purpose: that one reports, this one refuses, and
 * it checks only what must be true for the upload to be safe and usable. Throwing here costs
 * nothing; discovering it after a 60 MB upload costs an operation we then have to cancel.
 */
export async function ensureStageable(
  staging: StagingStore,
  recognizerRegion: string,
  options: ValidateOptions = {},
): Promise<void> {
  const lifecycle = await staging.assertLifecycle(STAGING_ROOT);
  if (!lifecycle.ok) throw new StagingRefusedError(lifecycle.message);

  // The region check is skipped when metadata is unreadable, because the lifecycle check
  // above would already have refused for the same reason. Reaching here means we can read.
  const info = await staging.info();
  if (info.locationType !== 'region' && options.allowMultiRegion !== true) {
    throw new StagingRefusedError(
      `Staging refused: gs://${staging.bucket} is ${info.locationType}, and batchRecognize ` +
        `requires a single-region bucket co-located with the recognizer (${recognizerRegion}). ` +
        `Set google_gcs_staging_allow_multiregion=true to override.`,
    );
  }
  if (info.location.toLowerCase() !== recognizerRegion.toLowerCase()) {
    throw new StagingRefusedError(
      `Staging refused: gs://${staging.bucket} is in ${info.location} but the recognizer ` +
        `region is ${recognizerRegion.toLowerCase()}. batchRecognize requires them to match.`,
    );
  }
}

export { StagingRefusedError };
