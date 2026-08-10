import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLifecycle, fixCommand, iamFixCommand, type RawLifecycle } from '../lifecycle.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = (name: string): RawLifecycle | null =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as RawLifecycle | null;

const check = (name: string, permitted = true) =>
  assertLifecycle('thibi-stt-staging-asse1', load(name), { permitted });

describe('assertLifecycle', () => {
  it('accepts the real bucket rule: Delete age=1 with no prefix', () => {
    // Measured 2026-08-10 against gs://thibi-stt-staging-asse1. A bucket-wide 1-day delete
    // on a dedicated staging bucket is a *stronger* guarantee than a prefixed one.
    const result = check('lifecycle-age1-noprefix');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toEqual({ ageDays: 1, prefixes: [] });
    expect(result.warning).toBeUndefined();
  });

  it('accepts a prefix-targeted rule and reports the prefix', () => {
    const result = check('lifecycle-age1-prefix');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toEqual({ ageDays: 1, prefixes: ['thibi-staging/'] });
  });

  it('refuses when there is no rule at all, and prints a copy-pasteable fix', () => {
    const result = check('lifecycle-none');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing');
    // The literal the phase plan promises. A message that describes a fix without giving
    // the command is a message someone has to go and research.
    expect(result.message).toContain('gcloud storage buckets update');
    expect(result.command).toContain('gsutil lifecycle set');
    expect(result.command).toContain('thibi-staging/');
  });

  it('distinguishes a rule that is too slow from a rule that is absent', () => {
    // Both are refusals, but one is fixed by tightening a number and the other by
    // creating a rule, and telling an operator the wrong one wastes their afternoon.
    const result = check('lifecycle-age30');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-long');
    expect(result.message).toContain('30 days');
  });

  it('ignores SetStorageClass: ageing to Coldline still keeps the audio forever', () => {
    const result = check('lifecycle-setstorageclass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing');
  });

  it('refuses a Delete whose prefix does not cover thibi-staging/', () => {
    const result = check('lifecycle-wrong-prefix');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing');
  });

  it('refuses a version-scoped Delete, and says why it could not reason about it', () => {
    // `numNewerVersions`/`isLive` narrow *when* the delete fires. A rule that only removes
    // non-current versions guarantees nothing about the object we just uploaded, and
    // accepting it would be the quietest possible way to lose the retention promise.
    const result = check('lifecycle-versions-only');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing');
    expect(result.message).toContain('conditions beyond age and matchesPrefix');
  });

  it('treats an unreadable configuration as a refusal, not a shrug', () => {
    // The point of the rule is a retention guarantee, and one we cannot verify is not one.
    const result = check('lifecycle-age1-noprefix', false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-permission');
  });

  it('names legacyBucketReader for a permission failure, never storage.admin', () => {
    // Measured 2026-08-10: roles/storage.objectAdmin can write and delete but gets a 403 on
    // storage.buckets.get, so this is the *expected* first-run state. The phase plan's draft
    // remedied it with roles/storage.admin — full bucket administration to read one metadata
    // field, pasted once and then living in a newsroom's IAM policy forever.
    const result = check('lifecycle-none', false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('roles/storage.legacyBucketReader');
    expect(result.message).not.toContain('roles/storage.admin');
  });

  it('warns but accepts a rule between the preferred and maximum age', () => {
    const result = assertLifecycle(
      'b',
      { rule: [{ action: { type: 'Delete' }, condition: { age: 5 } }] },
      { permitted: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toContain('5 days');
  });

  it('reports the tightest covering rule when several apply', () => {
    const result = assertLifecycle(
      'b',
      {
        rule: [
          { action: { type: 'Delete' }, condition: { age: 7 } },
          { action: { type: 'Delete' }, condition: { age: 2, matchesPrefix: ['thibi-'] } },
        ],
      },
      { permitted: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The tightest rule is the one that actually governs the object's lifetime.
    expect(result.rule.ageDays).toBe(2);
  });
});

describe('the fix commands', () => {
  it('emit the bucket they were asked about', () => {
    expect(fixCommand('my-bucket')).toContain('gs://my-bucket');
    expect(iamFixCommand('my-bucket', 'sa@x.iam.gserviceaccount.com')).toContain(
      'serviceAccount:sa@x.iam.gserviceaccount.com',
    );
  });

  it('emit matchesPrefix even though a bare rule would be accepted', () => {
    // The generated command has to be safe in the *other* case — a bucket the newsroom
    // also keeps things in — so it is always prefix-scoped even though `assertLifecycle`
    // accepts a bucket-wide rule.
    expect(fixCommand('b')).toContain('"matchesPrefix":["thibi-staging/"]');
  });
});
