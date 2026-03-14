import { ensureDir } from '../utils/fs.js';
import {
  WALNUT_HOME,
  TASKS_DIR,
  ARCHIVE_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
  PROJECTS_DIR,
  SYNC_DIR,
  DAILY_DIR,
  PROJECTS_MEMORY_DIR,
  SESSION_STREAMS_DIR,
} from '../constants.js';
import { ensureMemoryFile } from './memory-file.js';
import { seedConfigDefaults } from './config-manager.js';

/**
 * Ensure the full ~/.open-walnut/ directory structure exists.
 */
export async function initDirectories(): Promise<void> {
  await ensureDir(WALNUT_HOME);
  await ensureDir(TASKS_DIR);
  await ensureDir(ARCHIVE_DIR);
  await ensureDir(MEMORY_DIR);
  await ensureDir(SESSIONS_DIR);
  await ensureDir(PROJECTS_DIR);
  await ensureDir(SYNC_DIR);
  await ensureDir(DAILY_DIR);
  await ensureDir(PROJECTS_MEMORY_DIR);
  await ensureDir(SESSION_STREAMS_DIR);
  ensureMemoryFile();
  await seedConfigDefaults();
}
