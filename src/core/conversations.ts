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

/** List conversations for an agent (pinned first, then lastMessageAt desc). */
export async function listConversations(agentId: string): Promise<ConversationMeta[]> {
  await migrateIfNeeded(agentId);
  const index = await readIndex(agentId);
  return sortConversations(index.conversations);
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
    const oldest = [...index.conversations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
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
    const target = index.conversations.find((c) => c.id === conversationId);
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
    const meta = index.conversations.find((c) => c.id === conversationId);
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
    const meta = index.conversations.find((c) => c.id === conversationId);
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
      const meta = index.conversations.find((c) => c.id === conversationId);
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
      const meta = index.conversations.find((c) => c.id === conversationId);
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

