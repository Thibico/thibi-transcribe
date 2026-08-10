/**
 * Every Google STT v2 URL, derived rather than concatenated at the call site.
 *
 * Speech-to-Text v2 is regional and an operation name is already a fully-qualified resource
 * path (`projects/P/locations/R/operations/OPID`). Two consequences that this file exists to
 * make unavoidable:
 *
 *  - The host depends on the region, so a poll issued from a worker that never saw the
 *    submit needs the region carried alongside the operation name. That is why `BatchOp`
 *    has a `region` field (see `batch.ts` §10).
 *  - The operation name must be appended to the host **as-is**. Rebuilding it from parts
 *    would silently produce a valid-looking URL for a different operation.
 *
 * `speechEndpoint()` in `index.ts` — itself ported from `lib/providers/google.ts:89-94` — is
 * the ancestor of this file, kept as a re-export so Phase 1's call sites and its published
 * API do not churn.
 */

const host = (region: string): string => `https://${region}-speech.googleapis.com/v2`;

/** The recognizer path shared by the two synchronous-style verbs. */
const recognizer = (region: string, project: string): string =>
  `projects/${project}/locations/${region}/recognizers/_`;

export function recognizeUrl(region: string, project: string): string {
  return `${host(region)}/${recognizer(region, project)}:recognize`;
}

export function batchRecognizeUrl(region: string, project: string): string {
  return `${host(region)}/${recognizer(region, project)}:batchRecognize`;
}

/** `name` is already `projects/P/locations/R/operations/OPID`. Do not rebuild it. */
export function operationUrl(region: string, name: string): string {
  return `${host(region)}/${name}`;
}

export function cancelOperationUrl(region: string, name: string): string {
  return `${host(region)}/${name}:cancel`;
}

export function listOperationsUrl(region: string, project: string): string {
  return `${host(region)}/projects/${project}/locations/${region}/operations`;
}

/**
 * The region an operation name says it belongs to.
 *
 * A cross-check, not a lookup: `runs.pipeline.batch.region` is what a resume polls with, and
 * if the two ever disagree the stored one is wrong and the poll would 404 against a host in
 * the wrong region — a confusing way to learn about a corrupt row.
 */
export function regionOfOperation(name: string): string | null {
  return /^projects\/[^/]+\/locations\/([^/]+)\/operations\/[^/]+$/.exec(name)?.[1] ?? null;
}
