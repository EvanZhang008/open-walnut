/**
 * A backup destination, as the encrypted repository sees it: a flat place to
 * put, get, list and delete whole objects by key. Keys are relative to the
 * repository's root (the store adds its bucket prefix or Drive folder).
 *
 * Every byte handed to put() is already encrypted (repo/crypto.ts); a store
 * never sees plaintext and never needs to know what an object is.
 */

export type StoreKind = 's3' | 'r2' | 'gdrive' | 'local';

export interface StoredObject {
  key: string;
  size: number;
  /** Last write, ms since the epoch, when the store reports one. */
  modifiedAt?: number;
}

export interface BackupStore {
  readonly kind: StoreKind;
  /** Where it writes, for messages and logs: `r2://bucket/prefix`, `Google Drive: Walnut Backup`. */
  describe(): string;
  put(key: string, body: Buffer): Promise<void>;
  /** Throws StoreNotFoundError when the key is not there. */
  get(key: string): Promise<Buffer>;
  /** Every object whose key starts with `prefix` (all pages). */
  list(prefix: string): Promise<StoredObject[]>;
  /** A key that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

export class StoreNotFoundError extends Error {
  constructor(key: string) {
    super(`not found: ${key}`);
    this.name = 'StoreNotFoundError';
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof StoreNotFoundError || (err instanceof Error && err.name === 'StoreNotFoundError');
}
