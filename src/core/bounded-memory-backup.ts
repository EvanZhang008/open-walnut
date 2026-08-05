/**
 * Pre-write snapshots for the bounded memory stores (MEMORY.md / USER.md,
 * global and per-agent). Ported from hermes-agent's memory tool, which writes a
 * `.bak` next to a memory file before it lets a mutation land.
 *
 * WHY: these files are written AUTOMATICALLY — by the butler mid-turn and by the
 * forked background-review pass, which runs unattended. A single bad `replace`
 * or `batch` can swallow an entire section, and until now there was no rollback
 * path at all. This repo has already lost local data exactly this way once (a
 * "gitignored but still tracked" data-repo path wiped config.yaml wholesale;
 * that fix also ended in a .bak sidecar).
 *
 * ── Retention policy: 5 rolling generations, deduplicated ──
 *
 * `<file>.bak.1` is the state immediately before the newest write; `.bak.5` is
 * the oldest kept state. A single rolling .bak was considered and REJECTED:
 * background review writes with nobody watching, so two bad passes in a row
 * would overwrite the only good copy before a human ever looked. Depth 5 also
 * survives a foreground consolidate-retry burst (the store's own circuit
 * breaker allows 3 failed attempts per turn, and a model that "fixes" its
 * mistake by writing again is the common shape of this accident).
 *
 * Rotation is driven by WRITES, not by time, so the window is only as long as
 * the write rate allows — hence the dedup rule: a snapshot identical to the
 * newest one does not consume a generation. That keeps no-op writes (an
 * idempotent duplicate add still funnels through mutate() and "succeeds") from
 * evicting real history.
 *
 * Cost is negligible: the stores are hard-capped at 8,000 / 4,000 chars, so 5
 * generations is at most ~60 KB per store.
 *
 * These snapshots are machine-local recovery artifacts. They are gitignored by
 * the data-repo sync (see git-sync.ts) — syncing them would double memory write
 * churn into a repo that has starved this machine before, and the recovery is
 * always performed on the box that took the damage.
 *
 * ── Restore ──
 *
 * Deliberately NOT automated. The files are small, human-readable markdown, and
 * an automatic restore is itself a destructive write — picking the wrong
 * generation would undo good entries. `listMemoryBackups()` makes the snapshots
 * discoverable (for a triage tool or the Memory UI); putting content back is a
 * human copy, or a `file_read` + `memory_manage` round-trip the butler can do
 * when asked.
 *
 * The `.bak.<n>` suffix order matters and is not cosmetic: the snapshots must
 * NOT end in `.md`, or every markdown walker over the memory tree (the search
 * index collections, memory-index's `*.md` walk, the daily-log listing) would
 * pick them up and the butler would start reading its own history back as if it
 * were live memory.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging/index.js';

/** How many previous states to keep per store. See the retention note above. */
export const MEMORY_BACKUP_GENERATIONS = 5;

/**
 * Write `content` to `filePath` via a temp file + rename.
 *
 * The temp file is created in the SAME DIRECTORY as the target, deliberately: a
 * rename across filesystems fails with EXDEV, so a temp under the OS tmpdir
 * would break on any box whose home sits on a different device (this repo has
 * been bitten by that before). Rename is atomic on the same filesystem, so a
 * concurrent reader — `readSync()` on the prompt-building path runs without the
 * lock — sees either the whole old file or the whole new one, never a truncated
 * one. Plain `writeFile` truncates first and can be read mid-write.
 *
 * Throws on failure: the caller decides whether the write is essential (the real
 * memory write) or best-effort (a snapshot).
 */
export async function atomicWriteSameDir(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
    await fsp.rename(tmp, filePath);
  } catch (err) {
    // Don't leave a half-written temp file behind to confuse the next reader.
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** `<file>.bak.<gen>` — gen 1 is the most recent previous state. */
export function memoryBackupPath(filePath: string, generation: number): string {
  return `${filePath}.bak.${generation}`;
}

/**
 * Existing snapshots for a store, newest first. Pure read — never writes.
 * Exposed so triage tooling / the Memory UI can surface a rollback source.
 */
export function listMemoryBackups(filePath: string): string[] {
  const found: string[] = [];
  for (let gen = 1; gen <= MEMORY_BACKUP_GENERATIONS; gen++) {
    const candidate = memoryBackupPath(filePath, gen);
    try {
      if (fs.statSync(candidate).isFile()) found.push(candidate);
    } catch {
      // Missing generation — keep scanning; gaps are possible if a rename failed.
    }
  }
  return found;
}

/**
 * Snapshot `previous` (the content about to be overwritten by `next`) into
 * generation 1, shifting the older generations down and dropping the oldest.
 *
 * BEST EFFORT BY CONTRACT: never throws, never leaves the target file touched.
 * A backup failure must not block or corrupt the real write — losing the safety
 * net is strictly better than losing the write it was meant to protect — but it
 * IS logged, because a silently absent .bak is how you discover the net was
 * never there on the day you needed it.
 *
 * Callers must hold the store's file lock (mutate() does), which is what makes
 * the read-compare-rotate sequence safe against a concurrent writer.
 */
export async function backupBeforeWrite(filePath: string, previous: string, next: string): Promise<void> {
  // Nothing to lose on a first write / empty file, and an empty .bak.1 next to
  // a healthy MEMORY.md reads as alarming noise.
  if (!previous) return;

  // A write that changes nothing has nothing to protect. This is not a
  // micro-optimization: an idempotent duplicate `add` still funnels through
  // mutate() and reports success, so without this guard a model repeating
  // itself would burn the whole generation ring on identical copies and evict
  // the state a human actually needs.
  if (previous === next) return;

  try {
    const newest = memoryBackupPath(filePath, 1);

    // Second dedup guard for the same reason, one level down: a store that
    // oscillates back to an already-snapshotted state must not spend two
    // generations on identical bytes.
    try {
      if (await fsp.readFile(newest, 'utf-8') === previous) return;
    } catch {
      // No generation 1 yet, or unreadable — fall through and write one.
    }

    // Shift down: drop the oldest, then walk upward so no slot is clobbered.
    await fsp.rm(memoryBackupPath(filePath, MEMORY_BACKUP_GENERATIONS), { force: true });
    for (let gen = MEMORY_BACKUP_GENERATIONS - 1; gen >= 1; gen--) {
      try {
        await fsp.rename(memoryBackupPath(filePath, gen), memoryBackupPath(filePath, gen + 1));
      } catch {
        // That generation doesn't exist yet — normal until the ring fills.
      }
    }

    await atomicWriteSameDir(newest, previous);
  } catch (err) {
    log.memory.warn('bounded-memory: pre-write backup failed — the write proceeds unprotected', {
      filePath,
      backupDir: path.dirname(filePath),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
