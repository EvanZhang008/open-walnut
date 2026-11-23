/**
 * Where each message to a session got to, one line per step, kept 14 days
 * (WALNUT_HOME/cache/delivery-ledger/<UTC date>.ndjson; 2026-11-23, the Reflection VP's audit: "delivered"
 * meant only that the server took a message, and finding one lost message took a read of 650 MB of
 * logs). An auditor reads a message's steps with `GET /api/v1/delivery` (by id, task or session).
 *
 * Steps: `sent` (a session's or the user's send, with who sent it), `held` (a note that asks nothing,
 * waiting for the target's next message: held-notices-store.ts keeps it on disk, so a restart keeps
 * it), `carried` (held notes that rode the queue row named), `dropped` (a held note the hold let go
 * unsent, with why), `queued` (a row in the session's queue), `parked` (held back, with why),
 * `written` (in the CLI's input), `read` (the CLI started the line), `failed`, `cancelled`, and
 * `server_start` (where the server restarted, for reading a trail).
 *
 * Only ids, sessions, tasks, sources and a title: never a message's text. Best effort: a write that
 * fails is logged and never fails a send; one append chain keeps the order.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { eventData } from '../event-types.js';

export const DELIVERY_LEDGER_DIR = (): string => path.join(WALNUT_HOME, 'cache', 'delivery-ledger');
export const DELIVERY_KEEP_DAYS = 14;

export type DeliveryStep = 'sent' | 'held' | 'carried' | 'dropped' | 'queued' | 'parked' | 'written' | 'read' | 'failed' | 'cancelled' | 'server_start';

export interface DeliveryLine {
  at: string;
  step: DeliveryStep;
  /** The message id (a queue row's, or a held note's, which op_result reads too); absent on server_start. */
  id?: string;
  sessionId?: string;
  taskId?: string;
  /** sent: who sent it (a session id, `person`, an app or automation label) and its task. */
  from?: string;
  fromTaskId?: string;
  source?: string;
  title?: string;
  /** carried: the held notes the row `id` carried. read: the queue rows the line carried. */
  ids?: string[];
  /** read: the CLI line's uuid. */
  lineUuid?: string;
  /** parked, failed: why. */
  why?: string;
  requestId?: string;
}

const fileOf = (at: string) => path.join(DELIVERY_LEDGER_DIR(), `${at.slice(0, 10)}.ndjson`);
let chain: Promise<unknown> = Promise.resolve();

/** Append one step. Never throws; resolves once it is written (tests await it). */
export function recordDelivery(line: Omit<DeliveryLine, 'at'> & { at?: string }): Promise<unknown> {
  const row: DeliveryLine = { at: line.at ?? new Date().toISOString(), ...line } as DeliveryLine;
  if (row.title) row.title = row.title.replace(/\s+/g, ' ').slice(0, 120);
  chain = chain.then(async () => {
    await fsp.mkdir(DELIVERY_LEDGER_DIR(), { recursive: true });
    await fsp.appendFile(fileOf(row.at), `${JSON.stringify(row)}\n`, 'utf-8');
  }).catch((err) => log.session.warn('delivery ledger: a step was not recorded', { step: row.step, id: row.id, error: err instanceof Error ? err.message : String(err) }));
  return chain;
}

export function onDeliveryEvent(event: BusEvent): Promise<unknown> | undefined {
  switch (event.name) {
    case EventNames.SESSION_MESSAGE_QUEUED: {
      const d = eventData<'session:message-queued'>(event);
      return recordDelivery({ step: 'queued', id: d.messageId, sessionId: d.sessionId, ...(d.source ? { source: d.source } : {}) });
    }
    case EventNames.SESSION_MESSAGES_DELIVERED: {
      const d = eventData<'session:messages-delivered'>(event);
      return Promise.all((d.messageIds ?? []).map((id) => recordDelivery({ step: 'written', id, sessionId: d.sessionId })));
    }
    case EventNames.SESSION_USER_LINE: {
      const d = eventData<'session:user-line'>(event);
      return recordDelivery({ step: 'read', sessionId: d.sessionId, lineUuid: d.uuid, ...(d.taskId ? { taskId: d.taskId } : {}), ...(d.rowIds?.length ? { ids: d.rowIds } : {}) });
    }
    case EventNames.SESSION_BATCH_FAILED: {
      const d = eventData<'session:batch-failed'>(event);
      return Promise.all(d.messageIds.map((id) => recordDelivery({ step: d.parked ? 'parked' : 'failed', id, sessionId: d.sessionId, why: d.error.slice(0, 200) })));
    }
    case EventNames.SESSION_DELIVERY_HELD: {
      const d = eventData<'session:delivery-held'>(event);
      return Promise.all(d.messageIds.map((id) => recordDelivery({ step: 'parked', id, sessionId: d.sessionId, why: d.reason.slice(0, 200) })));
    }
    case EventNames.SESSION_QUEUED_CANCELLED: {
      const d = eventData<'session:queued-cancelled'>(event);
      return Promise.all(d.messageIds.map((id) => recordDelivery({ step: 'cancelled', id, sessionId: d.sessionId })));
    }
    default:
      return undefined;
  }
}

const SUBSCRIBER = 'delivery-ledger';

/** Every emitter of these events is covered by construction (as request-reached.ts). Prunes old days. */
export function startDeliveryLedger(): { stop: () => void } {
  void recordDelivery({ step: 'server_start' });
  void pruneDeliveryLedger();
  bus.subscribe(SUBSCRIBER, (event) => { void onDeliveryEvent(event); }, {
    global: true,
    interest: [EventNames.SESSION_MESSAGE_QUEUED, EventNames.SESSION_MESSAGES_DELIVERED, EventNames.SESSION_USER_LINE,
      EventNames.SESSION_BATCH_FAILED, EventNames.SESSION_DELIVERY_HELD, EventNames.SESSION_QUEUED_CANCELLED],
  });
  return { stop: () => bus.unsubscribe(SUBSCRIBER) };
}

export async function pruneDeliveryLedger(nowMs = Date.now()): Promise<void> {
  const keep = new Date(nowMs - DELIVERY_KEEP_DAYS * 24 * 3600_000).toISOString().slice(0, 10);
  const names = await fsp.readdir(DELIVERY_LEDGER_DIR()).catch(() => [] as string[]);
  for (const n of names) if (/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n) && n.slice(0, 10) < keep) await fsp.rm(path.join(DELIVERY_LEDGER_DIR(), n), { force: true });
}

export type DeliveryState = 'read' | 'written' | 'queued' | 'parked' | 'held' | 'carried' | 'dropped' | 'failed' | 'cancelled' | 'sent';

export interface DeliveryTrail {
  id: string; state: DeliveryState; sessionId?: string; taskId?: string; from?: string; title?: string;
  /** A held note: the message that carried it (its state is that message's). */
  carriedBy?: string;
  /** Still waiting (held, parked, queued): minutes since the step it waits at, when the reader passed a clock. */
  waitingMin?: number;
  steps: DeliveryLine[];
}

/** Where one message's own steps got it to (a held note's carrier aside): read stays, else its last step. Pure. */
function stateOf(steps: readonly DeliveryLine[]): DeliveryState {
  if (steps.some((s) => s.step === 'read')) return 'read';
  const last = [...steps].reverse().find((s) => s.step !== 'sent');
  return last ? (last.step as DeliveryState) : 'sent';
}

/**
 * Each message's steps and where it got to, from the ledger's lines (oldest first): read once the CLI
 * started a line carrying it, written once it is in the CLI's input; a held note is where the queue row
 * that carried it is. Pure.
 */
export function trailsOf(lines: readonly DeliveryLine[], nowMs?: number): DeliveryTrail[] {
  const by = new Map<string, DeliveryLine[]>();
  const add = (id: string, l: DeliveryLine) => by.set(id, [...(by.get(id) ?? []), l]);
  const carrierOf = new Map<string, string>();
  for (const l of lines) {
    if (l.step === 'server_start') continue;
    if (l.step === 'read') { for (const id of l.ids ?? []) add(id, l); continue; }
    if (l.step === 'carried') { for (const id of l.ids ?? []) { add(id, l); if (l.id) carrierOf.set(id, l.id); } continue; }
    if (l.id) add(l.id, l);
  }
  const own = new Map([...by.entries()].map(([id, steps]) => [id, stateOf(steps)]));
  return [...by.entries()].map(([id, steps]) => {
    const first = steps.find((s) => s.step === 'sent') ?? steps[0];
    const carriedBy = carrierOf.get(id);
    // A carrier with no steps of its own here (a row the ledger missed) reads as carried.
    const state = carriedBy ? own.get(carriedBy) ?? 'carried' : own.get(id)!;
    const sessionId = steps.find((s) => s.sessionId)?.sessionId;
    const taskId = steps.find((s) => s.taskId)?.taskId;
    const waitsAt = state === 'held' || state === 'parked' || state === 'queued' ? [...steps].reverse().find((s) => s.step === state)?.at : undefined;
    const waitingMin = nowMs !== undefined && waitsAt ? Math.max(0, Math.round((nowMs - Date.parse(waitsAt)) / 60_000)) : undefined;
    return {
      id, state, ...(waitingMin !== undefined ? { waitingMin } : {}), ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}), ...(first.from ? { from: first.from } : {}),
      ...(first.title ? { title: first.title } : {}), ...(carriedBy ? { carriedBy } : {}), steps,
    };
  });
}

/** The ledger's lines of the last `days` days (oldest first), each line parsed; bad lines skipped. */
export async function readDeliveryLines(days = 3, nowMs = Date.now()): Promise<DeliveryLine[]> {
  const out: DeliveryLine[] = [];
  for (let i = Math.min(days, DELIVERY_KEEP_DAYS) - 1; i >= 0; i--) {
    const day = new Date(nowMs - i * 24 * 3600_000).toISOString().slice(0, 10);
    const raw = await fsp.readFile(path.join(DELIVERY_LEDGER_DIR(), `${day}.ndjson`), 'utf-8').catch(() => '');
    let n = 0;
    for (const t of raw.split('\n')) {
      if (!t.trim()) continue;
      try { out.push(JSON.parse(t) as DeliveryLine); } catch { /* a torn last line */ }
      // Never a long parse on the event loop: other requests go between chunks.
      if (++n % 500 === 0) await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}
