/**
 * Cloud → primary durable queue for session METADATA patches (fast-accept).
 *
 * Mirrors core/task-queue.ts (same offline ladder, same drain triggers) for
 * the `session.control` action 'patch' — the one session mutation that is
 * pure metadata (title / archived / human_note) and therefore safe to accept
 * without the primary answering first. Everything session-runner-touching
 * (mode, model, effort, fork, terminate, restart, retry, permission,
 * execute-continue) stays a SYNCHRONOUS relay by design: those act on a live
 * CLI process whose current state only the primary knows, so a queued "accept"
 * would fabricate a success the runner may refuse (e.g. a mode change on a
 * dead session, a permission answer for a prompt that already resolved).
 *
 * Files: cache/control-queue/<opId>.json (NON-git on both boxes).
 * Contract with the caller (session-lifecycle-v1):
 *   - the phone already got its optimistic 200 — nothing here throws;
 *   - convergence is LWW per arrival: ops flush oldest-first, and the primary
 *     validates each patch at apply time (a patch it refuses — e.g. archive on
 *     a still-running session — is dropped loudly, and the next projection
 *     push shows the truthful state);
 *   - replays are harmless: patchSession is idempotent by value.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, CONTROL_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

export interface QueuedSessionPatch {
  opId: string;
  at: string;
  sessionId: string;
  patch: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_BATCH_MAX = 100;
/** Metadata patch RPC — small payload, no runner work. */
const PATCH_RPC_TIMEOUT_MS = 20_000;

let opSeq = 0;

function mintOpId(): string {
  return `${Date.now().toString().padStart(15, '0')}-${(opSeq++).toString().padStart(4, '0')}`;
}

/**
 * CLOUD box: durably queue one session metadata patch for background delivery.
 * Called AFTER the synchronous relay attempt failed on transport (bridge down
 * / timeout / needs_upgrade) — never as the first choice, so a live bridge
 * still gets authoritative synchronous behavior.
 */
export async function enqueueSessionPatch(sessionId: string, patch: Record<string, unknown>): Promise<string | null> {
  if (!CLOUD_MODE) return null;
  const op: QueuedSessionPatch = {
    opId: mintOpId(), at: new Date().toISOString(), sessionId, patch,
  };
  try {
    await writeJsonFile(path.join(CONTROL_QUEUE_DIR, `${op.opId}.json`), op);
    log.session.info('control-queue: session patch queued (bridge unavailable)', {
      opId: op.opId, sessionId, fields: Object.keys(patch),
    });
    return op.opId;
  } catch (err) {
    log.session.error('control-queue: FAILED to queue session patch — change will not reach primary', {
      sessionId, err: String(err),
    });
    return null;
  }
}

/** Pending queued patches (diagnostics/tests). */
export async function queuedSessionPatchCount(): Promise<number> {
  try {
    return (await fsp.readdir(CONTROL_QUEUE_DIR)).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

let flushing = false;

/**
 * Sweep the queue oldest-first: relay each patch, delete on success OR domain
 * rejection (the primary ran it and refused — an identical retry refuses
 * identically, and the projection push will show the truthful state), keep on
 * transport failure. Single-flight; stops at the first bridge-offline outcome.
 */
export async function flushControlQueue(): Promise<number> {
  if (!CLOUD_MODE || flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let names: string[];
    try {
      names = (await fsp.readdir(CONTROL_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return 0;
    }
    const { callPrimaryControl } = await import('../web/routes/v1-control-relay.js');
    for (const name of names.slice(0, FLUSH_BATCH_MAX)) {
      const file = path.join(CONTROL_QUEUE_DIR, name);
      let op: QueuedSessionPatch;
      try {
        op = JSON.parse(await fsp.readFile(file, 'utf-8')) as QueuedSessionPatch;
        if (!op || !op.opId || !op.sessionId || !op.patch) throw new Error('malformed op');
      } catch (err) {
        log.session.warn('control-queue: unreadable queued patch — removing', { file, err: String(err) });
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const reply = await callPrimaryControl('patch', op.sessionId, op.patch, PATCH_RPC_TIMEOUT_MS);
      if (!reply.ok && (reply.failure.kind === 'bridge_offline' || reply.failure.kind === 'needs_upgrade')) {
        break; // transport-level — the rest would fail the same way
      }
      if (!reply.ok) {
        // Domain rejection: apply-time validation said no. Drop loudly — the
        // next projection push reconciles the phone to the primary's truth.
        log.session.warn('control-queue: primary rejected queued session patch — dropping', {
          opId: op.opId, sessionId: op.sessionId,
          code: reply.failure.kind === 'error' ? reply.failure.code : reply.failure.kind,
          err: reply.failure.message,
        });
      } else {
        log.session.info('control-queue: queued session patch applied on primary', {
          opId: op.opId, sessionId: op.sessionId,
        });
      }
      await fsp.rm(file, { force: true }).catch(() => {});
      sent++;
    }
    return sent;
  } finally {
    flushing = false;
  }
}

/**
 * CLOUD box: start the drain triggers (same trio as task-queue): primary
 * bridge (re)connect, post-enqueue opportunism is the caller's job, and a 60s
 * unref'd floor sweep.
 */
export function startControlQueueFlush(): { stop: () => void } {
  const timer = setInterval(() => { void flushControlQueue(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  let unhook: (() => void) | null = null;
  void (async () => {
    try {
      const { addPrimaryBridgeConnectedHandler } = await import('../web/ws/bridge-registry.js');
      unhook = addPrimaryBridgeConnectedHandler(() => {
        log.session.info('control-queue: primary bridge connected — draining queued session patches');
        void flushControlQueue();
      });
    } catch (err) {
      log.session.warn('control-queue: could not hook the bridge-connected trigger', { err: String(err) });
    }
  })();
  return {
    stop: () => {
      clearInterval(timer);
      unhook?.();
    },
  };
}
