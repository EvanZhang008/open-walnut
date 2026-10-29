/**
 * Where Claude Code keeps a session's files (transcripts under `projects/`), as
 * the daemon that reads them resolves it. The ONE resolver for every server-side
 * transcript path: build paths from these, never from a literal `~/.claude`.
 *
 * The CLI writes under `$CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`. A
 * session's CLI inherits its daemon's environment (the daemon spawns it with
 * `...process.env`, `startSessionProcess` in daemon-standalone.ts), and no session
 * record or start command names a config dir of its own, so the dir is the
 * daemon's:
 *  - the local daemon is this server's child and inherits its env
 *    (`LocalDaemon` spawn env in src/providers/local-daemon.ts), so this server's
 *    `CLAUDE_CONFIG_DIR` is that daemon's;
 *  - a remote host's env is not known here, so its paths stay tilde-based
 *    (`~/.claude`, expanded by that host's daemon), and the daemon's `fs.find`
 *    over the default root also walks its own `CLAUDE_CONFIG_DIR/projects`.
 *
 * Read per call, not at import, so a test can point it at a temp dir.
 */

import path from 'node:path';
import { CLAUDE_HOME } from '../constants.js';

/** The tilde root every daemon expands against its own HOME. */
export const DEFAULT_CLAUDE_PROJECTS_ROOT = '~/.claude/projects';

function isLocalHost(host?: string): boolean {
  return !host || host === '__local__';
}

/** This process's CLAUDE_CONFIG_DIR when it names a usable absolute dir. */
function envConfigDir(): string | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir && path.isAbsolute(dir) ? dir.replace(/\/+$/, '') || '/' : undefined;
}

/**
 * The transcripts root on `host` in the form its daemon reads: absolute when the
 * local env relocates it, else `~/.claude/projects`.
 */
export function claudeProjectsDir(host?: string): string {
  const dir = isLocalHost(host) ? envConfigDir() : undefined;
  return dir ? path.join(dir, 'projects') : DEFAULT_CLAUDE_PROJECTS_ROOT;
}

/** The roots a find for a session's transcript walks, first hit wins: the
 *  resolved one, then the default (an older daemon searches only what it is told). */
export function claudeProjectsSearchRoots(host?: string): string[] {
  return [...new Set([claudeProjectsDir(host), DEFAULT_CLAUDE_PROJECTS_ROOT])];
}

/** The local transcripts root as an absolute path, for this machine's own fs. */
export function localClaudeProjectsDir(): string {
  return path.join(envConfigDir() ?? CLAUDE_HOME, 'projects');
}
