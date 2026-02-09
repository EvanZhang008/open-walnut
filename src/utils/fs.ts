import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Atomically write JSON to a file (write to tmp, then rename).
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpFile = path.join(
    os.tmpdir(),
    `walnut-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpFile, filePath);
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
    console.warn(`[readJsonFile] non-ENOENT error reading ${filePath}: ${err instanceof Error ? (err as Error).message : String(err)}`);
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
 * Ensure a directory exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
