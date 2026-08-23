/**
 * CWD existence pre-flight check — Layer 3 of the session-cwd-rename defense.
 *
 * (Layers 1+2 live in `core/session-hooks/builtins.ts::cwdRenameDetectorHook`.)
 *
 * Called before spawning `claude` to avoid the "session created and running" lie
 * when the working directory has been deleted/renamed out from under Walnut.
 *
 * Local: fs.existsSync — sync is fine here because this runs once per spawn
 *        (not in a hot loop) and the IO is local.
 * Remote: daemon `fs.ls` RPC. If the daemon is unreachable or times out we
 *         soft-fail (allow spawn) — better to let claude produce its own error
 *         than to block on a transient network blip.
 */

import fs from 'node:fs';
import type { SshTarget } from './session-io.js';
import { log } from '../logging/index.js';

export interface CwdCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Thrown when this pre-flight refuses a spawn. Typed so the delivery-failure
 * classifier can call it PERMANENT by class instead of by message text — the
 * text match stays as a fallback for the same failure arriving as a plain string
 * (e.g. relayed through a daemon reply). See providers/delivery-failure.ts.
 */
export class CwdMissingError extends Error {
  readonly permanentDelivery = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'CwdMissingError';
  }
}

const REMOTE_TIMEOUT_MS = 5_000;

/**
 * Check whether `cwd` exists. For remote sessions (host + sshTarget provided),
 * uses the walnut-daemon's fs.ls over WebSocket. On unreachable daemon, returns ok:true
 * (soft-fail) — the spawn itself will surface the real error.
 */
export async function checkCwdExists(
  cwd: string,
  host?: string,
  sshTarget?: SshTarget,
): Promise<CwdCheckResult> {
  if (!cwd) return { ok: false, error: 'Working directory not set' };

  // Local
  if (!host || !sshTarget) {
    try {
      if (fs.existsSync(cwd)) return { ok: true };
      return {
        ok: false,
        error: `Working directory no longer exists: ${cwd}`,
      };
    } catch (err) {
      // existsSync shouldn't throw, but if something weird happens, soft-fail.
      log.session.warn('local cwd check threw', {
        cwd,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: true };
    }
  }

  // Remote — ask the daemon
  try {
    const { getDaemonConnection } = await import('./daemon-connection.js');
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('cwd check timed out')),
        REMOTE_TIMEOUT_MS,
      );
    });
    const conn = await Promise.race([
      getDaemonConnection(host, sshTarget),
      timeoutPromise,
    ]);
    const result = await Promise.race([
      conn.send('fs.ls', { path: cwd }),
      timeoutPromise,
    ]);
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      // Distinguish "path missing" (ENOENT) from transient daemon errors.
      const errMsg = typeof result.error === 'string' ? result.error : '';
      if (/ENOENT|no such file|does not exist|not a directory/i.test(errMsg)) {
        return {
          ok: false,
          error: `Working directory no longer exists on ${host}: ${cwd}`,
        };
      }
      // Unknown daemon error — soft-fail so we don't block on flaky connectivity.
      log.session.warn('remote cwd check returned non-ENOENT error, soft-failing', {
        cwd,
        host,
        error: errMsg,
      });
      return { ok: true };
    }
    return { ok: true };
  } catch (err) {
    // Daemon unreachable / timeout — don't block the user.
    log.session.warn('remote cwd check failed, allowing spawn', {
      cwd,
      host,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}
