import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StagingRefusedError } from '../../errors.js';
import { BucketNotFound } from '../gcs.js';
import { FakeStagingStore } from '../memory.js';
import type { RawLifecycle } from '../lifecycle.js';
import type { BucketInfo } from '../types.js';
import {
  ensureStageable,
  validateStagingBucket,
  type CheckId,
  type CheckResult,
} from '../validate.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;

interface RawBucketFixture {
  name: string;
  location: string;
  locationType: BucketInfo['locationType'];
  storageClass: string;
}

/** A fake configured from the recorded metadata of one of the bucket fixtures. */
function fakeFrom(bucketFixture: string, lifecycleFixture = 'lifecycle-age1-noprefix') {
  const b = load<RawBucketFixture>(bucketFixture);
  return new FakeStagingStore({
    bucket: b.name,
    location: b.location,
    locationType: b.locationType,
    storageClass: b.storageClass,
    lifecycle: load<RawLifecycle | null>(lifecycleFixture),
    serviceAccountEmail: 'app@proj.iam.gserviceaccount.com',
  });
}

const detail = (checks: readonly CheckResult[], id: CheckId) => checks.find((c) => c.id === id)!;

describe('validateStagingBucket', () => {
  it('passes every check against the real bucket, upper-cased location and all', () => {
    // The recorded metadata says ASIA-SOUTHEAST1. If the case fold ever regresses, this is
    // the test that fails rather than a two-hour job at upload time.
    return validateStagingBucket(fakeFrom('bucket-regional-match'), 'asia-southeast1').then(
      (report) => {
        expect(report.ok).toBe(true);
        expect(report.missing).toBe(false);
        expect(report.checks.every((c) => c.ok)).toBe(true);
      },
    );
  });

  it('folds case on the recognizer region too', async () => {
    const report = await validateStagingBucket(fakeFrom('bucket-regional-match'), 'ASIA-SOUTHEAST1');
    expect(detail(report.checks, 'region').ok).toBe(true);
  });

  it('names BOTH regions on a mismatch', async () => {
    // "Region mismatch" on its own sends people to change the wrong one of the two.
    const report = await validateStagingBucket(fakeFrom('bucket-regional-mismatch'), 'asia-southeast1');
    const region = detail(report.checks, 'region');
    expect(region.ok).toBe(false);
    expect(region.message).toContain('europe-west4');
    expect(region.message).toContain('asia-southeast1');
    // A wrong region needs a different bucket, not a different permission.
    expect(report.fixable).toBe(false);
  });

  it('refuses a multi-region bucket and points at the escape hatch', async () => {
    const report = await validateStagingBucket(fakeFrom('bucket-multi-region'), 'asia-southeast1');
    const check = detail(report.checks, 'location-type');
    expect(check.ok).toBe(false);
    expect(check.message).toContain('google_gcs_staging_allow_multiregion');
  });

  it('refuses a dual-region bucket for the same reason', async () => {
    const report = await validateStagingBucket(fakeFrom('bucket-dual-region'), 'asia-southeast1');
    expect(detail(report.checks, 'location-type').ok).toBe(false);
  });

  it('lets a multi-region bucket through when the escape hatch is set', async () => {
    const report = await validateStagingBucket(fakeFrom('bucket-multi-region'), 'asia-southeast1', {
      allowMultiRegion: true,
    });
    expect(detail(report.checks, 'location-type').ok).toBe(true);
  });

  it('runs every remaining check after a metadata 403 instead of stopping', async () => {
    // The measured objectAdmin case. Reporting only the first failure turns one round of
    // configuration into four.
    const staging = fakeFrom('bucket-regional-match');
    const denied = new FakeStagingStore({
      bucket: staging.bucket,
      metadataPermitted: false,
      serviceAccountEmail: 'app@proj.iam.gserviceaccount.com',
    });
    const report = await validateStagingBucket(denied, 'asia-southeast1');

    expect(report.ok).toBe(false);
    expect(report.missing).toBe(false);
    expect(detail(report.checks, 'metadata').ok).toBe(false);
    // The probe is independent of metadata and must still have been attempted — it is the
    // check that actually passes for a correctly granted objectAdmin.
    expect(detail(report.checks, 'write-probe').ok).toBe(true);
    expect(report.checks).toHaveLength(5);
    // Granting the read role may reveal a perfectly good bucket, so this stays fixable.
    expect(report.fixable).toBe(true);
  });

  it('recommends legacyBucketReader on a 403, and never storage.admin', async () => {
    const denied = new FakeStagingStore({ metadataPermitted: false });
    const report = await validateStagingBucket(denied, 'asia-southeast1');
    const message = detail(report.checks, 'metadata').message ?? '';
    expect(message).toContain('roles/storage.legacyBucketReader');
    expect(message).not.toContain('roles/storage.admin');
    expect(message).toContain('roles/storage.objectAdmin does not include');
  });

  it('reports a missing bucket as missing, with no IAM advice at all', async () => {
    /**
     * The defect this test exists for, found by running `settings set … --check` against a
     * made-up bucket name rather than by reading the code. Every metadata failure was being
     * answered with "grant roles/storage.legacyBucketReader", so a **typo** sent the
     * operator to edit an IAM policy that was never the problem — the same class of mistake
     * as the old app's region hint, reintroduced somewhere new.
     */
    const missing = new (class extends FakeStagingStore {
      override async info(): Promise<BucketInfo> {
        throw new BucketNotFound(this.bucket);
      }
      override async assertLifecycle(): ReturnType<FakeStagingStore['assertLifecycle']> {
        throw new BucketNotFound(this.bucket);
      }
    })({ bucket: 'typoed-bucket' });

    const report = await validateStagingBucket(missing, 'asia-southeast1');
    expect(report.missing).toBe(true);
    expect(report.ok).toBe(false);
    // Not fixable by any grant: it is a name to correct.
    expect(report.fixable).toBe(false);

    const message = detail(report.checks, 'metadata').message ?? '';
    expect(message).toContain('There is no bucket named');
    expect(message).not.toContain('legacyBucketReader');
    // And the write probe is skipped rather than producing a second 404 that says nothing.
    expect(detail(report.checks, 'write-probe').detail).toBe('skipped');
  });

  it('reports a missing lifecycle rule without failing the region checks', async () => {
    const report = await validateStagingBucket(
      fakeFrom('bucket-regional-match', 'lifecycle-none'),
      'asia-southeast1',
    );
    expect(report.ok).toBe(false);
    expect(detail(report.checks, 'region').ok).toBe(true);
    expect(detail(report.checks, 'lifecycle').ok).toBe(false);
    expect(detail(report.checks, 'lifecycle').message).toContain('gsutil lifecycle set');
  });
});

describe('ensureStageable', () => {
  it('lets a correctly configured bucket through', async () => {
    await expect(
      ensureStageable(fakeFrom('bucket-regional-match'), 'asia-southeast1'),
    ).resolves.toBeUndefined();
  });

  it('refuses before any upload when the lifecycle rule is missing', async () => {
    // The ordering that matters: this is the first network call `runBatch` makes, ahead of
    // the probe, the normalize and a 20+ MB upload.
    await expect(
      ensureStageable(fakeFrom('bucket-regional-match', 'lifecycle-none'), 'asia-southeast1'),
    ).rejects.toBeInstanceOf(StagingRefusedError);
  });

  it('refuses on a region mismatch', async () => {
    await expect(
      ensureStageable(fakeFrom('bucket-regional-mismatch'), 'asia-southeast1'),
    ).rejects.toThrow(/europe-west4.*asia-southeast1/s);
  });

  it('refuses a multi-region bucket unless overridden', async () => {
    await expect(
      ensureStageable(fakeFrom('bucket-multi-region'), 'asia-southeast1'),
    ).rejects.toBeInstanceOf(StagingRefusedError);
    await expect(
      ensureStageable(fakeFrom('bucket-multi-region'), 'us', { allowMultiRegion: true }),
    ).resolves.toBeUndefined();
  });
});
