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
import type { ChatHistoryStore, ChatEntry, DisplayMessage } from './types.js';
import { CHAT_HISTORY_FILE } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { estimateMessagesTokens, estimateFullPayload, compactDailyLog, formatDateKey } from './daily-log.js';
import { log } from '../logging/index.js';
import fsp from 'node:fs/promises';
import { compressForApi, MAX_BASE64_BYTES } from '../utils/image-compress.js';

const COMPACTION_TOKEN_THRESHOLD = 160_000;
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
// Without this, concurrent callers (chat, cron, session triage, compaction) can
// read the same snapshot, modify independently, and overwrite each other's writes.
let writeLock: Promise<void> = Promise.resolve();

/**
 * Serialize a read-modify-write operation on the chat history store.
 * All public write functions must go through this to prevent data loss.
 */
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
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

async function readStore(): Promise<ChatHistoryStore> {
  const raw = await readJsonFile<ChatHistoryStore>(CHAT_HISTORY_FILE, freshStore());

  // Migrate v1 → v2
  if (raw.version === 1 || (!raw.entries && (raw.apiMessages || raw.displayMessages))) {
    const migrated = migrateV1toV2(raw);
    await writeStore(migrated);
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
    await writeStore(raw);
  }

  return raw;
}

async function writeStore(store: ChatHistoryStore): Promise<void> {
  store.lastUpdated = new Date().toISOString();
  // Clean v1 fields from v2 stores
  if (store.version === 2) {
    delete store.apiMessages;
    delete store.displayMessages;
  }
  await writeJsonFile(CHAT_HISTORY_FILE, store);
}

// ── Public API: reading ──

/**
 * Get the current API-format messages for the agent loop.
 * Filters to non-compacted AI entries and returns as MessageParam[].
 */
export async function getApiMessages(): Promise<MessageParam[]> {
  return getModelContext();
}

/**
 * Get model context: non-compacted AI entries as MessageParam[].
 * Turn-boundary compaction prevents NEW orphans, but pre-existing data
 * may still contain orphan tool_results from old compactions.
 * Defense layer: strip any user message whose tool_result blocks have
 * no matching tool_use in the preceding assistant message.
 */
export async function getModelContext(): Promise<MessageParam[]> {
  const store = await readStore();
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
export async function getCompactionSummary(): Promise<string | null> {
  const store = await readStore();
  return store.compactionSummary;
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
): Promise<PaginatedEntries> {
  const store = await readStore();
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
export async function getDisplayHistory(): Promise<DisplayMessage[]> {
  const result = await getDisplayEntries(1, Number.MAX_SAFE_INTEGER);
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
export async function getLastContextHashes(): Promise<Record<string, string>> {
  const store = await readStore();
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
 */
export async function addAIMessages(
  msgs: MessageParam[],
  options?: { displayText?: string; source?: ChatEntry['source']; contextHashes?: Record<string, string>; taskId?: string },
): Promise<void> {
  if (msgs.length === 0) return;
  return withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    let displayTextAttached = false;
    for (const msg of msgs) {
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
    await writeStore(store);
    log.agent.info('AI messages persisted', { count: msgs.length });
  });
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
}): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore();
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
    await writeStore(store);
    log.agent.debug('chat notification added', { source: msg.source, role: msg.role });
  });
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
): Promise<{ entries: ChatEntry[]; total: number }> {
  const store = await readStore();
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
): Promise<DisplayMessage[]> {
  return withWriteLock(async () => {
    const store = await readStore();
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

    await writeStore(store);
    return displayMsgs;
  });
}

/**
 * Clear all chat history.
 */
export async function clear(): Promise<void> {
  return withWriteLock(async () => {
    await writeStore(freshStore());
  });
}

// ── Compaction ──

/**
 * Check whether the full API payload (system + tools + messages) exceeds the
 * token threshold and needs compaction.
 *
 * Previously only counted message tokens (~155K could pass), while the actual
 * API payload includes system prompt + tool schemas (~120K overhead), causing
 * 275K+ payloads to slip through the 160K threshold.
 */
export async function needsCompaction(): Promise<boolean> {
  const modelMsgs = await getModelContext();

  let fullTotal: number;
  let breakdown: { system: number; tools: number; messages: number; total: number };
  try {
    // Dynamic imports for agent modules to avoid circular dependencies
    // (context.js and tools.js import from chat-history.ts)
    const { buildSystemPrompt } = await import('../agent/context.js');
    const { getToolSchemas } = await import('../agent/tools.js');
    const system = await buildSystemPrompt();
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

  const needed = fullTotal > COMPACTION_TOKEN_THRESHOLD;
  log.agent.info('needsCompaction check', {
    messageCount: modelMsgs.length,
    systemTokens: `~${Math.round(breakdown.system / 1000)}K`,
    toolsTokens: `~${Math.round(breakdown.tools / 1000)}K`,
    messageTokens: `~${Math.round(breakdown.messages / 1000)}K`,
    fullTotal: `~${Math.round(fullTotal / 1000)}K`,
    threshold: `${COMPACTION_TOKEN_THRESHOLD / 1000}K`,
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

Keep each section concise — use bullet points, not prose. Target ~2000 tokens total. Preserve exact file paths, function names, and error messages. Pay special attention to the most recent messages.`;
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

The conversation is about to be compacted. Persist important knowledge using the \`memory\` tool:

1. Daily log: Write a concise summary of what was discussed and accomplished. Include the current time. Keep it brief — max 500 characters. Bullet points are fine. Capture key outcomes, decisions, and next steps.
2. Project memory: Update relevant project memories with decisions and technical details.
3. Global memory: Update with any new user preferences or broadly-applicable facts.

Focus on knowledge that would be LOST if only a summary remained. Don't repeat
what's already in memory. Keep each write concise. If nothing new to store, just say "Nothing to persist."`;

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
  });
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
 * Old AI entries are marked `compacted: true` and slimmed — they stay in
 * the array for scroll-back but are excluded from model context.
 *
 * @param summarizer — function that takes the compaction prompt and returns AI summary
 * @param memoryFlusher — optional function that runs the memory flush agent turn
 */
export async function compact(
  summarizer: (instruction: string, history: MessageParam[]) => Promise<string>,
  memoryFlusher?: (messages: MessageParam[]) => Promise<void>,
): Promise<CompactionResult | null> {
  let store = await readStore();
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

  const [summary] = await Promise.all([
    // Summarizer: passes full history as MessageParam[] for cache reuse
    summarizer(instruction, aiMsgs),
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
    store = await readStore();
    entries = store.entries ?? [];
    aiEntries = entries.filter((e) => e.tag === 'ai' && !e.compacted);
    const freshBoundaryIdx = findTurnBoundaryIndex(aiEntries, RECENT_TURNS_TO_KEEP);

    // If the fresh data no longer supports compaction, bail out (store the summary
    // but don't mark anything compacted — unlikely but possible under heavy concurrency).
    if (freshBoundaryIdx === null) {
      store.compactionSummary = summary;
      store.compactionCount++;
      await writeStore(store);
      return { summary };
    }

    // Mark old AI entries as compacted (with full slimming including image data).
    // Kept entries ARE also slimmed (to prevent 68KB tool_results from bloating context),
    // but we preserve image paths so they can be hydrated when sent to the API.
    let aiIdx = 0;
    for (const entry of entries) {
      if (entry.tag !== 'ai' || entry.compacted) continue;
      if (aiIdx < freshBoundaryIdx) {
        // Old entries: mark compacted + strip image data
        entry.compacted = true;
        entry.content = slimContent(entry.content, /* stripImageData */ true);
      } else {
        // Kept entries: slim but preserve image paths (fixes ~50K token bloat from huge tool_results)
        entry.content = slimContent(entry.content, /* stripImageData */ false);
      }
      aiIdx++;
    }

    store.compactionSummary = summary;
    store.compactionCount++;
    await writeStore(store);

    log.agent.info('compaction complete', {
      compactionNumber: store.compactionCount,
      summaryLength: summary.length,
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
  });
}
