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
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import type { ExperimentCache } from '../experimental-cache.js';
import type { HeldKind } from './held-thread-model.js';

type LedgerState = 'open' | 'off';
interface LedgerEntry { kind: HeldKind; key: string; state: LedgerState; at: string }
interface Ledger { version: 1; entries: Record<string, LedgerEntry> }

const LEDGER_KEEP_MS = 90 * 24 * 3600_000;
const ledgerFile = (): string => path.join(WALNUT_HOME, 'org', 'held-threads.json');
const empty = (): Ledger => ({ version: 1, entries: {} });

async function readLedger(): Promise<Ledger> {
  const raw = await readJsonFile<Ledger>(ledgerFile(), empty()).catch(() => empty());
  return raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw : empty();
}

async function writeLedger(mutate: (entries: Record<string, LedgerEntry>) => boolean): Promise<void> {
  await updateJsonFile<Ledger>(ledgerFile(), empty(), (cur) => {
    const entries = { ...(cur?.entries ?? {}) };
    const cut = Date.now() - LEDGER_KEEP_MS;
    let changed = mutate(entries);
    for (const [id, e] of Object.entries(entries)) if (!(Date.parse(e.at) >= cut)) { delete entries[id]; changed = true; }
    return changed ? { version: 1, entries } : undefined;
  }).catch((err: unknown) => log.task.warn('held threads: ledger not written', { error: err instanceof Error ? err.message : String(err) }));
}

/** Whether this item had a thread here: 'open' (opened, whatever became of it), 'off' (set aside), or null. */
export async function heldSeen(threadId: string): Promise<LedgerState | null> {
  return (await readLedger()).entries[threadId]?.state ?? null;
}

/** Its thread was opened (or opened again), or set aside by the experiment going off. */
export async function noteHeld(threadId: string, kind: HeldKind, key: string, state: LedgerState): Promise<void> {
  await writeLedger((entries) => {
    if (entries[threadId]?.state === state) return false;
    entries[threadId] = { kind, key, state, at: new Date().toISOString() };
    return true;
  });
}

/** The items ended: no record of them is needed any more. `match` picks entries by kind and key. */
export async function forgetHeld(match: (e: { id: string; kind: HeldKind; key: string }) => boolean): Promise<void> {
  const ledger = await readLedger();
  if (!Object.entries(ledger.entries).some(([id, e]) => match({ id, ...e }))) return;
  await writeLedger((entries) => {
    let changed = false;
    for (const [id, e] of Object.entries(entries)) if (match({ id, ...e })) { delete entries[id]; changed = true; }
    return changed;
  });
}

/** The ledger's entries of one kind (a sweep forgets the ones whose item ended). */
export async function heldEntries(kind: HeldKind): Promise<Array<{ id: string; key: string }>> {
  return Object.entries((await readLedger()).entries).filter(([, e]) => e.kind === kind).map(([id, e]) => ({ id, key: e.key }));
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
