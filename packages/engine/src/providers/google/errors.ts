import {
  ChunkTooLargeError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnsupportedLanguageError,
} from '../../errors.js';

/**
 * Classify a Google STT error response.
 *
 * Ported from `lib/providers/google.ts:131-152`, keeping the principle that made it good —
 * **surface Google's own message rather than a bare status code** — and deleting the part
 * that made it harmful.
 *
 * `:139-141` appended "check the region: Chirp 2 and Burmese only overlap in
 * asia-southeast1 and europe-west4" to every INVALID_ARGUMENT mentioning a model or
 * language. That is a false statement: the 2026-07-30 probe accepted all 117 locale codes
 * in asia-southeast1, europe-west4 *and* us-central1, and spike S3 got identical correct
 * Burmese from all three on 2026-08-09. It sent operators to re-check a setting that was
 * never the problem. A test asserts no message from this module names a region.
 */

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Which permission problem is this?
 *
 * Three distinct principals can be the cause and they have three different fixes, so a
 * single "check your credentials" hint sends two out of three operators to the wrong place.
 *
 * The service-agent branch is worded for the **cross-project** case specifically. The Phase 2
 * draft called it the second-most-common first-run failure; measured 2026-08-10, that is
 * wrong for the normal setup — enabling the Speech API creates a project-level
 * `roles/speech.serviceAgent` binding that already covers every bucket in that project, which
 * is why spike S3 worked with the agent absent from the bucket's own IAM policy. A newsroom
 * only hits it with a staging bucket in a *different* project from the recognizer.
 *
 * The project number is not looked up: the app's service account gets a 403 on
 * `cloudresourcemanager.projects.get`, measured the same day, so the hint prints the command
 * that produces the number rather than making a call behind a permission we do not have.
 */
function permissionHint(detail: string): string {
  if (/gcp-sa-speech|service-\d+@/i.test(detail)) {
    return (
      'This names the Speech service agent, which is a different principal from the ' +
      'service account making the call. It needs read access to the staging bucket. For a ' +
      'bucket in the same project as the recognizer nothing is needed — the project-level ' +
      'roles/speech.serviceAgent binding covers it. For a bucket in another project:\n' +
      '  PN=$(gcloud projects describe <RECOGNIZER_PROJECT> --format="value(projectNumber)")\n' +
      '  gcloud storage buckets add-iam-policy-binding gs://<BUCKET> \\\n' +
      '    --member=serviceAccount:service-$PN@gcp-sa-speech.iam.gserviceaccount.com \\\n' +
      '    --role=roles/storage.objectViewer'
    );
  }

  if (/storage\.objects|storage\.buckets|storage\.googleapis/i.test(detail)) {
    return (
      'This is a Cloud Storage permission on the staging bucket, not a Speech one. The ' +
      'calling service account needs roles/storage.objectAdmin to stage and sweep, plus ' +
      'roles/storage.legacyBucketReader to read the bucket region and lifecycle rule — ' +
      'objectAdmin alone does not include storage.buckets.get. Run ' +
      '`thibi settings set google_gcs_staging_bucket <name> --check` to see which checks fail.'
    );
  }

  return 'Check the service account has roles/speech.client on this project.';
}

export async function toProviderError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  let detail = body.slice(0, 500);
  let status: string | undefined;

  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) {
      detail = parsed.error.message;
      status = parsed.error.status;
    }
  } catch {
    /* keep the raw body */
  }

  const message = `Google STT ${response.status}: ${detail || response.statusText}`;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (response.status === 429 || response.status === 503) {
    return new RateLimitedError(message, retryAfterMs !== undefined ? { retryAfterMs } : {});
  }
  if (response.status >= 500) {
    return new ProviderUnavailableError(message);
  }
  if (response.status === 401 || response.status === 403) {
    return new NotConfiguredError(message, { hint: permissionHint(detail) });
  }
  if (response.status === 413 || /too large|exceeds/i.test(detail)) {
    // Not retryable as-is, but the planner re-cuts this one chunk at half length and
    // tries once more: a bitrate spike mid-file should not fail a three-hour run.
    return new ChunkTooLargeError(message);
  }
  if (response.status === 400 && status === 'INVALID_ARGUMENT' && /language|model/i.test(detail)) {
    return new UnsupportedLanguageError(message, {
      hint:
        'The provider matrix may be stale — re-run `thibi probe languages --provider google` ' +
        'and check the language is still accepted.',
    });
  }
  return new ProviderError(message, response.status);
}
