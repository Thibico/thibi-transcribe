import { boolean, customType, pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Instance configuration.
 *
 * The encrypted columns exist from migration 0000 even though Phase 1 writes only
 * plaintext, so Phase 10's AES-256-GCM secrets are a code change rather than a migration
 * against a table a newsroom already depends on.
 *
 * Threat model, stated where it is implemented: encrypting these protects you if a
 * database backup leaks — the realistic failure, since `pg_dump` output ends up in
 * Dropbox. It does not protect you from someone with root on the host.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),

  /** Plaintext value. NULL when `is_secret`. */
  value: jsonb('value').$type<unknown>(),

  /** Phase 10. AAD-bound to the key name so a row cannot be moved to exfiltrate it. */
  secretCt: bytea('secret_ct'),
  nonce: bytea('nonce'),
  tag: bytea('tag'),
  isSecret: boolean('is_secret').notNull().default(false),

  /** A maskable display form, e.g. `sk-ant-…4f2a`, so the UI can show what is set. */
  hint: text('hint'),

  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
