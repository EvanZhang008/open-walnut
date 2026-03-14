/**
 * Shared test utility: generates a mock constants object that redirects
 * all file paths to a unique temporary directory.
 *
 * Usage in test files:
 *   import { createMockConstants } from '../helpers/mock-constants.js';
 *   vi.mock('../../src/constants.js', () => createMockConstants());
 */
import path from 'node:path';
import os from 'node:os';

export function createMockConstants(prefix = 'walnut-test') {
  const tmpBase = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tasksDir = path.join(tmpBase, 'tasks');
  return {
    WALNUT_HOME: tmpBase,
    TASKS_DIR: tasksDir,
    TASKS_FILE: path.join(tasksDir, 'tasks.json'),
    ARCHIVE_DIR: path.join(tasksDir, 'archive'),
    MEMORY_DIR: path.join(tmpBase, 'memory'),
    SESSIONS_DIR: path.join(tmpBase, 'memory', 'sessions'),
    PROJECTS_DIR: path.join(tmpBase, 'memory', 'projects'),
    DAILY_DIR: path.join(tmpBase, 'memory', 'daily'),
    MEMORY_FILE: path.join(tmpBase, 'MEMORY.md'),
    PROJECTS_MEMORY_DIR: path.join(tmpBase, 'memory', 'projects'),
    CONFIG_FILE: path.join(tmpBase, 'config.yaml'),
    SYNC_DIR: path.join(tmpBase, 'sync'),
    SESSIONS_FILE: path.join(tmpBase, 'sessions.json'),
    CLAUDE_HOME: path.join(tmpBase, '.claude'),
    HOOK_LOG_FILE: path.join(tmpBase, 'hook-errors.log'),
    GLOBAL_SKILLS_DIR: path.join(tmpBase, 'skills'),
    CLAUDE_SKILLS_DIR: path.join(tmpBase, '.claude', 'skills'),
    CHAT_HISTORY_FILE: path.join(tmpBase, 'chat-history.json'),
    CRON_FILE: path.join(tmpBase, 'cron-jobs.json'),
    PLUGIN_A_SYNC_FILE: path.join(tmpBase, 'sync', 'plugin-a-sync.json'),
    USAGE_DB_FILE: path.join(tmpBase, 'usage.sqlite'),
    SESSION_STREAMS_DIR: path.join(tmpBase, 'sessions', 'streams'),
    SESSION_QUEUE_FILE: path.join(tmpBase, 'session-message-queue.json'),
    IMAGES_DIR: path.join(tmpBase, 'images'),
    REMOTE_IMAGES_DIR: path.join(tmpBase, 'images', 'remote'),
    HEARTBEAT_FILE: path.join(tmpBase, 'HEARTBEAT.md'),
    LOG_DIR: path.join(tmpBase, 'logs'),
    LOG_PREFIX: 'open-walnut-test-',
  };
}
