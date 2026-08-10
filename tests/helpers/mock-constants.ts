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
import { fileURLToPath } from 'node:url';

// Real daemon binaries path (not mocked — needed for live tests)
const REAL_DAEMON_BINARIES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/daemon-binaries',
);

export function createMockConstants(prefix = 'walnut-test', overrides: Record<string, unknown> = {}) {
  const tmpBase = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tasksDir = path.join(tmpBase, 'tasks');
  return {
    IS_EPHEMERAL: false,
    CLOUD_MODE: false,
    WALNUT_HOME: tmpBase,
    TASKS_DIR: tasksDir,
    TASKS_FILE: path.join(tasksDir, 'tasks.json'),
    ARCHIVE_DIR: path.join(tasksDir, 'archive'),
    MEMORY_DIR: path.join(tmpBase, 'memory'),
    SESSIONS_DIR: path.join(tmpBase, 'memory', 'sessions'),
    PROJECTS_DIR: path.join(tmpBase, 'memory', 'projects'),
    DAILY_DIR: path.join(tmpBase, 'memory', 'daily'),
    MEMORY_FILE: path.join(tmpBase, 'memory', 'MEMORY.md'),
    USER_FILE: path.join(tmpBase, 'memory', 'USER.md'),
    LEGACY_MEMORY_FILE: path.join(tmpBase, 'MEMORY.md'),
    PROJECTS_MEMORY_DIR: path.join(tmpBase, 'memory', 'projects'),
    CONFIG_FILE: path.join(tmpBase, 'config.yaml'),
    SYNC_DIR: path.join(tmpBase, 'sync'),
    PLUGIN_STORES_DIR: path.join(tmpBase, 'plugin-stores'),
    SESSIONS_FILE: path.join(tmpBase, 'sessions.json'),
    CLAUDE_HOME: path.join(tmpBase, '.claude'),
    CLAUDE_SETTINGS_FILE: path.join(tmpBase, '.claude', 'settings.json'),
    CLAUDE_PLUGINS_DIR: path.join(tmpBase, '.claude', 'plugins'),
    HOOK_LOG_FILE: path.join(tmpBase, 'hook-errors.log'),
    GLOBAL_SKILLS_DIR: path.join(tmpBase, 'skills'),
    BUILTIN_SKILLS_DIR: path.join(tmpBase, 'data', 'skills'),
    CLAUDE_SKILLS_DIR: path.join(tmpBase, '.claude', 'skills'),
    SKILL_SETTINGS_FILE: path.join(tmpBase, 'skill-settings.json'),
    CHAT_HISTORY_FILE: path.join(tmpBase, 'chat-history.json'),
    chatHistoryFile: (agentId?: string) => {
      if (!agentId || agentId === 'general') return path.join(tmpBase, 'chat-history.json');
      return path.join(tmpBase, `chat-history-${agentId}.json`);
    },
    // Per-agent conversation registry (multi-conversation model).
    CONVERSATIONS_DIR: path.join(tmpBase, 'conversations'),
    conversationDir: (agentId: string) => path.join(tmpBase, 'conversations', agentId),
    conversationIndexFile: (agentId: string) => path.join(tmpBase, 'conversations', agentId, '_index.json'),
    conversationFile: (agentId: string, conversationId: string) =>
      path.join(tmpBase, 'conversations', agentId, `${conversationId}.json`),
    workingMemoryFile: (agentId: string, conversationId: string) =>
      path.join(tmpBase, 'conversations', agentId, `${conversationId}.working-memory.md`),
    validateConversationId: (id: string) => {
      if (!id || !/^conv-[A-Za-z0-9-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
      return id;
    },
    agentMemoryDir: (agentId?: string) => {
      if (!agentId || agentId === 'general') return tmpBase;
      return path.join(tmpBase, 'memory', 'agents', agentId);
    },
    agentDailyDir: (agentId?: string) => {
      if (!agentId || agentId === 'general') return path.join(tmpBase, 'memory', 'daily');
      return path.join(tmpBase, 'memory', 'agents', agentId, 'daily');
    },
    CRON_FILE: path.join(tmpBase, 'cron-jobs.json'),
    PLUGIN_A_SYNC_FILE: path.join(tmpBase, 'sync', 'plugin-a-sync.json'),
    USAGE_DB_FILE: path.join(tmpBase, 'usage.sqlite'),
    SESSION_STREAMS_DIR: path.join(tmpBase, 'sessions', 'streams'),
    SESSION_QUEUE_FILE: path.join(tmpBase, 'session-message-queue.json'),
    IMAGES_DIR: path.join(tmpBase, 'images'),
    REMOTE_IMAGES_DIR: path.join(tmpBase, 'images', 'remote'),
    PASTES_DIR: path.join(tmpBase, 'pastes'),
    HEARTBEAT_FILE: path.join(tmpBase, 'HEARTBEAT.md'),
    LOG_DIR: path.join(tmpBase, 'logs'),
    LOG_PREFIX: 'open-walnut-test-',
    FREQUENT_DIRS_FILE: path.join(tmpBase, 'frequent-directories.json'),
    MENTION_DIRS_FILE: path.join(tmpBase, 'mention-directories.json'),
    HOST_MODEL_CATALOG_FILE: path.join(tmpBase, 'cache', 'host-model-catalogs.json'),
    NOTES_DIR: path.join(tmpBase, 'notes'),
    GLOBAL_NOTES_FILE: path.join(tmpBase, 'notes', 'global-notes.md'),
    NOTES_AGENTS_FILE: path.join(tmpBase, 'notes', 'AGENTS.md'),
    NOTES_CLAUDE_FILE: path.join(tmpBase, 'notes', 'CLAUDE.md'),
    REPOSITORIES_DIR: path.join(tmpBase, 'repositories'),
    REPOS_MEMORY_DIR: path.join(tmpBase, 'skills', 'repos'),
    TIMELINE_DIR: path.join(tmpBase, 'timeline'),
    COMMANDS_DIR: path.join(tmpBase, 'commands'),
    BUILTIN_COMMANDS_DIR: path.join(tmpBase, 'data', 'slash-commands'),
    DAEMON_BINARIES_DIR: REAL_DAEMON_BINARIES_DIR,
    TOPICS_DIR: path.join(tmpBase, 'memory', 'topics'),
    COMPACTION_DIR: path.join(tmpBase, 'memory', 'compaction'),
    MEMORY_INDEX_FILE: path.join(tmpBase, 'memory', 'index.md'),
    WORKING_MEMORY_FILE: path.join(tmpBase, 'memory', 'working-memory.md'),
    TMP_DIR: path.join(tmpBase, 'tmp'),
    RECORDINGS_DIR: path.join(tmpBase, 'tmp', 'recordings'),
    // Synced (git-tracked) user preferences — tmp/'s opposite.
    CONFIG_SHARE_DIR: path.join(tmpBase, 'config', 'share'),
    UI_PREFS_FILE: path.join(tmpBase, 'config', 'share', 'ui-prefs.json'),
    STT_VOCAB_FILE: path.join(tmpBase, 'config', 'share', 'stt-vocab.txt'),
    // Non-path scalar constants — must be mirrored here too, otherwise any
    // module under test that imports them sees `undefined` (vitest throws on
    // unmocked named exports of a mocked module).
    QUICK_START_MESSAGE_SPILL_LIMIT: 25_000,
    QUICK_START_MESSAGE_HARD_LIMIT: 2_000_000,
    // Deterministic in tests: no Fix-Walnut source dir unless a test opts in.
    WALNUT_INSTALL_DIR: null,
    ...overrides,
  };
}
