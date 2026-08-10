/**
 * Orphan atomic-write temp-file sweeper.
 *
 * writeJsonFile() (src/utils/fs.ts) writes `.open-walnut-<hex>.tmp` NEXT TO the
 * target file and then renames it — the tmp file must share the directory or the
 * rename crosses filesystems and fails with EXDEV. If the process dies between
 * the write and the rename (SIGKILL, OOM, machine starvation), the `.tmp` is
 * orphaned in a DATA directory.
 *
 * Why that matters beyond a stray file: the 30s auto-save runs `git add -A`, so
 * an orphan gets staged, and if the next tick's write deletes it mid-`add` the
 * commit dies with `fatal: unable to stat 'sync/.open-walnut-<hex>.tmp'` — which
 * wedges the whole auto-commit loop until a human intervenes (seen repeatedly on
 * 2026-08-09). One orphan was also a stale copy of sync/ms-todo-tokens.json
 * holding a plaintext MS Graph accessToken, and it got committed.
 *
 * Design constraints:
 *  - FIXED directory list, non-recursive. WALNUT_HOME contains notes/ (a whole
 *    Obsidian vault) and plugin-stores/ (git clones with node_modules), so a
 *    recursive scan on every boot would be tens of thousands of stats. The list
 *    is exactly the set of directories writeJsonFile() targets.
 *  - Age gate (1h): a `.tmp` younger than that may belong to an IN-FLIGHT write
 *    in another process (a hook child, the other server). Deleting it would make
 *    that writer's rename fail and lose the data it was persisting.
 *  - Never throws. Best-effort cleanup must not be able to break boot, so every
 *    directory and every unlink is individually guarded.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  WALNUT_HOME,
  SYNC_DIR,
  TASKS_DIR,
  MEMORY_DIR,
  DAILY_DIR,
  CONVERSATIONS_DIR,
  PROJECTION_CACHE_DIR,
  TRANSCRIPT_CACHE_DIR,
  TASK_QUEUE_DIR,
} from '../constants.js';
import { log } from '../logging/index.js';

/** Exactly the shape writeJsonFile() produces: `.open-walnut-<hex>.tmp`. */
const ORPHAN_RE = /^\.open-walnut-[0-9a-f]+\.tmp$/;

/** Younger than this may be an in-flight write by another process — leave it. */
const MIN_AGE_MS = 60 * 60 * 1000;

/**
 * The directories writeJsonFile() targets. Non-recursive, deliberately explicit:
 * adding a new JSON store means adding its directory here.
 *
 * sessions/ and sessions/transcripts/ are spelled out rather than imported
 * because SESSIONS_DIR in constants.ts points at memory/sessions (a DIFFERENT
 * directory); the session projection and its transcripts live at
 * WALNUT_HOME/sessions (see src/core/session-projection.ts).
 *
 * Computed per call, not at module load, so a test that redirects WALNUT_HOME
 * still gets swept paths under its own tmp home.
 */
function sweepDirs(): string[] {
  return [
    WALNUT_HOME,
    SYNC_DIR,
    path.join(WALNUT_HOME, 'sessions'),
    path.join(WALNUT_HOME, 'sessions', 'transcripts'),
    TASKS_DIR,
    path.join(TASKS_DIR, 'outbox'),
    CONVERSATIONS_DIR,
    MEMORY_DIR,
    DAILY_DIR,
    // Projection cache (Phase 3) — gitignored, but a crashed rename still
    // leaves an orphan the read path never cleans up.
    PROJECTION_CACHE_DIR,
    TRANSCRIPT_CACHE_DIR,
    // Offline task-op queue (Phase 4) — same story: gitignored, but a torn
    // write leaves a .tmp the flush loop skips forever.
    TASK_QUEUE_DIR,
  ];
}

/**
 * Delete orphaned atomic-write temp files older than MIN_AGE_MS.
 * Resolves with the paths removed. Never rejects.
 */
export async function sweepOrphanAtomicTmpFiles(): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = Date.now() - MIN_AGE_MS;

  for (const dir of sweepDirs()) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !ORPHAN_RE.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs > cutoff) continue; // possibly an in-flight write
          await fsp.unlink(full);
          removed.push(full);
        } catch {
          // Raced with the real writer's rename, or no permission — either way
          // the file is not ours to clean up.
        }
      }
    } catch {
      // Directory missing (fresh install) or unreadable — skip it.
    }
  }

  if (removed.length > 0) {
    log.web.info('swept orphaned atomic-write temp files', {
      count: removed.length,
      files: removed.slice(0, 10),
    });
  }
  return removed;
}
