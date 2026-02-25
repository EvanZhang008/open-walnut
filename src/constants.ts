import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const WALNUT_HOME = resolveWalnutHome();

/**
 * Resolve WALNUT_HOME with a guard against leaked ephemeral env vars.
 *
 * The ephemeral launcher (`walnut web --ephemeral`) sets WALNUT_HOME to a tmpdir
 * AND WALNUT_EPHEMERAL=1. If a non-ephemeral process inherits WALNUT_HOME pointing
 * at a tmpdir (without WALNUT_EPHEMERAL=1), it was leaked from a parent — override
 * to ~/.walnut/ to prevent the production server from running against empty temp data.
 *
 * This guard MUST live here because constants.ts is evaluated at import time via
 * static import chains (cli.ts → logging → constants.ts), before any command handler
 * code runs. Placing the guard in web.ts would be too late.
 */
function resolveWalnutHome(): string {
  const envHome = process.env.WALNUT_HOME
  if (!envHome) return path.join(os.homedir(), '.walnut')

  // Ephemeral child processes set WALNUT_EPHEMERAL=1 — trust WALNUT_HOME as-is
  if (process.env.WALNUT_EPHEMERAL === '1') return envHome

  // Check if WALNUT_HOME looks like an ephemeral temp dir (leaked from parent)
  if (isEphemeralTmpDir(envHome)) {
    const defaultHome = path.join(os.homedir(), '.walnut')
    process.stderr.write(
      `WARNING: WALNUT_HOME=${envHome} looks like a leaked ephemeral temp dir.\n` +
      `  Overriding to ${defaultHome}. Set WALNUT_EPHEMERAL=1 to suppress.\n`,
    )
    process.env.WALNUT_HOME = defaultHome
    return defaultHome
  }

  return envHome
}

/**
 * Detect if a path matches the ephemeral dir pattern: {tmpdir}/walnut-{PPID}-{random}
 * produced by runEphemeralLauncher() in src/commands/web.ts.
 */
function isEphemeralTmpDir(inputPath: string): boolean {
  if (!/[\\/]walnut-[^\\/]+$/.test(inputPath)) return false

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
export const TIMELINE_DIR = path.join(WALNUT_HOME, 'timeline');
export const LOG_DIR = '/tmp/walnut';
export const LOG_PREFIX = 'walnut-';
