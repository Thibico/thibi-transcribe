/**
 * The defaults the composition root falls back to, and the one file in source permitted to
 * name a Google region.
 *
 * It was `apps/cli/src/config.ts` until the worker also had to build a context. Copying the
 * two constants would have been three lines, and it took CI four minutes to explain why that
 * was wrong: `apps/worker/src/main.ts` passed `region: 'asia-southeast1'` inline and the *No
 * region doctrine* grep — which allows exactly one file to name a region — failed the build on
 * `main`. The grep was right and the second copy was the defect, so the constants moved to
 * where a third app cannot invent its own, and `buildContext` now defaults `googleDefaults`
 * rather than demanding it.
 */

/**
 * The default Google region.
 *
 * The old app carried a doctrine that Chirp 2 plus my-MM worked only in a narrow overlap of
 * regions and that us-central1 failed outright — repeated in four places, including an
 * error-message hint. It is measured false twice: the 2026-07-30 provider probe accepted all
 * 117 locale codes in asia-southeast1, europe-west4 and us-central1, and spike S3 on
 * 2026-08-09 got a 200 with identical correct Burmese from all three.
 *
 * Region is a latency and data-residency choice. This value is simply the one nearest the
 * primary user. Do not restore the justification.
 */
export const DEFAULT_GOOGLE_REGION = 'asia-southeast1';

export const DEFAULT_GOOGLE_MODEL = 'chirp_2';
