/**
 * Every message set aside or voided unsent tells its sender, and the delivery ledger says it did
 * (`told`). 2026-11-26, the Reflection VP's audit: a peer's ask to a task whose host refused it
 * (host_runs_sessions_off) was parked, then retired an hour later, and its sender (the Walnut VP)
 * was never told and told the user something that had not happened; a held note dropped for a
 * completed task told nobody either.
 *
 * One place, so no way of parking or dropping can skip it: the ledger's own step observer
 * (delivery-ledger.ts recordDelivery), which every park, drop, removal and cancel reaches, from this
 * server's queue (session-queue-exits.ts, the queue file's one writer) or a host's channel fact.
 * What each step means for a sender is named for every step (STEP_MEANING: a new step fails
 * tests/core/sessions/undelivered-tell-ratchet.test.ts until it is named):
 *   set-aside  `parked`: told at once (once per message), with what comes next: Walnut tries it
 *              again by itself, it waits for its folder or host, or a person must retry it. A hold on
 *              its own clock (`via: wait`: a turn's end, a cold wake, a prompt, a slow host) and a
 *              park on a gone folder that comes back by itself are told only if still set aside
 *              WAIT_TELL_MS later (2026-11-24: a 21-second folder wait told "not delivered" made its
 *              sender resend).
 *   voided     `dropped`, `removed`, `cancelled`: told at once, "not delivered, and it will not be".
 *              A note the hold dropped itself (`via: hold`) is told by the hold (held-notices.ts
 *              dropParts), never twice.
 * A message's sender is its `sent` or `held` step's session; the notes that rode it (`carried`)
 * share its fate, and their senders are told too. A peer's ask with an open request is answered
 * through the request (its asker's notice: session-request-notify.ts), never a second notice: a
 * void settles it as not delivered; a park on this server's queue for a reason that proves it never
 * ran is answered where it parks (session-queue-park.ts logParked, notifyParkedRequests). A person's
 * and Walnut's own messages have no session to tell; their steps are in the ledger.
 *
 * The tell is the hold's sender notice (held-notices-sweep.ts flushDropTells): one per sender,
 * riding its next message and going on its own past the max hold, kept on disk until told. Runs on
 * the primary only (the ledger does).
 */
import { log } from '../../logging/index.js';
import { homeWritesStopped } from '../../lib/leader-clocks.js';
import type { DeliveryLine, DeliveryStep } from './delivery-ledger.js';

/** What each ledger step means for a message's sender. */
export const STEP_MEANING: Readonly<Record<DeliveryStep, 'on-its-way' | 'delivered' | 'set-aside' | 'voided' | 'bookkeeping'>> = {
  sent: 'on-its-way', held: 'on-its-way', queued: 'on-its-way', carried: 'on-its-way',
  // A batch failure that parks is recorded `parked`; one that is not puts the rows back in line.
  failed: 'on-its-way',
  written: 'delivered', read: 'delivered',
  parked: 'set-aside',
  dropped: 'voided', removed: 'voided', cancelled: 'voided',
  told: 'bookkeeping', server_start: 'bookkeeping',
};

/** A hold that goes by itself, or a gone folder's park, still set aside this long later tells its sender. */
export const WAIT_TELL_MS = 70 * 60_000;
const SWEEP_MS = 5 * 60_000;
/** The ledger days read back at boot: what was sent, told and still set aside before a restart. */
const LOAD_DAYS = 2;
const KNOWN_MAX = 30_000;

interface Known {
  /** The step that names its sender (`sent`, or `held` for a note). */
  origin?: DeliveryLine;
  /** Its newest step that says where it is (not `sent`, not bookkeeping). */
  last?: DeliveryLine;
  /** Written or read: it reached its session, so a later exit is no "not delivered". */
  delivered?: true;
  /** Its sender was told of a park / a void. */
  toldPark?: true;
  toldVoid?: true;
  /** Its ask was answered "not delivered yet" (a park the clock retries): a void must say it after all. */
  requestYet?: true;
  /** Held notes that rode it. */
  riders?: Set<string>;
}

const known = new Map<string, Known>();
/** Parks told only if they last (a hold, a folder wait): id → its park step. */
const waits = new Map<string, DeliveryLine>();
let loaded: Promise<void> | null = null;
let chain: Promise<unknown> = Promise.resolve();
let sweep: ReturnType<typeof setInterval> | null = null;

function entry(id: string): Known {
  let k = known.get(id);
  if (!k) {
    if (known.size >= KNOWN_MAX) {
      // The oldest that is not still set aside (a long park keeps its sender to tell at its void).
      for (const [old, v] of known) if (v.last?.step !== 'parked') { known.delete(old); break; }
      if (known.size >= KNOWN_MAX) known.delete(known.keys().next().value!);
    }
    k = {};
    known.set(id, k);
  }
  return k;
}

/** Keep what a step says of its message (pure but for the index). */
function index(l: DeliveryLine): void {
  if (l.step === 'server_start') return;
  if (l.step === 'carried') {
    if (l.id) {
      const k = entry(l.id);
      k.riders = new Set([...(k.riders ?? []), ...(l.ids ?? [])]);
    }
    return;
  }
  const ids = l.step === 'read' && l.ids?.length ? l.ids : l.id ? [l.id] : [];
  for (const id of ids) {
    const k = entry(id);
    if ((l.step === 'sent' || l.step === 'held') && !k.origin) k.origin = l;
    if (l.step === 'told') {
      if (l.via === 'void') k.toldVoid = true;
      else k.toldPark = true;
      if (l.via === 'request' && /not delivered yet/.test(l.why ?? '')) k.requestYet = true;
      continue;
    }
    if (STEP_MEANING[l.step] === 'delivered') k.delivered = true;
    // `sent` names who sent it, never where it is (as the ledger's own state reads it).
    if (l.step !== 'sent' && (!k.last || k.last.at <= l.at)) k.last = l;
  }
}

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const [{ readDeliveryLines }, { PARK_WAIT_VIA }] = await Promise.all([import('./delivery-ledger.js'), import('../session-queue-exits.js')]);
      const lines = await readDeliveryLines(LOAD_DAYS).catch(() => [] as DeliveryLine[]);
      for (const l of lines) index(l);
      // A hold that went by itself waits on: told if it still waits WAIT_TELL_MS after it began. Only
      // holds (`via: wait`): any other park was told when it was recorded, and one older than this
      // teller is not told now as if it were new (sweepWaits looks at the row first too).
      for (const [id, k] of known) if (k.last?.step === 'parked' && k.last.via === PARK_WAIT_VIA && !k.toldPark && !k.delivered) waits.set(id, k.last);
    })().catch(() => {});
  }
  return loaded;
}

/** The ledger's step observer (installed by startDeliveryLedger). Never throws; steps are handled in order. */
export function observeDeliveryStep(line: DeliveryLine): void {
  chain = chain.then(async () => {
    await load();
    const hadOrigin = !!(line.id && known.get(line.id)?.origin);
    index(line);
    await act(line, hadOrigin);
  }).catch((err) => log.session.warn('undelivered tell: a step could not be handled', {
    step: line.step, messageId: line.id, error: err instanceof Error ? err.message : String(err),
  }));
}

/** Take back the tells that a message is not delivered yet: it was delivered, or a void says what became of it. */
async function forgetNotYet(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const [{ forgetWaitingTells }, store] = await Promise.all([import('./held-notices.js'), import('./held-notices-store.js')]);
  const held = forgetWaitingTells(ids);
  const queued = store.forgetQueuedTells(ids);
  if (held || queued) await store.persist();
}

async function act(line: DeliveryLine, hadOrigin = true): Promise<void> {
  const meaning = STEP_MEANING[line.step];
  // Its sender's step came after it was set aside or voided (the send records `sent` once it returns).
  if ((line.step === 'sent' || line.step === 'held') && line.id && !hadOrigin) {
    const last = known.get(line.id)?.last;
    if (last && last !== line && (STEP_MEANING[last.step] === 'voided' || STEP_MEANING[last.step] === 'set-aside')) await act(last);
    return;
  }
  if (meaning === 'delivered' || line.step === 'queued') {
    const ids = line.ids?.length ? line.ids : line.id ? [line.id] : [];
    for (const id of ids) waits.delete(id);
    // A tell that it is not delivered yet, still waiting for its sender, is stale once it is delivered.
    if (meaning === 'delivered') await forgetNotYet(ids);
    return;
  }
  if (!line.id) return;
  if (meaning === 'voided') {
    waits.delete(line.id);
    const { HOLD_DROP_VIA } = await import('./held-notices.js');
    // A note the hold dropped is told there; a message that reached its session is not "not delivered".
    if (line.via === HOLD_DROP_VIA || known.get(line.id)?.delivered) return;
    await forgetNotYet([line.id, ...(known.get(line.id)?.riders ?? [])]);
    await tell(line, 'void');
    return;
  }
  if (meaning !== 'set-aside') return;
  const { PARK_WAIT_VIA } = await import('../session-queue-exits.js');
  const row = await rowHere(line);
  const { waitsForFolderNow } = await import('./folder-wait.js');
  if (line.via === PARK_WAIT_VIA || (row && await waitsForFolderNow(row))) {
    if (!known.get(line.id)?.toldPark) waits.set(line.id, line);
    return;
  }
  await tell(line, 'park', row);
}

type Row = import('../session-queue-store.js').QueuedMessage;

/** The message's row in this server's queue, if it is there. */
async function rowHere(line: DeliveryLine): Promise<Row | undefined> {
  if (!line.sessionId || !line.id) return undefined;
  const { getQueue } = await import('../session-message-queue.js');
  return (await getQueue(line.sessionId).catch(() => [] as Row[])).find((m) => m.id === line.id);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a tell names a message: its title (or id), when it was sent, and to which task. */
function labelOf(id: string, origin: DeliveryLine, line: DeliveryLine): string {
  const what = origin.title ? `"${origin.title}"` : `message ${id}`;
  const when = origin.at ? `, sent ${origin.at.slice(0, 16).replace('T', ' ')} UTC` : '';
  const to = line.taskId ?? origin.taskId;
  return `${what}${when}${to ? ` to task ${to}` : ''}`;
}

/** What comes next for a parked message, in the words its sender reads. */
async function nextOfPark(row: Row | undefined, waited: boolean): Promise<string> {
  if (waited) return 'it goes by itself once that clears; do not send it again';
  if (!row) return 'do not send it again yet';
  if (row.waitsFor) return 'Walnut sends it by itself once that host can run the agent; do not send it again';
  const { parkRetriedByClock } = await import('./delivery-retry.js');
  if (await parkRetriedByClock(row).catch(() => false)) return 'Walnut tries it again by itself; do not send it again';
  return 'it stays set aside until a person retries it in that task; send it again if it still matters';
}

/** The words of a void: a Stop's cancel handed the text back to the person, who decides. */
function voidWords(line: DeliveryLine, why: string): string {
  if (line.step === 'cancelled') return `not delivered: ${why}; its text went back to the person who stopped it, so do not send it again unless asked`;
  return `not delivered, and it will not be: ${why}`;
}

/**
 * Tell the senders of `line`'s message, and of the notes that rode it, that it was set aside
 * (`park`, `wait`) or voided. Once per message and kind, marked only once its sender is known
 * (a `sent` step that comes later tells then: act); each tell recorded `told`.
 */
async function tell(line: DeliveryLine, kind: 'park' | 'wait' | 'void', row?: Row, now = Date.now()): Promise<void> {
  const id = line.id!;
  const k = entry(id);
  const flag = kind === 'void' ? 'toldVoid' : 'toldPark';
  if (k[flag]) return;
  const why = (line.why || (kind === 'void' ? 'it left the queue unsent' : 'it was set aside')).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').slice(0, 200);
  const minutes = kind === 'wait' ? Math.round((now - Date.parse(line.at)) / 60_000) : 0;
  const words = kind === 'void'
    ? voidWords(line, why)
    : `${minutes ? `still not delivered after ${minutes} minutes` : 'not delivered yet'}: ${why}; ${await nextOfPark(row, kind === 'wait')}`;
  const subjects: Array<{ mid: string; rode?: string }> = [{ mid: id }, ...[...(k.riders ?? [])].map((mid) => ({ mid, rode: id }))];
  const [{ queueTell, recordFate }, { flushTellsSoon }, { recordDelivery }] = await Promise.all([
    import('./held-notices-store.js'), import('./held-notices.js'), import('./delivery-ledger.js'),
  ]);
  let queued = 0;
  for (const s of subjects) {
    const sk = entry(s.mid);
    const origin = sk.origin;
    if (!origin) continue;
    if (s.rode && kind === 'void') {
      // A note that rode it shares its fate (op_result reads the note's).
      recordFate(s.mid, { state: 'dropped', at: now, sid: line.sessionId ?? '', why: `it rode message ${id}, which was not delivered: ${why}` });
    }
    if (sk[flag]) continue;
    // Its sender is known now: whatever comes of it below, it is not looked at again.
    sk[flag] = true;
    const from = origin.from;
    if (!from || !SESSION_ID.test(from) || from === line.sessionId) continue;
    const said = s.rode ? `it rode message ${id}, which is ${words}` : words;
    if (!s.rode && origin.requestId && await answeredByRequest(origin.requestId, line, kind, why, sk, row)) continue;
    queueTell({
      kind: kind === 'void' ? 'dropped' : 'waiting', subject: 'message', callerSid: from, op: 'task_send',
      taskId: line.taskId ?? origin.taskId ?? '', reason: `${labelOf(s.mid, origin, line)}: ${said}`,
      at: now, tries: 0, mid: s.mid, ...(origin.fromTaskId ? { fromTask: origin.fromTaskId } : {}),
    });
    void recordDelivery({ step: 'told', id: s.mid, ...(line.sessionId ? { sessionId: line.sessionId } : {}), told: from, via: kind, why: said.slice(0, 200) });
    queued++;
  }
  if (queued) {
    log.session.info('undelivered tell: senders told their message was not delivered', { messageId: id, sessionId: line.sessionId, kind, told: queued });
    flushTellsSoon();
  }
}

/**
 * A peer's ask with a request: answered through it, never a second notice. True when the request
 * speaks for the message: a void settles an open one as not delivered, and tells one already
 * answered "not delivered yet" (or past its deadline as still on its way) that it was not after all;
 * a park on this server's queue that proves it never ran is answered where it parked.
 */
async function answeredByRequest(requestId: string, line: DeliveryLine, kind: 'park' | 'wait' | 'void', why: string, k: Known, row?: Row): Promise<boolean> {
  const { getSessionRequest } = await import('../session-requests.js');
  const request = await getSessionRequest(requestId).catch(() => undefined);
  if (!request) return false;
  if (kind === 'void') {
    const notify = await import('./session-request-notify.js');
    let told = false;
    if (request.status === 'pending') told = await notify.notifyRequesterFallback(request, 'error', { notDelivered: why });
    else if (request.status === 'expired' || (request.status === 'notified' && k.requestYet)) told = await notify.notifyFolderWaitEnded(request, why);
    // Answered by its target, withdrawn, or already told it was not delivered: nothing more to say.
    else return true;
    if (told) {
      const { recordDelivery } = await import('./delivery-ledger.js');
      void recordDelivery({ step: 'told', id: line.id!, ...(line.sessionId ? { sessionId: line.sessionId } : {}), told: request.fromSessionId, via: 'void', why: `its request ${requestId} was answered: not delivered: ${why}`.slice(0, 200) });
    }
    return true;
  }
  if (request.status !== 'pending') return true;
  const { parkAnsweredByRequest } = await import('./undelivered-requests.js');
  // Parked on this server's queue and answered where it parked (notifyParkedRequests).
  // The park's own reason is this step's (the row may have moved on since: a retry put it back in line).
  return !!row && parkAnsweredByRequest({ message: row.message, parkedReason: line.why ?? row.parkedReason }, requestId);
}

/** Parks that waited past WAIT_TELL_MS and are still set aside tell their senders. Returns how many. */
export async function sweepWaits(now = Date.now()): Promise<number> {
  await load();
  let told = 0;
  const { judgedHere } = await import('./judge-of.js');
  for (const [id, line] of [...waits]) {
    if (now - Date.parse(line.at) < WAIT_TELL_MS) continue;
    waits.delete(id);
    const k = known.get(id);
    if (k?.last?.step !== 'parked' || k.toldPark || k.delivered) continue;
    // Still set aside where it waits: its row here is still parked, or its queue is a host's.
    const row = await rowHere(line);
    if (row ? row.status !== 'parked' : (!!line.sessionId && judgedHere(line.sessionId))) continue;
    await tell({ ...line, at: k.last.at }, 'wait', row, now).catch(() => {});
    told++;
  }
  return told;
}

/** Start the waits' lap (startDeliveryLedger); returns its stop. */
export function startUndeliveredTell(): () => void {
  void load();
  if (!sweep) {
    // A tell writes the held-notices file and the ledger: never once a leader switch's stop began.
    sweep = setInterval(() => { if (homeWritesStopped()) return; chain = chain.then(() => sweepWaits()).catch(() => {}); }, SWEEP_MS);
    sweep.unref?.();
  }
  return () => {
    if (sweep) clearInterval(sweep);
    sweep = null;
  };
}

/** For tests: wait for the steps handled so far. */
export function _settledForTesting(): Promise<unknown> {
  return chain;
}

export function _resetUndeliveredTellForTesting(): void {
  known.clear();
  waits.clear();
  loaded = null;
  chain = Promise.resolve();
  if (sweep) clearInterval(sweep);
  sweep = null;
}
