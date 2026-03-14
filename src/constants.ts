import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const WALNUT_HOME = resolveOpenWalnutHome();

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

  // Ephemeral child processes set OPEN_WALNUT_EPHEMERAL=1 — trust OPEN_WALNUT_HOME as-is
  if (process.env.OPEN_WALNUT_EPHEMERAL === '1') return envHome

  // Check if OPEN_WALNUT_HOME looks like an ephemeral temp dir (leaked from parent)
  if (isEphemeralTmpDir(envHome)) {
    process.stderr.write(
      `WARNING: OPEN_WALNUT_HOME=${envHome} looks like a leaked ephemeral temp dir.\n` +
      `  Overriding to ${productionHome}. Set OPEN_WALNUT_EPHEMERAL=1 to suppress.\n`,
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
export const SESSIONS_FILE = path.join(WALNUT_HOME, 'sessions.json');
export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const HOOK_LOG_FILE = path.join(WALNUT_HOME, 'hook-errors.log');
export const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
export const MEMORY_FILE = path.join(WALNUT_HOME, 'MEMORY.md');
export const PROJECTS_MEMORY_DIR = path.join(MEMORY_DIR, 'projects');
export const CHAT_HISTORY_FILE = path.join(WALNUT_HOME, 'chat-history.json');
export const GLOBAL_SKILLS_DIR = path.join(WALNUT_HOME, 'skills');
export const CLAUDE_SKILLS_DIR = path.join(CLAUDE_HOME, 'skills');
export const CRON_FILE = path.join(WALNUT_HOME, 'cron-jobs.json');
export const USAGE_DB_FILE = path.join(WALNUT_HOME, 'usage.sqlite');
export const SESSION_STREAMS_DIR = path.join(WALNUT_HOME, 'sessions', 'streams');
export const SESSION_QUEUE_FILE = path.join(WALNUT_HOME, 'session-message-queue.json');
export const IMAGES_DIR = path.join(WALNUT_HOME, 'images');
export const REMOTE_IMAGES_DIR = path.join(IMAGES_DIR, 'remote');
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
export const FREQUENT_DIRS_FILE = path.join(WALNUT_HOME, 'frequent-directories.json');
export const GLOBAL_NOTES_FILE = path.join(WALNUT_HOME, 'global-notes.md');
export const TIMELINE_DIR = path.join(WALNUT_HOME, 'timeline');
export const LOG_DIR = '/tmp/open-walnut';
export const LOG_PREFIX = 'open-walnut-';
