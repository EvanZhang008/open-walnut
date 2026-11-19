/**
 * Encrypted or not: the one switch of a backup (Settings, Backup, "Encrypt backups").
 *
 * 2026-11-19, the user: "We know, encryption. It is optional. We default, just don't
 * add encryption." Off is the default: no recovery key to keep, backups start as soon
 * as the service is connected. On: the recovery key flow (recovery-key.ts).
 *
 * Both kinds live side by side at one destination and never touch each other:
 *   <root>/walnut-backup.json, packs/, ...         encrypted (every repository before 2026-11-19)
 *   <root>/plain/walnut-backup.json, plain/packs/  unencrypted (crypto.ts PLAIN_KEYS)
 * so turning the switch either way starts (or goes back to) the other repository, and
 * the backups already made stay where they are, restorable.
 */
import type { BackupStore, StoredObject } from './stores/types.js';
import type { BackupConfig } from './types.js';

/** Where unencrypted backups sit inside the destination. */
export const PLAIN_ROOT = 'plain/';

/**
 * The switch as set; unset, a setup that finished the recovery key step (it said
 * "I saved it") stays encrypted, and every other one is unencrypted.
 */
export function backupEncrypted(cfg: BackupConfig | undefined): boolean {
  return cfg?.encrypt ?? Boolean(cfg?.recovery_key_saved_at);
}

/**
 * The kind backups are made in at `base` (the destination's root store). Unset with the
 * key step never finished, encrypted backups already there keep it encrypted: a setup
 * that backed up from a terminal (`open-walnut backup run` never asked for the key step)
 * or another computer's backups are never joined by readable ones unasked.
 */
export async function resolveEncrypted(cfg: BackupConfig | undefined, base: BackupStore): Promise<boolean> {
  if (typeof cfg?.encrypt === 'boolean') return cfg.encrypt;
  if (cfg?.recovery_key_saved_at) return true;
  return (await base.list('snapshots/')).length > 0;
}

/** `store` seen from inside one folder of it. */
export function subStore(store: BackupStore, root: string): BackupStore {
  return {
    kind: store.kind,
    describe: () => store.describe(),
    put: (key, body) => store.put(root + key, body),
    get: (key) => store.get(root + key),
    delete: (key) => store.delete(root + key),
    list: async (prefix): Promise<StoredObject[]> =>
      (await store.list(root + prefix)).map((o) => ({ ...o, key: o.key.slice(root.length) })),
  };
}

/** The repository of one kind at a destination. */
export function repoStore(store: BackupStore, encrypted: boolean): BackupStore {
  return encrypted ? store : subStore(store, PLAIN_ROOT);
}
