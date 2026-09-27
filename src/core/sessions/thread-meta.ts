/**
 * Per-question navigation metadata (`SessionRecord.threadMeta`), the server half.
 *
 * Threads are a VIEW over one linear transcript (threadAnchors); this list adds
 * a status, a title and a takeaway per question, keyed by the question's head
 * user row msgId. Two writers touch the same entry concurrently: the client
 * (Done, Rename, Not yet) and the server's background AI (title, takeaway,
 * "looks answered"). So every write is an UPSERT by headId, never a whole-list
 * replace (a stale client list would erase a fresh AI title), and every write
 * runs through one in-process promise chain per session that re-reads the
 * record, so the merge always starts from the latest stored list.
 *
 * Pure functions first (normalize, merge, prune, follow-up reopen), then the
 * serialized write paths and the after-write listener registry.
 */

import { SessionControlError } from './session-controls.js';
import { threadAiAvailable } from './thread-ai-stub.js';
import { log } from '../../logging/index.js';
import type {
  SessionRecord, SessionThreadAnchor, SessionThreadMeta, SessionThreadMetaPatch,
} from '../types.js';

export const MAX_THREAD_META = 500; // same cap as MAX_THREAD_ANCHORS
export const MAX_THREAD_META_ID_CHARS = 128;
export const MAX_THREAD_TITLE_CHARS = 120;
export const MAX_THREAD_TAKEAWAY_CHARS = 280;
export const MAX_THREAD_QUESTION_CHARS = 400;
/** An entry without an anchor survives this long, so a meta write that lands
 *  before its anchor write is not pruned in between. */
export const THREAD_META_ORPHAN_TTL_MS = 10 * 60_000;

const ENUMS = {
  status: ['open', 'suggested', 'resolved', 'older'],
  titleSource: ['ai', 'user'],
  titleState: ['pending', 'done', 'failed', 'unavailable'],
  takeawaySource: ['fallback', 'user', 'ai'],
  takeawayState: ['pending', 'done', 'failed'],
} as const;
const STRING_CAPS = { title: MAX_THREAD_TITLE_CHARS, takeaway: MAX_THREAD_TAKEAWAY_CHARS } as const;
const BOOLEANS = ['hidden', 'suggestDismissed'] as const;

type MetaField = Exclude<keyof SessionThreadMeta, 'headId' | 'updatedAt'>;
const FIELDS: readonly MetaField[] = [
  'status', 'title', 'titleSource', 'titleState', 'question', 'takeaway',
  'takeawaySource', 'takeawayState', 'hidden', 'suggestDismissed', 'refinedAt',
];

function bad(message: string): never {
  throw new SessionControlError(message, 400);
}

/**
 * Validate a `thread_meta` PATCH body: a list of upsert entries. Rejects the whole
 * patch (400) on any malformed entry, like thread_anchors. `question` is the one
 * repair: it is cut to 400 chars, because it is a copy of what the user typed and
 * refusing a send over its length would be the worse failure. `updatedAt` is the
 * server's stamp and is ignored when a client sends it.
 */
export function normalizeThreadMeta(value: unknown): SessionThreadMetaPatch[] {
  if (!Array.isArray(value)) bad('thread_meta must be an array');
  if (value.length > MAX_THREAD_META) bad(`thread_meta holds at most ${MAX_THREAD_META} entries`);
  const out: SessionThreadMetaPatch[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('each thread_meta entry must be an object');
    const entry = raw as Record<string, unknown>;
    const headId = entry.headId;
    if (typeof headId !== 'string' || !headId.trim() || headId.length > MAX_THREAD_META_ID_CHARS) {
      bad(`thread_meta[].headId must be a non-empty string (max ${MAX_THREAD_META_ID_CHARS} chars)`);
    }
    const patch: Record<string, unknown> = { headId };
    for (const field of FIELDS) {
      const v = entry[field];
      if (v === undefined) continue;
      if (v === null) {
        if (field === 'status') bad('thread_meta[].status cannot be cleared');
        patch[field] = null;
        continue;
      }
      if (field in ENUMS) {
        const allowed = ENUMS[field as keyof typeof ENUMS] as readonly string[];
        if (typeof v !== 'string' || !allowed.includes(v)) {
          bad(`thread_meta[].${field} must be one of: ${allowed.join(', ')}`);
        }
        patch[field] = v;
      } else if (field === 'title' || field === 'takeaway') {
        const cap = STRING_CAPS[field];
        if (typeof v !== 'string' || v.length > cap) bad(`thread_meta[].${field} must be a string (max ${cap} chars)`);
        patch[field] = v;
      } else if (field === 'question') {
        if (typeof v !== 'string') bad('thread_meta[].question must be a string');
        patch[field] = v.slice(0, MAX_THREAD_QUESTION_CHARS);
      } else if ((BOOLEANS as readonly string[]).includes(field)) {
        if (typeof v !== 'boolean') bad(`thread_meta[].${field} must be a boolean`);
        patch[field] = v;
      } else if (field === 'refinedAt') {
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) bad('thread_meta[].refinedAt must be an ISO date');
        patch[field] = v;
      }
    }
    out.push(patch as SessionThreadMetaPatch);
  }
  return out;
}

// ── Merge (upsert by headId) ────────────────────────────────────────────────

export type ThreadMetaWriter = 'client' | 'ai';

export interface ThreadMetaMergeResult {
  meta: SessionThreadMeta[];
  /** headIds whose stored entry changed (new or any field moved). */
  touched: string[];
}

/**
 * Drop the fields an AI write may not change on this entry. The rules are the
 * whole reason for per-entry upsert: a user rename or a user takeaway is final;
 * an AI verdict is only ever a SUGGESTION (never `resolved`, never on a thread
 * the user said Not yet to, never on one that is no longer open); an AI failure
 * never downgrades a title another writer already finished.
 */
function aiGuard(base: SessionThreadMeta, patch: SessionThreadMetaPatch): SessionThreadMetaPatch {
  const p: Record<string, unknown> = { ...patch };
  if (base.titleSource === 'user') { delete p.title; delete p.titleSource; delete p.titleState; }
  if (p.titleState === 'failed' && base.titleState !== 'pending') delete p.titleState;
  if (base.takeawaySource === 'user') { delete p.takeaway; delete p.takeawaySource; delete p.takeawayState; }
  if (p.takeawayState === 'failed' && base.takeawayState !== 'pending') delete p.takeawayState;
  if (p.status !== undefined) {
    const may = p.status === 'suggested' && base.status === 'open' && !base.suggestDismissed;
    if (!may) delete p.status;
  }
  delete p.hidden; delete p.suggestDismissed; delete p.question;
  return p as SessionThreadMetaPatch;
}

/** A client that re-sends a bare `titleState: 'pending'` over a finished or user
 *  title is replaying a stale body; honouring it would re-open a done name. A
 *  body that also lists `title` or `titleSource` is a deliberate rename/reset. */
function clientGuard(base: SessionThreadMeta, patch: SessionThreadMetaPatch): SessionThreadMetaPatch {
  if (patch.titleState !== 'pending' || patch.title !== undefined || patch.titleSource !== undefined) return patch;
  if (base.titleState !== 'done' && base.titleSource !== 'user') return patch;
  const p = { ...patch };
  delete p.titleState;
  return p;
}

function sameEntry(a: SessionThreadMeta, b: SessionThreadMeta): boolean {
  return FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Upsert `patches` into `current`: listed fields overwrite, `null` clears, unlisted
 * entries and fields stay. New entries default to `status: 'open'`; an AI write
 * never creates an entry (its thread may have been removed meanwhile). With the
 * background AI unavailable for this session, `titleState: 'pending'` is stored
 * as `unavailable` (the UI never shows Naming…) and `takeawayState: 'pending'`
 * is dropped (the fallback is the takeaway).
 */
export function mergeThreadMeta(
  current: readonly SessionThreadMeta[] | undefined,
  patches: readonly SessionThreadMetaPatch[],
  nowIso: string,
  opts: { writer: ThreadMetaWriter; aiAvailable: boolean },
): ThreadMetaMergeResult {
  const list = (current ?? []).map((e) => ({ ...e }));
  const index = new Map(list.map((e, i) => [e.headId, i]));
  const touched = new Set<string>();
  for (const raw of patches) {
    const at = index.get(raw.headId);
    if (at === undefined && opts.writer === 'ai') continue;
    const before: SessionThreadMeta = at === undefined
      ? { headId: raw.headId, status: 'open', updatedAt: nowIso }
      : list[at];
    const patch = opts.writer === 'ai' ? aiGuard(before, raw) : clientGuard(before, raw);
    const next: Record<string, unknown> = { ...before };
    for (const field of FIELDS) {
      const v = patch[field];
      if (v === undefined) continue;
      if (v === null) delete next[field];
      else next[field] = v;
    }
    if (!opts.aiAvailable) {
      if (next.titleState === 'pending') next.titleState = 'unavailable';
      if (next.takeawayState === 'pending') delete next.takeawayState;
    }
    const entry = next as unknown as SessionThreadMeta;
    if (at !== undefined && sameEntry(before, entry)) continue;
    entry.updatedAt = nowIso;
    if (at === undefined) {
      if (list.length >= MAX_THREAD_META) continue; // cap: never grow past 500
      index.set(entry.headId, list.length);
      list.push(entry);
    } else {
      list[at] = entry;
    }
    touched.add(entry.headId);
  }
  return { meta: list, touched: [...touched] };
}

// ── Prune + follow-up reopen ────────────────────────────────────────────────

/**
 * Keep an entry while its anchor exists, or while it is young. Dropping an entry
 * the moment it has no anchor would kill a meta write that simply landed before
 * its anchor write; keeping them all would grow the record forever.
 */
export function pruneThreadMeta(
  meta: readonly SessionThreadMeta[],
  anchors: readonly SessionThreadAnchor[] | undefined,
  nowMs: number,
): SessionThreadMeta[] {
  const anchored = new Set((anchors ?? []).map((a) => a.msgId));
  return meta.filter((e) => {
    if (anchored.has(e.headId)) return true;
    const at = Date.parse(e.updatedAt);
    return Number.isFinite(at) && nowMs - at < THREAD_META_ORPHAN_TTL_MS;
  });
}

/** Whitespace-insensitive passage identity (same idea as the client's match). */
export function normalizeQuoteExact(exact: string | undefined): string {
  return (exact ?? '').replace(/\s+/g, ' ').trim();
}

function samePassage(a: SessionThreadAnchor, b: SessionThreadAnchor): boolean {
  return a.parent === b.parent && normalizeQuoteExact(a.quote?.exact) === normalizeQuoteExact(b.quote?.exact);
}

/**
 * Which question does a user row belong to? The head itself, or a follow-up
 * whose anchor points at the same passage as a head that has meta. `undefined`
 * when the row is not provably part of any question (never a guess).
 */
export function threadHeadForMsg(
  msgId: string,
  anchors: readonly SessionThreadAnchor[] | undefined,
  meta: readonly SessionThreadMeta[] | undefined,
): string | undefined {
  const byHead = new Map((meta ?? []).map((e) => [e.headId, e]));
  if (byHead.has(msgId)) return msgId;
  const list = anchors ?? [];
  const own = list.find((a) => a.msgId === msgId);
  if (!own) return undefined;
  const same = list.filter((a) => a.msgId !== msgId && byHead.has(a.msgId) && samePassage(a, own));
  // A hidden question's passage asked again opens a NEW question (spec 5.4), so
  // the visible one wins; among equals the newest head is the live one.
  const visible = same.filter((a) => !byHead.get(a.msgId)?.hidden);
  return (visible.length ? visible : same).at(-1)?.msgId;
}

/**
 * A new user row asked about the same passage as a question's head is a
 * follow-up in that question: it takes a `suggested` question back to `open`
 * (the user is still asking, so the suggestion no longer holds) and an `older`
 * one to `open` (the user picked it up again). `resolved` stays: reopening a
 * Done question is the user's own action.
 */
export function followUpReopen(
  meta: readonly SessionThreadMeta[],
  prevAnchors: readonly SessionThreadAnchor[] | undefined,
  nextAnchors: readonly SessionThreadAnchor[] | undefined,
  nowIso: string,
): ThreadMetaMergeResult {
  const before = new Set((prevAnchors ?? []).map((a) => a.msgId));
  const added = (nextAnchors ?? []).filter((a) => !before.has(a.msgId));
  if (added.length === 0) return { meta: [...meta], touched: [] };
  const touched = new Set<string>();
  const list = meta.map((e) => ({ ...e }));
  for (const a of added) {
    const headId = threadHeadForMsg(a.msgId, nextAnchors, list);
    if (!headId || headId === a.msgId) continue;
    const entry = list.find((e) => e.headId === headId);
    if (!entry || (entry.status !== 'suggested' && entry.status !== 'older')) continue;
    entry.status = 'open';
    entry.updatedAt = nowIso;
    touched.add(headId);
  }
  return { meta: list, touched: [...touched] };
}

/**
 * The whole meta step of one record write: merge the patches, reopen questions
 * that got a follow-up, prune. `null` when nothing changes, so a write that only
 * moves anchors on a record without meta leaves `threadMeta` absent.
 */
export function computeThreadMetaUpdate(
  record: Pick<SessionRecord, 'threadAnchors' | 'threadMeta'>,
  input: {
    anchors?: SessionThreadAnchor[];
    patches?: readonly SessionThreadMetaPatch[];
    writer: ThreadMetaWriter;
    aiAvailable: boolean;
    now: Date;
  },
): ThreadMetaMergeResult | null {
  const nowIso = input.now.toISOString();
  const nextAnchors = input.anchors ?? record.threadAnchors;
  const original = record.threadMeta ?? [];
  let meta: SessionThreadMeta[] = [...original];
  const touched = new Set<string>();
  if (input.patches?.length) {
    const merged = mergeThreadMeta(meta, input.patches, nowIso, input);
    meta = merged.meta;
    merged.touched.forEach((id) => touched.add(id));
  }
  if (input.anchors) {
    const reopened = followUpReopen(meta, record.threadAnchors, nextAnchors, nowIso);
    meta = reopened.meta;
    reopened.touched.forEach((id) => touched.add(id));
  }
  const pruned = pruneThreadMeta(meta, nextAnchors, input.now.getTime());
  if (touched.size === 0 && pruned.length === original.length) return null;
  return { meta: pruned, touched: [...touched].filter((id) => pruned.some((e) => e.headId === id)) };
}

// ── Serialized writes + after-write listeners ───────────────────────────────

export interface ThreadMetaWrittenEvent {
  sessionId: string;
  writer: ThreadMetaWriter;
  /** Entries whose stored value changed in this write. */
  touched: string[];
  /** Entries the writer listed (a no-op re-send is listed, not touched). */
  listed: string[];
  record: SessionRecord;
  prevRecord: SessionRecord;
}
type ThreadMetaListener = (event: ThreadMetaWrittenEvent) => void;

const listeners = new Set<ThreadMetaListener>();
const chains = new Map<string, Promise<unknown>>();

/** Register a listener for every successful thread write; returns unsubscribe.
 *  Listeners run synchronously after the write and must only SCHEDULE work. */
export function onThreadMetaWritten(listener: ThreadMetaListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(event: ThreadMetaWrittenEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch (err) {
      log.session.warn('thread meta listener threw', {
        sessionId: event.sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Run `fn` after every earlier thread write for this session settled. The chain
 * is what makes "re-read, merge, write" atomic between the client route and the
 * background AI inside this process (the only process that writes thread meta).
 */
export function serializeThreadMetaWrite<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(sessionId, tail);
  void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId); });
  return run;
}

/**
 * The client write (PATCH /api/sessions/:id and /api/v1): anchors first, then the
 * meta merge + follow-up reopen, then prune, all persisted by ONE `persist` call
 * (patchSession's own record write, so the anchor list and the meta list can
 * never be stored half-applied). `updates` is extended in place with threadMeta.
 */
export async function writeThreadFieldsAsClient(
  sessionId: string,
  updates: Partial<SessionRecord>,
  patches: SessionThreadMetaPatch[] | undefined,
  persist: (updates: Partial<SessionRecord>) => Promise<SessionRecord>,
): Promise<SessionRecord> {
  return serializeThreadMetaWrite(sessionId, async () => {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const prevRecord = await getSessionByClaudeId(sessionId);
    if (!prevRecord) throw new SessionControlError('session not found', 404);
    const step = computeThreadMetaUpdate(prevRecord, {
      anchors: updates.threadAnchors, patches, writer: 'client',
      aiAvailable: threadAiAvailable(sessionId), now: new Date(),
    });
    if (step) updates.threadMeta = step.meta;
    const record = await persist(updates);
    notify({
      sessionId, writer: 'client', touched: step?.touched ?? [],
      listed: (patches ?? []).map((p) => p.headId), record, prevRecord,
    });
    return record;
  });
}

/**
 * The background AI write (title, refine verdict, takeaway): re-read inside the
 * chain, merge with the AI guards, store, and emit the same status-changed event
 * patchSession emits so every client refetches. `null` when the session is gone;
 * the unchanged record when every field was guarded away (a user renamed first).
 */
export async function writeThreadMetaAsAi(
  sessionId: string,
  patches: SessionThreadMetaPatch[],
): Promise<SessionRecord | null> {
  return serializeThreadMetaWrite(sessionId, async () => {
    const tracker = await import('../session-tracker.js');
    const prevRecord = await tracker.getSessionByClaudeId(sessionId);
    if (!prevRecord) return null;
    const step = computeThreadMetaUpdate(prevRecord, {
      patches, writer: 'ai', aiAvailable: true, now: new Date(),
    });
    if (!step || step.touched.length === 0) return prevRecord;
    const record = await tracker.updateSessionRecord(sessionId, { threadMeta: step.meta });
    tracker.emitSessionStatusChanged(record, { threadMeta: record.threadMeta ?? [] }, ['*']);
    log.session.info('thread meta written by background AI', {
      sessionId, headIds: step.touched, fields: [...new Set(patches.flatMap((p) => Object.keys(p)))],
    });
    notify({
      sessionId, writer: 'ai', touched: step.touched, listed: patches.map((p) => p.headId), record, prevRecord,
    });
    return record;
  });
}

/** Test-only: drop every listener and pending chain between cases. */
export function __resetThreadMetaForTesting(): void {
  listeners.clear();
  chains.clear();
}
