/**
 * Conversation registry — manages the per-agent conversation list.
 *
 * Each agent (general, mentor, …) owns a directory of conversations:
 *   ~/.open-walnut/conversations/{agentId}/_index.json   <- ConversationIndex
 *   ~/.open-walnut/conversations/{agentId}/{conv-uuid}.json <- ChatHistoryStore
 *
 * This module ONLY touches the index + conversation file lifecycle. The chat
 * content inside each {conv}.json is owned by chat-history.ts. To avoid a static
 * import cycle (chat-history → conversations → chat-history) we read message
 * counts via the shared `isLogicalMessage` through a dynamic import.
 *
 * Migration is lazy + idempotent: the presence of _index.json means migration
 * is done. The legacy single-file chat history is COPIED into conversation #1 the
 * first time an agent's index is created, then RENAMED to {file}.migrated so the
 * deprecated single-file store can never again be read by a stray call that
 * forgot to pass conversationId (root-fix Phase 0). The .migrated copy is kept
 * for recovery; it is just no longer on any read path.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { ChatHistoryStore, ConversationIndex, ConversationMeta, ChatEntry } from './types.js';
import {
  conversationDir,
  conversationIndexFile,
  conversationFile,
  chatHistoryFile,
  validateConversationId,
} from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

const MAX_TITLE_LEN = 60;

// ── Write lock: serialize index read-modify-write per agent ──
// Keyed by agentId so two agents' indexes don't block each other.
const indexLocks = new Map<string, Promise<void>>();

function withIndexLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = indexLocks.get(agentId) ?? Promise.resolve();
  let release: () => void;
  const tail = new Promise<void>((r) => { release = r; });
  indexLocks.set(agentId, tail);
  return prev.then(fn).finally(() => {
    release!();
    // Tail-identity check, NOT unconditional delete — see the race timeline in
    // chat-history.ts withWriteLock (same pattern).
    if (indexLocks.get(agentId) === tail) indexLocks.delete(agentId);
  });
}

function freshIndex(): ConversationIndex {
  return { version: 1, activeConversationId: null, conversations: [] };
}

function freshStore(): ChatHistoryStore {
  return {
    version: 2,
    lastUpdated: new Date().toISOString(),
    compactionCount: 0,
    compactionSummary: null,
    entries: [],
  };
}

function newConversationId(): string {
  return `conv-${crypto.randomUUID()}`;
}

/**
 * Strip a leading bracketed context prefix (e.g. "[Task Context …]\n\n") and
 * extract a single-line title ≤60 chars from the first user message.
 */
export function deriveTitle(text: string): string {
  if (!text) return '';
  let t = text;
  // Drop leading [..] prefix blocks (task context / cron / plan-mode banners)
  // that are wrapped on their own lines before the real message.
  // These end with a closing tag like "[/Task Context]\n\n".
  const closeIdx = t.lastIndexOf('[/');
  if (closeIdx !== -1) {
    const after = t.slice(closeIdx);
    const nl = after.indexOf('\n');
    if (nl !== -1) t = after.slice(nl);
  }
  // First non-empty line that isn't a standalone bracketed banner line
  // (e.g. "[Current: Sun, Jun 7, 2026, 05:26 PM]" prefixed onto triage/heartbeat
  // turns — these have no closing tag so the [/..] strip above misses them).
  const firstLine = t.split('\n')
    .map(s => s.trim())
    .find(s => s.length > 0 && !/^\[[^\]]*\]$/.test(s)) ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_TITLE_LEN) return clean;
  return clean.slice(0, MAX_TITLE_LEN - 1).trimEnd() + '…';
}

/** Extract plain display text from a ChatEntry for title derivation. */
function entryText(entry: ChatEntry): string {
  if (entry.displayText) return entry.displayText;
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content)) {
    const parts = (entry.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    return parts.join(' ');
  }
  return '';
}

/** Count logical messages in a store (uses the shared chat-history filter). */
async function countLogicalMessages(store: ChatHistoryStore): Promise<number> {
  const { isLogicalMessage } = await import('./chat-history.js');
  return (store.entries ?? []).filter(isLogicalMessage).length;
}

/** Find the first user (non-tool-result) entry for title derivation. */
function firstUserMessage(store: ChatHistoryStore): string {
  for (const entry of store.entries ?? []) {
    if (entry.tag === 'ai' && entry.role === 'user') {
      const text = entryText(entry);
      if (text.trim()) return text;
    }
  }
  return '';
}

async function readIndex(agentId: string): Promise<ConversationIndex> {
  const raw = await readJsonFile<ConversationIndex>(conversationIndexFile(agentId), freshIndex());
  if (!raw.conversations) raw.conversations = [];
  return raw;
}

async function writeIndex(agentId: string, index: ConversationIndex): Promise<void> {
  await writeJsonFile(conversationIndexFile(agentId), index);
}

/**
 * Retire the legacy single-file store after a verified import. Renames it to
 * {path}.migrated so it leaves every read path (root-fix Phase 0) but stays
 * recoverable. Best-effort: a rename failure must not break migration.
 */
async function retireLegacyFile(legacyPath: string, importedPath: string, expectedMsgCount: number): Promise<void> {
  try {
    // Verify the imported conversation file exists and is non-empty before retiring.
    const imported = await readJsonFile<ChatHistoryStore | null>(importedPath, null);
    const importedCount = imported ? await countLogicalMessages(imported) : 0;
    if (!imported || importedCount < expectedMsgCount) {
      log.agent.warn('legacy retire skipped: import verification failed', { expectedMsgCount, importedCount });
      return;
    }
    await fsp.rename(legacyPath, `${legacyPath}.migrated`);
    log.agent.info('legacy chat-history retired', { from: legacyPath, to: `${legacyPath}.migrated` });
  } catch (err) {
    log.agent.warn('legacy retire failed (non-critical)', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Sort: main first, then pinned, then lastMessageAt desc. */
function sortConversations(list: ConversationMeta[]): ConversationMeta[] {
  return [...list].sort((a, b) => {
    if (!!a.isMain !== !!b.isMain) return a.isMain ? -1 : 1;
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  });
}

/**
 * Lazy + idempotent migration. If no _index.json exists for this agent, create
 * one. If a legacy single-file chat history exists with entries, COPY it into
 * conversation #1 (preserving the legacy file for safety). Otherwise create one
 * fresh empty conversation. Always leaves exactly one active conversation.
 */
export async function migrateIfNeeded(agentId: string): Promise<void> {
  // Fast path: index already present → migration done.
  try {
    await fsp.access(conversationIndexFile(agentId));
    return;
  } catch { /* needs migration */ }

  await withIndexLock(agentId, async () => {
    // Re-check under lock (another caller may have just migrated).
    try {
      await fsp.access(conversationIndexFile(agentId));
      return;
    } catch { /* still needs migration */ }

    await fsp.mkdir(conversationDir(agentId), { recursive: true });

    const legacyPath = chatHistoryFile(agentId);
    const legacy = await readJsonFile<ChatHistoryStore | null>(legacyPath, null);
    const now = new Date().toISOString();
    const newId = newConversationId();

    if (legacy && Array.isArray(legacy.entries) && legacy.entries.length > 0) {
      // Copy legacy content into conversation #1.
      await writeJsonFile(conversationFile(agentId, newId), legacy);
      const messageCount = await countLogicalMessages(legacy);
      const title = deriveTitle(firstUserMessage(legacy)) || 'Conversation 1';
      const meta: ConversationMeta = {
        id: newId,
        agentId,
        title,
        createdAt: now,
        lastMessageAt: legacy.lastUpdated || now,
        messageCount,
        // First-ever conversation of this agent → the main one (invariant).
        isMain: true,
        lastDistilledAt: null,
        lastDistilledMessageCount: 0,
      };
      await writeIndex(agentId, { version: 1, activeConversationId: newId, conversations: [meta] });
      // Retire the legacy file so a stray no-conversationId read can never pick
      // up stale ghost data again. Verify the import landed before renaming.
      await retireLegacyFile(legacyPath, conversationFile(agentId, newId), messageCount);
      log.agent.info('conversation migration: imported legacy chat history', { agentId, conversationId: newId, messageCount });
    } else {
      // No legacy / empty → one fresh empty conversation.
      await writeJsonFile(conversationFile(agentId, newId), freshStore());
      const meta: ConversationMeta = {
        id: newId,
        agentId,
        title: 'New Conversation',
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        // First-ever conversation of this agent → the main one (invariant).
        isMain: true,
        lastDistilledAt: null,
        lastDistilledMessageCount: 0,
      };
      await writeIndex(agentId, { version: 1, activeConversationId: newId, conversations: [meta] });
      log.agent.info('conversation migration: created fresh conversation', { agentId, conversationId: newId });
    }
  });
}

/**
 * Re-warn window for a duplicated id. The list is read on every conversation
 * request (and twice per message fetch), so a warn per call would be a log storm
 * on an index that stays broken until a human fixes it — but a warn-once would
 * hide a recurrence, hence a cooldown rather than a latch.
 */
const DUPLICATE_WARN_COOLDOWN_MS = 10 * 60 * 1000;
/** agentId → the duplicate set last warned about, and when. */
const lastDuplicateWarn = new Map<string, { signature: string; at: number }>();

/**
 * THE row for `id` when the index holds more than one: the latest lastMessageAt
 * wins, ties keep the earlier row (list order).
 *
 * ONE definition of "which twin is real", used by the read path AND by every
 * writer below. When the writers used a plain `find()` (raw-first row) while the
 * read used the newest, a rename could land on the loser and the title then
 * oscillated with every send — whichever row `touchLaneConversation` happened to
 * bump last became the visible one.
 */
export function pickConversationRow(
  list: ConversationMeta[],
  id: string,
): ConversationMeta | undefined {
  let winner: ConversationMeta | undefined;
  for (const c of list) {
    if (c.id !== id) continue;
    if (!winner || (c.lastMessageAt ?? '') > (winner.lastMessageAt ?? '')) winner = c;
  }
  return winner;
}

/**
 * Drop twin rows in a write that is ALREADY rewriting the index under the lock:
 * keep the picked winner, discard the rest. Returns the surviving winner (or
 * undefined when the id isn't there at all) so a writer can mutate it in place.
 *
 * Self-healing rather than read-only repair is safe HERE and only here: the
 * caller holds the index lock and is about to persist the file anyway, so there
 * is no separate write to race. The read path deliberately does not do this (see
 * dedupeConversations).
 */
function collapseTwinsForWrite(
  index: ConversationIndex,
  id: string,
): ConversationMeta | undefined {
  const winner = pickConversationRow(index.conversations, id);
  if (!winner) return undefined;
  const losers = index.conversations.filter((c) => c.id === id && c !== winner);
  // isMain and pinned are STICKY facts about the conversation, not about the row
  // that happens to be newest. Deleting a loser that carried isMain would retire
  // the agent's main conversation (nothing can recreate that flag) and a lost
  // `pinned` silently un-pins the chat, so both are OR-ed into the survivor.
  for (const loser of losers) {
    if (loser.isMain) winner.isMain = true;
    if (loser.pinned) winner.pinned = true;
  }
  if (losers.length > 0) {
    index.conversations = index.conversations.filter((c) => c.id !== id || c === winner);
    log.agent.warn('conversation index: dropped duplicate rows during a write', {
      agentId: winner.agentId, conversationId: id, dropped: losers.length,
      ...(winner.isMain ? { keptIsMain: true } : {}),
      ...(winner.pinned ? { keptPinned: true } : {}),
    });
  }
  return winner;
}

/**
 * Collapse rows that share an id, keeping the one with the latest lastMessageAt.
 *
 * `_index.json` is a materialized view synced whole-file with last-writer-wins,
 * and both the LWW merge and adoptOrphanedConversationFiles can leave TWO rows
 * for one id with different titles and counts (measured on a live box: 86 rows
 * for 84 ids). Every consumer treats the id as the identity — the iOS list is a
 * SwiftUI ForEach over Identifiable, which is undefined behaviour on duplicates —
 * so the collapse belongs here, at the single read path, not in one caller.
 *
 * The index file is deliberately NOT rewritten from a READ: a write would race
 * the very sync that produces the duplicates. The writers below repair it inside
 * their own locked write instead, so the two paths agree on the winner
 * (pickConversationRow) and disk converges on its own.
 */
function dedupeConversations(agentId: string, list: ConversationMeta[]): ConversationMeta[] {
  const winners = new Map<string, ConversationMeta>();
  const duplicated = new Set<string>();
  for (const c of list) {
    const prev = winners.get(c.id);
    if (!prev) { winners.set(c.id, c); continue; }
    duplicated.add(c.id);
    // Latest lastMessageAt wins; a tie keeps the earlier row (list order).
    if ((c.lastMessageAt ?? '') > (prev.lastMessageAt ?? '')) winners.set(c.id, c);
  }
  if (duplicated.size === 0) return list;

  const ids = [...duplicated].sort();
  const signature = ids.join(',');
  const seen = lastDuplicateWarn.get(agentId);
  if (!seen || seen.signature !== signature || Date.now() - seen.at > DUPLICATE_WARN_COOLDOWN_MS) {
    lastDuplicateWarn.set(agentId, { signature, at: Date.now() });
    log.agent.warn('conversation index holds duplicate ids — serving the newest row per id', {
      agentId, duplicateIds: ids, rows: list.length, ids: winners.size,
    });
  }
  // Identity comparison, so exactly one row per id survives and the incoming
  // order is preserved. Sticky flags are OR-ed in on a COPY (never mutate a row
  // from a READ) so the list agrees with what collapseTwinsForWrite will persist —
  // `pinned` decides sort position, so disagreeing here moves rows around.
  return list.filter((c) => winners.get(c.id) === c).map((winner) => {
    if (!duplicated.has(winner.id)) return winner;
    const losers = list.filter((c) => c.id === winner.id && c !== winner);
    const isMain = winner.isMain || losers.some((l) => l.isMain);
    const pinned = winner.pinned || losers.some((l) => l.pinned);
    if (isMain === !!winner.isMain && pinned === !!winner.pinned) return winner;
    return { ...winner, isMain, pinned };
  });
}

/** List conversations for an agent (pinned first, then lastMessageAt desc). */
export async function listConversations(agentId: string): Promise<ConversationMeta[]> {
  await migrateIfNeeded(agentId);
  await adoptOrphanedConversationFiles(agentId);
  const index = await readIndex(agentId);
  // Dedupe BEFORE sorting: the tie-break is "keep the earlier row in list order",
  // and pickConversationRow (the writers' half of the same rule) sees the raw file
  // order. Deduping a sorted list would let the two paths pick different winners.
  return sortConversations(dedupeConversations(agentId, index.conversations));
}

/**
 * Self-heal the index: adopt conversation FILES that have no index row.
 *
 * Why this exists (2026-08-22 incident): _index.json is one JSON file synced
 * whole-file with last-writer-wins. When two boxes both touch it inside one
 * sync window (a replica adding a phone-created conversation while the primary
 * bumps lastMessageAt on another row), the merge picks ONE side and the other
 * side's new row is annihilated — the conversation file survives on every box
 * but no longer appears in any list and its reads 404. The files are the
 * ground truth (one file per conversation, no cross-box conflict), so the
 * index is treated as a materialized view and rebuilt from disk: any
 * `conv-*.json` with no row is re-adopted with metadata derived from its
 * content. Derivation is deterministic, so every box converges to the same
 * row and the LWW merge can no longer eat it (both sides carry it).
 *
 * Cheap on the happy path: one readdir + a set diff; the lock and file reads
 * only happen when an orphan is actually found.
 */
async function adoptOrphanedConversationFiles(agentId: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(conversationDir(agentId));
  } catch {
    return; // no dir yet — nothing to reconcile
  }
  const onDisk = names
    .filter((n) => /^conv-[a-z0-9-]{1,64}\.json$/i.test(n))
    .map((n) => n.slice(0, -'.json'.length));
  if (onDisk.length === 0) return;
  const known = new Set((await readIndex(agentId)).conversations.map((c) => c.id));
  const orphans = onDisk.filter((id) => !known.has(id));
  if (orphans.length === 0) return;

  await withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    const knownNow = new Set(index.conversations.map((c) => c.id));
    const adopted: string[] = [];
    for (const id of orphans) {
      if (knownNow.has(id)) continue; // raced: someone re-added it meanwhile
      let store: ChatHistoryStore | null = null;
      try {
        store = await readJsonFile<ChatHistoryStore | null>(conversationFile(agentId, id), null);
      } catch { /* corrupt JSON — readJsonFile throws on parse errors */ }
      if (!store || !Array.isArray(store.entries)) continue; // unreadable/garbage — leave for a human
      const now = new Date().toISOString();
      const firstTs = store.entries.find((e) => typeof e?.timestamp === 'string' && e.timestamp)?.timestamp;
      const createdAt = firstTs || store.lastUpdated || now;
      index.conversations.push({
        id,
        agentId,
        title: deriveTitle(firstUserMessage(store)) || 'Recovered Conversation',
        createdAt,
        lastMessageAt: store.lastUpdated || createdAt,
        messageCount: await countLogicalMessages(store),
        lastDistilledAt: null,
        lastDistilledMessageCount: 0,
        // Derived createdAt can predate the real main; keep this row out of
        // the oldest-is-main self-heal (see getMainConversationId).
        recovered: true,
      });
      adopted.push(id);
    }
    if (adopted.length > 0) {
      await writeIndex(agentId, index);
      log.agent.warn('conversation index reconcile: adopted orphaned conversation files', {
        agentId, adopted,
      });
    }
  });
}

/**
 * Make sure an index row exists for `conversationId`, creating one when
 * missing (title derived from `seedText`). Used by the cloud chat-turn relay:
 * the replica created the conversation in ITS index, and waiting for git-sync
 * to deliver the row proved lossy (whole-file LWW can drop it — see
 * adoptOrphanedConversationFiles). Writing the row on the primary too means
 * BOTH sides of any index merge carry it, so no resolution can lose it.
 * Best-effort by contract: a failure here must never block a chat turn.
 */
export async function ensureConversationRow(
  agentId: string,
  conversationId: string,
  seedText?: string,
): Promise<void> {
  try {
    validateConversationId(conversationId);
    await migrateIfNeeded(agentId);
    await withIndexLock(agentId, async () => {
      const index = await readIndex(agentId);
      if (index.conversations.some((c) => c.id === conversationId)) return;
      const now = new Date().toISOString();
      index.conversations.push({
        id: conversationId,
        agentId,
        title: deriveTitle(seedText ?? '') || 'New Conversation',
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        lastDistilledAt: null,
        lastDistilledMessageCount: 0,
      });
      await writeIndex(agentId, index);
      log.agent.info('conversation row ensured (relay/adoption path)', { agentId, conversationId });
    });
  } catch (err) {
    log.agent.warn('ensureConversationRow failed (non-critical)', {
      agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The active conversation id for an agent (guaranteed non-null after migrate). */
export async function getActiveConversationId(agentId: string): Promise<string> {
  await migrateIfNeeded(agentId);
  const index = await readIndex(agentId);
  if (index.activeConversationId) return index.activeConversationId;
  // Defensive: index somehow has no active id — pick the first or create one.
  const first = sortConversations(index.conversations)[0];
  if (first) {
    await setActiveConversationId(agentId, first.id);
    return first.id;
  }
  const created = await createConversation(agentId);
  return created.id;
}

/**
 * The MAIN conversation id for an agent (guaranteed non-null after migrate).
 *
 * Background/system turns (cron, heartbeat, triage, subagent results) write here —
 * the agent's single stable conversation, NOT activeConversationId (which is whatever
 * the user last clicked). Idempotent + lock-safe: back-fill only WRITES when no main
 * exists. For a legacy index (pre-isMain) it promotes the active-or-oldest conversation
 * and persists, so subsequent reads are O(1).
 */
export async function getMainConversationId(agentId: string): Promise<string> {
  await migrateIfNeeded(agentId);
  return withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    // Recovered rows (orphan-file adoption) have createdAt DERIVED from file
    // content — a re-adopted months-old thread would otherwise look "oldest"
    // and capture main. Only fall back to them when nothing else exists.
    const eligible = index.conversations.filter((c) => !c.recovered);
    const pool = eligible.length > 0 ? eligible : index.conversations;
    const oldest = [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const existing = index.conversations.find((c) => c.isMain);
    if (existing) {
      // Self-heal a mis-assigned main. `isMain` is only ever set by auto-logic
      // (migration marks conv #1 = the oldest legacy import; back-fill below). There
      // is NO user-facing "set main" yet, so the canonical main is always the oldest
      // conversation. An early buggy back-fill promoted whatever was *active* at the
      // time, which could be a brand-new side conversation (observed: a 2-msg "hi"
      // beat the 240-msg original). If the flagged main isn't the oldest, correct it.
      // NOTE: when a manual set-main feature is added, gate or remove this self-heal.
      if (oldest && existing.id !== oldest.id) {
        for (const c of index.conversations) c.isMain = c.id === oldest.id;
        await writeIndex(agentId, index);
        log.agent.info('corrected mis-assigned main conversation', { agentId, from: existing.id, to: oldest.id });
        return oldest.id;
      }
      return existing.id;
    }

    // No main yet — back-fill. Promote the OLDEST conversation (by createdAt): for a
    // migrated agent that's the imported legacy chat (the agent's original/primary
    // thread), which is exactly what "main" should be. We deliberately do NOT use
    // activeConversationId here — "active" is just whatever the user last clicked, so
    // a freshly-created side conversation could wrongly become main.
    const promote = oldest;
    if (promote) {
      promote.isMain = true;
      await writeIndex(agentId, index);
      log.agent.info('back-filled main conversation', { agentId, conversationId: promote.id });
      return promote.id;
    }

    // Defensive: index somehow has zero conversations. Create+mark INLINE (mirror
    // getActiveConversationId's inline branch) — do NOT call createConversation, which
    // would re-enter this same non-reentrant withIndexLock and deadlock.
    const newId = newConversationId();
    const now = new Date().toISOString();
    await writeJsonFile(conversationFile(agentId, newId), freshStore());
    index.conversations.push({
      id: newId,
      agentId,
      title: 'New Conversation',
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
      isMain: true,
      lastDistilledAt: null,
      lastDistilledMessageCount: 0,
    });
    index.activeConversationId = newId;
    await writeIndex(agentId, index);
    log.agent.info('created main conversation (empty index)', { agentId, conversationId: newId });
    return newId;
  });
}

/** Set the active conversation. Validates and ensures it exists in the index. */
export async function setActiveConversationId(agentId: string, conversationId: string): Promise<void> {
  validateConversationId(conversationId);
  await migrateIfNeeded(agentId);
  await withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    if (!index.conversations.some((c) => c.id === conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    index.activeConversationId = conversationId;
    await writeIndex(agentId, index);
  });
}

/** Create a new empty conversation, set it active, and return its meta. */
export async function createConversation(agentId: string, title?: string): Promise<ConversationMeta> {
  await migrateIfNeeded(agentId);
  return withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    const newId = newConversationId();
    const now = new Date().toISOString();
    // Write an empty store for the new conversation.
    await writeJsonFile(conversationFile(agentId, newId), freshStore());
    const meta: ConversationMeta = {
      id: newId,
      agentId,
      title: title?.trim() || 'New Conversation',
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
      // If the agent has no main yet (brand-new agent), this first conv becomes main.
      // Otherwise an explicit "+New" conv is always a side conversation.
      isMain: index.conversations.some((c) => c.isMain) ? undefined : true,
      lastDistilledAt: null,
      lastDistilledMessageCount: 0,
    };
    index.conversations.push(meta);
    index.activeConversationId = newId;
    await writeIndex(agentId, index);
    log.agent.info('conversation created', { agentId, conversationId: newId });
    return meta;
  });
}

/**
 * Delete a conversation. Removes its meta + file (best-effort). If it was the
 * active conversation, falls back to the first remaining one (or creates a fresh
 * empty conversation if none remain). Distill-before-delete is the CALLER's job.
 *
 * The MAIN conversation is never deletable (it receives background notifications +
 * cron). Attempting to delete it throws an Error whose message contains "main" — the
 * route maps that to HTTP 409. INVARIANT preserved: a main always exists post-delete.
 */
export async function deleteConversation(agentId: string, conversationId: string): Promise<void> {
  validateConversationId(conversationId);
  await migrateIfNeeded(agentId);
  await withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    // Winner row for the isMain guard: reading a twin could answer "not main" for
    // a conversation whose real row IS main (or the reverse).
    const target = pickConversationRow(index.conversations, conversationId);
    // Guard: the main conversation can never be deleted via the UI.
    if (target?.isMain) {
      throw new Error('Cannot delete the main conversation');
    }
    const before = index.conversations.length;
    index.conversations = index.conversations.filter((c) => c.id !== conversationId);
    if (index.conversations.length === before) {
      // Not found — nothing to delete. Still unlink any stray file.
      await fsp.unlink(conversationFile(agentId, conversationId)).catch(() => {});
      return;
    }

    // Remove the conversation file (best-effort).
    await fsp.unlink(conversationFile(agentId, conversationId)).catch(() => {});

    // Purge the conversation's rows from the history FTS index too —
    // delete means delete (best-effort, module handles its own errors).
    const { deleteConversationHistory } = await import('./history-db.js');
    deleteConversationHistory(agentId, conversationId);

    // Reassign active if we just deleted it.
    if (index.activeConversationId === conversationId) {
      const remaining = sortConversations(index.conversations)[0];
      if (remaining) {
        index.activeConversationId = remaining.id;
      } else {
        // None left — create a fresh empty conversation inline. It becomes the new
        // main so the invariant (exactly one main) survives deletion.
        const newId = newConversationId();
        const now = new Date().toISOString();
        await writeJsonFile(conversationFile(agentId, newId), freshStore());
        index.conversations.push({
          id: newId,
          agentId,
          title: 'New Conversation',
          createdAt: now,
          lastMessageAt: now,
          messageCount: 0,
          isMain: true,
          lastDistilledAt: null,
          lastDistilledMessageCount: 0,
        });
        index.activeConversationId = newId;
      }
    }

    // Invariant repair: if no main remains (e.g. legacy index without a main, or a
    // non-active main was somehow removed), promote the new active (or first) survivor.
    if (index.conversations.length > 0 && !index.conversations.some((c) => c.isMain)) {
      const promote =
        index.conversations.find((c) => c.id === index.activeConversationId) ??
        sortConversations(index.conversations)[0];
      if (promote) promote.isMain = true;
    }

    await writeIndex(agentId, index);
    log.agent.info('conversation deleted', { agentId, conversationId, activeConversationId: index.activeConversationId });
  });
}

/**
 * Rename a conversation.
 *
 * `opts.auto` distinguishes the LLM auto-titler from a user rename — BOTH set
 * `titleAutoGenerated = true` so the one-shot auto-titler won't run again (a
 * manual title must never be clobbered by the LLM, and the LLM labels once).
 */
export async function renameConversation(
  agentId: string,
  conversationId: string,
  title: string,
  opts?: { auto?: boolean },
): Promise<ConversationMeta> {
  validateConversationId(conversationId);
  await migrateIfNeeded(agentId);
  return withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    // The WINNER row (and drop its twins) — a rename that landed on the loser was
    // invisible, and the next lane send re-bumped the other row's title back.
    const meta = collapseTwinsForWrite(index, conversationId);
    if (!meta) throw new Error(`Conversation not found: ${conversationId}`);
    meta.title = title.trim().slice(0, MAX_TITLE_LEN) || meta.title;
    meta.titleAutoGenerated = true;
    await writeIndex(agentId, index);
    return meta;
  });
}

/** Pin or unpin a conversation. */
export async function setPinned(agentId: string, conversationId: string, pinned: boolean): Promise<ConversationMeta> {
  validateConversationId(conversationId);
  await migrateIfNeeded(agentId);
  return withIndexLock(agentId, async () => {
    const index = await readIndex(agentId);
    const meta = collapseTwinsForWrite(index, conversationId);
    if (!meta) throw new Error(`Conversation not found: ${conversationId}`);
    meta.pinned = pinned;
    await writeIndex(agentId, index);
    return meta;
  });
}

/**
 * Bump conversation metadata for a LANE turn (thin-layer chat). The turn's
 * transcript lives in the lane session's own JSONL — chat-history never sees
 * it — so lastMessageAt/messageCount/auto-title must be fed from the send
 * itself or the tab bar and History dropdown go permanently stale.
 * Best-effort: metadata can never fail a send.
 */
export async function touchLaneConversation(
  agentId: string,
  conversationId: string,
  messageText: string,
): Promise<void> {
  try {
    validateConversationId(conversationId);
    await migrateIfNeeded(agentId);
    await withIndexLock(agentId, async () => {
      const index = await readIndex(agentId);
      const meta = collapseTwinsForWrite(index, conversationId);
      if (!meta) return;
      meta.lastMessageAt = new Date().toISOString();
      meta.messageCount += 1;
      if (meta.title === 'New Conversation' || !meta.title) {
        const derived = deriveTitle(messageText);
        if (derived) meta.title = derived;
      }
      await writeIndex(agentId, index);
    });
  } catch (err) {
    log.agent.debug('touchLaneConversation failed (non-critical)', {
      agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Update lastMessageAt + messageCount after a turn persists. Best-effort: must
 * not throw into the chat flow. Called by chat-history.writeStore path.
 */
export async function touchConversation(
  agentId: string,
  conversationId: string,
  opts: { messageCount: number },
): Promise<void> {
  try {
    validateConversationId(conversationId);
    await withIndexLock(agentId, async () => {
      const index = await readIndex(agentId);
      // Same winner rule as every other writer (see pickConversationRow): this one
      // fires on every persisted turn, so a loser-row bump here is what made a
      // duplicated conversation's title flip back and forth.
      const meta = collapseTwinsForWrite(index, conversationId);
      if (!meta) return; // pre-migration / race — ignore
      meta.lastMessageAt = new Date().toISOString();
      meta.messageCount = opts.messageCount;
      // Auto-title: if still the default and we now have a first user message, derive one.
      if ((meta.title === 'New Conversation' || !meta.title) && meta.messageCount > 0) {
        try {
          const store = await readJsonFile<ChatHistoryStore>(conversationFile(agentId, conversationId), freshStore());
          const derived = deriveTitle(firstUserMessage(store));
          if (derived) meta.title = derived;
        } catch { /* best-effort */ }
      }
      await writeIndex(agentId, index);
    });
  } catch (err) {
    log.agent.debug('touchConversation failed (non-critical)', {
      agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

