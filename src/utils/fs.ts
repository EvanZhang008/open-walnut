import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { log } from '../logging/index.js';
import { withFileLock } from './file-lock.js';
import { selfHealDataDirJson } from './json-conflict-recovery.js';

/**
 * Atomically write JSON to a file (write to tmp, then rename).
 */
export async function writeJsonFile(
  filePath: string,
  data: unknown,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // tmp file must live in the SAME directory as the target: rename() across
  // filesystems fails with EXDEV (e.g. tmpfs /tmp → EBS data dir on Linux).
  const tmpFile = path.join(
    dir,
    `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf-8',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await fs.rename(tmpFile, filePath);
    if (options.mode !== undefined) await fs.chmod(filePath, options.mode);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read and parse a JSON file. Returns fallback if file doesn't exist.
 * Throws on parse errors (corrupt/truncated files) to avoid silently
 * losing data — callers should handle this rather than accepting empty data.
 *
 * One exception, added after the 2026-08-22 incident: a file inside the walnut
 * data dir whose content no longer parses is SELF-HEALED from the data repo's
 * git history before the throw (see src/utils/json-conflict-recovery.ts). Two
 * data files were committed with git conflict markers in them, and every read
 * of `config/share/ui-prefs.json` then dead-ended on `Failed to parse …` — hours
 * of 500s and six crashes of a bus subscriber, while a perfectly good version of
 * the file sat one commit back. Recovery is gated to the data dir (repo config
 * files and test fixtures must keep failing loudly) and, when it cannot find a
 * valid version, the ORIGINAL parse error is thrown unchanged.
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

    // Self-heal from git history (data dir only). Never swallows the failure:
    // if nothing recoverable exists we fall through to the original error, whose
    // exact `Failed to parse …` shape callers and tests depend on.
    const healed = await selfHealDataDirJson(filePath);
    if (healed) {
      log.web.warn('corrupt JSON self-healed from git history', {
        file: filePath,
        restoredFrom: healed.restoredFrom,
        movedTo: healed.movedTo,
        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      try {
        return JSON.parse(healed.content) as T;
      } catch { /* validated before the write — fall through to the original error */ }
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
  options: { mode?: number } = {},
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readJsonFile<T>(filePath, fallback);
    const result = await mutate(current);
    const next = result === undefined ? current : result;
    await writeJsonFile(filePath, next, options);
    return next;
  });
}

/**
 * Ensure a directory exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
