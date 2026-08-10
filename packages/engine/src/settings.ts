import { eq } from 'drizzle-orm';
import { settings as settingsTable, type Db } from '@thibi/db';
import type { SettingsPort } from './context.js';

/**
 * Settings over the `settings` table, with environment precedence supplied by the caller.
 *
 * Ported in spirit from `lib/settings.ts:43-82`. The valuable part is the precedence order
 * and the mask-aware write, not the code:
 *
 *   DB row → environment override → default
 *
 * The engine never reads the environment itself, so `envOverrides` arrives as a plain
 * record from `apps/cli/src/context.ts`. Encryption of secret values is Phase 10; the
 * columns already exist so that is a code change rather than a migration.
 */

export interface CreateSettingsOptions {
  db: Db;
  /** Values from the environment. Take precedence over stored rows. */
  envOverrides?: Record<string, string | undefined>;
  defaults?: Record<string, string>;
}

/**
 * The masked form a UI shows for a secret it will not re-send.
 *
 * A write of exactly this value means "the user did not touch the field" and must not
 * clobber the stored secret — the single most valuable line in the original settings
 * module, because getting it wrong silently erases an API key on every settings save.
 */
export const MASK = '••••••••';

export function isMasked(value: string): boolean {
  return value === MASK || /^•+$/.test(value);
}

export function createSettings(options: CreateSettingsOptions): SettingsPort {
  const { db } = options;
  const env = options.envOverrides ?? {};
  const defaults = options.defaults ?? {};

  return {
    async get(key: string): Promise<string | null> {
      const override = env[key];
      if (override !== undefined && override !== '') return override;

      const rows = await db
        .select({ value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, key))
        .limit(1);

      const stored = rows[0]?.value;
      if (stored !== undefined && stored !== null) {
        return typeof stored === 'string' ? stored : JSON.stringify(stored);
      }
      return defaults[key] ?? null;
    },

    async getJson<T>(key: string): Promise<T | null> {
      const raw = await this.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async set(key: string, value: string): Promise<void> {
      // An untouched masked field must never clobber a stored secret.
      if (isMasked(value)) return;
      await db
        .insert(settingsTable)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value, updatedAt: new Date() },
        });
    },
  };
}

/** A settings port backed by a plain object. Used by `--no-db` and by tests. */
export function createMemorySettings(initial: Record<string, string> = {}): SettingsPort {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async getJson<T>(key: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (isMasked(value)) return;
      store.set(key, value);
    },
  };
}

/** Setting keys this phase reads. One file knows these names; providers never do. */
export const SETTING_KEYS = {
  googleServiceAccountJson: 'google.service_account_json',
  googleProjectId: 'google.project_id',
  googleRegion: 'google.region',
  googleModel: 'google.model',
} as const;
