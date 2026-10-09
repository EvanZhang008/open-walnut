/**
 * Cloud REPLICA: deliver one phone message straight to the session's host
 * daemon over THAT host's own bridge, without the primary.
 *
 * The normal path is the `session.message` relay: host daemon → the primary's
 * durable queue. This one exists for the window where the host is on the
 * companion's bridge but no primary is behind it (the Mac is offline, or the
 * Mac cannot reach the host: the host daemon then answers "no primary server
 * connected" at once, having forwarded nothing). Two callers, one behavior:
 * the send route (core of the old cloudSendDirect) and the send-queue sweep,
 * which delivers a banked send this way when the host comes back before the
 * primary does.
 *
 * Marker and delivery are one step when the host's daemon can do it
 * (send-markers-v1, which its `status` reply says): the marker goes with the
 * send and is written after the body enters the pipe and before the line's
 * newline, so a marker in the stream proves the CLI got the line and no marker
 * proves it never did. That closes the residual window (gate r3, N1) for the
 * live path: a companion that dies mid-delivery can learn the truth from the
 * host and send again what never arrived. An older daemon, and the resume path
 * (the message is the respawned CLI's first stdin line), keep the loss-safe
 * order: deliver FIRST, append the marker only after the daemon confirmed
 * delivery (the old marker-first order produced ghost user bubbles), so no
 * marker there proves nothing and such a message is never sent twice.
 *
 * Never call this for a message the primary may already hold: the primary's
 * queue would deliver it again (send-direct-gate.ts decides).
 *
 * Crash safety (gate r2, B3): the intent is written durably BEFORE the first
 * request that can start a turn, and cleared only when the host answered that
 * no turn started. A companion that dies in between leaves the intent on disk;
 * the next pass asks the host instead of sending it again (send-direct-gate.ts
 * resolveDirectIntent). While a delivery runs here, the sweep leaves its row
 * alone (directSendRunning).
 */

import { log } from '../../logging/index.js';

export type DirectSendOutcome =
  | { ok: true; path: 'live' | 'resumed'; pid?: number }
  /** The host answered: this message will not run (a stop fence, or a session it cannot resume). */
  | { ok: false; kind: 'refused'; status: 409; code: 'session_stopped' | 'session_dead'; message: string }
  /**
   * The host could not be asked. `offline`: no bridge socket, nothing was sent.
   * `ambiguous`: a delivery request went out and its answer was lost, so the
   * message MAY have reached the CLI (never send it again without proof).
   */
  | { ok: false; kind: 'transport'; offline: boolean; ambiguous: boolean; message: string };

export interface DirectSendInput {
  host: string;
  sessionId: string;
  text: string;
  messageId: string;
  stopFence: string | null;
  /** Resume hints for a host whose daemon lost the session's record. */
  cwd?: string;
  model?: string;
  /** Poll for a just-launched spawn (the route's case; the sweep has none). */
  waitForLaunch?: boolean;
  /** When the phone's send reached the companion (ms): a stop asked for after it does not hold it back. */
  acceptedAt?: number;
}

const SPAWN_POLL_MS = 1_000;
const SPAWN_WAIT_MAX_MS = 20_000;

/** Direct deliveries running in this process, by messageId. */
const running = new Set<string>();

export function directSendRunning(messageId: string): boolean {
  return running.has(messageId);
}

/** Tests only: a restarted process remembers no running delivery (what is on disk stays). */
export function forgetRunningDirectSends(): void {
  running.clear();
}

/**
 * A stop the companion knows of overtook this message (cloud-stop-fence.ts).
 * Checked right before each request that can start the turn: this path never
 * passes the primary, whose queue would otherwise refuse it, and the host may
 * not know of the stop either (the primary could not deliver it).
 */
async function overtakenByStop(input: DirectSendInput): Promise<DirectSendOutcome | null> {
  const { stopSupersedes } = await import('./cloud-stop-fence.js');
  const why = await stopSupersedes(input.sessionId, input.stopFence, input.acceptedAt ?? Date.now());
  if (!why) return null;
  log.web.info('direct send refused: a later stop overtook the message', { sessionId: input.sessionId, messageId: input.messageId });
  return { ok: false, kind: 'refused', status: 409, code: 'session_stopped', message: why };
}

export async function deliverDirectToHost(input: DirectSendInput): Promise<DirectSendOutcome> {
  if (running.has(input.messageId)) {
    return { ok: false, kind: 'transport', offline: false, ambiguous: false, message: 'a delivery of it is already running' };
  }
  running.add(input.messageId);
  try {
    return await deliverOnce(input);
  } finally {
    running.delete(input.messageId);
  }
}

async function deliverOnce(input: DirectSendInput): Promise<DirectSendOutcome> {
  const { host, sessionId, text, messageId, stopFence } = input;
  const { bridgeRequest, BridgeOfflineError } = await import('../../web/ws/bridge-registry.js');
  const { markDirectIntent, clearDirectIntent } = await import('../send-outcomes.js');
  const stopped = await overtakenByStop(input);
  if (stopped) return stopped;
  // `delivering` = a request that can start the turn is out (send / bridgeResume).
  let delivering = false;
  /** The intent goes to disk first; a delivery that provably never started takes it back. */
  const startDelivering = async (ordered = false): Promise<void> => {
    await markDirectIntent(sessionId, messageId, { ordered });
    delivering = true;
  };
  const notStarted = async <T extends DirectSendOutcome>(outcome: T): Promise<T> => {
    await clearDirectIntent(sessionId, messageId);
    return outcome;
  };
  try {
    // Liveness precheck: a gone CLI (dead record, or a record the daemon lost)
    // gets a bridgeResume instead of a 409.
    let status = await bridgeRequest(host, 'status', { sid: sessionId });
    // Just-launched race (caught by the live suite, 2026-08-07): the spawn on the
    // primary is ASYNC, so a send fired right after the 201 finds no session yet
    // and the daemon rightly refuses a resume (no jsonl). While the launch seed is
    // fresh, poll for the spawn instead of declaring death.
    if (status.exists !== true && input.waitForLaunch) {
      const { getLaunchSeed } = await import('./launch-seed.js');
      if (getLaunchSeed(sessionId)) {
        const deadline = Date.now() + SPAWN_WAIT_MAX_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
          status = await bridgeRequest(host, 'status', { sid: sessionId });
          if (status.exists === true) break;
        }
        log.web.info('mobile send waited for just-launched spawn', { sessionId, host, spawned: status.exists === true });
      }
    }
    // The launch wait above can take seconds: look again.
    const stoppedSince = input.waitForLaunch ? await overtakenByStop(input) : null;
    if (stoppedSince) return stoppedSince;
    if (status.exists === true && status.alive === true) {
      // send-markers-v1: the marker is written inside the delivery (see the header).
      const ordered = status.sendMarkers === true;
      await startDelivering(ordered);
      const sent = await bridgeRequest(host, 'send', {
        sid: sessionId, message: text, stopFence, ...(ordered ? { markers: [{ message: text, messageId }] } : {}),
      });
      if (sent.ok !== true) {
        const reason = String(sent.reason ?? sent.error ?? 'unknown');
        if (reason === 'session_stopped') {
          return notStarted({ ok: false, kind: 'refused', status: 409, code: 'session_stopped', message: 'Message predates the latest stop; send a new message to continue' });
        }
        if (reason === 'ENXIO' || reason === 'session_dead' || reason === 'not_found') {
          return notStarted({ ok: false, kind: 'refused', status: 409, code: 'session_dead', message: 'Session process died mid-send' });
        }
        // The daemon answered, and did not write the line.
        return notStarted({ ok: false, kind: 'transport', offline: false, ambiguous: false, message: `Send failed: ${reason}` });
      }
      if (!ordered) await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId }).catch(() => {});
      log.web.info('mobile session send via bridge (direct)', { sessionId, host, messageId, path: 'live' });
      return { ok: true, path: 'live' };
    }
    // Dead or lost: resume. The daemon rebuilds argv from its stored record when it
    // survived, else from the cwd/model hints; the message is the initial stdin
    // line, same as the Mac's --resume spawn path in session-runner.
    await startDelivering();
    const resumed = await bridgeRequest(host, 'bridgeResume', {
      sid: sessionId, message: text, cwd: input.cwd, model: input.model, stopFence,
    }, 30_000);
    if (resumed.reason === 'session_stopped') {
      return notStarted({ ok: false, kind: 'refused', status: 409, code: 'session_stopped', message: 'Message predates the latest stop; send a new message to continue' });
    }
    if (!resumed.pid) {
      return notStarted({ ok: false, kind: 'refused', status: 409, code: 'session_dead', message: String(resumed.error ?? 'resume failed') });
    }
    await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId }).catch(() => {});
    log.web.info('mobile session send via bridge (direct)', { sessionId, host, messageId, path: 'resumed', pid: resumed.pid });
    return { ok: true, path: 'resumed', pid: typeof resumed.pid === 'number' ? resumed.pid : undefined };
  } catch (err) {
    const offline = err instanceof BridgeOfflineError;
    // BridgeOfflineError is raised only when there is no socket to write to, so
    // even mid-sequence it sent nothing: the request that failed never left.
    const outcome: DirectSendOutcome = {
      ok: false, kind: 'transport', offline,
      ambiguous: delivering && !offline,
      message: err instanceof Error ? err.message : String(err),
    };
    // An intent that could not be written: nothing went out.
    return outcome.ambiguous || !delivering ? outcome : notStarted(outcome);
  }
}
