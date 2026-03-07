/**
 * Shared file operations for memory tools and file tools.
 *
 * Provides content hashing (SHA256), line-numbered reading with offset/limit,
 * exact-match editing with stale-hash rejection, and checked writes.
 *
 * Memory tools pass `expectedHash` for safety; file tools pass `undefined` to skip the check.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './file-lock.js';

// ── Types ──

export interface ReadFileMeta {
  /** Line-numbered content (6-char right-aligned + tab). */
  content: string;
  /** SHA256 hash of the full raw content (first 12 hex chars). */
  contentHash: string;
  /** Total number of lines in the file. */
  totalLines: number;
  /** Human-readable range, e.g. "1-87 of 87". */
  showing: string;
}

export interface EditFileResult {
  /** Number of replacements made. */
  replacements: number;
  /** New content hash after the edit. */
  contentHash: string;
}

export interface WriteFileResult {
  /** New content hash after the write. */
  contentHash: string;
}

// ── Hash ──

/**
 * Compute a content hash: SHA256 → first 12 hex characters.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// ── Read ──

/**
 * Read a file with line numbers, optional offset/limit, and full-content hash.
 *
 * Line numbers use the same format as the `read_file` tool:
 * 6-char right-aligned number + tab + line content.
 *
 * The `contentHash` is always computed on the full file content,
 * not just the slice shown — so it can be passed to edit/write for stale checks.
 */
export async function readFileWithMeta(
  filePath: string,
  opts?: { offset?: number; limit?: number },
): Promise<ReadFileMeta> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const contentHash = computeContentHash(raw);
  const allLines = raw.split('\n');
  const totalLines = allLines.length;

  const offset = Math.max(1, opts?.offset ?? 1);
  const limit = opts?.limit;

  const start = offset - 1; // 0-based
  const sliced = limit != null ? allLines.slice(start, start + limit) : allLines.slice(start);

  const numbered = sliced.map(
    (line, i) => `${String(start + i + 1).padStart(6)}\t${line}`,
  );

  const content = numbered.join('\n');
  const endLine = start + sliced.length;
  const showing = `${start + 1}-${endLine} of ${totalLines}`;

  return { content, contentHash, totalLines, showing };
}

// ── Edit ──

export class StaleHashError extends Error {
  constructor(public currentHash: string) {
    super(
      `Stale content_hash. File was modified since last read. Current hash: ${currentHash}. Read again before editing.`,
    );
    this.name = 'StaleHashError';
  }
}

export class ContentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentNotFoundError';
  }
}

export class AmbiguousMatchError extends Error {
  constructor(public matchCount: number) {
    super(
      `old_content matches ${matchCount} locations. Provide more surrounding context to make it unique, or set replace_all to true.`,
    );
    this.name = 'AmbiguousMatchError';
  }
}

/**
 * Edit a file by exact string replacement, with optional hash-based stale check.
 *
 * Runs inside `withFileLock` to prevent concurrent modifications.
 *
 * @param expectedHash — if provided, the file's current hash must match. Pass `undefined` to skip (for file tools).
 * @param replaceAll — if true, replace all occurrences; otherwise require exactly one match.
 */
export async function editFileContent(
  filePath: string,
  oldContent: string,
  newContent: string,
  opts?: { expectedHash?: string; replaceAll?: boolean },
): Promise<EditFileResult> {
  return withFileLock(filePath, async () => {
    const raw = await fsp.readFile(filePath, 'utf-8');

    // Hash check (only if expectedHash provided)
    if (opts?.expectedHash != null) {
      const currentHash = computeContentHash(raw);
      if (currentHash !== opts.expectedHash) {
        throw new StaleHashError(currentHash);
      }
    }

    // Count occurrences
    let count = 0;
    let searchPos = 0;
    while (true) {
      const idx = raw.indexOf(oldContent, searchPos);
      if (idx === -1) break;
      count++;
      searchPos = idx + oldContent.length;
    }

    if (count === 0) {
      throw new ContentNotFoundError(
        'old_content not found in file. Make sure the string matches exactly (including whitespace and indentation).',
      );
    }

    if (count > 1 && !opts?.replaceAll) {
      throw new AmbiguousMatchError(count);
    }

    // Perform replacement
    let updated: string;
    if (opts?.replaceAll) {
      updated = raw.split(oldContent).join(newContent);
    } else {
      const idx = raw.indexOf(oldContent);
      updated = raw.slice(0, idx) + newContent + raw.slice(idx + oldContent.length);
    }

    // Clean up triple+ blank lines left by deletions
    if (!newContent) {
      updated = updated.replace(/\n{3,}/g, '\n\n');
    }

    await fsp.writeFile(filePath, updated, 'utf-8');
    const newHash = computeContentHash(updated);
    return { replacements: opts?.replaceAll ? count : 1, contentHash: newHash };
  });
}

// ── Write ──

/**
 * Write a file with optional hash-based stale check.
 *
 * Runs inside `withFileLock` to prevent concurrent modifications.
 * If the file doesn't exist and expectedHash is provided, throws StaleHashError
 * (you can't have a valid hash for a non-existent file).
 * If the file doesn't exist and no hash is provided, creates it.
 */
export async function writeFileChecked(
  filePath: string,
  content: string,
  opts?: { expectedHash?: string },
): Promise<WriteFileResult> {
  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  return withFileLock(filePath, async () => {
    // Hash check (only if expectedHash provided)
    if (opts?.expectedHash != null) {
      let raw: string;
      try {
        raw = await fsp.readFile(filePath, 'utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new StaleHashError('(file does not exist)');
        }
        throw err;
      }
      const currentHash = computeContentHash(raw);
      if (currentHash !== opts.expectedHash) {
        throw new StaleHashError(currentHash);
      }
    }

    await fsp.writeFile(filePath, content, 'utf-8');
    return { contentHash: computeContentHash(content) };
  });
}
