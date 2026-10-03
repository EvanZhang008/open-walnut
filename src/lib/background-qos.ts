/**
 * Keep the server's background children in the macOS utility QoS band when,
 * and only when, the server itself was raised above it.
 *
 * scripts/dev-prod.sh loads the production server as a launchd job with
 * ProcessType Interactive (base priority 31) instead of a `launchctl submit`
 * job (launchd's Standard type, the utility band, base priority 20), so the
 * server is no longer starved by the agent work on a busy Mac. Children
 * inherit the parent's band, so without a clamp the local daemon, every Claude
 * Code session it runs, the embedding model worker and the git backups would
 * have moved up with it and the server would have gained nothing over them.
 * That job, and only that job, sets WALNUT_DAEMON_QOS_CLAMP=1 (in the plist's
 * EnvironmentVariables, so the submit fallback, which stays in the utility
 * band, never carries it).
 *
 * Every other launch leaves children alone: a server started from a terminal
 * (`open-walnut web`) or by the Mac app already runs at priority 31 together
 * with everything it starts, and clamping there would only take CPU away from
 * the user's own agents (measured 2026-10-03: a clamped CLI got 6.7 s of CPU in
 * 15 s under load, against 14.6 s unclamped). Opt-in, never a default.
 *
 * `taskpolicy -c utility` sets the clamp and then execs the program (it spawns
 * with exec semantics), so the child's pid, its fds and a fork() IPC channel
 * are the program's own. A missing taskpolicy, another platform, or a program
 * that is not there spawns exactly as before.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TASKPOLICY = '/usr/sbin/taskpolicy';
export const QOS_CLAMP_ENV = 'WALNUT_DAEMON_QOS_CLAMP';

export interface QosClampOptions {
  platform?: NodeJS.Platform;
  /** Where the clamp request is read (default: this process's env). */
  env?: NodeJS.ProcessEnv;
  /** PATH a bare command name resolves on (default: env.PATH): the child's, when it gets its own env. */
  searchPath?: string;
  exists?: (p: string) => boolean;
}

let testOverride: { program: string; platform: NodeJS.Platform } | null = null;

/** Tests: run the clamp through a stand-in program (it must exec the rest of its argv). */
export function _setQosClampProgramForTest(program: string | null, platform: NodeJS.Platform = 'darwin'): void {
  testOverride = program ? { program, platform } : null;
}

function clampProgram(): string {
  return testOverride?.program ?? TASKPOLICY;
}

/** True when this server was raised to Interactive and asked to keep its background children down. */
export function backgroundQosClampOn(opts: QosClampOptions = {}): boolean {
  const platform = opts.platform ?? testOverride?.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  return platform === 'darwin' && env[QOS_CLAMP_ENV] === '1' && exists(clampProgram());
}

// A bare command name is looked up on PATH once per (name, PATH): the git
// backups spawn every 30 s, and a miss must keep failing as a spawn ENOENT.
const pathLookups = new Map<string, boolean>();

function programExists(cmd: string, searchPath: string, exists: (p: string) => boolean): boolean {
  if (cmd.includes('/')) return exists(cmd);
  const lookup = (): boolean => searchPath.split(path.delimiter).some((dir) => dir !== '' && exists(path.join(dir, cmd)));
  if (exists !== fs.existsSync) return lookup();
  const key = `${cmd}\0${searchPath}`;
  let hit = pathLookups.get(key);
  if (hit === undefined) {
    hit = lookup();
    if (pathLookups.size > 64) pathLookups.clear();
    pathLookups.set(key, hit);
  }
  return hit;
}

/** spawn() form: the command and arguments that run `cmd args` under the clamp, or unchanged. */
export function withUtilityQosClamp(cmd: string, args: readonly string[], opts: QosClampOptions = {}): [string, string[]] {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  // A program that is not there is spawned bare, so it still fails as a spawn
  // ENOENT instead of as a taskpolicy exit the caller would wait out.
  if (!backgroundQosClampOn(opts) || !programExists(cmd, opts.searchPath ?? env.PATH ?? '', exists)) return [cmd, [...args]];
  return [clampProgram(), ['-c', 'utility', cmd, ...args]];
}

/**
 * fork() form: `execPath`/`execArgv` that start a Node child under the clamp.
 * fork spawns `execPath [...execArgv, module, ...args]`, so the clamp program
 * becomes execPath and node moves to the front of execArgv.
 */
export function utilityQosForkExec(execArgv: readonly string[], opts: QosClampOptions = {}): { execPath?: string; execArgv: string[] } {
  if (!backgroundQosClampOn(opts)) return { execArgv: [...execArgv] };
  return { execPath: clampProgram(), execArgv: ['-c', 'utility', process.execPath, ...execArgv] };
}
