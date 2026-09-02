/**
 * Unsaved file-editor drafts (IndexedDB) — the Files panel's temporary copy of
 * text you typed but never saved.
 *
 * Why it exists: the editor's dirty buffer used to live only in React state, so
 * leaving the Files panel, switching files, or pressing Refresh threw the
 * keystrokes away with no warning ("I had unsaved edits, came back, they were
 * gone"). Saving stays EXPLICIT — an agent may be writing the same repo in the
 * same second — so a draft is a SIDE record: never written to the file, only
 * replayed into the editor when you come back to it.
 *
 * Best-effort by contract, same as cache/history-idb.ts: every failure (private
 * browsing, quota, corrupt DB, blocked upgrade) resolves to null / no-op.
 * Nothing here may ever throw into a render path.
 *
 * `baseHash` is what makes a replay safe: it is the contentHash the editor was
 * seeded from, so the reader can tell "disk is untouched, seed my text back"
 * from "the file moved underneath me, ask first" (planDraftReplay), and it stays
 * the save's lock token when the user restores the older text
 * (planStaleDraftRestore).
 *
 * A draft is keyed by PATH, so a rename must carry it (moveFileDraftsUnder) and a
 * delete must drop it (deleteFileDraftsUnder) — including every descendant when a
 * directory moves or goes.
 */
import { useEffect, useState } from 'react';
import { createKeyedIdbStore } from '@/cache/keyed-idb-store';
import { log } from '@/utils/log';

const DB_NAME = 'walnut-file-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';
/** Records kept at most; oldest evicted first. */
const MAX_RECORDS = 300;
/** A draft nobody came back for in a month is abandoned, not pending. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_NAME = 'walnut-file-drafts';

export interface FileDraft {
  /** Exec host the file lives on; null = this machine. */
  host: string | null;
  path: string;
  text: string;
  /** contentHash of the bytes the editor was seeded from. */
  baseHash: string;
  updatedAt: number;
}

/**
 * The whole storage surface, injectable so the node test tier (no IndexedDB,
 * and no fake-indexeddb in devDependencies) can exercise the real policy —
 * expiry, cap eviction, per-host listing, failure tolerance — against a
 * five-method in-memory stand-in.
 */
export interface FileDraftAdapter {
  get(key: string): Promise<FileDraft | null>;
  put(key: string, record: FileDraft): Promise<void>;
  delete(key: string): Promise<void>;
  /** Primary keys starting with `prefix` (one host's drafts), values NOT read. */
  keysWithPrefix(prefix: string): Promise<string[]>;
  /** `{ key, updatedAt }` OLDEST FIRST — housekeeping only, values NOT read. */
  agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>>;
}

/** Host segment of a key. Hostnames never contain a space, so ` ` separates. */
function hostPrefix(host: string | null | undefined): string {
  return `${host ?? 'local'} `;
}

export function fileDraftKey(host: string | null | undefined, path: string): string {
  return `${hostPrefix(host)}${path}`;
}

// ── Storage ────────────────────────────────────────────────────────────────

const store = createKeyedIdbStore<FileDraft>({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  maxRecords: MAX_RECORDS,
  maxAgeMs: MAX_AGE_MS,
});

/** Test seam: swap the storage layer (and re-arm the one-shot housekeeping). */
export function setFileDraftAdapter(next: FileDraftAdapter | null): void {
  store.setAdapter(next);
  pathRules = [];
}

/**
 * Every write AWAITS this. Housekeeping is the ordering barrier: two writes to
 * the same key both queue behind the one memoised sweep, so they land in the
 * order they were issued. When only the put awaited it, a save parked behind a
 * slow sweep landed AFTER a delete issued later and resurrected the draft the
 * delete had just removed.
 */
function housekeep(): Promise<void> {
  return store.housekeep();
}

/**
 * Subtree re-keying is a MULTI-STEP operation, and a read in the middle of one
 * sees a draft at neither its old key nor its new one.
 *
 * `moveFileDraftsUnder` walks the keys, then per draft does get → put(new) →
 * delete(old). A `loadFileDraft` for the NEW path that lands mid-walk finds
 * nothing, reports "no unsaved work", and (worse) its `releasePathRules` drops
 * the redirect rule the move is still relying on, so a late flush from the
 * outgoing editor writes back to the path that no longer exists.
 *
 * That window used to be hidden: the only caller read its draft after a network
 * round trip, which the move always won. Once the viewer started reading the
 * draft and the cached file bytes together — before the network, so a re-open can
 * paint immediately — the read got there first and a rename lost the draft it was
 * supposed to carry (caught by the "a rename carries the unsaved draft to the new
 * name" e2e test). Timing must not be the thing that makes this work, so subtree
 * mutations are serialised and reads queue behind whichever one is in flight.
 */
let subtreeTail: Promise<unknown> = Promise.resolve();

/** Run a subtree mutation with exclusive access, after any already queued. */
function queueSubtree<T>(run: () => Promise<T>): Promise<T> {
  const next = subtreeTail.then(run, run);
  // Never let a rejection poison the chain for everyone behind it.
  subtreeTail = next.catch(() => undefined);
  return next;
}

/**
 * Wait out any in-flight subtree mutation, so a read observes it whole — but
 * never longer than this. A read used to be independent of every mutation, and
 * making it wait means a wedged IndexedDB transaction could otherwise hold the
 * viewer's open path forever. On timeout we fall back to the old, racy behaviour:
 * the draft may be missed, which is what happened before this queue existed.
 */
const SUBTREE_WAIT_MS = 2_000;

function subtreeSettled(): Promise<unknown> {
  const tail = subtreeTail;
  return Promise.race([
    tail,
    new Promise((resolve) => setTimeout(resolve, SUBTREE_WAIT_MS)),
  ]);
}

// ── Change notification (this tab + other tabs) ─────────────────────────────

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    // Gated on `window`, not just on BroadcastChannel: node has the class too,
    // and an open channel there is a handle that keeps a test worker alive.
    // Outside a browser there are no other tabs to tell anyway.
    channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  if (channel) channel.onmessage = () => fire();
  return channel;
}

function fire(): void {
  for (const cb of [...listeners]) {
    try { cb(); } catch { /* a listener must not break the others */ }
  }
}

function notify(): void {
  fire();
  // BroadcastChannel never echoes to the posting context, so this is the
  // other tabs only — no double-fire here.
  try { getChannel()?.postMessage(1); } catch { /* channel closed */ }
}

/** Called after every draft save/delete, in this tab and (via BroadcastChannel) others. */
export function subscribeFileDrafts(cb: () => void): () => void {
  listeners.add(cb);
  getChannel();
  return () => { listeners.delete(cb); };
}

// ── Paths a rename or a delete moved out from under a draft ─────────────────
/**
 * A rename/delete reaches the tree BEFORE the editor for that path unmounts, and
 * the unmount FLUSHES the pending buffer under the path it was typed at. So
 * relocating the stored records is only half the job — that LATE write has to be
 * corrected too, or a rename leaves the draft orphaned at a path that no longer
 * exists (the new view reads the new key, finds nothing, and shows pre-edit disk
 * bytes) and a delete RESURRECTS the record it just removed, so recreating the
 * filename offers to restore the deleted file's body.
 *
 * A move/delete therefore also arms a RULE that rewrites (or drops) writes for the
 * old subtree. Rules expire, and reading a path RELEASES the rules over it: the
 * same name can be created again, and the new file's drafts belong where typed.
 */
const PATH_RULE_TTL_MS = 60_000;
/** Chained rules (rename a→b, then delete b) — also the loop guard for a→b→a. */
const MAX_RULE_HOPS = 4;

interface PathRule {
  host: string | null;
  from: string;
  /** Where writes under `from` go now; null = the path is gone, drop the write. */
  to: string | null;
  expiresAt: number;
}

let pathRules: PathRule[] = [];

/** Segment-wise: `/a/b` covers `/a/b` and `/a/b/c`, NEVER `/a/bc`. */
function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function remapUnder(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

function armPathRule(host: string | null | undefined, from: string, to: string | null): void {
  const h = host ?? null;
  const now = Date.now();
  pathRules = pathRules.filter((r) => r.expiresAt > now && !(r.host === h && r.from === from));
  pathRules.push({ host: h, from, to, expiresAt: now + PATH_RULE_TTL_MS });
}

/** Where a write for `path` must land: itself, the remapped path, or nowhere. */
function resolveDraftPath(host: string | null | undefined, path: string): string | null {
  if (pathRules.length === 0) return path;
  const h = host ?? null;
  const now = Date.now();
  const used = new Set<PathRule>();
  let cur = path;
  for (let hop = 0; hop < MAX_RULE_HOPS; hop++) {
    // Newest first: a path renamed twice follows the LATEST move. `used` is what
    // makes a rename-back (a→b, then b→a) settle instead of ping-ponging.
    const rule = [...pathRules].reverse().find(
      (r) => r.host === h && r.expiresAt > now && !used.has(r) && isUnder(cur, r.from),
    );
    if (!rule) return cur;
    used.add(rule);
    if (rule.to === null) return null;
    cur = remapUnder(cur, rule.from, rule.to);
  }
  return cur;
}

/** A path being read is LIVE again — drop the rules that would rewrite its writes. */
function releasePathRules(host: string | null | undefined, path: string): void {
  if (pathRules.length === 0) return;
  const h = host ?? null;
  const now = Date.now();
  pathRules = pathRules.filter((r) => r.expiresAt > now && !(r.host === h && isUnder(path, r.from)));
}

/** One host's draft keys at or under `base` — the descendants a directory
 *  rename/delete has to take with it. */
async function draftKeysUnder(
  host: string | null | undefined,
  base: string,
): Promise<Array<{ key: string; path: string }>> {
  const prefix = hostPrefix(host);
  const out: Array<{ key: string; path: string }> = [];
  for (const key of await store.keysWithPrefix(prefix)) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (isUnder(path, base)) out.push({ key, path });
  }
  return out;
}

/**
 * Carry every draft under `from` to `to` (one file, or a whole subtree).
 * `baseHash` rides along untouched: a rename doesn't change the bytes, so the
 * draft is still a valid replay for the same content under the new name.
 */
export async function moveFileDraftsUnder(
  host: string | null | undefined,
  from: string,
  to: string,
): Promise<void> {
  // Armed OUTSIDE the queue, synchronously: a flush racing this rename must be
  // redirected from the moment the rename is issued, not once its turn comes up.
  armPathRule(host, from, to);
  return queueSubtree(async () => {
    try {
      await housekeep();
      const found = await draftKeysUnder(host, from);
      for (const { key, path } of found) {
        const rec = await store.get(key);
        if (!rec) continue;
        const nextPath = remapUnder(path, from, to);
        await store.put(fileDraftKey(host, nextPath), { ...rec, path: nextPath });
        await store.delete(key);
      }
      if (found.length > 0) notify();
    } catch (err) {
      log.warn('file-drafts', 'moving drafts across a rename failed', {
        from, to, host: host ?? null, error: String(err),
      });
    }
  });
}

/** Forget every draft at `path` and under it — the file/folder is gone. */
export async function deleteFileDraftsUnder(
  host: string | null | undefined,
  path: string,
): Promise<void> {
  armPathRule(host, path, null);
  return queueSubtree(async () => {
    try {
      await housekeep();
      const found = await draftKeysUnder(host, path);
      for (const { key } of found) await store.delete(key);
      if (found.length > 0) notify();
    } catch { /* best effort */ }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function saveFileDraft(
  host: string | null | undefined,
  path: string,
  entry: { text: string; baseHash: string },
): Promise<void> {
  try {
    const target = resolveDraftPath(host, path);
    if (target === null) {
      // The unmount flush of a view for a path the tree just DELETED. Writing it
      // back would resurrect what deleteFileDraftsUnder removed.
      log.info('file-drafts', 'draft write dropped for a removed path', { path, host: host ?? null });
      return;
    }
    await housekeep();
    await store.put(fileDraftKey(host, target), {
      host: host ?? null, path: target, text: entry.text, baseHash: entry.baseHash, updatedAt: Date.now(),
    });
    notify();
  } catch (err) {
    // Losing the persisted copy is survivable (the live buffer is still on
    // screen); a silent loss is not — this is the line that explains a draft
    // that didn't come back.
    log.warn('file-drafts', 'draft save failed (unsaved text stays memory-only)', {
      path, host: host ?? null, error: String(err),
    });
  }
}

export async function loadFileDraft(
  host: string | null | undefined,
  path: string,
): Promise<FileDraft | null> {
  try {
    // Whole-operation ordering: a rename's draft move must be finished before this
    // read decides there is nothing here (and before releasePathRules below tears
    // down the redirect that move depends on). See queueSubtree.
    await subtreeSettled();
    // A read proves the path exists: any move/delete rule over it is history.
    releasePathRules(host, path);
    await housekeep();
    const rec = await store.get(fileDraftKey(host, path));
    return rec && typeof rec.text === 'string' ? rec : null;
  } catch {
    return null;
  }
}

export async function deleteFileDraft(host: string | null | undefined, path: string): Promise<void> {
  try {
    const target = resolveDraftPath(host, path);
    if (target === null) return; // already dropped with its subtree
    // Awaited for the ORDERING, not the sweep: a delete issued after a save must
    // queue behind that save's put, or the parked put lands last and brings the
    // draft back (a Save then leaves an "unsaved" marker on a saved file).
    await housekeep();
    await store.delete(fileDraftKey(host, target));
    notify();
  } catch { /* best effort */ }
}

// ── Replay policy (web/src/utils/file-draft-replay.ts) ──────────────────────
/**
 * Re-exported so every caller keeps importing the draft rules from ONE module
 * (`@/utils/file-drafts`) while the policy itself lives in its own file — this
 * one was over the ~500-line guideline.
 */
export { planDraftReplay, planStaleDraftRestore } from './file-draft-replay';
export type { DraftReplayPlan } from './file-draft-replay';

/** Paths with a pending draft on one host — the file tree's unsaved marker. */
export async function listFileDraftPaths(host: string | null | undefined): Promise<Set<string>> {
  try {
    await housekeep();
    const prefix = hostPrefix(host);
    const keys = await store.keysWithPrefix(prefix);
    return new Set(keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  } catch {
    return new Set();
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Paths with a pending draft, live. Identity is STABLE when the contents are
 * unchanged — the file tree renders off this Set, so a re-notify that changed
 * nothing must not re-render every row.
 */
export function useFileDraftPaths(host: string | null | undefined): Set<string> {
  const [paths, setPaths] = useState<Set<string>>(() => new Set<string>());
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void listFileDraftPaths(host).then((next) => {
        if (cancelled) return;
        setPaths((prev) => (sameSet(prev, next) ? prev : next));
      });
    };
    reload();
    const off = subscribeFileDrafts(reload);
    return () => { cancelled = true; off(); };
  }, [host]);
  return paths;
}
