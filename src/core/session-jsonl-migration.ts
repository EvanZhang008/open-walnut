/**
 * JSONL migration when a session's cwd changes.
 *
 * Claude Code stores session history at `~/.claude/projects/<sanitize(cwd)>/<sid>.jsonl`
 * and `--resume` is strictly cwd-scoped. When a session renames its own cwd mid-work,
 * we must move the JSONL (and any subagent dir) from the old cwd-encoded directory to
 * the new one, or subsequent resumes lose all history.
 *
 * First-version scope:
 *  - Local host only (remote host migration requires a daemon `fs.rename` RPC — TODO)
 *  - Moves `<sid>.jsonl` and `<sid>/` subagent dir
 *  - Does NOT move sibling files (bridge-pointer.json, cast, memory) — TODO
 *  - Idempotent: missing source = no-op, existing dest = no-op
 *  - Long-path safety: skips when either cwd would trigger Bun.hash suffix (>200 chars)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalJsonlPath,
  subagentDirPath,
  isSafeForProjectEncoding,
} from './session-file-reader.js';
import { log } from '../logging/index.js';

export interface MigrateResult {
  migrated: boolean;
  reason?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function moveIfPresent(src: string, dst: string): Promise<'moved' | 'missing' | 'dest-exists'> {
  if (!(await exists(src))) return 'missing';
  if (await exists(dst)) return 'dest-exists';
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return 'moved';
}

/**
 * Migrate a session's JSONL + subagent dir from `oldCwd`-encoded directory to
 * `newCwd`-encoded directory. No-ops on missing source. Safe to call multiple times.
 *
 * This function is the reason sessions survive a cwd rename — Claude Code's
 * `--resume` is strictly cwd-scoped with no fallback search, so without this
 * move `claude --resume <sid>` after a cwd change silently loses all history.
 *
 * Returns `{migrated: true}` on success, otherwise `{migrated: false, reason}`.
 */
export async function migrateSessionJsonlForCwd(
  sessionId: string,
  oldCwd: string | undefined | null,
  newCwd: string | undefined | null,
): Promise<MigrateResult> {
  if (!sessionId) return { migrated: false, reason: 'no-session-id' };
  if (!oldCwd || !newCwd) return { migrated: false, reason: 'missing-cwd' };
  if (oldCwd === newCwd) return { migrated: false, reason: 'unchanged' };

  if (!isSafeForProjectEncoding(oldCwd) || !isSafeForProjectEncoding(newCwd)) {
    log.session.warn(
      'cwd encodes to >200 chars (Bun.hash territory), skipping JSONL migration',
      { sessionId, oldCwd, newCwd },
    );
    return { migrated: false, reason: 'cwd-too-long' };
  }

  const oldJsonl = canonicalJsonlPath(sessionId, oldCwd);
  const newJsonl = canonicalJsonlPath(sessionId, newCwd);
  const oldSubagentDir = subagentDirPath(sessionId, oldCwd);
  const newSubagentDir = subagentDirPath(sessionId, newCwd);

  try {
    // An archived session (transcript-archive.ts) comes back plain first, so it moves whole.
    const { restoreArchivedAt } = await import('../providers/transcript-archive.js');
    await restoreArchivedAt(path.dirname(oldJsonl), sessionId);
    const jsonlResult = await moveIfPresent(oldJsonl, newJsonl);
    let subagentResult: string = 'skipped';
    try {
      subagentResult = await moveIfPresent(oldSubagentDir, newSubagentDir);
    } catch (err) {
      log.session.warn('subagent dir migration failed (non-fatal)', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    log.session.info('cwd change — JSONL migration attempted', {
      sessionId,
      oldCwd,
      newCwd,
      jsonl: jsonlResult,
      subagentDir: subagentResult,
    });

    return jsonlResult === 'moved'
      ? { migrated: true }
      : { migrated: false, reason: jsonlResult };
  } catch (err) {
    log.session.warn('JSONL migration failed', {
      sessionId,
      oldCwd,
      newCwd,
      err: err instanceof Error ? err.message : String(err),
    });
    return { migrated: false, reason: 'error' };
  }
}
