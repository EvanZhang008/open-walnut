import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { log } from '../logging/index.js';
import { withFileLock } from './file-lock.js';

/**
 * Atomically write JSON to a file (write to tmp, then rename).
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // tmp file must live in the SAME directory as the target: rename() across
  // filesystems fails with EXDEV (e.g. tmpfs /tmp → EBS data dir on Linux).
  const tmpFile = path.join(
    dir,
    `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read and parse a JSON file. Returns fallback if file doesn't exist.
 * Throws on parse errors (corrupt/truncated files) to avoid silently
 * losing data — callers should handle this rather than accepting empty data.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    // File doesn't exist → use fallback (normal first-run case)
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return fallback;
    }
    // Permission error, etc. → log and use fallback (matches previous behavior)
    log.web.warn('non-ENOENT error reading JSON file', { filePath, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }

  // File exists and was read — parse it. If it's corrupt, throw rather than
  // silently returning the fallback (which could cause data loss on re-persist).
  try {
    return JSON.parse(content) as T;
  } catch (parseErr) {
    // Empty file is treated the same as missing (can happen after truncated write)
    if (content.trim().length === 0) {
      return fallback;
    }
    throw new Error(
      `Failed to parse ${filePath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}

/**
 * Locked read-modify-write for a shared JSON file.
 *
 * RULE: any JSON file that can have MORE THAN ONE writer (a second server
 * process, a hook child process, a worker, or several modules) must do its
 * read→mutate→write cycle through this primitive — never a bare
 * `readJsonFile` + `writeJsonFile` pair. The unlocked pair re-persists a
 * stale in-memory snapshot and silently reverts the other writer's changes
 * (the tasks.sqlite double-writer and the 2026-08-04 cron re-fire were both
 * this exact incident class).
 *
 * Semantics: acquire the cross-process lock (`withFileLock`, mkdir-based) →
 * read a FRESH copy (fallback when missing) → `mutate(current)`. A returned
 * value is persisted; returning `undefined` means "mutated in place", so
 * `current` itself is persisted. The write goes through the atomic
 * `writeJsonFile`. Returns the persisted value.
 */
export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T> | undefined | Promise<undefined>,
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readJsonFile<T>(filePath, fallback);
    const result = await mutate(current);
    const next = result === undefined ? current : result;
    await writeJsonFile(filePath, next);
    return next;
  });
}

/**
 * Ensure a directory exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
