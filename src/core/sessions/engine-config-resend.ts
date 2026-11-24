/**
 * Messages an engine setting held go out by themselves once that setting may have changed.
 *
 *   - A row parked because a setting refused its session's start (a Codex provider that reaches
 *     nothing on the session's host: parked with code `engine_config`, delivery-failure.ts) goes
 *     back in line once after each config change: a change on this server (`config:changed`), or a
 *     new copy of the leader's config on a host (replication/kinds/config.ts onConfigCopyChanged).
 *   - A row left pending because this server had no copy of the leader's settings yet (a
 *     transient refusal, codex-engine-source.ts withCopiedEngines) is sent again when the copy
 *     arrives: its session is noted here by the delivery that was refused.
 *
 * The same way a host turning runnable sends the rows that waited for it (agent-wait-resend.ts):
 * once per change (a row refused again parks again and waits for the next one), never past a
 * Stop (a row whose stop fence is not the session's now stays for the person), never an archived
 * session's, and the session's own delivery (SESSION_SEND) sends them.
 */
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import type { QueuedMessage } from '../session-queue-store.js';

/** The park code of a row a setting held (delivery-failure.ts ENGINE_CONFIG_CODE). */
const ENGINE_CONFIG_CODE = 'engine_config';
const heldBySetting = (m: QueuedMessage): boolean => m.parkedCode === ENGINE_CONFIG_CODE;

/** Sessions whose delivery waits for the first copy of the leader's settings (pending rows). */
const awaitingCopy = new Set<string>();
const AWAITING_MAX = 512;

/** A delivery of `sessionId` was refused until a copy of the leader's settings arrives: its pending rows go then. */
export function noteAwaitingConfigCopy(sessionId: string): void {
  if (awaitingCopy.size >= AWAITING_MAX) awaitingCopy.delete(awaitingCopy.values().next().value as string);
  awaitingCopy.add(sessionId);
}

/** Put every row a setting held back in line, and drive the noted sessions. Returns the sessions sent to. */
export async function resendAfterConfigChange(): Promise<string[]> {
  const { sessionsWithAgentWaitRows, unparkAgentWaitRows } = await import('../session-message-queue.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { sessionStops } = await import('./session-stop.js');
  const sent: string[] = [];
  const drive = (sessionId: string, taskId: string | undefined, why: string, messageIds: string[]): void => {
    sent.push(sessionId);
    log.session.info(why, { sessionId, messageIds });
    bus.emit(EventNames.SESSION_SEND, { sessionId, message: '', ...(taskId ? { taskId } : {}) }, ['session-runner'], { source: 'config-changed' });
  };
  for (const sessionId of await sessionsWithAgentWaitRows(heldBySetting)) {
    try {
      const record = await getSessionByClaudeId(sessionId);
      if (!record || record.archived) continue;
      // A Stop waiting for its host: nothing goes out until it is settled.
      const fence = await sessionStops.fence(sessionId).catch(() => undefined);
      if (fence === undefined) continue;
      const ids = await unparkAgentWaitRows(sessionId, fence, { match: heldBySetting });
      if (ids.length > 0) drive(sessionId, record.taskId, 'the config changed: sending the messages a setting held', ids);
    } catch (err) {
      log.session.warn('sending the messages a setting held failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}

/** A copy of the leader's settings arrived: the noted sessions' pending rows go, then what a setting held. */
export async function resendAfterConfigCopy(): Promise<string[]> {
  const { getQueue } = await import('../session-message-queue.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const noted = [...awaitingCopy];
  awaitingCopy.clear();
  const sent: string[] = [];
  for (const sessionId of noted) {
    try {
      const record = await getSessionByClaudeId(sessionId);
      if (!record || record.archived) continue;
      const pending = (await getQueue(sessionId)).filter((m) => m.status === 'pending').map((m) => m.id);
      if (pending.length === 0) continue;
      sent.push(sessionId);
      log.session.info('the leader\'s settings arrived: sending the messages that waited for them', { sessionId, messageIds: pending });
      bus.emit(EventNames.SESSION_SEND, { sessionId, message: '', ...(record.taskId ? { taskId: record.taskId } : {}) }, ['session-runner'], { source: 'config-copy' });
    } catch (err) {
      log.session.warn('sending the messages that waited for the leader\'s settings failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const sessionId of await resendAfterConfigChange()) if (!sent.includes(sessionId)) sent.push(sessionId);
  return sent;
}

let chain: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let copyArrived = false;
/** Resolves once the pass the waiting timer starts has run (engineConfigResendSettled). */
let scheduled: { promise: Promise<void>; resolve: () => void } | undefined;
/** A config write often comes as a few events: one pass a moment after the last. */
const SETTLE_MS = 500;

function schedule(fromCopy: boolean): void {
  copyArrived ||= fromCopy;
  if (timer) clearTimeout(timer);
  if (!scheduled) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    scheduled = { promise, resolve };
  }
  timer = setTimeout(() => {
    timer = undefined;
    const copy = copyArrived;
    const done = scheduled;
    copyArrived = false;
    scheduled = undefined;
    chain = chain.catch(() => {}).then(() => (copy ? resendAfterConfigCopy() : resendAfterConfigChange()));
    void chain.catch(() => {}).then(() => done?.resolve());
  }, SETTLE_MS);
  timer.unref?.();
}

/** Server wiring: a config change here, and a new copy of the leader's config. Returns an unsubscribe. */
export async function wireEngineConfigResend(): Promise<() => void> {
  const NAME = 'engine-config-resend';
  bus.subscribe(NAME, () => { schedule(false); }, { global: true, interest: [EventNames.CONFIG_CHANGED] });
  const { onConfigCopyChanged } = await import('../replication/kinds/config.js');
  const offCopy = onConfigCopyChanged(() => { schedule(true); });
  return () => { bus.unsubscribe(NAME); offCopy(); if (timer) clearTimeout(timer); timer = undefined; };
}

/** Test seam. */
export function resetEngineConfigResendForTests(): void {
  awaitingCopy.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
  copyArrived = false;
  scheduled?.resolve();
  scheduled = undefined;
  chain = Promise.resolve();
}

/** Test seam: the pass a change starts has run. */
export async function engineConfigResendSettled(): Promise<void> {
  await scheduled?.promise;
  await chain.catch(() => {});
}
