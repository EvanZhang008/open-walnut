/**
 * ChatHistoryManager — persistent conversation history for the main chat.
 *
 * Uses a unified `entries[]` array (v2) as the single source of truth.
 * Each entry is tagged 'ai' (model-facing) or 'ui' (display-only).
 * The model reads AI entries; the UI shows everything. Tool calls can never
 * be lost because there's only one representation.
 *
 * Migrates v1 stores (parallel apiMessages/displayMessages) on first read.
 */

import type { MessageParam } from '../agent/model.js';
import { getContextThreshold } from '../agent/model.js';
import type { ChatHistoryStore, ChatEntry, DisplayMessage } from './types.js';
import { CHAT_HISTORY_FILE, chatHistoryFile, conversationFile } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { estimateMessagesTokens, estimateFullPayload, compactDailyLog, formatDateKey } from './daily-log.js';
import { getWorkingMemory, isWorkingMemoryEmpty, truncateWorkingMemoryForCompact, snapshotWorkingMemory } from './working-memory.js';
import { effectiveTotalTokens, getLastTurnTokens, clearLastTurnTokens } from './token-truth.js';
import { log } from '../logging/index.js';
import fsp from 'node:fs/promises';
import { compressForApi, MAX_BASE64_BYTES } from '../utils/image-compress.js';

/** Compaction triggers at 80% of the model's context window. */
const COMPACTION_PERCENT = 0.80;
const RECENT_TURNS_TO_KEEP = 10;

/** Token threshold for daily log compaction — ~8K tokens (~32KB of text) */
const DAILY_LOG_COMPACT_THRESHOLD = 8_000;

// ── Slim limits for compacted entries ──
const SLIM_TOOL_INPUT_MAX = 200;
const SLIM_TOOL_RESULT_MAX = 500;

// ── Turn-boundary helpers ──

/**
 * Check if an AI entry is the start of a new user turn.
 * A turn starts with a user message that is NOT a tool_result response.
 */
function isTurnStart(entry: ChatEntry): boolean {
  if (entry.role !== 'user') return false;
  if (typeof entry.content === 'string') return true;
  if (!Array.isArray(entry.content)) return true;
  return !(entry.content as Array<{ type: string }>).some((b) => b.type === 'tool_result');
}

/**
 * Find the index in aiEntries where the last `turnsToKeep` turns begin.
 * Scans from the end, counting user messages that are NOT tool_result responses.
 * Returns the index of the first entry in the kept section, or null if
 * there are fewer than `turnsToKeep` turns (nothing to compact).
 */
export function findTurnBoundaryIndex(aiEntries: ChatEntry[], turnsToKeep: number): number | null {
  let turnsSeen = 0;
  for (let i = aiEntries.length - 1; i >= 0; i--) {
    if (isTurnStart(aiEntries[i])) {
      turnsSeen++;
      if (turnsSeen === turnsToKeep) {
        return i;
      }
    }
  }
  return null;
}

// ── Write lock: serializes all read-modify-write operations ──
// Per (agent, conversation) write locks: each console agent's conversation has
// its own promise chain so that General's writes don't block Mentor, and two
// conversations of the same agent don't serialize against each other.
const writeLocks = new Map<string, Promise<void>>();

/** Lock key — backward compatible: undefined conversationId → ':_' suffix. */
function lockKey(agentId?: string, conversationId?: string): string {
  return `${agentId || 'general'}:${conversationId || '_'}`;
}

function getWriteLock(key: string): Promise<void> {
  return writeLocks.get(key) ?? Promise.resolve();
}

/**
 * Serialize a read-modify-write operation on the chat history store.
 * All public write functions must go through this to prevent data loss.
 * Each (agentId, conversationId) pair gets its own lock chain.
 */
function withWriteLock<T>(fn: () => Promise<T>, agentId = 'general', conversationId?: string): Promise<T> {
  const key = lockKey(agentId, conversationId);
  const prev = getWriteLock(key);
  let resolve: () => void;
  writeLocks.set(key, new Promise<void>((r) => { resolve = r; }));
  return prev.then(fn).finally(() => resolve!());
}

/** Detect test/dev so a missing conversationId fails LOUD instead of silently
 *  reading the deprecated legacy file (the root cause of the multi-conversation
 *  bug family). See conversation-identity-root-fix plan, Phase 0. */
const FAIL_ON_MISSING_CONVID = !!(
  process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test'
);

/**
 * Resolve the on-disk store path.
 *
 * conversationId set → the per-conversation file under conversations/{agent}/.
 * conversationId MISSING → this is a bug: every chat read/write belongs to a
 * conversation (UI turns → active; background turns → main). We NEVER silently
 * fall back to the legacy single-file store anymore — that fallback is exactly
 * what let ~9 call sites read a stale ghost file.
 *   - test/dev: throw, so the offending call site surfaces immediately.
 *   - prod: log.error + use the legacy path as a last resort. After migration
 *     renames chat-history.json → .migrated, this resolves to an empty store
 *     rather than stale ghost data (degrade, don't corrupt).
 */
function resolveStorePath(agentId?: string, conversationId?: string): string {
  if (conversationId) return conversationFile(agentId || 'general', conversationId);
  const msg = `resolveStorePath called without conversationId (agentId=${agentId ?? 'general'}) — chat I/O must be conversation-scoped`;
  if (FAIL_ON_MISSING_CONVID) throw new Error(msg);
  log.agent.error('chat store: missing conversationId — falling back to legacy path', { agentId: agentId ?? 'general' });
  return chatHistoryFile(agentId);
}

/**
 * Best-effort: update the conversation registry's lastMessageAt + messageCount
 * after a write that added messages. Only runs when a conversationId is set.
 * Dynamic import avoids a static cycle (conversations.ts imports chat-history).
 */
async function touchConversationBestEffort(
  store: ChatHistoryStore,
  agentId?: string,
  conversationId?: string,
): Promise<void> {
  if (!conversationId) return;
  try {
    const messageCount = (store.entries ?? []).filter(isLogicalMessage).length;
    const { touchConversation } = await import('./conversations.js');
    await touchConversation(agentId || 'general', conversationId, { messageCount });
    // Fire-and-forget: once a thread has some chat, auto-generate a short tab title.
    // Self-dedups (one-shot via titleAutoGenerated + module mutex); never throws.
    const { generateConversationTitle } = await import('./conversation-title.js');
    void generateConversationTitle(agentId || 'general', conversationId);
  } catch { /* non-critical — must not break the chat flow */ }
}

// ── Store: read / write / migrate ──

function freshStore(): ChatHistoryStore {
  return {
    version: 2,
    lastUpdated: new Date().toISOString(),
    compactionCount: 0,
    compactionSummary: null,
    entries: [],
  };
}

/**
 * Migrate a v1 store to v2 by interleaving apiMessages and displayMessages
 * into a unified entries[] array.
 */
function migrateV1toV2(store: ChatHistoryStore): ChatHistoryStore {
  const apiMessages = (store.apiMessages ?? []) as MessageParam[];
  const displayMessages = (store.displayMessages ?? []) as DisplayMessage[];

  const entries: ChatEntry[] = [];

  // Collect notification-only display messages (those with source or notification flag)
  // Normal display messages are skipped — their content is already in apiMessages → AI entries
  const notificationDisplayMsgs = displayMessages.filter(
    (dm) => dm.source || dm.notification,
  );

  // Convert API messages → AI entries
  for (const msg of apiMessages) {
    const { role, content } = msg as { role: string; content: unknown };
    entries.push({
      tag: 'ai',
      role: role as 'user' | 'assistant',
      content,
      timestamp: store.lastUpdated,
    });
  }

  // Convert notification display messages → UI entries
  for (const dm of notificationDisplayMsgs) {
    entries.push({
      tag: 'ui',
      role: dm.role,
      content: dm.content,
      timestamp: dm.timestamp,
      source: dm.source,
      cronJobName: dm.cronJobName,
      notification: dm.notification,
      taskId: dm.taskId,
    });
  }

  return {
    version: 2,
    lastUpdated: store.lastUpdated,
    compactionCount: store.compactionCount,
    compactionSummary: store.compactionSummary,
    entries,
  };
}

async function readStore(agentId?: string, conversationId?: string): Promise<ChatHistoryStore> {
  const filePath = resolveStorePath(agentId, conversationId);
  const raw = await readJsonFile<ChatHistoryStore>(filePath, freshStore());

  // Migrate v1 → v2
  if (raw.version === 1 || (!raw.entries && (raw.apiMessages || raw.displayMessages))) {
    const migrated = migrateV1toV2(raw);
    await writeStore(migrated, agentId, conversationId);
    return migrated;
  }

  // Ensure entries array exists
  if (!raw.entries) raw.entries = [];

  // Migration: clean ALL orphan tool_result entries in non-compacted AI entries.
  // An orphan is a user message with tool_result blocks whose tool_use_ids
  // don't match any tool_use in the preceding non-compacted AI assistant message.
  let orphanCleaned = false;
  const ncAi = raw.entries.filter((e) => e.tag === 'ai' && !e.compacted);
  for (let idx = 0; idx < ncAi.length; idx++) {
    const entry = ncAi[idx];
    if (entry.role !== 'user' || !Array.isArray(entry.content)) continue;
    const blocks = entry.content as Array<{ type: string; tool_use_id?: string }>;
    if (!blocks.some((b) => b.type === 'tool_result')) continue;

    // Gather tool_use IDs from the preceding non-compacted AI assistant message
    const prevTuIds = new Set<string>();
    if (idx > 0) {
      const prev = ncAi[idx - 1];
      if (prev.role === 'assistant' && Array.isArray(prev.content)) {
        for (const b of prev.content as Array<{ type: string; id?: string }>) {
          if (b.type === 'tool_use' && b.id) prevTuIds.add(b.id);
        }
      }
    }

    // Check if ANY tool_result is orphaned
    const hasOrphan = blocks.some(
      (b) => b.type === 'tool_result' && (b.tool_use_id == null || !prevTuIds.has(b.tool_use_id)),
    );
    if (hasOrphan) {
      entry.compacted = true;
      entry.content = slimContent(entry.content);
      orphanCleaned = true;
    }
  }
  if (orphanCleaned) {
    log.agent.info('Cleaned orphan tool_result entries from chat history');
    await writeStore(raw, agentId, conversationId);
  }

  return raw;
}

async function writeStore(store: ChatHistoryStore, agentId?: string, conversationId?: string): Promise<void> {
  store.lastUpdated = new Date().toISOString();
  // Clean v1 fields from v2 stores
  if (store.version === 2) {
    delete store.apiMessages;
    delete store.displayMessages;
  }
  await writeJsonFile(resolveStorePath(agentId, conversationId), store);
}

// ── Public API: reading ──

/**
 * Get the current API-format messages for the agent loop.
 * Filters to non-compacted AI entries and returns as MessageParam[].
 */
export async function getApiMessages(agentId?: string, conversationId?: string): Promise<MessageParam[]> {
  return getModelContext(agentId, conversationId);
}

/**
 * Get model context: non-compacted AI entries as MessageParam[].
 * Turn-boundary compaction prevents NEW orphans, but pre-existing data
 * may still contain orphan tool_results from old compactions.
 * Defense layer: strip any user message whose tool_result blocks have
 * no matching tool_use in the preceding assistant message.
 */
export async function getModelContext(agentId?: string, conversationId?: string): Promise<MessageParam[]> {
  const store = await readStore(agentId, conversationId);
  const raw = (store.entries ?? [])
    .filter((e) => e.tag === 'ai' && !e.compacted)
    .map((e) => ({ role: e.role, content: e.content }) as MessageParam);

  // Defense: remove orphan tool_result messages
  const cleaned: MessageParam[] = [];
  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i] as { role: string; content: unknown };
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type: string; tool_use_id?: string }>;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (hasToolResult) {
        // Check preceding assistant message for matching tool_use
        const prev = cleaned[cleaned.length - 1] as { role: string; content: unknown } | undefined;
        const prevToolUseIds = new Set<string>();
        if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
          for (const b of prev.content as Array<{ type: string; id?: string }>) {
            if (b.type === 'tool_use' && b.id) prevToolUseIds.add(b.id);
          }
        }
        // Keep only tool_result blocks that have a matching tool_use
        const keptBlocks = blocks.filter((b) => {
          if (b.type !== 'tool_result') return true;
          return b.tool_use_id != null && prevToolUseIds.has(b.tool_use_id);
        });
        if (keptBlocks.length === 0) {
          log.agent.warn('Dropped orphan tool_result message from model context', {
            index: i,
            orphanIds: blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id),
          });
          continue; // skip this entire message
        }
        if (keptBlocks.length < blocks.length) {
          log.agent.warn('Stripped orphan tool_result blocks from model context', {
            index: i,
            kept: keptBlocks.length,
            total: blocks.length,
          });
          cleaned.push({ role: msg.role, content: keptBlocks } as MessageParam);
          continue;
        }
      }
    }
    cleaned.push(raw[i]);
  }

  // Log summary only when orphans were actually dropped
  if (cleaned.length < raw.length) {
    log.agent.info('getModelContext: orphan cleanup', {
      rawEntries: raw.length,
      afterCleanup: cleaned.length,
      dropped: raw.length - cleaned.length,
    });
  }

  // Return cleaned messages WITHOUT hydration — hydration should only happen
  // when actually sending to the API (in agent loop), not for token estimation.
  // Path-based images are much smaller and allow accurate token counting.
  return cleaned;
}

/**
 * Hydrate path-based image blocks in messages back to base64 for the Anthropic API.
 * Path-based blocks: { type: 'image', path: '/abs/path', media_type: 'image/png' }
 * Anthropic blocks: { type: 'image', source: { type: 'base64', media_type, data } }
 *
 * This should ONLY be called right before sending messages to the API, not for
 * token estimation or display purposes where path-based images are preferred.
 */
export async function hydrateImagePaths(msgs: MessageParam[]): Promise<MessageParam[]> {
  const result: MessageParam[] = [];
  for (const msg of msgs) {
    const { role, content } = msg as { role: string; content: unknown };
    if (role === 'user' && Array.isArray(content)) {
      const blocks = content as Array<Record<string, unknown>>;
      const needsHydration = blocks.some(
        (b) =>
          (b.type === 'image' && typeof b.path === 'string') ||
          // Defense: detect corrupted source-based blocks (data replaced with '[compacted]')
          (b.type === 'image' && b.source && typeof b.source === 'object' &&
            (b.source as Record<string, unknown>).data === '[compacted]'),
      );
      if (needsHydration) {
        const hydrated = await Promise.all(
          blocks.map(async (block) => {
            if (block.type === 'image' && typeof block.path === 'string') {
              try {
                const rawBuffer = await fsp.readFile(block.path as string);
                if (rawBuffer.length === 0) {
                  return { type: 'text', text: `[image: ${block.media_type ?? 'unknown'} — empty file]` };
                }
                const { buffer, mimeType } = await compressForApi(rawBuffer, (block.media_type as string) ?? 'image/png');
                const base64 = buffer.toString('base64');
                // If compression still couldn't get it under the limit, replace with placeholder
                if (base64.length > MAX_BASE64_BYTES) {
                  log.agent.warn('image dropped from history — too large after compression', { path: block.path, sizeMb: (buffer.length / 1_048_576).toFixed(1), mimeType });
                  return { type: 'text', text: `[image: ${mimeType} — too large even after compression (${(buffer.length / 1_048_576).toFixed(1)} MB)]` };
                }
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: base64,
                  },
                };
              } catch {
                // File missing — return a placeholder
                return { type: 'text', text: `[image: ${block.media_type ?? 'unknown'} — file not found]` };
              }
            }
            // Defense: drop image blocks whose base64 was destroyed by compaction
            if (block.type === 'image' && block.source && typeof block.source === 'object' &&
              (block.source as Record<string, unknown>).data === '[compacted]') {
              return { type: 'text', text: '[image: data unavailable — compacted]' };
            }
            return block;
          }),
        );
        result.push({ role, content: hydrated } as unknown as MessageParam);
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}

/**
 * Get the compaction summary (or null if no compaction has occurred).
 */
export async function getCompactionSummary(agentId?: string, conversationId?: string): Promise<string | null> {
  const store = await readStore(agentId, conversationId);
  return store.compactionSummary;
}

/** Get file mtime as cache key — single syscall, avoids parsing the full file. */
export async function getLastUpdated(agentId?: string, conversationId?: string): Promise<string> {
  try {
    const stat = await fsp.stat(resolveStorePath(agentId, conversationId));
    return stat.mtimeMs.toString();
  } catch {
    return '';
  }
}

/**
 * Check whether an entry is a "logical message" for pagination counting.
 * A logical message is a user message (non-tool-result), an assistant message,
 * or a UI notification. Tool-result-only user entries are NOT counted — they
 * ride along with their preceding assistant message.
 */
export function isLogicalMessage(entry: ChatEntry): boolean {
  if (entry.tag === 'ui') return true;
  if (entry.role === 'assistant') return true;
  if (entry.role === 'user' && Array.isArray(entry.content)) {
    const allToolResult = (entry.content as Array<{ type: string }>).every(
      (b) => b.type === 'tool_result',
    );
    if (allToolResult) return false;
  }
  return true;
}

export interface PaginationInfo {
  page: number;
  pageSize: number;
  totalMessages: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedEntries {
  messages: ChatEntry[];
  pagination: PaginationInfo;
}

/**
 * Get display entries for the browser with page-based pagination.
 *
 * Page 1 = most recent `pageSize` logical messages (reverse chronological).
 * Tool-result-only user entries don't count toward pageSize but ARE included
 * alongside their associated assistant/user message.
 *
 * @param page - 1-based page number (1 = most recent)
 * @param pageSize - number of logical messages per page (default 100)
 */
export async function getDisplayEntries(
  page = 1,
  pageSize = 100,
  agentId?: string,
  conversationId?: string,
): Promise<PaginatedEntries> {
  const store = await readStore(agentId, conversationId);
  const allEntries = store.entries ?? [];

  // Build an index of logical message positions
  const logicalIndices: number[] = [];
  for (let i = 0; i < allEntries.length; i++) {
    if (isLogicalMessage(allEntries[i])) {
      logicalIndices.push(i);
    }
  }

  const totalMessages = logicalIndices.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));

  // Page 1 = last pageSize logical messages, page 2 = the pageSize before that, etc.
  const endLogical = totalMessages - (page - 1) * pageSize;
  const startLogical = Math.max(0, endLogical - pageSize);

  if (endLogical <= 0 || startLogical >= totalMessages) {
    return {
      messages: [],
      pagination: { page, pageSize, totalMessages, totalPages, hasMore: false },
    };
  }

  // Convert logical message range to entry index range.
  const entryStart = logicalIndices[startLogical];
  const entryEnd = endLogical < totalMessages
    ? logicalIndices[endLogical]
    : allEntries.length;

  return {
    messages: allEntries.slice(entryStart, entryEnd),
    pagination: {
      page,
      pageSize,
      totalMessages,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}

/**
 * Get display messages for the browser (legacy format).
 * @deprecated Use getDisplayEntries() instead.
 */
export async function getDisplayHistory(agentId?: string, conversationId?: string): Promise<DisplayMessage[]> {
  const result = await getDisplayEntries(1, Number.MAX_SAFE_INTEGER, agentId, conversationId);
  return result.messages.map(entryToDisplayMessage);
}

/**
 * Convert a ChatEntry to the legacy DisplayMessage format for backward compat.
 */
function entryToDisplayMessage(entry: ChatEntry): DisplayMessage {
  let content: string;
  if (typeof entry.content === 'string') {
    content = entry.content;
  } else if (entry.tag === 'ai' && entry.displayText) {
    content = entry.displayText;
  } else if (Array.isArray(entry.content)) {
    // Extract text from content blocks
    const textParts = (entry.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    content = textParts.join('') || '';
  } else {
    content = '';
  }

  return {
    role: entry.role,
    content,
    timestamp: entry.timestamp,
    source: entry.source,
    cronJobName: entry.cronJobName,
    notification: entry.notification,
    taskId: entry.taskId,
  };
}

/**
 * Scan non-compacted entries and collect the most recent contextHashes.
 * Merges hashes across entries — for each key, the latest entry's hash wins.
 * Used by enrichTaskContext to determine which content fields changed.
 */
export async function getLastContextHashes(agentId?: string, conversationId?: string): Promise<Record<string, string>> {
  const store = await readStore(agentId, conversationId);
  const entries = store.entries ?? [];
  const merged: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.compacted) continue;
    if (entry.contextHashes) {
      Object.assign(merged, entry.contextHashes);
    }
  }

  return merged;
}

// ── Public API: writing ──

/**
 * Push AI entries (conversation turns) into the store.
 * Content is the raw Anthropic format (string or ContentBlock[]).
 *
 * PRINCIPLE: What AI sees = what human sees. Avoid displayText overrides
 * for content divergence. Use displayText only for formatting hints, never
 * to hide content from the user that the AI can see.
 */
export async function addAIMessages(
  msgs: MessageParam[],
  options?: { displayText?: string; source?: ChatEntry['source']; contextHashes?: Record<string, string>; taskId?: string; agentId?: string; conversationId?: string },
): Promise<void> {
  if (msgs.length === 0) return;
  const aid = options?.agentId;
  const cid = options?.conversationId;
  return withWriteLock(async () => {
    const store = await readStore(aid, cid);
    const now = new Date().toISOString();
    let displayTextAttached = false;

    // ── Dedup guard: if the last store entry is an eagerly-persisted user message
    //    (has turnId) and the first msg in this batch is also a user message, skip it.
    //    Belt-and-suspenders — callers should already skip the user msg. ──
    const lastStoreEntry = store.entries!.length > 0
      ? store.entries![store.entries!.length - 1]
      : null;
    const skipFirstUser = !!(
      lastStoreEntry?.tag === 'ai' && lastStoreEntry.role === 'user' && lastStoreEntry.turnId
      && msgs.length > 0 && (msgs[0] as { role: string }).role === 'user'
    );
    if (skipFirstUser) {
      log.agent.debug('Dedup guard: skipping first user msg (already eagerly persisted)');
    }

    for (let i = 0; i < msgs.length; i++) {
      if (i === 0 && skipFirstUser) continue;
      const msg = msgs[i];
      const { role, content } = msg as { role: string; content: unknown };
      const entry: ChatEntry = {
        tag: 'ai',
        role: role as 'user' | 'assistant',
        content,
        timestamp: now,
      };
      // Attach displayText + contextHashes + taskId to the first user message in this batch only
      if (options?.displayText && role === 'user' && !displayTextAttached) {
        entry.displayText = options.displayText;
        if (options.contextHashes) entry.contextHashes = options.contextHashes;
        if (options.taskId) entry.taskId = options.taskId;
        displayTextAttached = true;
      }
      if (options?.source) {
        entry.source = options.source;
      }
      store.entries!.push(entry);
    }
    await writeStore(store, aid, cid);
    await touchConversationBestEffort(store, aid, cid);
    log.agent.info('AI messages persisted', { count: msgs.length, agentId: aid });
  }, aid, cid);
}

/**
 * Persist a single user message eagerly (before the agent loop runs).
 * Ensures the message survives page refreshes during processing.
 * Tagged 'ai' so it appears in both model context and display.
 * The turnId field enables dedup guards in addAIMessages.
 */
export async function addUserMessage(
  content: string | unknown[],
  options?: {
    displayText?: string;
    contextHashes?: Record<string, string>;
    taskId?: string;
    source?: ChatEntry['source'];
    turnId?: string;
    agentId?: string;
    conversationId?: string;
  },
): Promise<void> {
  const aid = options?.agentId;
  const cid = options?.conversationId;
  return withWriteLock(async () => {
    const store = await readStore(aid, cid);
    const entry: ChatEntry = {
      tag: 'ai',
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    if (options?.displayText) entry.displayText = options.displayText;
    if (options?.contextHashes) entry.contextHashes = options.contextHashes;
    if (options?.taskId) entry.taskId = options.taskId;
    if (options?.source) entry.source = options.source;
    if (options?.turnId) entry.turnId = options.turnId;
    store.entries!.push(entry);
    await writeStore(store, aid, cid);
    await touchConversationBestEffort(store, aid, cid);
    log.agent.info('User message eagerly persisted', { turnId: options?.turnId, agentId: aid });
  }, aid, cid);
}

/**
 * Check for orphaned user messages left by a server crash during processing.
 * If the last AI entry is a user message with no assistant response following,
 * add a recovery notification so the user knows to resend.
 * Call once at server startup.
 */
export async function recoverOrphanedUserMessage(agentId?: string, conversationId?: string): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore(agentId, conversationId);
    const entries = store.entries ?? [];

    // Find the last AI-tagged entry (skip trailing UI notifications)
    let lastAiIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].tag === 'ai') { lastAiIdx = i; break; }
    }
    if (lastAiIdx < 0) return;

    const lastAi = entries[lastAiIdx];
    if (lastAi.role !== 'user') return; // last AI entry is assistant → no orphan
    if (!lastAi.turnId) return; // only eagerly-persisted messages (with turnId) can be orphans

    log.agent.warn('Orphaned user message detected at startup', {
      turnId: lastAi.turnId,
      timestamp: lastAi.timestamp,
    });

    store.entries!.push({
      tag: 'ui',
      role: 'assistant',
      content: 'Your previous message was saved, but the response was interrupted by a server restart. You may want to resend it.',
      timestamp: new Date().toISOString(),
      source: 'agent-error',
      notification: true,
    });
    await writeStore(store, agentId, conversationId);
  }, agentId, conversationId);
}

/**
 * Push a UI-only entry (notification: cron, session result, error, compaction divider).
 */
export async function addNotification(msg: {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  source?: ChatEntry['source'];
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
  sessionId?: string;
  agentId?: string;
  conversationId?: string;
}): Promise<void> {
  const aid = msg.agentId;
  const cid = msg.conversationId;
  return withWriteLock(async () => {
    const store = await readStore(aid, cid);
    const entry: ChatEntry = {
      tag: 'ui',
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      source: msg.source,
      cronJobName: msg.cronJobName,
      notification: msg.notification,
      taskId: msg.taskId,
    };
    if (msg.sessionId) entry.sessionId = msg.sessionId;
    store.entries!.push(entry);
    await writeStore(store, aid, cid);
    log.agent.debug('chat notification added', { source: msg.source, role: msg.role, agentId: aid });
  }, aid, cid);
}

/**
 * Get triage notification entries from chat history (newest first).
 * Used by the Triage History panel.
 *
 * For entries missing sessionId (stored before the sessionId field was added),
 * attempts to backfill by matching against embedded "Session Triage:" sessions.
 */
export async function getTriageEntries(
  limit = 50,
  taskId?: string,
  agentId?: string,
  conversationId?: string,
): Promise<{ entries: ChatEntry[]; total: number }> {
  const store = await readStore(agentId, conversationId);
  const allEntries = store.entries ?? [];

  let triage = allEntries.filter(
    (e) => e.source === 'triage' && !e.compacted,
  );

  if (taskId) {
    triage = triage.filter((e) => e.taskId === taskId);
  }

  const total = triage.length;

  // Newest first, apply limit
  triage.reverse();
  if (limit > 0) {
    triage = triage.slice(0, limit);
  }

  // Backfill sessionId for old entries by matching to embedded triage sessions
  const needsBackfill = triage.some((e) => !e.sessionId);
  if (needsBackfill) {
    try {
      const { listSessions } = await import('./session-tracker.js');
      const sessions = await listSessions();
      // Build index: taskId → triage sessions sorted by time
      const triageSessions = sessions.filter(
        (s) => s.provider === 'embedded' && s.title?.startsWith('Session Triage:'),
      );
      const byTask = new Map<string, typeof triageSessions>();
      for (const s of triageSessions) {
        const list = byTask.get(s.taskId) ?? [];
        list.push(s);
        byTask.set(s.taskId, list);
      }

      for (const entry of triage) {
        if (entry.sessionId || !entry.taskId) continue;
        const candidates = byTask.get(entry.taskId);
        if (!candidates || candidates.length === 0) continue;
        // Find the session closest in time (within 60s) to the triage entry
        const entryTime = new Date(entry.timestamp).getTime();
        let best: typeof triageSessions[0] | null = null;
        let bestDist = Infinity;
        for (const s of candidates) {
          const sTime = new Date(s.startedAt).getTime();
          const dist = Math.abs(entryTime - sTime);
          if (dist < bestDist && dist < 120_000) { // within 2 minutes
            bestDist = dist;
            best = s;
          }
        }
        if (best) {
          entry.sessionId = best.claudeSessionId;
        }
      }
    } catch {
      // Non-critical — old entries just won't have session links
    }
  }

  return { entries: triage, total };
}

/**
 * Append a new turn's messages to the store and persist.
 * @deprecated Use addAIMessages() and addNotification() instead.
 * Kept for backward compatibility with existing call sites and tests.
 */
export async function addTurn(
  apiMsgs: MessageParam[],
  displayMsgs: DisplayMessage[],
  agentId?: string,
  conversationId?: string,
): Promise<DisplayMessage[]> {
  return withWriteLock(async () => {
    const store = await readStore(agentId, conversationId);
    const now = new Date().toISOString();

    // Build a map of role → timestamp from display messages for AI entry timestamps
    const normalDisplayByRole = new Map<string, DisplayMessage[]>();
    for (const dm of displayMsgs) {
      if (!dm.source && !dm.notification) {
        const key = dm.role;
        if (!normalDisplayByRole.has(key)) normalDisplayByRole.set(key, []);
        normalDisplayByRole.get(key)!.push(dm);
      }
    }

    // Add AI entries from apiMsgs, using display message timestamps when available
    const roleCounters = new Map<string, number>();
    for (const msg of apiMsgs) {
      const { role, content } = msg as { role: string; content: unknown };
      // Try to find matching display message timestamp
      const idx = roleCounters.get(role) ?? 0;
      const matchingDisplay = normalDisplayByRole.get(role)?.[idx];
      roleCounters.set(role, idx + 1);

      store.entries!.push({
        tag: 'ai',
        role: role as 'user' | 'assistant',
        content,
        timestamp: matchingDisplay?.timestamp ?? now,
      });
    }

    // Add UI entries for notification display messages
    for (const dm of displayMsgs) {
      if (dm.source || dm.notification) {
        store.entries!.push({
          tag: 'ui',
          role: dm.role,
          content: dm.content,
          timestamp: dm.timestamp,
          source: dm.source,
          cronJobName: dm.cronJobName,
          notification: dm.notification,
          taskId: dm.taskId,
        });
      }
      // Normal display messages (non-notification) are already covered by the AI entries above.
    }

    await writeStore(store, agentId, conversationId);
    return displayMsgs;
  }, agentId, conversationId);
}

/**
 * Clear all chat history.
 */
export async function clear(agentId?: string, conversationId?: string): Promise<void> {
  return withWriteLock(async () => {
    await writeStore(freshStore(), agentId, conversationId);
  }, agentId, conversationId);
}

// ── Compaction ──

/**
 * Check whether the full API payload (system + tools + messages) exceeds the
 * token threshold and needs compaction.
 *
 * Threshold is 80% of the model's context window (200K default, 1M for `[1m]` models).
 * Reads `agent.main_model` from config to detect the window size.
 */
export async function needsCompaction(agentId?: string, conversationId?: string): Promise<boolean> {
  const modelMsgs = await getModelContext(agentId, conversationId);

  // Read model from config to compute context-aware threshold
  let threshold: number;
  try {
    const { getConfig } = await import('./config-manager.js');
    const config = await getConfig();
    const model = config.agent?.main_model;
    threshold = getContextThreshold(model, COMPACTION_PERCENT);
  } catch {
    // Fallback: assume 200K default window
    threshold = getContextThreshold(undefined, COMPACTION_PERCENT);
  }

  let fullTotal: number;
  let breakdown: { system: number; tools: number; messages: number; total: number };
  try {
    // Dynamic imports for agent modules to avoid circular dependencies
    // (context.js and tools.js import from chat-history.ts)
    const { buildSystemPrompt } = await import('../agent/context.js');
    const { getToolSchemas } = await import('../agent/tools.js');
    const system = await buildSystemPrompt(agentId, conversationId);
    const tools = getToolSchemas();
    breakdown = estimateFullPayload({ system, tools, messages: modelMsgs });
    fullTotal = breakdown.total;
  } catch (err) {
    // Fallback: add a conservative overhead estimate so this doesn't silently
    // revert to the old under-counting bug. The system prompt + tool schemas
    // typically consume ~120K tokens; using that as a floor prevents the exact
    // scenario this fix was designed to prevent.
    const FALLBACK_OVERHEAD = 120_000;
    log.agent.warn('needsCompaction: full payload estimation failed, using conservative overhead', {
      error: String(err),
      fallbackOverhead: FALLBACK_OVERHEAD,
    });
    const msgTokens = estimateMessagesTokens(modelMsgs);
    fullTotal = msgTokens + FALLBACK_OVERHEAD;
    breakdown = { system: FALLBACK_OVERHEAD, tools: 0, messages: msgTokens, total: fullTotal };
  }

  // Gate in REAL-token space, not estimate space. The offline estimator undercounts
  // Claude 3+ payloads by ~35%, so a real ~1.03M-token history estimated ~758K and
  // sailed under the 800K threshold — compaction NEVER fired and the conversation grew
  // until it 400'd at the hard ~1M API limit. effectiveTotalTokens() takes the larger
  // of (estimate × 1.35) and the last EXACT API input_tokens for this conversation.
  // (Same root cause + fix as the triage bail — see token-truth.ts.)
  const effectiveTotal = effectiveTotalTokens(fullTotal, conversationId);
  const needed = effectiveTotal > threshold;
  log.agent.info('needsCompaction check', {
    messageCount: modelMsgs.length,
    systemTokens: `~${Math.round(breakdown.system / 1000)}K`,
    toolsTokens: `~${Math.round(breakdown.tools / 1000)}K`,
    messageTokens: `~${Math.round(breakdown.messages / 1000)}K`,
    // `fullTotal` retained as an alias of the raw estimate for backward-compatible log
    // scraping; `effectiveTotal` is the real-token-space value the gate actually uses.
    fullTotal: `~${Math.round(fullTotal / 1000)}K`,
    rawEstimate: `~${Math.round(fullTotal / 1000)}K`,
    effectiveTotal: `~${Math.round(effectiveTotal / 1000)}K`,
    lastExact: (() => { const e = getLastTurnTokens(conversationId ?? ''); return e ? `~${Math.round(e / 1000)}K` : 'unknown'; })(),
    threshold: `${Math.round(threshold / 1000)}K`,
    needed,
  });
  return needed;
}

/**
 * Extract content between XML tags. Returns null if tag not found.
 */
export function extractXmlTag(text: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Extract all <project path="...">content</project> entries from <project-memories>.
 */
export function extractProjectMemories(text: string): Array<{ path: string; content: string }> {
  const block = extractXmlTag(text, 'project-memories');
  if (!block) return [];

  const results: Array<{ path: string; content: string }> = [];
  const regex = /<project\s+path="([^"]+)">([\s\S]*?)<\/project>/g;
  let match;
  while ((match = regex.exec(block)) !== null) {
    const content = match[2].trim();
    if (content) {
      results.push({ path: match[1], content });
    }
  }
  return results;
}

/**
 * Serialize API messages into human-readable text for the compaction prompt.
 */
export function serializeMessages(msgs: MessageParam[]): string {
  return msgs
    .map((msg) => {
      const role = (msg as { role: string }).role;
      const content = (msg as { content: unknown }).content;
      if (typeof content === 'string') return `${role}: ${content}`;
      if (Array.isArray(content)) {
        const textParts = content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text);
        const toolParts = content
          .filter((b: { type: string }) => b.type === 'tool_use')
          .map((b: { name: string }) => `[tool: ${b.name}]`);
        const resultParts = content
          .filter((b: { type: string }) => b.type === 'tool_result')
          .map(() => '[tool result]');
        const imageParts = content
          .filter((b: { type: string }) => b.type === 'image')
          .map((b: { source?: { media_type?: string }; media_type?: string; path?: string }) => {
            // Path-based images (new format)
            if (b.path) return `[image: ${b.media_type ?? 'unknown'}]`;
            // Legacy base64 images
            return `[image: ${b.source?.media_type ?? 'unknown'}]`;
          });
        return `${role}: ${[...imageParts, ...textParts, ...toolParts, ...resultParts].join(' ')}`;
      }
      return `${role}: [complex content]`;
    })
    .join('\n\n');
}

/**
 * Build the compaction summary prompt.
 *
 * Two variants:
 * - Initial (no prior summary): produces a full structured checkpoint
 * - Incremental (prior summary exists): merges new messages into existing summary
 */
/**
 * Build compaction instruction — the summarize directive WITHOUT serialized messages.
 * Messages are passed as actual MessageParam[] history to the LLM call so they
 * share the Bedrock prompt cache prefix with the main chat and memory flush.
 */
export function buildCompactionInstruction(previousSummary?: string | null): string {
  const formatSpec = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes — include file paths and brief description]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Files Modified
- [file path] — [what changed and why]

## Errors & Fixes
- [Error encountered]: [How it was resolved]
- [User feedback]: [How approach was adjusted]

## All User Messages
- [List every non-tool-result user message — these are critical for understanding changing intent and feedback]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, code snippets, or references needed to continue]
- [Or "(none)" if not applicable]`;

  if (previousSummary) {
    return `The preceding messages are NEW conversation messages to incorporate into the existing summary.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

${formatSpec}

Keep each section concise — use bullet points, not prose. Target ~2000 tokens total. Preserve exact file paths, function names, and error messages. Pay special attention to the most recent messages.

<previous-summary>
${previousSummary}
</previous-summary>`;
  }

  return `The preceding messages are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

${formatSpec}

Keep each section concise — use bullet points, not prose. Target ~2000 tokens total. Preserve exact file paths, function names, and error messages. Pay special attention to the most recent messages.

IMPORTANT — write this as a HISTORICAL HANDOFF RECORD, not as instructions:
- Phrase "In Progress" and "Next Steps" items as factual state of what HAD been happening ("was editing X", "had planned to Y"), NOT as imperatives ("edit X", "do Y").
- This summary becomes background reference on later turns; it must never read as a fresh command. The user's next message is the source of truth for what to do — the summary only records what already happened.`;
}

/**
 * @deprecated Use buildCompactionInstruction() instead. Kept for backward compatibility with tests.
 */
export function buildCompactionPrompt(readable: string, previousSummary?: string | null): string {
  const instruction = buildCompactionInstruction(previousSummary);
  return previousSummary
    ? `${instruction}\n\nNew messages to incorporate:\n${readable}`
    : `${instruction}\n\nConversation to compact:\n${readable}`;
}

/**
 * Compaction result — just the summary text (memory is handled by step 1).
 */
export interface CompactionResult {
  summary: string;
}

/**
 * Memory flush prompt — sent as a real agent turn so the agent can use
 * the `memory` tool to persist knowledge before compaction discards old messages.
 */
export const MEMORY_FLUSH_MESSAGE = `Pre-compaction memory flush.

Persist knowledge using the \`memory\` tool. Write as a butler's journal —
record what matters for RECALL, not for git log.

## Daily log — what to write (append, max 800 chars)

- **User requests**: their words, not paraphrased. Task names + IDs, not commits
- **Decisions & why**: important choices and reasoning
- **Struggles**: what blocked, how resolved, root causes, user corrections
- **Events**: personal matters, noteworthy non-task events, new patterns
- **Open threads**: unresolved questions, pending items

DO NOT: commit SHAs, file line counts, bundle sizes, deploy status tables,
implementation details (those → project memory).

Think: "What would I need to recall 2 weeks from now?"

## Project memory — update with technical decisions
## Global memory — update with new user preferences
If nothing new → "Nothing to persist."`;

/**
 * Minimum number of AI entries required before running memory flush.
 * With fewer than this, there's unlikely enough content to persist.
 */
const MEMORY_FLUSH_MIN_ENTRIES = 8;

/**
 * Slim down content: truncate tool_use inputs and tool_result content.
 * Keeps tool names and text blocks fully intact.
 *
 * @param stripImageData — when true, replaces base64 image data with '[compacted]'.
 *   Only pass true for entries being marked as compacted. Kept entries must preserve
 *   image data so hydrateImagePaths can reconstruct them for the API.
 */
function slimContent(content: unknown, stripImageData = false): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  return content.map((block: Record<string, unknown>) => {
    // Strip thinking blocks — compacted entries are never re-sent to the API
    if (block.type === 'thinking') return null;
    if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      const slimmed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(block.input as Record<string, unknown>)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        slimmed[k] = s.length > SLIM_TOOL_INPUT_MAX
          ? s.slice(0, SLIM_TOOL_INPUT_MAX) + '… [truncated]'
          : v;
      }
      return { ...block, input: slimmed };
    }
    if (block.type === 'tool_result') {
      // Structured content blocks (may contain images from tool returns)
      if (Array.isArray(block.content)) {
        const slimmed = (block.content as Array<Record<string, unknown>>).map(sub => {
          if (sub.type === 'image') {
            // Replace image with text placeholder to avoid storing large base64 in history
            return { type: 'text', text: '[image content]' };
          }
          return sub;
        });
        return { ...block, content: slimmed };
      }
      // Original string-based path
      const raw = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      return {
        ...block,
        content: raw.length > SLIM_TOOL_RESULT_MAX
          ? raw.slice(0, SLIM_TOOL_RESULT_MAX) + '… [truncated]'
          : block.content,
      };
    }
    // Path-based image blocks are already small (just a file path) — no stripping needed.
    // Source-based image blocks: only strip data for compacted entries.
    // Kept entries must preserve data so it can be hydrated back for the API.
    if (stripImageData && block.type === 'image' && block.source && typeof block.source === 'object') {
      return {
        ...block,
        source: { ...(block.source as Record<string, unknown>), data: '[compacted]' },
      };
    }
    return block;
  }).filter(Boolean);
}

/**
 * Two-step compaction:
 *
 * Step 1 (Memory Flush): Runs a real agent turn with the full tool set.
 *   The agent sees the current conversation and uses the `memory` tool
 *   to persist knowledge to daily logs, project memory, and global memory.
 *
 * Step 2 (Summarize): LLM call with fresh conversation (empty history).
 *   Produces a structured checkpoint summary stored as compactionSummary
 *   and injected into the system prompt on subsequent turns.
 *
 * All entries before the turn boundary are DELETED from `entries[]` — both
 * old AI conversation and older UI notifications (triage/cron/subagent).
 * Their context is preserved in `compactionSummary` (AI) and in each
 * subagent's own JSONL file (notifications). Keeping them in chat-history
 * only grows the file with no access benefit.
 *
 * Kept entries (the recent turns) are slimmed to prevent single large
 * tool_results from bloating future turns.
 *
 * @param summarizer — function that takes the compaction prompt and returns AI summary
 * @param memoryFlusher — optional function that runs the memory flush agent turn
 */
export async function compact(
  summarizer: (instruction: string, history: MessageParam[]) => Promise<string>,
  memoryFlusher?: (messages: MessageParam[]) => Promise<void>,
  agentId?: string,
  conversationId?: string,
): Promise<CompactionResult | null> {
  let store = await readStore(agentId, conversationId);
  let entries = store.entries ?? [];

  // Get non-compacted AI entries for compaction consideration
  let aiEntries = entries.filter((e) => e.tag === 'ai' && !e.compacted);
  const aiMsgs = aiEntries.map((e) => ({ role: e.role, content: e.content }) as MessageParam);

  log.agent.info('compaction start', { aiEntries: aiEntries.length });

  // Need at least 1 turn beyond what we keep to have something to compact
  if (aiMsgs.length <= 2) return null;

  // ── Find turn boundary upfront ──
  // Compute boundary before starting any LLM calls so we can run flush + summarizer
  // in parallel. The boundary depends only on message structure (user turn count),
  // which doesn't change during flush (flush writes to memory files, not chat entries).
  const boundaryIdx = findTurnBoundaryIndex(aiEntries, RECENT_TURNS_TO_KEEP);
  if (boundaryIdx === null) return null; // not enough turns to compact

  log.agent.info('compaction boundary', {
    compacting: boundaryIdx,
    keeping: aiEntries.length - boundaryIdx,
  });

  const oldMsgs = aiEntries.slice(0, boundaryIdx)
    .map((e) => ({ role: e.role, content: e.content }) as MessageParam);

  // Guard: if there are fewer than 4 old messages, compaction isn't worthwhile
  if (oldMsgs.length < 4) return null;

  // Build the summarizer instruction upfront (no serialized messages — messages
  // are passed as actual MessageParam[] history so they share the Bedrock cache
  // prefix with the main chat and memory flush).
  const previousSummary = store.compactionSummary;
  const instruction = buildCompactionInstruction(previousSummary);

  // ── Run flush + summarizer in parallel ──
  // No data dependency: flush writes to memory files, summarizer reads chat messages.
  // Both receive the full aiMsgs as history so they share the same Bedrock cache
  // prefix (system + tools + messages), maximizing cache-read hits.
  const shouldFlush = memoryFlusher && aiEntries.length >= MEMORY_FLUSH_MIN_ENTRIES;
  if (!shouldFlush) {
    log.agent.info('compaction memory flush skipped', {
      reason: !memoryFlusher ? 'no flusher' : `${aiEntries.length} < ${MEMORY_FLUSH_MIN_ENTRIES} entries`,
    });
  }

  // Prevent working memory updater from running during compaction
  const { setCompacting } = await import('../agent/working-memory-updater.js');
  setCompacting(true, agentId, conversationId);

  try {
    // ── Try working memory as compaction summary (saves an LLM call) ──
    const workingMemoryContent = getWorkingMemory(agentId, conversationId);
    const useWorkingMemory = workingMemoryContent != null && !isWorkingMemoryEmpty(workingMemoryContent);

    if (useWorkingMemory) {
      log.agent.info('compaction: using working memory as summary (skipping summarizer)');
      // Snapshot working memory to compaction archive
      try { snapshotWorkingMemory(agentId, conversationId); } catch (err) {
        log.agent.debug('working memory snapshot failed (non-critical)', { error: String(err) });
      }
    }

    const [summary] = await Promise.all([
      // Summarizer: skip if working memory is available
      useWorkingMemory
        ? Promise.resolve(truncateWorkingMemoryForCompact(workingMemoryContent))
        : summarizer(instruction, aiMsgs),
      // Memory flusher: runs in parallel if eligible, errors don't block summarizer
      shouldFlush
        ? memoryFlusher(aiMsgs)
            .then(() => log.agent.info('compaction memory flush done'))
            .catch((err) => log.agent.warn('Memory flush failed during compaction, continuing', { error: String(err) }))
        : Promise.resolve(),
    ]);

    // Step A (memory flush) already writes to daily log via the agent's memory tool.
    // Step B (summarizer) only produces a summary for chat-history.json — no daily log write needed.

    // Final phase: re-read, mark compacted, write — all under write lock
    // to prevent concurrent writes from being lost.
    return withWriteLock(async () => {
      // Re-read store to pick up any concurrent writes during the LLM calls.
      // Recompute boundary on fresh data to avoid stale-index mismatches.
      store = await readStore(agentId, conversationId);
      entries = store.entries ?? [];
      aiEntries = entries.filter((e) => e.tag === 'ai' && !e.compacted);
      const freshBoundaryIdx = findTurnBoundaryIndex(aiEntries, RECENT_TURNS_TO_KEEP);

      // If the fresh data no longer supports compaction, bail out (store the summary
      // but don't mark anything compacted — unlikely but possible under heavy concurrency).
      if (freshBoundaryIdx === null) {
        store.compactionSummary = summary;
        store.compactionCount++;
        await writeStore(store, agentId, conversationId);
        return { summary };
      }

      // Map the AI-only boundary index back to an entries[] index, then DELETE
      // everything before it. Old AI conversation + older UI notifications
      // (triage/cron/subagent) are discarded together — their context is
      // preserved in compactionSummary (for AI) and in each subagent's JSONL
      // (for notifications). This keeps the file small forever.
      let aiSeen = 0;
      let entriesCutoff = entries.length;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.tag === 'ai' && !e.compacted) {
          if (aiSeen === freshBoundaryIdx) {
            entriesCutoff = i;
            break;
          }
          aiSeen++;
        }
      }
      const prunedCount = entriesCutoff;
      store.entries = entries.slice(entriesCutoff);

      // Slim kept entries (fixes ~50K token bloat from huge tool_results),
      // preserving image paths so they can be hydrated when sent to the API.
      for (const e of store.entries) {
        if (e.tag === 'ai' && !e.compacted) {
          e.content = slimContent(e.content, /* stripImageData */ false);
        }
      }

      store.compactionSummary = summary;
      store.compactionCount++;
      await writeStore(store, agentId, conversationId);

      // The conversation just shrank — forget the pre-prune exact token count so the
      // next needsCompaction/triage gate doesn't re-fire on a now-stale large value.
      // (The next real turn re-populates it via the onUsage callback.)
      if (conversationId) clearLastTurnTokens(conversationId);

      log.agent.info('compaction pruned entries', {
        prunedCount,
        remaining: store.entries.length,
        agentId,
      });

      log.agent.info('compaction complete', {
        compactionNumber: store.compactionCount,
        summaryLength: summary.length,
        agentId,
      });

      // Fire-and-forget: compact today's daily log if it's oversized.
      // Threshold: 8K tokens (~32KB). The summarizer is provided by the caller
      // or we skip if none available. This is a defense-in-depth measure.
      compactDailyLog(formatDateKey(), DAILY_LOG_COMPACT_THRESHOLD, async (content) => {
        // Use the same summarizer with a daily-log-specific instruction
        const [compactedSummary] = await Promise.all([
          summarizer(
            'Compact this daily log into a concise summary. Preserve key decisions, outcomes, and action items. Remove redundant entries and verbose session recaps. Keep timestamps for important events. Output markdown.',
            [{ role: 'user' as const, content }],
          ),
        ]);
        return compactedSummary;
      }).catch((err) => {
        log.agent.warn('Daily log compaction failed (non-critical)', { error: String(err) });
      });

      return { summary };
    }, agentId, conversationId);
  } finally {
    setCompacting(false, agentId, conversationId);
  }
}
