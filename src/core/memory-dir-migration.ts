/**
 * One-shot disk migration for the category removal:
 * `memory/projects/<category>/<project>/` → `memory/projects/<project>/`.
 *
 * Project memory used to be addressed by a two-segment path because tasks had a
 * category above the project. With Project as the only grouping layer every
 * reader now passes a single segment, so the on-disk tree has to be flattened
 * once — otherwise every `getProjectMemory('walnut')` misses the real content
 * that still lives under `passion/walnut/`.
 *
 * Deliberately narrow scope:
 *  - Only TWO-level dirs that DIRECTLY contain a MEMORY.md are moved. A
 *    one-level dir is already in the target shape, and anything deeper is an
 *    opaque path a stateful agent configured itself (`memory_project`), which we
 *    must not rewrite. A two-level dir whose MEMORY.md lives only in a deeper
 *    child is therefore left alone as well.
 *  - Moves the whole directory (not just MEMORY.md) so siblings — e.g. a
 *    `triage/` subdir with its own memory — travel with it.
 *  - Collision (two categories held the same project name, or the target name
 *    already exists at the top level): the MEMORY.md with the NEWEST mtime is
 *    the base and the other one's body is appended under a
 *    `## Merged from <cat>/<proj> (legacy)` heading. Nothing is deleted.
 *
 * Guarded by a `.migrated-project-only` marker file so a restart is a cheap
 * no-op. Never throws: a failed flatten degrades to "readers see less memory",
 * which must not block server startup.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_MEMORY_DIR } from '../constants.js';
import { log } from '../logging/index.js';

/** Marker file written after a successful pass. */
export const MEMORY_DIR_MIGRATION_MARKER = path.join(PROJECTS_MEMORY_DIR, '.migrated-project-only');

const MEMORY_FILE_NAME = 'MEMORY.md';

export interface MemoryDirMigrationResult {
  /** True when the pass actually ran (marker absent + tree present). */
  ran: boolean;
  /** Directories flattened to the top level. */
  moved: number;
  /** Directories whose MEMORY.md was merged into an existing target. */
  merged: number;
}

interface Candidate {
  /** Legacy category segment. */
  category: string;
  /** Project segment (the new top-level name). */
  project: string;
  /** Absolute source dir (`<projects>/<category>/<project>`). */
  sourceDir: string;
}

/** Strip a leading YAML frontmatter block, returning the body only. */
function bodyOf(content: string): string {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return fm ? content.slice(fm[0].length) : content;
}

/**
 * Merge two MEMORY.md contents. The newer file (by mtime) is the base; the
 * older one's body is appended under a legacy heading so nothing is lost and
 * the frontmatter (name/description — a stateful agent's carry-forward state)
 * of the freshest copy survives verbatim.
 */
export function mergeMemoryContents(
  base: string,
  legacy: string,
  legacyLabel: string,
): string {
  const legacyBody = bodyOf(legacy).trim();
  if (!legacyBody) return base;
  const head = base.endsWith('\n') ? base : `${base}\n`;
  return `${head}\n## Merged from ${legacyLabel} (legacy)\n\n${legacyBody}\n`;
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Two-level dirs that directly hold a MEMORY.md, snapshotted before any move. */
function findCandidates(root: string): Candidate[] {
  const out: Candidate[] = [];
  let level1: fs.Dirent[];
  try {
    level1 = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const cat of level1) {
    if (!cat.isDirectory()) continue;
    const catDir = path.join(root, cat.name);
    // A level-1 dir with its OWN MEMORY.md is already a project in the target
    // shape — its children are project sub-dirs (e.g. `walnut/triage/`), not
    // category/project pairs. Skipping it makes a re-run (marker write failed)
    // idempotent instead of flattening `walnut/triage` up to `triage`.
    if (fs.existsSync(path.join(catDir, MEMORY_FILE_NAME))) continue;
    let level2: fs.Dirent[];
    try {
      level2 = fs.readdirSync(catDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const proj of level2) {
      if (!proj.isDirectory()) continue;
      const sourceDir = path.join(catDir, proj.name);
      if (!fs.existsSync(path.join(sourceDir, MEMORY_FILE_NAME))) continue;
      out.push({ category: cat.name, project: proj.name, sourceDir });
    }
  }
  return out;
}

/** Move every remaining entry of `from` into `to`, skipping name collisions. */
async function drainDir(from: string, to: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(from);
  } catch {
    return;
  }
  for (const name of entries) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) continue; // keep the destination's copy
    await fsp.rename(path.join(from, name), target).catch((err) => {
      log.memory.warn('memory-dir migration: entry move failed', {
        from: path.join(from, name), to: target, error: String(err),
      });
    });
  }
  // Only removes it when empty — leftovers (collisions) stay visible on disk.
  await fsp.rmdir(from).catch(() => {});
}

/**
 * Flatten `memory/projects/<cat>/<proj>/` → `memory/projects/<proj>/` once.
 * Idempotent via the marker file; safe to call on every boot.
 */
export async function migrateProjectMemoryDirs(): Promise<MemoryDirMigrationResult> {
  const result: MemoryDirMigrationResult = { ran: false, moved: 0, merged: 0 };
  try {
    // A missing tree is the common case post-2026-07 (init.ts stopped creating
    // it). Don't materialize the dir just to drop a marker in it.
    if (!fs.existsSync(PROJECTS_MEMORY_DIR)) return result;
    if (fs.existsSync(MEMORY_DIR_MIGRATION_MARKER)) return result;

    result.ran = true;
    const candidates = findCandidates(PROJECTS_MEMORY_DIR);
    const touchedCategories = new Set(candidates.map((c) => c.category));

    for (const c of candidates) {
      const targetDir = path.join(PROJECTS_MEMORY_DIR, c.project);
      const label = `${c.category}/${c.project}`;
      try {
        if (!fs.existsSync(targetDir)) {
          await fsp.rename(c.sourceDir, targetDir);
          result.moved += 1;
          continue;
        }

        const sourceMem = path.join(c.sourceDir, MEMORY_FILE_NAME);
        const targetMem = path.join(targetDir, MEMORY_FILE_NAME);
        if (!fs.existsSync(targetMem)) {
          await fsp.rename(sourceMem, targetMem);
          await drainDir(c.sourceDir, targetDir);
          result.moved += 1;
          continue;
        }

        // Both sides have memory — newest mtime is the base.
        const sourceContent = await fsp.readFile(sourceMem, 'utf-8');
        const targetContent = await fsp.readFile(targetMem, 'utf-8');
        const sourceNewer = mtimeMs(sourceMem) > mtimeMs(targetMem);
        const mergedContent = sourceNewer
          ? mergeMemoryContents(sourceContent, targetContent, c.project)
          : mergeMemoryContents(targetContent, sourceContent, label);
        await fsp.writeFile(targetMem, mergedContent, 'utf-8');
        await fsp.rm(sourceMem, { force: true });
        await drainDir(c.sourceDir, targetDir);
        result.merged += 1;
      } catch (err) {
        log.memory.warn('memory-dir migration: candidate failed (skipped)', {
          candidate: label, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Drop legacy category dirs we fully drained. rmdir only succeeds when the
    // dir is empty, so a category still holding un-migrated content survives.
    for (const cat of touchedCategories) {
      await fsp.rmdir(path.join(PROJECTS_MEMORY_DIR, cat)).catch(() => {});
    }

    await fsp.writeFile(
      MEMORY_DIR_MIGRATION_MARKER,
      `migrated ${new Date().toISOString()}\n`,
      'utf-8',
    );
    if (result.moved > 0 || result.merged > 0) {
      log.memory.info('memory-dir migration: flattened project memory to one level', {
        moved: result.moved, merged: result.merged,
      });
    }
  } catch (err) {
    log.memory.warn('memory-dir migration failed (will retry next start)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}
