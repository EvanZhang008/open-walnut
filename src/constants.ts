import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const WALNUT_HOME = resolveOpenWalnutHome();

/**
 * True when running as an ephemeral child server (open-walnut web --_ephemeral-child).
 * Ephemeral servers run over a snapshot of production data and must never touch
 * production's shared remote singleton daemons.
 *
 * Identity is read from ARGV, not env, on purpose: "ephemeral" is a property of
 * exactly one process instance (how it was invoked), while env vars inherit down
 * the whole process tree. The old OPEN_WALNUT_EPHEMERAL=1 env flag leaked
 * ephemeral-server → shared local daemon → every claude CLI it spawned → any
 * `npm run dev:prod` run inside such a CLI, booting the production server in
 * attach-only mode (all remote sessions stuck on "Reconnecting…"). argv cannot
 * leak that way. In-process embedders (test harnesses) that need ephemeral
 * semantics push '--_ephemeral-child' onto process.argv before importing.
 */
export const IS_EPHEMERAL = process.argv.includes('--_ephemeral-child');

/**
 * True when running as a headless cloud companion (WALNUT_CLOUD_MODE=1).
 * Cloud mode serves the same HTTP API + offline chat brain + git sync node,
 * but the box has no Claude Code CLI, no local session daemon, no macOS
 * audio, and no qmd semantic indexes — subsystems that presume those are
 * gated on this flag. Read at import time, same constraint as IS_EPHEMERAL.
 */
export const CLOUD_MODE = process.env.WALNUT_CLOUD_MODE === '1';

/**
 * Resolve OPEN_WALNUT_HOME with guards against:
 * 1. Test processes touching production data (~/.open-walnut/)
 * 2. Leaked ephemeral env vars from parent processes
 *
 * Test guard: When VITEST or NODE_ENV=test is detected, OPEN_WALNUT_HOME is forced to
 * a temp dir (/tmp/open-walnut-test-{pid}/) unless OPEN_WALNUT_HOME is already explicitly
 * set to a non-production path. This prevents `fs.rm(WALNUT_HOME)` in test
 * setup/teardown from nuking real user data.
 *
 * This guard MUST live here because constants.ts is evaluated at import time via
 * static import chains (cli.ts → logging → constants.ts), before any command handler
 * code runs. Placing the guard in web.ts would be too late.
 */
function resolveOpenWalnutHome(): string {
  const envHome = process.env.OPEN_WALNUT_HOME
  const productionHome = path.join(os.homedir(), '.open-walnut')
  const isTestEnv = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')

  // Test guard: never let tests touch ~/.open-walnut/
  if (isTestEnv) {
    // If OPEN_WALNUT_HOME is explicitly set to a non-production path, trust it
    if (envHome && envHome !== productionHome && !envHome.startsWith(productionHome + path.sep)) {
      assertNotProductionPath(envHome)
      return envHome
    }
    // Force to isolated temp dir
    const testHome = path.join(os.tmpdir(), `open-walnut-test-${process.pid}`)
    process.env.OPEN_WALNUT_HOME = testHome
    return testHome
  }

  if (!envHome) return productionHome

  // A true ephemeral child (argv-identified, cannot be inherited) trusts
  // OPEN_WALNUT_HOME as-is — web.ts pointed it at the snapshot tmpdir.
  if (process.argv.includes('--_ephemeral-child')) return envHome

  // Check if OPEN_WALNUT_HOME looks like an ephemeral temp dir (leaked from parent)
  if (isEphemeralTmpDir(envHome)) {
    process.stderr.write(
      `WARNING: OPEN_WALNUT_HOME=${envHome} looks like a leaked ephemeral temp dir.\n` +
      `  Overriding to ${productionHome}. (Only --_ephemeral-child processes may use one.)\n`,
    )
    process.env.OPEN_WALNUT_HOME = productionHome
    return productionHome
  }

  return envHome
}

/**
 * Layer 2 self-validation: in test environments, throws if a resolved path
 * lands inside ~/.open-walnut/ (the production data directory).
 * No-op in production to avoid overhead.
 */
export function assertNotProductionPath(inputPath: string): void {
  const isTestEnv = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')
  if (!isTestEnv) return

  const resolved = path.resolve(inputPath)
  const prodHome = path.join(os.homedir(), '.open-walnut')

  if (resolved === prodHome || resolved.startsWith(prodHome + path.sep)) {
    throw new Error(
      `SAFETY: Test process attempted to use production path: ${resolved}\n` +
      `  This would destroy real user data in ~/.open-walnut/.\n` +
      `  Set OPEN_WALNUT_HOME to a temp directory or let constants.ts auto-assign one.`,
    )
  }
}

/**
 * Detect if a path matches the ephemeral dir pattern: {tmpdir}/open-walnut-{PPID}-{random}
 * produced by runEphemeralLauncher() in src/commands/web.ts.
 */
function isEphemeralTmpDir(inputPath: string): boolean {
  if (!/[\\/]open-walnut-[^\\/]+$/.test(inputPath)) return false

  // Resolve symlinks on the parent dir for comparison.
  // On macOS, /tmp → /private/tmp and os.tmpdir() → /var/folders/.../T/
  const tmpDirs = new Set<string>()
  tmpDirs.add(os.tmpdir())
  try { tmpDirs.add(fs.realpathSync(os.tmpdir())) } catch { /* best-effort */ }
  try { tmpDirs.add(fs.realpathSync('/tmp')) } catch { /* best-effort */ }

  const parent = path.dirname(path.resolve(inputPath))
  if (tmpDirs.has(parent)) return true

  // Also resolve the parent through realpathSync in case of symlinks
  try { return tmpDirs.has(fs.realpathSync(parent)) } catch { return false }
}

export const TASKS_DIR = path.join(WALNUT_HOME, 'tasks');
export const TASKS_FILE = path.join(TASKS_DIR, 'tasks.json');
export const ARCHIVE_DIR = path.join(TASKS_DIR, 'archive');
export const MEMORY_DIR = path.join(WALNUT_HOME, 'memory');
export const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
export const PROJECTS_DIR = path.join(MEMORY_DIR, 'projects');
export const CONFIG_FILE = path.join(WALNUT_HOME, 'config.yaml');
export const SYNC_DIR = path.join(WALNUT_HOME, 'sync');
/** Git clones of plugin-source repos (the "plugin store" feature). One subdir per source slug. */
export const PLUGIN_STORES_DIR = path.join(WALNUT_HOME, 'plugin-stores');
export const SESSIONS_FILE = path.join(WALNUT_HOME, 'sessions.json');
export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const HISTORY_CACHE_DIR = path.join(WALNUT_HOME, 'cache', 'history');
/** Last-known model catalog per host (from any session's list_models) — feeds pickers before/without a live CLI. */
export const HOST_MODEL_CATALOG_FILE = path.join(WALNUT_HOME, 'cache', 'host-model-catalogs.json');
export const HOOK_LOG_FILE = path.join(WALNUT_HOME, 'hook-errors.log');
export const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
/** Pinned global memory. Lives INSIDE memory/ (three-word model: memory / skill / history). */
export const MEMORY_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
/** User profile — who the user is (identity, work, durable preferences). Injected every turn alongside MEMORY.md. */
export const USER_FILE = path.join(MEMORY_DIR, 'USER.md');
/** Pre-2026-07 location (WALNUT_HOME root) — read-migrated on startup by initDirectories. */
export const LEGACY_MEMORY_FILE = path.join(WALNUT_HOME, 'MEMORY.md');
export const PROJECTS_MEMORY_DIR = path.join(MEMORY_DIR, 'projects');
export const CHAT_HISTORY_FILE = path.join(WALNUT_HOME, 'chat-history.json');

/**
 * Validate an agentId from user input to prevent path traversal.
 * Throws if the value is not a safe alphanumeric-dash-underscore string.
 */
export function validateAgentId(agentId: string): string {
  if (!/^[a-z0-9_-]{1,64}$/i.test(agentId)) {
    throw new Error(`Invalid agentId: ${JSON.stringify(agentId)}`);
  }
  return agentId;
}

/**
 * Resolve chat history file path for a console agent.
 * General ('general' or undefined) → chat-history.json (zero migration).
 * Others → chat-history-{agentId}.json.
 */
export function chatHistoryFile(agentId?: string): string {
  if (!agentId || agentId === 'general') return CHAT_HISTORY_FILE;
  return path.join(WALNUT_HOME, `chat-history-${agentId}.json`);
}

// ── Multi-conversation per agent ──
// Each agent gets a directory of conversations: an _index.json registry +
// one {conversationId}.json per conversation (ChatHistoryStore schema).
export const CONVERSATIONS_DIR = path.join(WALNUT_HOME, 'conversations');

/** Per-agent conversation directory. 'general' is used literally (not root). */
export function conversationDir(agentId: string): string {
  return path.join(CONVERSATIONS_DIR, validateAgentId(agentId));
}

/** The conversation registry (_index.json) for an agent. */
export function conversationIndexFile(agentId: string): string {
  return path.join(conversationDir(agentId), '_index.json');
}

/** A single conversation's ChatHistoryStore file. conversationId must be pre-validated. */
export function conversationFile(agentId: string, conversationId: string): string {
  return path.join(conversationDir(agentId), `${conversationId}.json`);
}

/**
 * Validate a conversationId from user input to prevent path traversal.
 * Format: 'conv-' + alphanumeric/dash (allows crypto.randomUUID() dashes).
 */
export function validateConversationId(id: string): string {
  if (!/^conv-[a-z0-9-]{1,64}$/i.test(id)) {
    throw new Error(`Invalid conversationId: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Strict RFC-4122 v4 UUID shape — the ONLY form accepted for a client-supplied
 * session id (`preassignedSessionId`). Deliberately narrower than "any uuid":
 * the value is passed to the CLI as `--session-id` and becomes a filename on
 * the exec host (`<id>.jsonl`, `<id>.pipe`), so anything but hex+dashes is a
 * path-traversal / arg-injection vector.
 */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `id` is a v4 UUID safe to use as a session id / filename. */
export function isValidSessionUuid(id: unknown): id is string {
  return typeof id === 'string' && SESSION_UUID_RE.test(id);
}

/**
 * Resolve the memory directory for a console agent.
 * General → MEMORY_DIR (existing path, zero migration).
 * Others → MEMORY_DIR/agents/{agentId}/.
 */
export function agentMemoryDir(agentId?: string): string {
  if (!agentId || agentId === 'general') return WALNUT_HOME;
  return path.join(MEMORY_DIR, 'agents', agentId);
}

/**
 * Resolve the daily log directory for a console agent.
 * General → DAILY_DIR (existing path, zero migration).
 * Others → MEMORY_DIR/agents/{agentId}/daily/.
 */
export function agentDailyDir(agentId?: string): string {
  if (!agentId || agentId === 'general') return DAILY_DIR;
  return path.join(MEMORY_DIR, 'agents', agentId, 'daily');
}
export const GLOBAL_SKILLS_DIR = path.join(WALNUT_HOME, 'skills');
export const SKILL_SETTINGS_FILE = path.join(WALNUT_HOME, 'skill-settings.json');
export const CLAUDE_SKILLS_DIR = path.join(CLAUDE_HOME, 'skills');
/** Claude Code plugin registry — where enabled plugins + marketplaces are recorded. */
export const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_HOME, 'settings.json');
export const CLAUDE_PLUGINS_DIR = path.join(CLAUDE_HOME, 'plugins');
/** Claude Code's subscription OAuth store. We ONLY ever probe its EXISTENCE
 *  (boolean) — never read the token value inside it. */
export const CLAUDE_CREDENTIALS_FILE = path.join(CLAUDE_HOME, '.credentials.json');
export const CRON_FILE = path.join(WALNUT_HOME, 'cron-jobs.json');
export const USAGE_DB_FILE = path.join(WALNUT_HOME, 'usage.sqlite');
// Env-aware so an isolated demo server (WALNUT_DAEMON_DIR=/tmp/open-walnut-demo)
// keeps its logs/streams/images separate from production. Read at import time —
// the env must be set by the launching shell (see dev:demo) before node starts,
// same constraint as IS_EPHEMERAL above. Production sets nothing → /tmp/open-walnut.
export const LOG_DIR = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut';
export const SESSION_STREAMS_DIR = path.join(LOG_DIR, 'streams');
export const SESSION_QUEUE_FILE = path.join(WALNUT_HOME, 'session-message-queue.json');
export const IMAGES_DIR = path.join(LOG_DIR, 'images');
export const REMOTE_IMAGES_DIR = path.join(IMAGES_DIR, 'remote');
// Oversized chat-input pastes spilled to disk (POST /api/pastes); the message
// then carries the file path instead of megabytes of text. /tmp like
// IMAGES_DIR: same lifecycle, same remote-transfer treatment.
export const PASTES_DIR = path.join(LOG_DIR, 'pastes');
export const HEARTBEAT_FILE = path.join(WALNUT_HOME, 'HEARTBEAT.md');
export const COMMANDS_DIR = path.join(WALNUT_HOME, 'commands');
// Resolve builtin commands dir. tsup inlines this into each entry point
// (dist/cli.js, dist/web/server.js) so import.meta.url varies by bundle.
// Walk up from the current file to find the nearest data/slash-commands/ sibling.
export const BUILTIN_COMMANDS_DIR = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'data', 'slash-commands');
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
    dir = path.dirname(dir);
  }
  // Fallback: original relative path (works from src/ via tsx)
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'slash-commands');
})();
export const BUILTIN_SKILLS_DIR = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'data', 'skills');
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
    dir = path.dirname(dir);
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'skills');
})();
export const FREQUENT_DIRS_FILE = path.join(WALNUT_HOME, 'frequent-directories.json');
/** Folders the user browsed in the "@" file picker — kept SEPARATE from the
 *  session-derived frequent-directories so the /session path picker isn't polluted
 *  by ad-hoc "@" browsing. "@?" searches the union of both; /session reads only the
 *  frequent-directories store. */
export const MENTION_DIRS_FILE = path.join(WALNUT_HOME, 'mention-directories.json');
export const NOTES_DIR = path.join(WALNUT_HOME, 'notes');
/** Reserved filename inside NOTES_DIR — consumers listing NOTES_DIR must exclude it */
export const GLOBAL_NOTES_FILE = path.join(NOTES_DIR, 'global-notes.md');
/** Primary instructions file — Walnut injects into all session contexts */
export const NOTES_AGENTS_FILE = path.join(NOTES_DIR, 'AGENTS.md');
/** Mirror of AGENTS.md — Claude Code discovers this natively when CWD is NOTES_DIR */
export const NOTES_CLAUDE_FILE = path.join(NOTES_DIR, 'CLAUDE.md');
export const REPOSITORIES_DIR = path.join(WALNUT_HOME, 'repositories');
/** Repo environment knowledge — now lives in the skill system as the `repos`
 *  category (skills/repos/<slug>/SKILL.md). memory/repos was merged into skills
 *  in the 2026-07 memory/skill/history unification (the old dir was empty). */
export const REPOS_MEMORY_DIR = path.join(GLOBAL_SKILLS_DIR, 'repos');
export const TOPICS_DIR = path.join(MEMORY_DIR, 'topics');
export const COMPACTION_DIR = path.join(MEMORY_DIR, 'compaction');
export const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, 'index.md');
/** @deprecated global single-file working memory — pre-multi-conversation. Kept as
 *  the lazy-migration SOURCE for an agent's main conversation. New reads/writes use
 *  workingMemoryFile(agentId, conversationId). */
export const WORKING_MEMORY_FILE = path.join(MEMORY_DIR, 'working-memory.md');

/**
 * Per-conversation working memory (real-time scratchpad). Lives beside the
 * conversation's chat file so each conversation has its own scratchpad and they
 * never cross-talk. Mirrors conversationFile()'s layout.
 */
export function workingMemoryFile(agentId: string, conversationId: string): string {
  return path.join(conversationDir(agentId), `${validateConversationId(conversationId)}.working-memory.md`);
}
export const TIMELINE_DIR = path.join(WALNUT_HOME, 'timeline');
/**
 * Cross-device user preferences — the SYNCED half of Walnut's configuration.
 *
 * Data-temperature rule: a preference the same human wants on every box is WARM
 * data and belongs in git (low write rate, real merge value); anything that
 * describes THIS machine (credentials, ssh hosts, binary paths, absolute file
 * paths) is COLD and stays ignored. config.yaml is cold as a whole today, which
 * is why the shareable settings inside it are still stranded (see follow-up:
 * splitting it into config/share/settings.yaml).
 *
 * Deliberately NOT gitignored — that is the whole point of the directory. The
 * data-repo .gitignore's `config.yaml` / `config.yaml.bak` rules are FILENAME
 * patterns, so they can never catch anything under here, and `/ui-prefs.json`
 * is root-anchored for the same reason.
 */
export const CONFIG_SHARE_DIR = path.join(WALNUT_HOME, 'config', 'share');
/**
 * Browser layout state mirrored server-side (src/web/routes/ui-prefs.ts):
 * collapse flags, splitter ratios, panel widths. Shared so a second browser or
 * a second device opens the UI already laid out. Machine-specific entries
 * (`open-walnut-file-explorer-selected:*`, whose key embeds an absolute path)
 * are filtered out by the allowlist instead of being synced as noise.
 */
export const UI_PREFS_FILE = path.join(CONFIG_SHARE_DIR, 'ui-prefs.json');
/**
 * Custom STT vocabulary — one word per line, `#` comments. Shared: the proper
 * nouns a user needs transcribed correctly are the same on every box.
 */
export const STT_VOCAB_FILE = path.join(CONFIG_SHARE_DIR, 'stt-vocab.txt');
/**
 * The ONE place app-generated scratch may live. Gitignored (`tmp/` is in the
 * .gitignore template AND in EXTRA_IGNORE_PATTERNS, so pre-existing installs
 * self-heal), so nothing written here can ever reach the sync history.
 *
 * Rule for new code: anything regenerable, machine-local, or binary goes under
 * TMP_DIR — never at WALNUT_HOME root. Root-level scratch is how this repo grew
 * to 15 GB / 1,958 commits per day (2026-07-25) and how a stale
 * ms-todo-tokens.json copy with a live MS Graph access token got committed.
 */
export const TMP_DIR = path.join(WALNUT_HOME, 'tmp');
/** Audio-capture WAV chunks (date-subdir per day). Under tmp/: large, binary, machine-local. */
export const RECORDINGS_DIR = path.join(TMP_DIR, 'recordings');
export const LOG_PREFIX = 'open-walnut-';
/** Directory containing pre-compiled daemon binaries (built by scripts/build-daemon.sh). */
/**
 * Quick Start: messages longer than this are spilled to a temp file on disk.
 * 25K chars ≈ 6K tokens — comfortably below a single Claude turn budget, and
 * large enough that typical paste-a-log / paste-a-stack-trace flows still
 * inline without touching disk. Past this, the full content lands in a file
 * and the session sees only a pointer prompt + preview.
 */
export const QUICK_START_MESSAGE_SPILL_LIMIT = 25_000;
/**
 * Quick Start: absolute max message size (DoS guard on the spill path).
 * 2MB caps disk writes and daemon base64-payload uploads to remote hosts.
 */
export const QUICK_START_MESSAGE_HARD_LIMIT = 2_000_000;

export const DAEMON_BINARIES_DIR = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'dist', 'daemon-binaries');
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
    dir = path.dirname(dir);
  }
  // Fallback: relative from project root
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'daemon-binaries');
})();

/**
 * Walnut's own source checkout, for the "Fix Walnut" quick-start entry.
 * Walk up from the bundle looking for package.json (name === 'open-walnut')
 * alongside a .git dir — a fixable *source* checkout, not an npm install or a
 * cloud bundle. null → the UI hides the Fix Walnut button entirely.
 */
export const WALNUT_INSTALL_DIR: string | null = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'open-walnut' && fs.statSync(path.join(dir, '.git')).isDirectory()) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
})();
