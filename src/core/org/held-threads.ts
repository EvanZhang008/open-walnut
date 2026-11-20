/**
 * The runtime both held-thread kinds share (held-thread-model.ts): a decision letter's thread
 * (human-inbox/letter-threads.ts) and a Board choice's thread (boards/choice-threads.ts).
 *
 * The ledger: which items ever had a thread here (`WALNUT_HOME/org/held-threads.json`). A closed
 * thread is deleted a week after it closed (threads-model.ts prune, the database's dropExpired);
 * without this record the next sync would find no thread for an item still waiting (a choice he
 * dropped, a letter he closed the thread of) and open a second one a week later. An item that had
 * one opens no other; one set aside by the experiment going off opens again when it comes back.
 * An entry goes when its item ends, and any entry after LEDGER_KEEP_MS. Older releases never read
 * the file.
 *
 * startHeldThreads: follow the item's events and the experiment switch; at boot run the whole
 * sweep whatever the switch says, so a switch made while the server was down closes or opens what
 * it should.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, updateJsonFile, writeJsonFile } from '../../utils/fs.js';
import type { ExperimentCache } from '../experimental-cache.js';
import type { HeldKind } from './held-thread-model.js';
import type { OrgThread, ThreadsFile } from './threads-model.js';

type LedgerState = 'open' | 'off';
interface LedgerEntry { kind: HeldKind; key: string; state: LedgerState; at: string }
interface Ledger { version: 1; entries: Record<string, LedgerEntry> }

const LEDGER_KEEP_MS = 90 * 24 * 3600_000;
/** A live item's entry is stamped again once a day, so it never expires while the item waits. */
const LEDGER_REFRESH_MS = 24 * 3600_000;
const ledgerFile = (): string => path.join(WALNUT_HOME, 'org', 'held-threads.json');
const empty = (): Ledger => ({ version: 1, entries: {} });
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const shape = (raw: unknown): Ledger | null =>
  raw && typeof raw === 'object' && (raw as Ledger).entries && typeof (raw as Ledger).entries === 'object' ? raw as Ledger : null;

/** The item a thread holds, as the ledger keys it; null when it holds none or its item ended. */
function heldKeyOf(t: Pick<OrgThread, 'letter' | 'choice'>): { kind: HeldKind; key: string; state: LedgerState } | null {
  if (t.letter && !t.letter.done) return { kind: 'letter', key: t.letter.id, state: t.letter.off ? 'off' : 'open' };
  if (t.choice && !t.choice.done) return { kind: 'choice', key: `${t.choice.board}/${t.choice.id}`, state: t.choice.off ? 'off' : 'open' };
  return null;
}

/**
 * A ledger Walnut cannot read (a torn write, a hand edit) is written again from the threads as
 * they are now, never left to stop every later write.
 */
async function rebuildLedger(): Promise<Ledger> {
  const { threadTaskIds, readThreads } = await import('./threads-store.js');
  const at = new Date().toISOString();
  const entries: Record<string, LedgerEntry> = {};
  for (const node of await threadTaskIds()) {
    for (const t of (await readThreads(node)).threads) {
      const k = heldKeyOf(t);
      if (k && !t.movedTo) entries[t.id] = { ...k, at };
    }
  }
  const ledger: Ledger = { version: 1, entries };
  await writeJsonFile(ledgerFile(), ledger);
  log.task.warn('held threads: the ledger was unreadable and was written again from the threads', { entries: Object.keys(entries).length });
  return ledger;
}

async function readLedger(): Promise<Ledger> {
  try {
    return shape(await readJsonFile<unknown>(ledgerFile(), empty())) ?? await rebuildLedger();
  } catch (err) {
    log.task.warn('held threads: ledger not read', { error: errText(err) });
    return rebuildLedger().catch(() => empty());
  }
}

async function writeLedger(mutate: (entries: Record<string, LedgerEntry>) => boolean): Promise<void> {
  const write = () => updateJsonFile<Ledger>(ledgerFile(), empty(), (cur) => {
    const entries = { ...(shape(cur)?.entries ?? {}) };
    const cut = Date.now() - LEDGER_KEEP_MS;
    let changed = mutate(entries);
    for (const [id, e] of Object.entries(entries)) if (!(Date.parse(e.at) >= cut)) { delete entries[id]; changed = true; }
    return changed ? { version: 1, entries } : undefined;
  });
  try {
    await write();
  } catch (err) {
    // Unreadable: write it again from the threads, then this change; any other failure is only logged.
    const unreadable = await readJsonFile<unknown>(ledgerFile(), empty()).then(() => false, () => true);
    log.task.warn('held threads: ledger not written', { error: errText(err), unreadable });
    if (unreadable) await rebuildLedger().then(write).catch((e: unknown) => log.task.warn('held threads: ledger not rebuilt', { error: errText(e) }));
  }
}

/** Whether this item had a thread here: 'open' (opened, whatever became of it), 'off' (set aside), or null. */
export async function heldSeen(threadId: string): Promise<LedgerState | null> {
  return (await readLedger()).entries[threadId]?.state ?? null;
}

/**
 * Its thread was opened (or opened again, or found holding it), or set aside by the experiment
 * going off. The same state again only stamps the entry anew once a day, so a live item's record
 * never expires.
 */
export async function noteHeld(threadId: string, kind: HeldKind, key: string, state: LedgerState): Promise<void> {
  const cur = (await readLedger()).entries[threadId];
  if (cur?.state === state && Date.now() - Date.parse(cur.at) < LEDGER_REFRESH_MS) return;
  await writeLedger((entries) => {
    const e = entries[threadId];
    if (e?.state === state && Date.now() - Date.parse(e.at) < LEDGER_REFRESH_MS) return false;
    entries[threadId] = { kind, key, state, at: new Date().toISOString() };
    return true;
  });
}

/** The ledger entry this thread holds now, written when its item still waits (closed threads too). */
export async function noteHolder(t: Pick<OrgThread, 'id' | 'letter' | 'choice'>): Promise<void> {
  const k = heldKeyOf(t);
  if (k) await noteHeld(t.id, k.kind, k.key, k.state);
}

/** The items ended: no record of them is needed any more. `match` picks entries by kind, key and when written. */
export async function forgetHeld(match: (e: { id: string; kind: HeldKind; key: string; at: string }) => boolean): Promise<void> {
  const ledger = await readLedger();
  if (!Object.entries(ledger.entries).some(([id, e]) => match({ id, ...e }))) return;
  await writeLedger((entries) => {
    let changed = false;
    for (const [id, e] of Object.entries(entries)) if (match({ id, ...e })) { delete entries[id]; changed = true; }
    return changed;
  });
}

/**
 * Write one held thread on `node`'s Threads: `step` returns the next file and how the thread
 * changed, or null for no change. Returns that change (null: none).
 */
export async function writeHeldThread<C extends 'opened' | 'reopened' | 'settled'>(
  node: string, threadId: string, step: (cur: ThreadsFile) => { file: ThreadsFile; changed: C | null } | null,
): Promise<C | null> {
  const { writeThreadsFor } = await import('./threads-store.js');
  return writeThreadsFor(node, (cur) => {
    const r = step(cur);
    if (!r?.changed) return { file: cur, out: null };
    return { file: r.file, out: r.changed, changed: { kind: r.changed === 'opened' ? 'opened' as const : 'updated' as const, threadId } };
  });
}

/**
 * Which of `items` a thread holds now, for the status pass (heldLetterIds, heldChoiceKeys): each
 * item's thread on its node, followed to where it moved, holding it (`holds`). `holders`: item key
 * -> the node holding it; `counted`: the keys whose holder is an open task that keeps Threads (a
 * completed task's threads are not counted). A store Walnut cannot read throws: the caller holds
 * none, so a miss shows an item twice, never hides one.
 */
export async function heldHolders(
  items: ReadonlyArray<{ key: string; node: string; threadId: string }>,
  holds: (t: OrgThread) => boolean,
): Promise<{ holders: Map<string, string>; counted: Set<string> }> {
  const store = await import('./threads-store.js');
  const files = new Map<string, ThreadsFile>();
  const holders = new Map<string, string>();
  for (const it of items) {
    if (!files.has(it.node)) files.set(it.node, await store.readThreads(it.node));
    const here = files.get(it.node)!.threads.find((t) => t.id === it.threadId);
    if (!here) continue;
    const where = here.movedTo ? await store.threadHolder(it.node, it.threadId).catch(() => null) : { node: it.node, thread: here };
    if (where && holds(where.thread)) holders.set(it.key, where.node);
  }
  const counted = new Set<string>();
  if (!holders.size) return { holders, counted };
  const { listTasksByIds } = await import('../task-manager.js');
  const { keepsThreads } = await import('./keeps-threads.js');
  const open = new Set((await listTasksByIds([...new Set(holders.values())]))
    .filter((t) => keepsThreads(t) && t.phase !== 'COMPLETE' && t.status !== 'done').map((t) => t.id));
  for (const [key, node] of holders) if (open.has(node)) counted.add(key);
  return { holders, counted };
}

/** One run at a time per key (a node, a Board), so two events never open or settle the same thread twice. */
const chains = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

/**
 * Follow one kind's events and its experiment (server boot, leader only). `onEvent` gets each
 * event of `events` with the experiment as last read; a switch runs `syncAll`; boot runs it too,
 * on or off, after `firstMs`.
 */
export function startHeldThreads(opts: {
  name: string;
  flag: ExperimentCache;
  events: readonly string[];
  onEvent: (event: { name: string; data: unknown }, on: boolean) => void;
  syncAll: () => Promise<unknown>;
  firstMs?: number;
}): { stop: () => void } {
  let stopped = false;
  let first: ReturnType<typeof setTimeout> | null = null;
  void (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    let seen = await opts.flag.on();
    bus.subscribe(opts.name, (event) => {
      if (event.name === EventNames.CONFIG_CHANGED) {
        void opts.flag.on().then((now) => {
          if (now === seen) return;
          seen = now;
          log.task.info(`${opts.name}: experiment switched`, { on: now });
          return opts.syncAll().then(() => undefined);
        }).catch((err: unknown) => log.task.warn(`${opts.name}: switch not synced`, { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      opts.onEvent(event, seen);
    }, { global: true, interest: [...opts.events, EventNames.CONFIG_CHANGED] });
    if (!stopped) {
      first = setTimeout(() => { void opts.syncAll().catch(() => {}); }, opts.firstMs ?? 5_000);
      first.unref?.();
    }
  })();
  return {
    stop: () => {
      stopped = true;
      if (first) clearTimeout(first);
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(opts.name)).catch(() => {});
    },
  };
}
