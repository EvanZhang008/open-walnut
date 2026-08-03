import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import {
  WALNUT_HOME,
  TASKS_DIR,
  ARCHIVE_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
  SYNC_DIR,
  DAILY_DIR,
  REPOS_MEMORY_DIR,
  COMPACTION_DIR,
  NOTES_DIR,
  REPOSITORIES_DIR,
  TIMELINE_DIR,
  RECORDINGS_DIR,
  COMMANDS_DIR,
  GLOBAL_SKILLS_DIR,
  SESSION_STREAMS_DIR,
  IMAGES_DIR,
  REMOTE_IMAGES_DIR,
  MEMORY_FILE,
  LEGACY_MEMORY_FILE,
} from '../constants.js';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { ensureMemoryFile } from './memory-file.js';
import { seedConfigDefaults } from './config-manager.js';
import { log } from '../logging/index.js';

/**
 * One-time migration: MEMORY.md moved from WALNUT_HOME root into memory/
 * (2026-07 memory/skill/history unification). Move the old file if the new
 * location doesn't exist yet; leave a copy-free move so git-sync sees a rename.
 */
async function migrateLegacyMemoryFile(): Promise<void> {
  try {
    if (fs.existsSync(LEGACY_MEMORY_FILE) && !fs.existsSync(MEMORY_FILE)) {
      await fsp.rename(LEGACY_MEMORY_FILE, MEMORY_FILE);
      log.memory.info('Migrated MEMORY.md into memory/ folder', { from: LEGACY_MEMORY_FILE, to: MEMORY_FILE });
    }
  } catch (err) {
    log.memory.warn('MEMORY.md migration failed (will retry next start)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Ensure the full ~/.open-walnut/ directory structure exists.
 * Called early in startServer() so first-run works on a fresh machine.
 */
export async function initDirectories(): Promise<void> {
  await ensureDir(WALNUT_HOME);
  await ensureDir(TASKS_DIR);
  await ensureDir(ARCHIVE_DIR);
  await ensureDir(MEMORY_DIR);
  await ensureDir(SESSIONS_DIR);
  await ensureDir(SYNC_DIR);
  await ensureDir(DAILY_DIR);
  // memory/projects/ retired (2026-07 unification) — knowledge lives under skills/.
  // Do NOT ensureDir it: PROJECTS_DIR and PROJECTS_MEMORY_DIR are the SAME path
  // (memory/projects), so recreating it here resurrected the legacy tree on every
  // boot after the full migration deleted it. TOPICS_DIR is retired for the same reason.
  await ensureDir(REPOS_MEMORY_DIR);
  await ensureDir(COMPACTION_DIR);
  await ensureDir(NOTES_DIR);
  // PARA scaffolding (Areas/Projects/Resources/Archive) retired 2026-08 — the
  // vault is topic-first now (see notes/CLAUDE.md routing table). Recreating
  // them here resurrected empty PARA dirs on every boot after the migration.
  await ensureDir(REPOSITORIES_DIR);
  await ensureDir(TIMELINE_DIR);
  await ensureDir(RECORDINGS_DIR);
  await ensureDir(COMMANDS_DIR);
  await ensureDir(GLOBAL_SKILLS_DIR);
  await ensureDir(SESSION_STREAMS_DIR);
  await ensureDir(IMAGES_DIR);
  await ensureDir(REMOTE_IMAGES_DIR);
  await migrateLegacyMemoryFile();
  ensureMemoryFile();
  await seedConfigDefaults();
}
