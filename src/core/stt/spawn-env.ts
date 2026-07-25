/**
 * Spawn environment helpers for STT child processes.
 *
 * When Walnut runs under a process manager (launchd, systemd, docker, pm2…)
 * it inherits a minimal PATH like /usr/bin:/bin:/usr/sbin:/sbin — missing
 * Homebrew and other user-install prefixes. Child tools (whisper-server's
 * internal `sh -c ffmpeg` probe, our own ffmpeg conversion, `which` lookups)
 * then silently fail even though everything is installed. These helpers build
 * an augmented PATH so STT works regardless of how the server was launched.
 */

import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

/** Well-known install prefixes appended when missing from the inherited PATH. */
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',   // Homebrew on Apple Silicon
  '/usr/local/bin',      // Homebrew on Intel / manual installs on Linux
  join(homedir(), '.local', 'bin'),
];

/**
 * Inherited PATH + extraDirs (e.g. the configured binary's own directory —
 * ffmpeg is almost always installed under the same prefix) + common prefixes.
 * Order preserves the inherited PATH first so explicit user setup still wins.
 */
export function augmentedPath(extraDirs: string[] = []): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...extraDirs, ...COMMON_BIN_DIRS]) {
    if (dir && !parts.includes(dir)) parts.push(dir);
  }
  return parts.join(delimiter);
}

/** process.env with the augmented PATH — pass as `env` to spawn/execFile. */
export function sttSpawnEnv(extraDirs: string[] = []): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(extraDirs) };
}
