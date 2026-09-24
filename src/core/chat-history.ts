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

import type { MessageParam } from '../model/model.js';
import { getContextThreshold } from '../model/model.js';
import type { ChatHistoryStore, ChatEntry, DisplayMessage } from './types.js';
import { CHAT_HISTORY_FILE, chatHistoryFile, conversationFile } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { estimateMessagesTokens, estimateTokens, compactDailyLog, formatDateKey } from './daily-log.js';
import { getWorkingMemory, isWorkingMemoryEmpty, truncateWorkingMemoryForCompact, snapshotWorkingMemory } from './working-memory.js';
import { effectiveTotalTokens, getLastTurnTokens, clearLastTurnTokens } from './token-truth.js';
import { log } from '../logging/index.js';
import fsp from 'node:fs/promises';
import { compressForApi, MAX_BASE64_BYTES } from '../utils/image-compress.js';
import { indexChatEntries } from './history-db.js';
import { addNotification as addFeedNotification } from './notifications/store.js';

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
  const tail = new Promise<void>((r) => { resolve = r; });
  writeLocks.set(key, tail);
  return prev.then(fn).finally(() => {
    resolve!();
    // Delete only if WE are still the tail. Race guarded: A finishes while B is
    // already chained on A's tail — an unconditional delete here would let a
    // newly-arriving C start a FRESH chain concurrent with B (read-modify-write
    // overlap = lost writes). Same pattern in conversations.ts/side-questions.ts
    // — keep all three in sync.
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  });
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
            (b.source as Record<string, unknown>).data === '[compacted]') ||
          // Recovery: legacy rows may hold raw base64 that predates the
          // dimension clamp. Those replay verbatim on EVERY later turn, so one
          // oversized image would 400 the whole conversation forever. Route
          // them through the clamp too.
          (b.type === 'image' && b.source && typeof b.source === 'object' &&
            typeof (b.source as Record<string, unknown>).data === 'string' &&
            (b.source as Record<string, unknown>).data !== '[compacted]'),
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
            // Recovery for inline base64 stored before the dimension clamp existed.
            if (block.type === 'image' && block.source && typeof block.source === 'object') {
              const src = block.source as Record<string, unknown>;
              if (typeof src.data === 'string') {
                try {
                  const raw = Buffer.from(src.data, 'base64');
                  const { buffer, mimeType } = await compressForApi(raw, (src.media_type as string) ?? 'image/png');
                  const base64 = buffer.toString('base64');
                  if (base64.length > MAX_BASE64_BYTES) {
                    return { type: 'text', text: `[image: ${mimeType} — too large even after compression]` };
                  }
                  return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
                } catch {
                  return { type: 'text', text: '[image: unreadable]' };
                }
              }
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

function isLegacySyntheticAgentError(entry: ChatEntry): boolean {
  if (entry.tag !== 'ai' || entry.role !== 'assistant' || entry.source) return false;
  if (!Array.isArray(entry.content) || entry.content.length !== 1) return false;
  const block = entry.content[0] as { type?: unknown; text?: unknown };
  return block?.type === 'text'
    && typeof block.text === 'string'
    && /^\[Error:\s[\s\S]*\]$/.test(block.text.trim());
}

/** Runtime errors live in the notification center, never the chat timeline. */
export function isNotificationOnlyError(entry: ChatEntry): boolean {
  return entry.source === 'agent-error'
    || entry.source === 'session-error'
    || isLegacySyntheticAgentError(entry);
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
  // Keep legacy error entries on disk for model context/forensics, but exclude
  // them before pagination so they neither render nor consume chat page slots.
  const allEntries = (store.entries ?? []).filter((entry) => !isNotificationOnlyError(entry));

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
  options?: {
    displayText?: string; source?: ChatEntry['source']; contextHashes?: Record<string, string>;
    taskId?: string; agentId?: string; conversationId?: string; turnId?: string;
    /** Which engine produced this answer — see the engine-stamp section below.
     *  Stamped on the ASSISTANT entries of the batch only (a tool_result carrier
     *  is not an answer), and never sent to the model. */
    engine?: string;
  },
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
      // The turn's id, on the ASSISTANT entries only. It is what lets the browser
      // recognise a reloaded message as the same message it just streamed:
      // `<suggest>` action cards key their "already clicked" receipts on it
      // (web/src/utils/suggest-parse.ts), and a per-turn value is the right
      // granularity because chatEntriesToMessages folds one turn's entries into
      // ONE displayed message, reading its metadata off the leading assistant
      // entry. It never reaches the model — getModelContext projects
      // `{ role, content }` only.
      //
      // Deliberately NOT stamped on the user (tool_result) entries of the batch:
      // the dedup guard above reads "an `ai` user entry carrying a turnId" as
      // "eagerly persisted by addUserMessage", and widening that would blur the
      // one signal it has.
      if (options?.turnId && role === 'assistant') {
        entry.turnId = options.turnId;
      }
      // Engine provenance, assistant entries only: it answers "who produced
      // this?", and the tool_result carriers of a batch produced nothing.
      if (options?.engine && role === 'assistant') {
        (entry as EngineStampedEntry).engine = options.engine;
      }
      store.entries!.push(entry);
    }
    await writeStore(store, aid, cid);
    await touchConversationBestEffort(store, aid, cid);
    // Mirror into the conversation FTS index (history.db) — best-effort,
    // derived data; a failure must never break chat persistence.
    const appendedCount = msgs.length - (skipFirstUser ? 1 : 0);
    if (appendedCount > 0) {
      indexChatEntries(store.entries!.slice(-appendedCount), aid, cid);
    }
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
    /** Write only if no entry already carries this `turnId`. For the rescue path
     *  in api-v1: a turn that dies before its eager persist loses the user's
     *  message entirely, and the error handler re-writes it — but it cannot know
     *  whether the persist got in first. Checked INSIDE the write lock, so the
     *  answer can't go stale between the read and the push. */
    onlyIfTurnAbsent?: boolean;
  },
): Promise<void> {
  const aid = options?.agentId;
  const cid = options?.conversationId;
  return withWriteLock(async () => {
    const store = await readStore(aid, cid);
    if (options?.onlyIfTurnAbsent && options.turnId
        && (store.entries ?? []).some((e) => e.turnId === options.turnId)) {
      return;
    }
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
    // Mirror into the conversation FTS index — best-effort (see addAIMessages).
    indexChatEntries([entry], aid, cid);
    log.agent.info('User message eagerly persisted', { turnId: options?.turnId, agentId: aid });
  }, aid, cid);
}

/**
 * Check for orphaned user messages left by a server crash during processing.
 * If the last AI entry is a user message with no assistant response following,
 * add a notification-center entry so the user knows to resend.
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

    await addFeedNotification({
      kind: 'operation-error',
      severity: 'error',
      title: 'Chat Interrupted',
      body: 'Your previous message was saved, but the response was interrupted by a server restart. You may want to resend it.',
      dedupKey: `chat-interrupted:${agentId ?? 'general'}:${conversationId ?? 'unknown'}:${lastAi.turnId}`,
    });
  }, agentId, conversationId);
}

// ── Lane-turn orphan adoption (mid-turn server death) ──────────────────────

/**
 * A user message whose answer never reached the store.
 *
 * The shape a mid-turn server death leaves behind on the lane engine: the CLI
 * finishes the turn and durably writes the answer (its stream JSONL + its own
 * transcript), but the turn's promise and subscription lived in the process that
 * was killed, so nothing ever called `addAIMessages`. The conversation then
 * reads user→user with the answer stranded on disk. The healer that pairs the
 * two back up is `core/sessions/lane-orphan-recovery.ts`.
 */
export interface OrphanTurnTail {
  /** The eagerly-persisted user entry's turn id — the adoption key. */
  turnId: string;
  /** Plain text of the user message (what the lane session was sent). */
  text: string;
  /** The user entry's own timestamp — the correlation anchor against the stream. */
  timestamp: string;
}

/**
 * One turn-starting user message, orphaned or not.
 *
 * The healer needs the WHOLE ordered sequence, not just the orphans: it pairs
 * same-text store turns with same-text stream turns BY ORDER, so a turn that
 * already has its answer still occupies its ordinal. Dropping the answered ones
 * would shift every ordinal after them and silently re-point an orphan at a
 * neighbour's answer.
 */
export interface StoreTurnRef {
  /** Absent for a turn a background producer persisted without one. */
  turnId?: string;
  text: string;
  timestamp: string;
  /** No assistant entry between this turn and the next turn-starting user one. */
  orphan: boolean;
}

/** Plain text of an entry, or '' when it carries none (image-only, tool blocks). */
function entryPlainText(entry: ChatEntry): string {
  const c = entry.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** True for an `ai` user entry that STARTS a turn (not a tool_result echo). */
function isTurnStartingUserEntry(entry: ChatEntry): boolean {
  return entry.tag === 'ai' && entry.role === 'user' && isTurnStart(entry);
}

/**
 * ChatEntry plus the recovery marker. Declared locally on purpose: unknown JSON
 * fields round-trip untouched through the store, and the marker is forensic —
 * no reader keys behavior off it, so it does not belong in the shared type.
 */
type RecoveredChatEntry = ChatEntry & { recovered: true; recoveredFrom: string };

/** Turns kept by `listStoreTurns` — enough to cover any stream tail window, and
 *  bounded so a 5000-entry conversation is never walked whole into memory. */
const MAX_STORE_TURNS = 200;

/**
 * The conversation's turn-starting user messages, oldest-first, each flagged
 * with whether it is orphaned.
 *
 * This is the SEQUENCE the healer aligns against the stream. It deliberately
 * includes answered turns and turns with no turnId: both consumed a delivery
 * slot in the stream, so both hold an ordinal.
 */
export async function listStoreTurns(
  agentId: string,
  conversationId: string,
): Promise<StoreTurnRef[]> {
  const store = await readStore(agentId, conversationId);
  const entries = store.entries ?? [];

  const starts: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isTurnStartingUserEntry(entries[i])) starts.push(i);
  }

  const turns: StoreTurnRef[] = [];
  for (let k = 0; k < starts.length; k++) {
    const idx = starts[k];
    const entry = entries[idx];
    const end = k + 1 < starts.length ? starts[k + 1] : entries.length;
    let answered = false;
    for (let j = idx + 1; j < end; j++) {
      if (entries[j].tag === 'ai' && entries[j].role === 'assistant') { answered = true; break; }
    }
    const text = entryPlainText(entry).trim() || (entry.displayText ?? '').trim();
    turns.push({
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      text,
      timestamp: entry.timestamp,
      orphan: !answered,
    });
  }
  return turns.slice(-MAX_STORE_TURNS);
}

/**
 * Orphan-tail scan: turn-starting user messages in the recent tail that have no
 * assistant entry before the next user message.
 *
 * Finds BOTH shapes a killed turn leaves: a store that simply ends with a user
 * message, and a mid-list gap (two consecutive user messages, e.g. the user
 * retyped the question after the answer never came).
 *
 * Bounded by `maxScan` turns counted from the END (default 20): a healer must
 * not walk a 2000-entry conversation, and an older orphan is unadoptable anyway
 * because its stream tail has long since scrolled out of the read window.
 *
 * ANY assistant entry counts as answered, INCLUDING a persisted `[Error: …]`
 * one. A turn that already recorded a verdict is a different defect, and
 * adopting on top of it would show two answers to one question.
 *
 * A turn with no turnId is never returned: there is no key to adopt against.
 * It still appears in `listStoreTurns` — it holds its ordinal there.
 */
export async function listOrphanTurnTails(
  agentId: string,
  conversationId: string,
  opts?: { maxScan?: number },
): Promise<OrphanTurnTail[]> {
  const maxScan = Math.max(1, opts?.maxScan ?? 20);
  const turns = await listStoreTurns(agentId, conversationId);
  return turns
    .slice(-maxScan)
    .filter((t): t is StoreTurnRef & { turnId: string } => t.orphan && !!t.turnId && !!t.text)
    .map((t) => ({ turnId: t.turnId, text: t.text, timestamp: t.timestamp }));
}

export type AdoptRecoveredOutcome = 'adopted' | 'turn-missing' | 'no-orphan' | 'already-present';

/**
 * Insert a recovered assistant answer immediately after the user message it
 * answers, marked as recovered.
 *
 * INSERT, not append: an orphan is often mid-list (the user retyped and later
 * turns landed after it), and appending would put the answer at the bottom of
 * the conversation — wrong for the reader and wrong for model context.
 *
 * Every check runs INSIDE the write lock, immediately before the write, because
 * the whole point is that this races the ordinary persist path:
 *   - `turn-missing`     — the user entry is gone (history cleared/compacted).
 *   - `no-orphan`        — an assistant entry appeared for that turn meanwhile.
 *   - `already-present`  — this exact answer text is on disk somewhere already,
 *     which is what makes a second pass a no-op. A lane result carries no id, so
 *     exact text equality is the only idempotency key available; a false match
 *     costs us one un-adopted answer, while a false miss would duplicate one.
 *
 * The adopted entry carries the ORIGINAL turnId. That is what keeps a client
 * safe: a phone still holding a provisional bubble for that turn finalizes it
 * (its reconcile is keyed on the turn) instead of rendering a second copy.
 */
export async function adoptRecoveredAssistantMessage(opts: {
  agentId: string;
  conversationId: string;
  /** turnId of the orphaned USER entry this answer belongs to. */
  turnId: string;
  text: string;
  /** Honest completion time (stream marker + turn duration); defaults to now. */
  timestamp?: string;
  /** Provenance stamped on the entry. */
  recoveredFrom?: string;
}): Promise<AdoptRecoveredOutcome> {
  const { agentId, conversationId, turnId, text } = opts;
  if (!text.trim()) return 'no-orphan';
  return withWriteLock(async () => {
    const store = await readStore(agentId, conversationId);
    const entries = store.entries ?? [];
    const idx = entries.findIndex(
      (e) => e.turnId === turnId && e.tag === 'ai' && e.role === 'user',
    );
    if (idx < 0) return 'turn-missing';

    let end = entries.length;
    for (let j = idx + 1; j < entries.length; j++) {
      if (isTurnStartingUserEntry(entries[j])) { end = j; break; }
    }
    for (let j = idx + 1; j < end; j++) {
      if (entries[j].tag === 'ai' && entries[j].role === 'assistant') return 'no-orphan';
    }

    const needle = text.trim();
    for (const e of entries) {
      if (e.tag === 'ai' && e.role === 'assistant' && entryPlainText(e).trim() === needle) {
        return 'already-present';
      }
    }

    const entry: RecoveredChatEntry = {
      tag: 'ai',
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: opts.timestamp || new Date().toISOString(),
      turnId,
      recovered: true,
      recoveredFrom: opts.recoveredFrom ?? 'lane-stream',
    };
    entries.splice(idx + 1, 0, entry);
    store.entries = entries;
    await writeStore(store, agentId, conversationId);
    await touchConversationBestEffort(store, agentId, conversationId);
    // Mirror into the conversation FTS index — best-effort, and position-free
    // (rows are appended with their own timestamp), so a mid-list insert is fine.
    indexChatEntries([entry], agentId, conversationId);
    log.agent.warn('adopted a stranded lane answer into the conversation', {
      agentId, conversationId, turnId, textLength: text.length, insertedAt: idx + 1,
    });
    return 'adopted';
  }, agentId, conversationId);
}

// ── Engine provenance, and seeding a fresh engine with the conversation ────
//
// THE INVARIANT: every engine that answers a turn in a conversation must be
// given that conversation's whole prior content, so the model's memory is never
// narrower than what the UI shows. The in-process loop satisfies it by
// construction — it reads this store on every turn (getModelContext). A LANE
// engine does not: a `claude` CLI minted for a conversation that already has
// turns starts with an empty context while the phone and the console keep
// rendering the whole conversation, so it answers "there is no such context in
// this conversation" about text the user is looking at.
//
// Two mechanisms close that, and they are deliberately different because the
// seam can open at two different moments:
//
//   1. THE MINT. buildConversationSeed renders the prior conversation into the
//      spawn profile's system prompt (personal-ai-lane.resolveLane). It rides
//      the profile, NOT a first user turn: a turn burns a turn, the model often
//      answers it, and the mint sites that pass no first message at all (a
//      read-driven `ensure: true` mint, which the phone's model pill triggers on
//      mount) would produce a visible orphan turn.
//   2. THE TURN. A lane can already exist and THEN miss content: the Mac sleeps,
//      the cloud replica answers a turn with its in-process fallback and
//      persists it, the Mac wakes and continues on the SAME lane. Nothing is
//      re-minted, so nothing re-seeds. buildLaneCatchUp finds exactly those
//      entries and the sender prepends them to the user's next message
//      (lane-turn.runLaneTurn).
//
// Both need to know WHICH engine produced an entry, which is what the `engine`
// stamp is for. Before it the answering engine rode only the terminal SSE frame
// and never reached disk, which is why the incident had to be reconstructed from
// commit authorship and tool-name vocabulary.

/**
 * ChatEntry plus the engine that produced it.
 *
 * A local extension for the same reason as RecoveredChatEntry above: unknown
 * JSON fields round-trip untouched through the store, and every writer and
 * reader of this stamp lives in THIS module — the catch-up rule below is the
 * only thing that keys behavior off it. The model never sees it either
 * (getModelContext projects `{ role, content }` only).
 */
export type EngineStampedEntry = ChatEntry & { engine?: string };

/** The engine that answered this entry, or undefined when it is unstamped. */
export function entryEngine(entry: ChatEntry): string | undefined {
  const value = (entry as EngineStampedEntry).engine;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The engine label for one Personal AI lane session.
 *
 * Per-SESSION, not per-engine-kind ('claude-code'), because the catch-up rule
 * needs to distinguish "this lane answered it" from "some other engine did", and
 * a re-minted lane (a failed `--resume`, an engine swap) is a different context
 * that has to be seeded again. It is also the strictly more useful forensic
 * value: it names the transcript the answer can be read back from.
 */
export function laneEngineLabel(sessionId: string): string {
  return `lane:${sessionId}`;
}

// ── Turns the cloud companion answered, adopted by the primary ─────────────
//
// When the primary provably cannot receive a phone turn, the cloud companion
// answers it on its own lane and banks the turn in a NON-git outbox
// (core/cloud-chat-outbox.ts). It never writes this store: a conversation file
// has ONE writer, the primary, because git-sync merges it per file last-writer-
// wins and two boxes appending inside one sync window drops one side's entries.
// Once the primary is reachable again it adopts each banked turn here, exactly
// once by turnId.

/** Engine-label namespace of the cloud companion's own lanes. */
export const CLOUD_ENGINE_PREFIX = 'cloud:';

/** The engine label for one cloud-companion lane session. */
export function cloudEngineLabel(sessionId: string): string {
  return `${CLOUD_ENGINE_PREFIX}${sessionId}`;
}

/**
 * ChatEntry plus adoption provenance. Local extension for the same reason as
 * EngineStampedEntry: unknown JSON fields round-trip untouched through the store.
 * `adoptedFrom` is the answering engine label; `adoptedAt` is when THIS store
 * learned of the turn, which can be long after the turn's own timestamps.
 */
type AdoptedChatEntry = EngineStampedEntry & { adoptedFrom?: string; adoptedAt?: string };

/** True for an entry the primary adopted from the cloud companion's outbox. */
export function isAdoptedCloudEntry(entry: ChatEntry): boolean {
  const from = (entry as AdoptedChatEntry).adoptedFrom;
  return typeof from === 'string' && from.startsWith(CLOUD_ENGINE_PREFIX);
}

/**
 * When this store learned of an entry: its own timestamp, or its adoption time
 * when that is later. The catch-up rule compares against a lane's high-water
 * mark, and a turn adopted after the mark moved past the turn's own clock would
 * otherwise never be given to that lane.
 */
function entryKnownAt(entry: ChatEntry): string {
  const adoptedAt = (entry as AdoptedChatEntry).adoptedAt;
  return typeof adoptedAt === 'string' && adoptedAt > entry.timestamp ? adoptedAt : entry.timestamp;
}

/** Of `turnIds`, the ones already adopted into this conversation. */
export async function listAdoptedTurnIds(
  agentId: string,
  conversationId: string,
  turnIds: string[],
): Promise<string[]> {
  if (turnIds.length === 0) return [];
  const wanted = new Set(turnIds);
  const store = await readStore(agentId, conversationId);
  const found = new Set<string>();
  for (const entry of store.entries ?? []) {
    if (entry.turnId && wanted.has(entry.turnId)) found.add(entry.turnId);
  }
  return [...found];
}

export interface CloudTurnAdoption {
  agentId: string;
  conversationId: string;
  turnId: string;
  userText: string;
  userAt: string;
  /** The answer, or absent for a turn that failed on the companion. */
  answerText?: string;
  answeredAt?: string;
  /** Failure text for an unanswered turn (stored as an error notification). */
  error?: string;
  /** cloudEngineLabel(<companion lane session>). */
  engine: string;
}

/**
 * Write one banked cloud turn into this conversation, idempotent by turnId.
 *
 * `already-present` when ANY entry already carries the turnId, which is what
 * makes a retried adoption (a lost reply) a no-op. Checked inside the write lock,
 * immediately before the write, because the check and the write must not be
 * separable by a concurrent adoption of the same turn.
 *
 * INSERTED by time, never merely appended: the turn happened while the primary
 * was unreachable, and the primary may have answered its own turns since (a web
 * console chat on the same conversation). It goes in front of the first turn
 * that STARTED after it, on a turn boundary, so it never splits another turn.
 *
 * A failed turn keeps the user's words plus the same `[Error: …]` notification
 * entry the primary writes for its own failed turns: the error is filtered out of
 * every timeline, and it marks the turn as answered, so the lane orphan healer
 * never tries to pair it with an unrelated lane answer.
 */
export async function adoptCloudTurn(opts: CloudTurnAdoption): Promise<'adopted' | 'already-present'> {
  const { agentId, conversationId, turnId } = opts;
  return withWriteLock(async () => {
    const store = await readStore(agentId, conversationId);
    const entries = store.entries ?? [];
    if (entries.some((e) => e.turnId === turnId)) return 'already-present';

    const adoptedAt = new Date().toISOString();
    const provenance = { adoptedFrom: opts.engine, adoptedAt };
    const user: AdoptedChatEntry = {
      tag: 'ai', role: 'user', content: opts.userText, displayText: opts.userText,
      timestamp: opts.userAt, turnId, ...provenance,
    };
    const answerAt = opts.answeredAt && opts.answeredAt >= opts.userAt ? opts.answeredAt : opts.userAt;
    const answer: AdoptedChatEntry = opts.answerText
      ? {
          tag: 'ai', role: 'assistant', content: [{ type: 'text', text: opts.answerText }],
          timestamp: answerAt, turnId, engine: opts.engine, ...provenance,
        }
      : {
          tag: 'ai', role: 'assistant', source: 'agent-error',
          content: [{ type: 'text', text: `[Error: ${opts.error || 'The cloud companion did not answer this turn.'}]` }],
          timestamp: answerAt, turnId, ...provenance,
        };

    let at = entries.length;
    for (let i = 0; i < entries.length; i++) {
      if (isTurnStartingUserEntry(entries[i]) && entries[i].timestamp > opts.userAt) { at = i; break; }
    }
    entries.splice(at, 0, user, answer);
    store.entries = entries;
    await writeStore(store, agentId, conversationId);
    await touchConversationBestEffort(store, agentId, conversationId);
    indexChatEntries([user, answer], agentId, conversationId);
    log.agent.info('adopted a turn the cloud companion answered', {
      agentId, conversationId, turnId, engine: opts.engine, answered: !!opts.answerText,
      insertedAt: at, appended: at === entries.length - 2,
    });
    return 'adopted';
  }, agentId, conversationId);
}

/**
 * Per-lane high-water marks: laneLabel → the timestamp of the newest entry that
 * lane has been GIVEN. Store-level rather than per-entry so the common turn
 * (nothing to catch up) costs no write at all, and so a 900-entry conversation
 * is not rewritten with a `seenBy` array on every row.
 *
 * The KEY's presence is itself the signal "this lane has been seeded once".
 */
type LaneSeenStore = ChatHistoryStore & { laneSeen?: Record<string, string> };

/** Token ceiling for one injected block. Chat latency and the spawn argv both
 *  bound this; see personal-ai-lane's byte clamp for the argv half. */
export const CONVERSATION_SEED_TOKEN_BUDGET = 10_000;

/** Rough bytes-per-token, used only to pre-clamp before tokenizing. */
const SEED_BYTES_PER_TOKEN = 4;

/** Cost of the `\n\n` that joins two rendered turns — inside the budget, not on
 *  top of it (see renderSeed). */
const SEED_JOIN_BYTES = 2;
const SEED_JOIN_TOKENS = 1;

/** At most this share of the budget goes to the compaction summary, so a long
 *  summary can never crowd out the recent turns (which are the concrete part). */
const SEED_SUMMARY_BUDGET_SHARE = 0.3;

export const CONVERSATION_SEED_HEADER = '## Conversation so far (injected by Walnut)';
const CONVERSATION_SEED_PREAMBLE = 'These turns already happened in THIS conversation and the user can still see them on screen. Treat them as your own memory of it: do not greet the user again, and never say a topic was not discussed just because it is not written below. If your own context already holds these turns, this block is a duplicate — ignore it.';

const CATCH_UP_HEADER = '## Conversation turns you have not seen (injected by Walnut)';
/**
 * True for BOTH triggers, deliberately. Trigger A carries turns another engine
 * answered; trigger B carries turns that simply predate this session. An earlier
 * wording claimed "answered elsewhere while this session was unreachable" for
 * both, which is a confident false statement to a model in the trigger-B case
 * (the lane was never unreachable — it never existed). Also carries the seed
 * preamble's duplicate-tolerance sentence: after a sync merge drops a high-water
 * mark this block can arrive for turns the model already holds, and "ignore the
 * duplicate" is the only instruction that makes that harmless.
 */
const CATCH_UP_PREAMBLE = 'These turns are part of THIS conversation and the user can see them on screen, but they may not be in your own context: some were answered by a different engine, and some are older than this session. Treat them as your own memory of the conversation, and never say a topic was not discussed just because it is not written here. If your context already holds these turns, this block is a duplicate — ignore it. The message AFTER this block is the user\'s new message; answer that one.';

/** Stated, never silent: a model that cannot see something concludes it never
 *  happened, which is the exact failure this whole section exists to fix. */
export const CONVERSATION_SEED_OMITTED_NOTICE = '_(earlier turns omitted to fit the context budget — ask the user if you need anything from before this point)_';

/**
 * Banner wrapper for a block that rides a MESSAGE rather than a system prompt.
 *
 * Uses the established `[Banner]…[/Banner]` convention (task context, cron and
 * plan-mode prefixes already use it) so the two readers that strip a leading
 * banner keep working: the mobile transcript projection and the conversation
 * auto-titler. Without it the user's own bubble would open with the recap and
 * the conversation would be titled after it.
 */
export const CATCH_UP_BANNER_OPEN = '[Conversation context]';
export const CATCH_UP_BANNER_CLOSE = '[/Conversation context]';

export interface ConversationSeedStats {
  /** Turns available to inject (after the "cut at the last answer" rule). */
  turnsTotal: number;
  /** Turns that survived the budget. */
  turnsKept: number;
  /** True when anything was dropped or clipped — the notice is then present. */
  omitted: boolean;
  bytes: number;
  tokens: number;
}

export interface ConversationSeed {
  /** The rendered block, or '' when there is nothing to inject. */
  text: string;
  /**
   * Timestamp of the newest entry the block covers, '' when it covers nothing.
   * Recorded as the lane's high-water mark once the block has been delivered.
   */
  watermark: string;
  stats: ConversationSeedStats;
}

/**
 * One turn-shaped unit of the conversation.
 *
 * Rendering and TOKENIZING are lazy on purpose. The overwhelmingly common turn
 * finds nothing to inject, and eagerly rendering + tokenizing every turn of a
 * 900-entry conversation would put tens of milliseconds of synchronous tokenizer
 * work on the shared event loop for every single lane send. Selection runs on
 * the cheap metadata below; only the turns the budget actually considers are
 * ever turned into text.
 */
interface SeedTurn {
  /** The turn's model-facing entries (a shallow slice, not a copy). */
  entries: ChatEntry[];
  /** Newest entry timestamp in the turn — the watermark candidate. */
  timestamp: string;
  /** Engines that answered inside this turn (empty = unstamped/legacy). */
  answeredBy: string[];
  /** Newest ANSWER timestamp in the turn (what the watermark is compared to). */
  answeredAt: string;
  /** Memoized renders. */
  _text?: string;
  _bytes?: number;
  _tokens?: number;
}

/** What replaces one of Walnut's own control markers found inside quoted history. */
const SEED_MARKER_PLACEHOLDER = '[marker removed by Walnut]';

/**
 * Neutralize Walnut's own block markers inside quoted conversation content.
 *
 * A stored message can contain the exact terminator of the block being built —
 * most easily by quoting a previous injected block back. The two server-side
 * banner strippers happen to survive it (they take the LAST occurrence, and the
 * real terminator is always last), so this is NOT a stripping bug: it is what the
 * MODEL reads, where a forged terminator makes the user's real message look like
 * part of the quoted history, and what the transcript renderer shows.
 */
function neutralizeSeedMarkers(text: string): string {
  let out = text;
  for (const marker of [CATCH_UP_BANNER_CLOSE, CATCH_UP_BANNER_OPEN, CONVERSATION_SEED_HEADER, CATCH_UP_HEADER]) {
    if (out.includes(marker)) out = out.split(marker).join(SEED_MARKER_PLACEHOLDER);
  }
  return out;
}

function seedTurnText(turn: SeedTurn): string {
  if (turn._text !== undefined) return turn._text;
  const lines: string[] = [];
  for (const entry of turn.entries) {
    const text = neutralizeSeedMarkers(seedEntryText(entry));
    if (!text) continue;
    const label = entry.role === 'user' ? '**User:**' : '**You:**';
    // Continuation lines are INDENTED. Without it, lines 2..n of a multi-line
    // message sit at column 0 with no speaker attached, so a pasted transcript
    // (or any line that merely looks like a speaker label) reads as a new
    // speaker's turn — and the label prefix is only honest for line 1.
    const [first, ...rest] = text.split('\n');
    lines.push(rest.length === 0
      ? `${label} ${first}`
      : `${label} ${first}\n${rest.map((line) => `  ${line}`).join('\n')}`);
  }
  turn._text = lines.join('\n\n');
  return turn._text;
}

function seedTurnBytes(turn: SeedTurn): number {
  if (turn._bytes === undefined) turn._bytes = Buffer.byteLength(seedTurnText(turn), 'utf-8');
  return turn._bytes;
}

function seedTurnTokens(turn: SeedTurn): number {
  if (turn._tokens === undefined) turn._tokens = estimateTokens(seedTurnText(turn));
  return turn._tokens;
}

/** True when this entry's content carries an image block (path or base64). */
function hasImageBlock(entry: ChatEntry): boolean {
  return Array.isArray(entry.content)
    && (entry.content as Array<{ type?: string }>).some((b) => b?.type === 'image');
}

/**
 * The text of one entry as the seed renders it: TEXT blocks only.
 *
 * `thinking`, `tool_use` and `tool_result` blocks are dropped — they are
 * engine-specific, they are most of the bytes, and a tool call replayed without
 * its result reads as an instruction rather than as history.
 */
function seedEntryText(entry: ChatEntry): string {
  const text = entryPlainText(entry).trim() || (entry.displayText ?? '').trim();
  if (text) return text;
  return hasImageBlock(entry) ? '(image attached)' : '';
}

/**
 * Group the conversation's model-facing entries into renderable turns.
 *
 * Two rules that both paths depend on:
 *  - the SAME projection getModelContext uses (`tag === 'ai' && !compacted`),
 *    MINUS the error entries, so the lane is given what the in-process engine
 *    would have been given and nothing else. An error row ("[Error: the main AI
 *    did not answer this turn]") is a notification about the infrastructure, not
 *    something a participant said: quoting it back as `**You:**` tells the model
 *    it authored an apology it never wrote, and the timeline the user is looking
 *    at does not show it either (getDisplayEntries filters the same predicate).
 *    Dropping it also correctly makes that turn UNANSWERED, so the cut-at-the-
 *    last-answer rule below stops at the last real answer;
 *  - CUT AT THE LAST ANSWER. Both senders eagerly persist the user's message
 *    BEFORE the turn runs, so the store already ends with the very message that
 *    is about to be delivered. Everything after the last assistant entry is that
 *    unanswered turn, and injecting it would show the user their own question
 *    twice.
 */
function collectSeedTurns(entries: ChatEntry[]): SeedTurn[] {
  const ai = entries.filter((e) => e.tag === 'ai' && !e.compacted && !isNotificationOnlyError(e));
  let lastAnswer = -1;
  for (let i = ai.length - 1; i >= 0; i--) {
    if (ai[i].role === 'assistant') { lastAnswer = i; break; }
  }
  if (lastAnswer < 0) return [];
  const answered = ai.slice(0, lastAnswer + 1);

  // Turn boundaries: a user entry that is not a tool_result carrier.
  const starts: number[] = [];
  for (let i = 0; i < answered.length; i++) {
    if (isTurnStartingUserEntry(answered[i])) starts.push(i);
  }
  // Content before the first turn start (a leading notification-shaped entry)
  // still belongs to the conversation — give it its own leading group.
  if (starts.length === 0 || starts[0] > 0) starts.unshift(0);

  const turns: SeedTurn[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : answered.length;
    const turnEntries = answered.slice(from, to);
    const answeredBy: string[] = [];
    let timestamp = '';
    let answeredAt = '';
    for (const entry of turnEntries) {
      // Adoption-aware (see entryKnownAt): a turn the cloud companion answered
      // becomes known to this store only when it is adopted, so a lane whose mark
      // moved past the turn's own clock in the meantime must still select it.
      const at = entryKnownAt(entry);
      if (at > timestamp) timestamp = at;
      if (entry.role === 'assistant') {
        const engine = entryEngine(entry);
        if (engine && !answeredBy.includes(engine)) answeredBy.push(engine);
        if (at > answeredAt) answeredAt = at;
      }
    }
    turns.push({ entries: turnEntries, timestamp, answeredBy, answeredAt });
  }
  return turns;
}

/** Clip to a byte ceiling on a character boundary, marking the cut. */
function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  const marker = '… [clipped]';
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf-8'));
  // Byte-safe slice: cut in the byte domain, then drop a broken tail character.
  const buf = Buffer.from(text, 'utf-8').subarray(0, room);
  return buf.toString('utf-8').replace(/�+$/, '') + marker;
}

/**
 * Render the NEWEST turns that fit, oldest-first, with the compaction summary
 * ahead of them and an explicit notice when anything was left out.
 *
 * Truncation direction is load-bearing: the newest turns are what the user is
 * looking at, so they are kept WHOLE and the oldest end is dropped. When even
 * the newest turn alone does not fit it is clipped rather than dropped — a block
 * that says nothing is worse than a block that says "this is the tail".
 */
function renderSeed(
  turns: SeedTurn[],
  summary: string | null,
  header: string,
  preamble: string,
  maxTokens: number,
  maxBytes: number,
): ConversationSeed {
  const empty: ConversationSeed = {
    text: '', watermark: '',
    stats: { turnsTotal: turns.length, turnsKept: 0, omitted: false, bytes: 0, tokens: 0 },
  };
  if (turns.length === 0) return empty;

  // The fixed scaffolding (header, preamble, notice, section joins) comes OUT of
  // the budget, not on top of it: `maxBytes` is an argv ceiling the provider
  // hard-fails on, so "the content fits and then we add 600 bytes of framing" is
  // not a budget at all. Same for tokens, so `stats.tokens <= maxTokens` is a
  // real invariant rather than one that holds only for the content.
  const overheadText = [header, preamble, CONVERSATION_SEED_OMITTED_NOTICE, '### Summary of earlier turns'].join('\n\n');
  const overhead = Buffer.byteLength(overheadText, 'utf-8') + 16;
  const byteBudget = Math.min(maxBytes - overhead, maxTokens * SEED_BYTES_PER_TOKEN);
  const tokenBudget = maxTokens - estimateTokens(overheadText);
  if (byteBudget <= 0 || tokenBudget <= 0) return empty;

  // The summary is the oldest content, so it gets a bounded share and never
  // crowds out the recent turns. Typed defensively: the field is JSON off disk,
  // and a non-string there used to throw out of this whole builder.
  let summaryText = '';
  let omitted = false;
  const summaryBody = typeof summary === 'string' ? summary.trim() : '';
  if (summaryBody) {
    const share = Math.floor(byteBudget * SEED_SUMMARY_BUDGET_SHARE);
    summaryText = clipToBytes(summaryBody, share);
    if (summaryText !== summaryBody) omitted = true;
  }
  let bytes = Buffer.byteLength(summaryText, 'utf-8');
  let tokens = summaryText ? estimateTokens(summaryText) : 0;

  /** Rendered turn bodies, oldest-first (what the block prints). */
  const kept: string[] = [];
  let watermark = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    // The newest turn CONSIDERED sets the watermark, whether or not it renders.
    // A turn whose every block is dropped by the filter (tool traffic only) has
    // still been resolved by this block: leaving the mark behind it would
    // re-select that turn on every send for the life of the lane. A running MAX
    // rather than the last turn by position: an adopted cloud turn can sit
    // earlier in the list than a turn it is newer than (see entryKnownAt).
    if (turn.timestamp > watermark) watermark = turn.timestamp;
    const body = seedTurnText(turn);
    if (!body) continue; // tool-only turn: nothing survives the block filter
    // The `\n\n` between two turns is content too, and it is what made the
    // rendered block overshoot `maxBytes` by up to a kilobyte on long recaps.
    const joins = kept.length > 0 ? 1 : 0;
    const cost = seedTurnBytes(turn) + joins * SEED_JOIN_BYTES;
    const costTokens = seedTurnTokens(turn) + joins * SEED_JOIN_TOKENS;
    if (bytes + cost <= byteBudget && tokens + costTokens <= tokenBudget) {
      kept.unshift(body);
      bytes += cost;
      tokens += costTokens;
      continue;
    }
    // The newest turn does not fit on its own → clip it, so the tail still
    // lands. A block that says nothing is worse than one that says "this is
    // where the conversation is right now".
    if (kept.length === 0) {
      const clipped = clipToBytes(body, Math.max(0, byteBudget - bytes));
      if (clipped.trim()) {
        kept.unshift(clipped);
        bytes += Buffer.byteLength(clipped, 'utf-8');
        tokens += estimateTokens(clipped);
      }
    }
    omitted = true;
    break;
  }
  // Every turn rendered empty. `watermark` is still carried out so the caller can
  // advance past them; `text` stays '' so nothing is injected.
  if (kept.length === 0) return { ...empty, watermark, stats: { ...empty.stats, omitted: true } };

  const parts = [header, preamble];
  if (summaryText) parts.push(`### Summary of earlier turns\n\n${summaryText}`);
  if (omitted) parts.push(CONVERSATION_SEED_OMITTED_NOTICE);
  parts.push(kept.join('\n\n'));
  const text = parts.join('\n\n');

  return {
    text,
    watermark,
    stats: {
      turnsTotal: turns.length,
      turnsKept: kept.length,
      omitted,
      bytes: Buffer.byteLength(text, 'utf-8'),
      tokens: estimateTokens(text),
    },
  };
}

/**
 * The whole prior conversation, rendered for a system prompt.
 *
 * `maxBytes` exists because the block rides the spawn argv on a claude lane and
 * the provider hard-FAILS a system prompt over 64KB (claude-code-session's
 * MAX_PROFILE_PROMPT_BYTES) — a seed that blew that limit would not degrade, it
 * would break the mint and take the whole chat down with it.
 */
export async function buildConversationSeed(
  agentId: string,
  conversationId: string,
  opts?: { maxTokens?: number; maxBytes?: number },
): Promise<ConversationSeed> {
  const store = await readStore(agentId, conversationId);
  return renderSeed(
    collectSeedTurns(store.entries ?? []),
    store.compactionSummary,
    CONVERSATION_SEED_HEADER,
    CONVERSATION_SEED_PREAMBLE,
    opts?.maxTokens ?? CONVERSATION_SEED_TOKEN_BUDGET,
    opts?.maxBytes ?? Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Shrink an ALREADY RENDERED seed to a byte ceiling, dropping whole turns from
 * the OLDEST end and keeping the header, the summary and the newest turns.
 *
 * The drift repair needs this. A lane's record carries `freshPersona + frozenSeed`
 * and the persona half is rewritten whenever skills/memory/persona change, so a
 * persona that GREW can push a record that minted just under the provider's
 * 64KB argv ceiling over it — and the provider does not degrade there, it throws
 * on the next cold `--resume` and the lane never comes back. The seed cannot be
 * rebuilt from the store at that point (the resume must re-emit the spawn-time
 * prompt byte-for-byte to hold the cache prefix, so a rebuilt-and-grown seed
 * would be a different prompt anyway), so the frozen text is shrunk in place.
 *
 * Lives here rather than in the lane module because THIS module owns the rendered
 * shape: continuation lines are indented, so a line starting with `**User:** ` at
 * column 0 is unambiguously the start of a turn (see seedTurnText).
 */
export function clipRenderedSeed(seed: string, maxBytes: number): string {
  if (Buffer.byteLength(seed, 'utf-8') <= maxBytes) return seed;
  const firstTurn = seed.search(/\n\n\*\*(?:User|You):\*\* /);
  // No recognizable turn boundary (a foreign or future shape): fall back to a
  // plain tail clip rather than guessing.
  if (firstTurn < 0) return clipToBytes(seed, maxBytes);
  const head = seed.slice(0, firstTurn);
  const bodies = seed.slice(firstTurn + 2).split(/\n\n(?=\*\*(?:User|You):\*\* )/);
  // Whatever survives is a tail of the conversation, so the notice must be there.
  const framed = head.includes(CONVERSATION_SEED_OMITTED_NOTICE)
    ? head
    : `${head}\n\n${CONVERSATION_SEED_OMITTED_NOTICE}`;
  const render = (kept: string[]): string => `${framed}\n\n${kept.join('\n\n')}`;
  const kept = bodies.slice();
  while (kept.length > 1 && Buffer.byteLength(render(kept), 'utf-8') > maxBytes) kept.shift();
  return clipToBytes(render(kept), maxBytes);
}

export interface LaneCatchUpInput {
  agentId: string;
  conversationId: string;
  /** laneEngineLabel(sessionId) of the lane about to be sent to. */
  laneLabel: string;
  /**
   * "Does this lane's spawn profile carry the mint seed?" (its record's
   * systemPrompt contains CONVERSATION_SEED_HEADER).
   *
   * It suppresses the one-shot full recap below, and it is checked IN ADDITION to
   * the high-water mark because the mark lives in a git-synced file: a
   * last-writer-wins merge can drop it, and re-injecting a whole conversation on
   * that basis would be a big, visible duplicate. Losing a small foreign-turn
   * catch-up the same way is cheap.
   *
   * A THUNK, not a value, so the common turn — mark present, nothing foreign —
   * never pays for the record read this answer needs.
   */
  seededAtMint: () => boolean | Promise<boolean>;
  /**
   * When the lane was minted (its record's `startedAt`) — the FLOOR for trigger A
   * when the high-water mark is missing.
   *
   * The mark lives in a git-synced, whole-file last-writer-wins document, so it
   * can be lost. Without a floor, a lost mark makes '' the comparison base and
   * every foreign answer in the conversation's whole history counts as "newer
   * than the mark": a lane that already holds 40 turns gets all 40 re-injected.
   * A seeded lane provably holds everything up to its own mint, so its mint time
   * is a sound floor. Also a THUNK, and only ever called on the same rare path
   * as seededAtMint (no mark).
   */
  laneSeededAt?: () => string | Promise<string>;
  /**
   * Read the lane's high-water mark from somewhere OTHER than this store. The
   * cloud companion's own lane keeps its mark in a machine-local sidecar,
   * because the conversation file is git-synced with exactly one writer (the
   * primary) and the companion must never write it. Absent = the store's
   * `laneSeen` map, as for every primary-side lane.
   */
  readMark?: () => Promise<string | undefined>;
  /**
   * Count an UNSTAMPED answer as another engine's. Off for primary-side lanes:
   * the web chat's compat copy of a lane turn carries no stamp, and there the
   * lane itself gave it. On for the cloud companion's lane, which stamps every
   * answer it gives (`cloud:<sid>`), so an unstamped one was provably given
   * elsewhere and trigger A would otherwise never carry it.
   */
  unstampedIsForeign?: boolean;
  maxTokens?: number;
}

/**
 * Entries this LANE has not been given, or null in the (overwhelmingly common)
 * case that there are none. A returned block with an empty `text` means "nothing
 * to say, but advance the mark" — see `deliverable` below.
 *
 * ── The detection rule, and why it is idempotent ──
 *
 * Two independent triggers, both anchored on facts written to disk:
 *
 *  A. FOREIGN ANSWERS. An assistant entry stamped with an engine that is not
 *     this lane, newer than this lane's high-water mark. That is the honest
 *     signal: the stamp says who answered, so "not this lane" IS "this lane
 *     never saw it". The turn is expanded to include the user message it
 *     answers — a foreign answer without its question is unreadable, and the
 *     user's own message carries no stamp of its own.
 *  B. NEVER SEEDED. No high-water mark AND no seed in the spawn profile. That is
 *     an ACP lane (which has no system-prompt channel at all, so this is its
 *     ONLY channel) or a lane minted before the seed existed. Fires at most once
 *     and injects the same recap the mint would have.
 *
 * Idempotency comes from the high-water mark, which the caller records only
 * AFTER the block has actually been delivered (recordLaneSeen). A retry that
 * never reached the CLI therefore re-injects; a delivered one never does,
 * because every entry it covered is now at or below the mark. Trigger B is
 * additionally latched by the profile check, so it cannot re-fire even if the
 * mark is lost in a sync merge.
 *
 * The NORMAL turn is a no-op with no store write: every answer in the
 * conversation carries THIS lane's label, so trigger A finds nothing, and the
 * mark exists, so trigger B is off. Cost is one store read (see the caller).
 *
 * DECLARED GAP: trigger A selects TURNS THAT WERE ANSWERED elsewhere. A user
 * message that got no answer at all (the user sent two in a row and only the
 * second was answered) is not carried by it — only the answered turn's own
 * question is. Widening the rule to "any turn with no answer" would also re-feed
 * a lane its own orphaned question (a turn killed mid-flight), which is a
 * confident wrong statement about what happened; a provable signal that misses a
 * rare case is the better trade. Trigger B, which is not looking for provenance,
 * carries everything.
 */
export async function buildLaneCatchUp(input: LaneCatchUpInput): Promise<ConversationSeed | null> {
  const { agentId, conversationId, laneLabel, seededAtMint } = input;
  const store = await readStore(agentId, conversationId) as LaneSeenStore;
  const watermark = input.readMark ? await input.readMark() : store.laneSeen?.[laneLabel];
  const turns = collectSeedTurns(store.entries ?? []);
  if (turns.length === 0) return null;

  const maxTokens = input.maxTokens ?? CONVERSATION_SEED_TOKEN_BUDGET;

  // Trigger B — never seeded. The whole prior conversation, once.
  if (watermark === undefined && !(await seededAtMint())) {
    return deliverable(renderSeed(
      turns, store.compactionSummary, CATCH_UP_HEADER, CATCH_UP_PREAMBLE,
      maxTokens, Number.MAX_SAFE_INTEGER,
    ));
  }

  // Trigger A — turns answered by another engine after our high-water mark. When
  // the mark was lost, the mint time floors the comparison (see laneSeededAt).
  let mark = watermark;
  if (mark === undefined) mark = (await input.laneSeededAt?.()) ?? '';
  const unseen = turns.filter((t) =>
    t.answeredAt > mark && (
      t.answeredBy.some((engine) => engine !== laneLabel)
      || (input.unstampedIsForeign === true && t.answeredAt !== '' && t.answeredBy.length === 0)
    ));
  if (unseen.length === 0) return null;
  return deliverable(renderSeed(
    unseen, null, CATCH_UP_HEADER, CATCH_UP_PREAMBLE, maxTokens, Number.MAX_SAFE_INTEGER,
  ));
}

/**
 * A rendered catch-up worth acting on: one with text to inject, OR one that
 * resolved turns into no text at all and therefore only has a mark to advance.
 *
 * The second case is not hypothetical bookkeeping. A foreign turn made entirely
 * of tool traffic renders to nothing after the block filter, so before this the
 * mark stayed behind it and that same turn was re-selected, re-rendered and
 * re-discarded on EVERY send for the life of the lane. The caller sends nothing
 * and commits the mark (see lane-turn.withCatchUpContext).
 */
function deliverable(seed: ConversationSeed): ConversationSeed | null {
  return seed.text || seed.watermark ? seed : null;
}

/**
 * Record how far a lane has been caught up. Called AFTER the block reached the
 * lane (a mint's spawn, or a completed send) — that ordering is what makes a
 * failed delivery retry instead of silently losing the content.
 *
 * A watermark of '' is meaningful: the KEY's presence latches "this lane has
 * been seeded", which is what keeps trigger B from re-firing on a conversation
 * that was empty at mint.
 */
export async function recordLaneSeen(
  agentId: string,
  conversationId: string,
  laneLabel: string,
  watermark: string,
): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore(agentId, conversationId) as LaneSeenStore;
    const current = store.laneSeen?.[laneLabel];
    // Never move BACKWARD: two producers can serialize out of order here, and a
    // lower mark would re-inject content the lane already has.
    if (current !== undefined && watermark <= current) return;
    store.laneSeen = { ...(store.laneSeen ?? {}), [laneLabel]: watermark };
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

  // Messages are the only part Walnut owns. The turn runs in a `claude` lane
  // session, whose system prompt and tool schemas are the CLI's, so there is
  // nothing here to estimate them from — and guessing a fixed overhead is what
  // this gate must not do (it decides when to prune a real conversation).
  // effectiveTotalTokens closes the gap with the number that is exact: the input
  // count the lane's last turn reported.
  const fullTotal = estimateMessagesTokens(modelMsgs);

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
    messageTokens: `~${Math.round(fullTotal / 1000)}K`,
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
 * Compaction: summarize, then prune.
 *
 * Summarize: one LLM call that produces a structured checkpoint summary, stored
 *   as compactionSummary and injected into the system prompt on subsequent
 *   turns. Skipped entirely when working memory already holds a usable summary.
 *
 * `memoryFlusher` is an optional hook that runs alongside the summarizer to
 *   persist knowledge before old messages are discarded. No production caller
 *   supplies one.
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
 * @param memoryFlusher — optional pre-prune memory persistence hook
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
  const { setCompacting } = await import('./memory/working-memory-updater.js');
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

    // The summarizer only produces a summary for chat-history.json — no daily
    // log write needed here.

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
