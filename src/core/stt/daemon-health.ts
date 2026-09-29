/**
 * Health probing for the local STT daemons (mlx, whisper-server).
 *
 * A probe that does not answer in time is NOT evidence that the daemon died.
 * On 2026-09-28 the machine sat at load ~250 and the server's own event loop
 * lagged by seconds: a 2s probe to a healthy mlx daemon "timed out", the engine
 * retired it, adopted it again while it was exiting, and the dictation in
 * flight came back `fetch failed`. The next one waited out a 54s cold model
 * load behind a 20s client timeout. Death has a clear signature on loopback:
 * nothing accepts the connection. Everything else gets a patient second look.
 */

import { connect } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { log } from '../../logging/index.js';

export type DaemonProbe =
  /** Answered 2xx. */
  | 'ok'
  /** Nothing accepted the connection, or the listener dropped it: gone or going. */
  | 'refused'
  /** Something holds the port but did not answer in time (busy, or we are lagging). */
  | 'unresponsive'
  /** Answered, but not 2xx. */
  | 'bad-status';

/** The quick probe on every request. */
export const QUICK_PROBE_MS = 2_000;
/** The second look before a daemon that did not answer quickly is declared dead. */
export const PATIENT_PROBE_MS = 15_000;

export async function probeDaemon(port: number, timeoutMs: number): Promise<DaemonProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    // Drain the body so the socket is released now, not when GC gets to it.
    await res.arrayBuffer().catch(() => {});
    return res.ok ? 'ok' : 'bad-status';
  } catch (err) {
    return isDaemonConnectionLost(err) ? 'refused' : 'unresponsive';
  }
}

/**
 * Probe quickly, and when the port is held but silent, look again with a long
 * timeout before giving up on it. `isBusy` short-circuits that second look to
 * 'busy' when the caller knows the daemon is working on something (a request
 * in flight, or one abandoned but still generating), since a busy daemon can
 * miss a probe and must never be killed for it.
 */
export async function probeDaemonPatiently(
  port: number,
  opts: { isBusy?: () => boolean; onSlow?: () => void } = {},
): Promise<DaemonProbe | 'busy'> {
  const quick = await probeDaemon(port, QUICK_PROBE_MS);
  if (quick !== 'unresponsive') return quick;
  if (opts.isBusy?.()) return 'busy';
  opts.onSlow?.();
  return probeDaemon(port, PATIENT_PROBE_MS);
}

/**
 * Which walnut daemon, if any, is on `port`: ours (adopt it), a walnut daemon
 * for another model (retire it, then spawn), nothing (spawn), or foreign
 * (anything else, including a listener that answers nothing even to a patient
 * probe: leave it be). A slow answer is not "nothing there": spawning onto a
 * held port loads the whole model only to fail the bind.
 */
export async function identifyWalnutDaemon(port: number, model: string): Promise<'ours' | 'other-model' | 'none' | 'foreign'> {
  for (const timeoutMs of [QUICK_PROBE_MS, PATIENT_PROBE_MS]) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (isConnectionRefused(err)) return 'none';
      continue; // held but silent (or dropping us on its way out): one patient look
    }
    if (!res.ok) return 'foreign';
    try {
      const json = await res.json() as { status?: string; model?: string };
      if (json.status !== 'ok' || !json.model) return 'foreign';
      return json.model === model ? 'ours' : 'other-model';
    } catch {
      return 'foreign';
    }
  }
  return 'foreign';
}

/** True when a fetch failed because nothing accepted the connection. */
export function isConnectionRefused(err: unknown): boolean {
  return errorCodes(err).includes('ECONNREFUSED');
}

/**
 * True when a request to the daemon failed at the connection level before any
 * response arrived (refused, or the peer went away mid-request). A timeout is
 * NOT one of these: the daemon may still be working on it.
 */
export function isDaemonConnectionLost(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return false;
  const codes = errorCodes(err);
  return codes.some(c => c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EPIPE' || c === 'UND_ERR_SOCKET');
}

/**
 * Resolves true once nothing accepts a connection on `port`, false if it is
 * still bound at the deadline. A plain TCP connect, not an HTTP probe: a daemon
 * on its way out can still accept and then drop, and that port is not free yet.
 */
export async function waitForPortReleased(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const accepted = await new Promise<boolean>((resolve) => {
      const sock = connect({ port, host: '127.0.0.1' });
      sock.setTimeout(500, () => { sock.destroy(); resolve(true); });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (!accepted) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/** Error codes along the cause chain (undici wraps the socket error in `cause`). */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * Retire a daemon judged dead (or for another model) and wait until its port
 * is free. Without the wait, a restart's own probe finds the daemon still
 * answering in the moment before it exits, adopts it, and sends the next
 * request into a process on its way out (`fetch failed`, 2026-09-28). A daemon
 * we spawned gets a signal; an adopted one (no handle) gets an HTTP shutdown.
 */
export async function retireDaemon(proc: ChildProcess | null, port: number, label: string): Promise<void> {
  if (proc) {
    log.stt.info(`Killing ${label} (pid=${proc.pid})`);
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
  } else {
    log.stt.info(`Shutting down adopted ${label} on :${port}`);
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST', signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
  if (!(await waitForPortReleased(port, 5_000))) {
    log.stt.warn(`${label} on :${port} still holds the port after shutdown`);
  }
}
