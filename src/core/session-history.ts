/**
 * Session History Reader — reads Claude Code's JSONL conversation files.
 *
 * Claude Code stores session history at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Path encoding: /Users/foo/bar → -Users-foo-bar (replace / with -)
 *
 * File access for both local and remote sessions is handled by
 * SessionFileReader (session-file-reader.ts).
 */

import { log } from '../logging/index.js';
import {
  encodeProjectPath,
  findLocalJsonlPath,
  isSafeForProjectEncoding,
  mergeSyntheticUserEvents,
  readSessionJsonlContent,
  readSubagentContents,
  readSingleSubagentContent,
  readWorkflowManifest,
  readWorkflowSubagentContent,
  remoteJsonlPath,
  type ReadSessionResult,
} from './session-file-reader.js';
import { accumulateWorkflowProgress, sortedPhases, sortedAgents } from './workflow-progress.js';
import { sessionModeFromCli } from './types.js';
import type { SessionBackgroundTasksPayload, WorkflowPhaseInfo, WorkflowAgentInfo } from './event-types.js';
import os from 'node:os';
import path from 'node:path';
import { findImagePaths, findRelativeImageNames } from '../providers/session-io.js';
import { REMOTE_IMAGES_DIR } from '../constants.js';
import { backfillMirrorSidecar, resolveSessionMirrorPath } from './remote-image-mirror.js';

/** Cached homedir — avoids repeated syscall on each history request */
const LOCAL_HOME = os.homedir();

// ── Server-side parsed history cache (mtime-based, for completed/historical sessions) ──

interface ParsedHistoryCacheEntry {
  mtimeMs: number;
  messages: SessionHistoryMessage[];
  /** Approx retained chars (raw JSONL length proxy) — drives the byte budget. */
  approxChars: number;
  /** Entry came from a BOUNDED cold tail read (maxColdReadBytes), not a full
   *  parse. It may only satisfy requests that are themselves tail-bounded — a
   *  full-read request (Load earlier / delta warm-up) must fall through to the
   *  real full read, which overwrites this entry. */
  windowed?: boolean;
  /** Incremental append-read state (see readSessionHistory). Absent when the
   *  last read couldn't establish it (no resolvable path / stat failed). */
  inc?: HistoryIncrementalState;
  /** Orphan finished-agent ids (getOrphanFinishedAgentIds) carried across
   *  incremental reads: the tail re-parse only sees the tail's notifications,
   *  and the merged [...prefix, ...tail] array is a NEW object the parser never
   *  marked — without persisting here, ids proven in the frozen prefix would be
   *  silently dropped on every incremental round. Full parses overwrite;
   *  incremental reads union cached ∪ tail. */
  orphanFinishedIds?: string[];
}

/**
 * Incremental append-read state. The canonical JSONL is append-only in normal
 * operation (/compact rewrites it — detected and handled), so instead of
 * re-reading + re-parsing the whole file on every mtime change (7,230 reads /
 * 167 GB / day observed; the 233 MB whale alone was fully re-read 467×,
 * culminating in a V8-heap-OOM crash loop), we remember where parsing stopped
 * and read only the appended bytes.
 *
 * SEGMENTED PARSE MODEL: parseSessionMessages has cross-line passes (Pattern
 * A/B enqueue matching, batched-twin joins, message.id block merging, tool
 * result pairing), so an appended region can NOT be parsed alone. Instead the
 * file is split at a line boundary into a frozen PREFIX and a live TAIL; the
 * tail segment is re-parsed as one unit on every delta:
 *   messages = prefixMessages ++ parse(tailText + appendedBytes)
 *
 * Seeding is SELF-VALIDATING: after a normal full read+parse, the candidate
 * tail segment is parsed separately and its messages are matched (by msgId,
 * pairwise) against the tail of the full-parse result. Only when segmented ==
 * full is the state kept — any cross-boundary hazard (an enqueue whose
 * Pattern-A twin sits across the boundary, a message.id merged across it)
 * fails the comparison and seeding is skipped for this round; the next full
 * read retries at a different (grown) boundary.
 *
 * When the tail grows past TAIL_SEGMENT_ROLL_BYTES, the state is dropped and
 * the next read is a normal full read that re-seeds — a full re-read every
 * ~3 MB of appended content instead of on every mtime change (measured before
 * this fix: 7,230 full reads / 167 GB / day; the 233 MB whale re-read 467×).
 *
 * Rewrite safety: shrink (size < parsedBytes) invalidates outright; a
 * same-or-grown rewrite (/compact) is caught by re-reading from the last
 * known line start and verifying the line still matches `lastLineCheck`
 * (same trick as session-changes.ts). Mismatch → full re-parse.
 */
interface HistoryIncrementalState {
  /** Absolute path used for range reads (tilde form ok — daemon expands). */
  filePath: string;
  /** Byte offset of the START of the frozen-prefix/tail boundary line. */
  tailStartByte: number;
  /** Messages parsed from bytes [0, tailStartByte) — never re-parsed. */
  prefixMessages: SessionHistoryMessage[];
  /** Byte offset just past the last parsed '\n' (never mid-line). */
  parsedBytes: number;
  /** Start byte of the last parsed line (re-read for rewrite verification). */
  lastLineStart: number;
  /** Cheap identity check of the last parsed line. */
  lastLineCheck: { len: number; head: string; tail: string } | null;
  /** Raw text of the current tail segment [tailStartByte, parsedBytes). */
  tailText: string;
  /** tool_use ids in the FROZEN PREFIX that still lack a result (long-running
   *  tools, background Task agents). If an appended line references one (its
   *  tool_result finally arrived, or a <task-notification> proves the agent
   *  stopped), the segmented parse can't attach it across the boundary —
   *  incremental bails to a full read for that (rare) event. */
  pendingToolIds: string[];
}

/** Tail segment re-parsed on every delta; rolled into the prefix past this. */
const TAIL_SEGMENT_ROLL_BYTES = 4 * 1024 * 1024;
/** After a roll, keep this much as the new tail (fresh lookbehind window). */
const TAIL_SEGMENT_KEEP_BYTES = 1 * 1024 * 1024;

function historyLineCheckOf(line: string): { len: number; head: string; tail: string } {
  return { len: line.length, head: line.slice(0, 64), tail: line.slice(-64) };
}
function historyLineMatches(line: string, check: { len: number; head: string; tail: string }): boolean {
  return line.length === check.len && line.slice(0, 64) === check.head && line.slice(-64) === check.tail;
}

const MAX_HISTORY_CACHE = 30;
// Byte budget across ALL entries. Entry count alone is not a bound: transcripts
// range 4 KB → 164 MB, so 30 whale sessions once held ~600 MB of parsed messages
// and the resulting major-GC pauses froze the event loop for 8-50s (the
// "Quick Session not loading" incident). A whale bigger than the whole budget is
// still cached (evicting everything else) — the active session is polled
// repeatedly and re-reading 164 MB per poll would be worse than caching it.
// 64 Mi-chars ≈ 128 MB retained (UTF-16) — small enough that a full major GC
// stays sub-second, large enough for one whale + a few normal sessions. The
// same figure appears INDEPENDENTLY in session-changes.ts (its own cache, its
// own budget); they don't share a pool, so tune each on its own evidence.
const MAX_HISTORY_CACHE_CHARS = 64 * 1024 * 1024;
const parsedHistoryCache = new Map<string, ParsedHistoryCacheEntry>();
let historyCacheChars = 0;

/**
 * Resolved remote path cache — sessionId@host → full remote path of the JSONL
 * as it actually exists on the remote host. Populated after the first successful
 * `readSessionJsonlContent` for sessions whose cwd encoding is unsafe (> 200
 * chars, Claude Code hashes them and we can't replicate the hash). Lets the
 * mtime-stat fast path work for these sessions on subsequent reads.
 */
const remoteResolvedPaths = new Map<string, string>();
const MAX_RESOLVED_PATHS = 200;
function resolvedPathKey(sessionId: string, host: string): string { return `${sessionId}@${host}`; }
function getResolvedRemotePath(sessionId: string, host: string): string | undefined {
  return remoteResolvedPaths.get(resolvedPathKey(sessionId, host));
}
function setResolvedRemotePath(sessionId: string, host: string, fullPath: string): void {
  const key = resolvedPathKey(sessionId, host);
  remoteResolvedPaths.delete(key);
  remoteResolvedPaths.set(key, fullPath);
  if (remoteResolvedPaths.size > MAX_RESOLVED_PATHS) {
    const oldest = remoteResolvedPaths.keys().next().value;
    if (oldest) remoteResolvedPaths.delete(oldest);
  }
}

/**
 * Parses that came from a BOUNDED SLIDING WINDOW rather than the whole file.
 *
 * A transcript over DaemonFileReader's byte ceiling degrades to the last 4 MiB
 * (readSessionHistoryTailWindow), so the resulting array is a moving window: its
 * LENGTH is not a cursor space — it can shrink between reads while the turn appends
 * at the tail. `GET /history?since=N` used to treat that length as a monotonic
 * cursor and `slice(since)` then omitted the newest messages (inc-1785993576822:
 * measured 1773 → 1764 → … → 1753 on a 55.8 MB session).
 *
 * Marked on the ARRAY ITSELF, not by session id, so the answer can never be raced
 * by a concurrent read of the same session: the caller asks about the exact object
 * it was handed. Callers that concatenate (fork ancestors) must therefore read the
 * flag BEFORE building the combined array and propagate it.
 */
const windowedParses = new WeakSet<object>();
function markWindowedRead(messages: object): void { windowedParses.add(messages); }
/** True when `messages` is a bounded sliding window — never a valid cursor space. */
export function isWindowedHistory(messages: object): boolean { return windowedParses.has(messages); }

/**
 * Parses whose transcript SOURCE was proven to exist (a successful stat, or the
 * reader returning content) — as opposed to "the parse yielded 0 messages".
 *
 * Those two are NOT the same, and conflating them is what made a healthy
 * just-launched session render "History unavailable — Session history file not
 * found": for the first seconds a session's JSONL holds only `system`/hook lines,
 * so it exists and is growing while parseSessionMessages legitimately returns [].
 * Callers deciding "missing file" vs "nothing to show yet" must ask THIS, not the
 * message count (Codex's branch already had the real signal, `journalExists`).
 *
 * Marked on the ARRAY ITSELF for the same reason as windowedParses above: the
 * answer can't be raced by a concurrent read of the same session, because the
 * caller asks about the exact object it was handed.
 */
const sourceFoundParses = new WeakSet<object>();
function markSourceFound(messages: object): void { sourceFoundParses.add(messages); }
/** True when the transcript source behind `messages` was proven to exist. */
export function isSourceFoundHistory(messages: object): boolean { return sourceFoundParses.has(messages); }

/**
 * Orphan finished-agent ids (inc-1786496042099): tool_use ids PROVEN stopped by
 * a <task-notification> line, for which NO tool row exists anywhere in the
 * parse. A NESTED background agent's tool_use definition line exists only in
 * the daemon stream file (parent_tool_use_id set) — never in the canonical
 * session JSONL — so no history row can ever carry its toolUseId and the
 * bgTaskFinished stamp has no row to land on. The completion proof DOES reach
 * the canonical file (queue-operation enqueues / hidden user lines); without
 * this transport it was silently thrown away and the nested agent's streamed
 * lane blocks had no absorption evidence at all — pinned below every later
 * turn forever.
 *
 * Marked on the ARRAY ITSELF for the same reason as windowedParses above: the
 * answer can't be raced by a concurrent read of the same session, because the
 * caller asks about the exact object it was handed. Callers that concatenate
 * (fork ancestors) must read the set BEFORE building the combined array and
 * union it themselves.
 */
const orphanFinishedParses = new WeakMap<object, Set<string>>();
/** Finished-agent toolUseIds with no tool row in this parse (see above). */
export function getOrphanFinishedAgentIds(messages: object): Set<string> | undefined {
  return orphanFinishedParses.get(messages);
}
/** Attach orphan finished-agent ids to a messages array (incremental merges,
 *  disk-cache rehydration — anywhere the array wasn't produced by
 *  parseSessionMessages itself). No-op for an empty set. */
export function markOrphanFinishedAgentIds(messages: object, ids: Iterable<string>): void {
  const set = new Set(ids);
  if (set.size > 0) orphanFinishedParses.set(messages, set);
}

/** Compose cache key so local and remote entries for the same sessionId don't collide. */
function cacheKey(sessionId: string, host?: string): string {
  return host ? `${sessionId}@${host}` : sessionId;
}

function cacheGet(sessionId: string, host?: string): ParsedHistoryCacheEntry | undefined {
  const key = cacheKey(sessionId, host);
  const entry = parsedHistoryCache.get(key);
  if (entry) {
    parsedHistoryCache.delete(key);
    parsedHistoryCache.set(key, entry);
  }
  return entry;
}

/**
 * Last successfully parsed history for a session, if any — degraded-mode
 * fallback for when the live read fails (SSH down, daemon read timeout).
 * Serving yesterday's conversation beats a blank "Failed to load history"
 * screen (inc-1783406628291). Returns undefined when never read this process.
 */
export function getCachedSessionHistory(sessionId: string, host?: string): SessionHistoryMessage[] | undefined {
  return cacheGet(sessionId, host)?.messages;
}

function cacheDelete(key: string): void {
  const prev = parsedHistoryCache.get(key);
  if (prev) {
    historyCacheChars -= prev.approxChars;
    parsedHistoryCache.delete(key);
  }
}

/** Test-only: byte-budget accounting + eviction are otherwise unobservable. */
export function _historyCacheStateForTesting(): { size: number; chars: number; keys: string[] } {
  return { size: parsedHistoryCache.size, chars: historyCacheChars, keys: [...parsedHistoryCache.keys()] };
}
export function _historyCacheSetForTesting(sessionId: string, entry: ParsedHistoryCacheEntry, host?: string): void {
  cacheSet(sessionId, entry, host);
}
export function _historyCacheGetForTesting(sessionId: string, host?: string): ParsedHistoryCacheEntry | undefined {
  return cacheGet(sessionId, host);
}
export function _resetHistoryCacheForTesting(): void {
  parsedHistoryCache.clear();
  historyCacheChars = 0;
}

function cacheSet(sessionId: string, entry: ParsedHistoryCacheEntry, host?: string): void {
  const key = cacheKey(sessionId, host);
  cacheDelete(key);
  parsedHistoryCache.set(key, entry);
  historyCacheChars += entry.approxChars;
  // Evict LRU until BOTH bounds hold. The just-inserted entry is exempt (it may
  // alone exceed the budget — see MAX_HISTORY_CACHE_CHARS comment).
  for (const oldest of parsedHistoryCache.keys()) {
    if (parsedHistoryCache.size <= MAX_HISTORY_CACHE && historyCacheChars <= MAX_HISTORY_CACHE_CHARS) break;
    if (oldest === key) continue;
    cacheDelete(oldest);
  }
}

// ── Image file detection ──

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Check if a file path looks like an image */
export function isImagePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}

/**
 * Extract the file path from a tool_use input block if it points to an image.
 * Checks common field names: file_path (most specific), then path, then filename.
 * Only matches Read/Write/Edit-style tools that have an explicit file path input.
 */
export function extractImageFilePathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filename']) {
    const val = input[key];
    if (typeof val === 'string' && val && isImagePath(val)) return val;
  }
  return undefined;
}

// Re-export for backward compatibility
export { encodeProjectPath };
export { findLocalJsonlPath as findSessionJsonlPath } from './session-file-reader.js';

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  /** True when the tool_result carried is_error — the tool FAILED. Without this
   *  flag the UI renders failed tools with the same ✓ as successes after any
   *  history reload (streaming had the error state; persisted history lost it). */
  isError?: boolean;
  planContent?: string;
  /** agentId extracted from Task/Agent tool_result — links to subagent JSONL */
  agentId?: string;
  /** True when a <task-notification> line proved this background Agent/Task run
   *  STOPPED (the CLI injects one each time an async agent stops). This is the
   *  archival proof for subagent-lane streaming blocks — their transcript lives
   *  in a separate subagents/agent-<id>.jsonl, never in this session's history,
   *  so promote-blocks clears them on this flag instead of twin-matching
   *  (inc-1783612454903: 226 lane blocks pinned below the last message). */
  bgTaskFinished?: boolean;
  /** Team name extracted from Agent tool input (for multi-agent teams) */
  teamName?: string;
  /** Team agent name extracted from Agent tool input */
  teamAgentName?: string;
  /** Child messages from subagent JSONL (populated for Task tools) */
  childMessages?: SessionHistoryMessage[];
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  /** For role='system': display variant (matches the streaming system-block
   *  palette). compact = context compaction, error = API failures, info = model
   *  substitution / scheduled runs. */
  systemVariant?: 'compact' | 'error' | 'info';
  tools?: SessionHistoryTool[];
  thinking?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Stable message id: the API `message.id` (`msg_…`) for assistant messages,
   *  else the JSONL line `uuid`. The SAME id rides the live stream (SSE
   *  message_start → SESSION_TEXT_DELTA.msgId), so streaming blocks and history
   *  messages share a natural key — consumers match by id, not content.
   *  Synthetic fallback (`<timestamp>-<index>` / `queue-<ts>`) for lines with
   *  neither; ACP dialect: ≈ ContentChunk.messageId. */
  msgId?: string;
  /** Walnut-generated message ID for deterministic dedup of optimistic user messages.
   *  Present on synthetic user events written by writeSyntheticUserEvent(). */
  walnutMessageId?: string;
  /** Set by the /history route (never by the parser): this row's CONTENT can still
   *  change — an Agent/Task row awaiting its late `bgTaskFinished`, or a tool row
   *  awaiting its result. The client re-asks for these ids on its next delta, which
   *  is the only way a prefix synced mid-flight ever gets corrected
   *  (inc-1785965937858). See src/core/history-delta.ts. */
  unsettled?: boolean;
  /** True for CLI-injected user lines the human did NOT type (skill content
   *  dumps, compaction continuation summaries, image-read metadata, auto
   *  "Continue" prompts). Detected via the CLI's own flags — canonical JSONL
   *  marks them isMeta/isCompactSummary/isVisibleInTranscriptOnly, stream-json
   *  stdout maps all of those to isSynthetic (QueryEngine emit path). The UI
   *  renders these as a collapsed context row, never a "You" bubble. */
  injected?: boolean;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Internal: raw JSONL line shape ──

interface RawJsonlLine {
  type: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null;
  /** Walnut-generated message ID on synthetic user events (subtype='walnut-injected'). */
  walnutMessageId?: string;
  // CLI-injected user-line flags. Canonical JSONL writes isMeta (skill dumps,
  // image metadata, agent continuations) and isCompactSummary/
  // isVisibleInTranscriptOnly (compaction summaries); the CLI's stream-json
  // stdout (daemon stream files) folds all of them into isSynthetic.
  isMeta?: boolean;
  isSynthetic?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  // queue-operation fields (FIFO-injected user messages)
  operation?: string;
  content?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
    content?: string | Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      thinking?: string;
      // tool_result fields
      tool_use_id?: string;
      is_error?: boolean;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  };
}

/** Tool names whose child messages (identified by parent_tool_use_id) should be grouped. */
const GROUPABLE_TOOL_NAMES = new Set(['Task', 'Agent']);

/**
 * Classify/transform CLI-injected user STRING lines (internal plumbing the CLI
 * re-logs as `user` lines — NOT something the human typed). Rendered raw they
 * show up as mis-attributed "You" bubbles (inc-1783552157700: a background
 * agent's full report as a giant user bubble). Shapes enumerated empirically
 * from a 4000-session corpus scan (Mac + remote host, 2026-07):
 *
 *   hide (pure plumbing; content renders elsewhere or is boilerplate):
 *   - <task-notification>    background-agent completion feed-back (report is
 *                            in the Task tool's agent box; assistant responds)
 *   - <local-command-caveat> "messages below were generated by ..." boilerplate
 *   - <local-command-stdout> local slash-command output (the /command bubble
 *                            above already tells the story)
 *   - <bash-stdout|stderr>   CLI `!` bash-mode output echo
 *
 *   transform (the human DID act — show a readable form):
 *   - <command-name|message|args>  slash command typed in the CLI TUI → "/model sonnet"
 *   - <bash-input>                 CLI `!` bash-mode input → "! which claude"
 *   - <teammate-message …>         inter-agent mail → "[Teammate ui-dev] …"
 *
 * Returns: null → hide; string → replacement display text; undefined → not
 * injected, render as-is.
 */
export function transformInjectedUserText(text: string): string | null | undefined {
  if (!text.startsWith('<')) return undefined;
  if (text.startsWith('<task-notification>')) return null;
  if (text.startsWith('<local-command-caveat>')) return null;
  if (text.startsWith('<local-command-stdout>')) return null;
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return null;
  if (text.startsWith('<bash-input>')) {
    const m = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
    const cmd = m?.[1]?.trim();
    return cmd ? `! ${cmd}` : null;
  }
  // Both orderings exist in the corpus: <command-name> first (Mac) and
  // <command-message> first (remote). Extract by tag, not by position.
  if (/^<command-(name|message|args)>/.test(text)) {
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
    if (!name) return null; // command-message/args without a name — nothing to show
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return args ? `${name} ${args}` : name;
  }
  if (text.startsWith('<teammate-message')) {
    const id = text.match(/teammate_id="([^"]*)"/)?.[1];
    const body = text
      .replace(/^<teammate-message[^>]*>/, '')
      .replace(/<\/teammate-message>\s*$/, '')
      .trim();
    if (!body) return null;
    return `[Teammate${id ? ` ${id}` : ''}] ${body}`;
  }
  return undefined;
}

/** CLI-flagged injected user line (not typed by the human). Canonical JSONL:
 *  isMeta / isCompactSummary / isVisibleInTranscriptOnly; stream-json stdout
 *  folds all of those into isSynthetic. walnut-injected synthetic events are
 *  handled separately (walnutMessageId dedup) — excluded here. */
function isInjectedLine(raw: RawJsonlLine): boolean {
  if (raw.subtype === 'walnut-injected') return false;
  return raw.isMeta === true || raw.isSynthetic === true
    || raw.isCompactSummary === true || raw.isVisibleInTranscriptOnly === true;
}

/**
 * Group inline subagent children under their parent tool calls.
 * For Agent tools (Claude Code subagents), child messages live in the same JSONL
 * with parent_tool_use_id pointing to the parent tool_use block.
 * This function moves those children into tool.childMessages and removes them
 * from the flat result array.
 */
function groupInlineChildren(
  result: SessionHistoryMessage[],
  parentIds: (string | undefined)[],
): SessionHistoryMessage[] {
  // Build map: parentToolUseId → child result indices
  const childIndicesByParent = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    const pid = parentIds[i];
    if (!pid) continue;
    const arr = childIndicesByParent.get(pid);
    if (arr) arr.push(i);
    else childIndicesByParent.set(pid, [i]);
  }
  if (childIndicesByParent.size === 0) return result;

  // Attach children to parent tools (Agent, Task, etc.)
  for (const msg of result) {
    if (!msg.tools) continue;
    for (const tool of msg.tools) {
      if (!tool.toolUseId || !GROUPABLE_TOOL_NAMES.has(tool.name)) continue;
      const childIndices = childIndicesByParent.get(tool.toolUseId);
      if (!childIndices) continue;
      // Don't overwrite childMessages already populated by readSubagentContents
      if (tool.childMessages && tool.childMessages.length > 0) continue;
      tool.childMessages = childIndices.map(i => result[i]);
    }
  }

  // Remove consumed children from the flat list
  const consumed = new Set<number>();
  for (const indices of childIndicesByParent.values()) {
    // Only remove if actually attached to a parent tool
    const parentToolUseId = parentIds[indices[0]];
    if (!parentToolUseId) continue;
    const isAttached = result.some(m =>
      m.tools?.some(t => t.toolUseId === parentToolUseId && t.childMessages && t.childMessages.length > 0)
    );
    if (isAttached) {
      for (const i of indices) consumed.add(i);
    }
  }
  if (consumed.size === 0) return result;
  return result.filter((_, i) => !consumed.has(i));
}

/**
 * Core parsing logic: parse raw JSONL content string into SessionHistoryMessage[].
 * Deduplicates by message.id, handles queue-operations.
 */
export function parseSessionMessages(content: string): SessionHistoryMessage[] {
  const lines = content.split('\n').filter(Boolean);

  // Parse all lines
  const rawMessages: RawJsonlLine[] = [];
  for (const line of lines) {
    try {
      rawMessages.push(JSON.parse(line));
    } catch (err) {
      log.session.debug('failed to parse JSONL entry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Filter to user/assistant message types and deduplicate by message.id
  // (assistant messages can span multiple JSONL lines sharing the same message.id)
  const messageMap = new Map<string, {
    role: string;
    timestamp: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
    parentToolUseId?: string;
    walnutMessageId?: string;
    injected?: boolean;
    systemVariant?: 'compact' | 'error' | 'info';
    contentBlocks: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      thinking?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  }>();

  // First pass: identify Pattern A enqueue entries — a mid-turn FIFO send that the CLI
  // ALSO re-logged as a normal user STRING line, so the enqueue is a duplicate to skip.
  //
  //   Pattern A: enqueue → (soon) user STRING with identical content  ⇒ skip the enqueue
  //   Pattern B: enqueue with NO nearby matching user STRING           ⇒ emit as synthetic user msg
  //              (message was consumed mid-stream / cancelled — never re-logged as a real line)
  //
  // WHY CONTENT-MATCHING WITH A WINDOW (not dequeue/remove counting):
  //   The old approach paired each `dequeue` with the OLDEST pending `enqueue` (a global
  //   FIFO). That silently corrupts across resume/compact boundaries: a `--resume`d session
  //   accumulates ORPHAN dequeues/removes (their enqueue lived in a prior process' buffer)
  //   plus orphan enqueues, so enqueue/dequeue/remove counts don't balance (measured on a
  //   real 1424-session corpus: 3353 enqueue / 2859 dequeue / 483 remove). A stray dequeue
  //   then claims the wrong enqueue, leaving a LATER enqueue falsely unmatched → it re-emits
  //   as Pattern B even though its real user twin sits a couple lines below → the message
  //   renders TWICE (the "compact still shows old messages below" bug). The inverse also
  //   happened: a `remove` wrongly claimed a real Pattern B enqueue → that message was
  //   silently DROPPED. Content-matching is the true invariant and is immune to how many
  //   resume boundaries chopped the queue ops.
  //
  //   THE WINDOW matters: the real user twin always follows the enqueue closely (corpus
  //   p50=2, p90=4, p99=144 lines). But identical short text ("continue", "summary") recurs
  //   across DIFFERENT turns, so an unbounded forward search could claim a same-text user
  //   line hundreds of lines later — wrongly skipping THIS enqueue AND stealing the twin of
  //   a genuinely-Pattern-B enqueue (double corruption). Bounding the forward search to
  //   PATTERN_A_LOOKAHEAD lines cuts true duplicates from 11→3 across the corpus vs. the
  //   unbounded claim, with no observed message loss. Each real user STRING line is claimed
  //   at most once (multiset) so N identical mid-turn sends still map 1:1 to N enqueues.
  const PATTERN_A_LOOKAHEAD = 50;
  // Collect the comparable text of every real user line so an enqueue can find its twin.
  // The CLI re-logs a mid-turn send either as a STRING content OR as an ARRAY content whose
  // first text block holds the message (measured on the real corpus: of 2517 enqueues, 1952
  // twins were string, 7 were array — the array ones carry image refs / long text like
  // "[Image #2] looks the side…"). Missing the array shape leaves those 7 enqueues un-skipped,
  // so the message renders twice. Extract the first text block for the array case.
  const userTwinTexts: Array<{ index: number; content: string; claimed: boolean }> = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'user') continue;
    const c = raw.message?.content;
    let text: string | undefined;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const tb = c.find((b): b is { type: 'text'; text: string } =>
        (b as { type?: string })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string');
      if (tb) text = tb.text;
    }
    if (typeof text === 'string') {
      userTwinTexts.push({ index: i, content: text, claimed: false });
    }
  }
  const skipEnqueueIndices = new Set<number>();
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'queue-operation' || raw.operation !== 'enqueue' || !raw.content) continue;
    // Claim the earliest not-yet-claimed real user line within the lookahead window whose
    // text matches. Found → Pattern A (skip enqueue). None → Pattern B (emit synthetic msg).
    const wanted = raw.content.trim();
    const twin = userTwinTexts.find(
      u => !u.claimed && u.index > i && u.index - i <= PATTERN_A_LOOKAHEAD && u.content.trim() === wanted,
    );
    if (twin) {
      twin.claimed = true;
      skipEnqueueIndices.add(i);
    }
  }

  // ── Batched-twin pass (inc-1784349380504) ──
  // When ≥2 sends sit in the CLI's queue at turn start, the CLI drains them into ONE
  // next-turn prompt and logs a SINGLE user line whose content is the '\n'-join of the
  // queued messages (real corpus: 9 occurrences across 1762 sessions, runs of 2-3,
  // separator always exactly '\n'). Neither message alone equals the join, so the exact
  // pass above leaves every enqueue in the batch unmatched → each re-emits as a Pattern B
  // synthetic AND the merged line renders → every message in the batch shows TWICE.
  // Claim the merged line as the twin of the whole run and skip its enqueues. A failed
  // match degrades to today's duplicate — a message can never be lost here.
  const pendingEnqueues: Array<{ index: number; content: string }> = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'queue-operation' || raw.operation !== 'enqueue' || !raw.content) continue;
    if (skipEnqueueIndices.has(i)) continue;
    pendingEnqueues.push({ index: i, content: raw.content });
  }
  if (pendingEnqueues.length >= 2) {
    for (const twin of userTwinTexts) {
      if (twin.claimed) continue;
      const wanted = twin.content.trim();
      // Unclaimed enqueues before this user line, within the same lookahead window,
      // in queue (line) order. The CLI drains contiguously, so only contiguous runs
      // of length ≥2 can form the merged prompt (length 1 = the exact pass above).
      const cands = pendingEnqueues.filter(
        e => !skipEnqueueIndices.has(e.index) && e.index < twin.index && twin.index - e.index <= PATTERN_A_LOOKAHEAD,
      );
      let matched = false;
      for (let s = 0; s < cands.length - 1 && !matched; s++) {
        let joined = cands[s].content;
        for (let e = s + 1; e < cands.length; e++) {
          joined += '\n' + cands[e].content;
          if (joined.trim() === wanted) {
            twin.claimed = true;
            for (let k = s; k <= e; k++) skipEnqueueIndices.add(cands[k].index);
            matched = true;
            break;
          }
        }
      }
    }
  }

  // ── Background-agent completion proof (inc-1783612454903) ──
  // The CLI injects a <task-notification> user line each time an async Agent/Task
  // STOPS. The line itself is hidden from chat (transformInjectedUserText), but
  // its <tool-use-id> is the ONLY archival proof for that agent's streamed
  // lane blocks — their transcript persists to subagents/agent-<id>.jsonl, never
  // to this session's JSONL, so promote-blocks can't twin-match them. Collect the
  // ids here; the parent tool is stamped bgTaskFinished when tools are built.
  // Any <status> counts as stopped (completed/failed/…) — the notification only
  // fires when the agent has no live background children. A re-resumed agent
  // notifies again on its next stop, so "finished" can only flap to true.
  const finishedBgToolUseIds = new Set<string>();
  for (const u of userTwinTexts) {
    if (!u.content.startsWith('<task-notification>')) continue;
    const toolUseId = u.content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
    if (toolUseId) finishedBgToolUseIds.add(toolUseId);
  }
  // queue-operation enqueues of the same notification (Pattern B — consumed
  // mid-turn, never re-logged as a user line) carry the proof too.
  for (const raw of rawMessages) {
    if (raw.type !== 'queue-operation' || raw.operation !== 'enqueue') continue;
    const c = raw.content;
    if (!c || !c.startsWith('<task-notification>')) continue;
    const toolUseId = c.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
    if (toolUseId) finishedBgToolUseIds.add(toolUseId);
  }

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];

    // ── System lines the user should SEE (corpus-audited 2026-07) ──
    // The CLI logs meaningful conversation events as type='system' lines that
    // were previously dropped entirely — the user saw an unexplained gap:
    //   compact_boundary        "Context compacted (410K tokens)" — why history shrank
    //   api_error               connection/API failures mid-turn — why a turn stalled
    //   informational           e.g. "Model X restricted … using Y instead"
    //   model_refusal_fallback  safeguard retry notices
    //   scheduled_task_fire     why a turn started with no user message
    // (Live streaming already surfaces compact via SESSION_SYSTEM_EVENT; history
    // reloads lost it. Noise subtypes — stop_hook_summary, turn_duration,
    // away_summary, local_command — stay hidden.)
    if (raw.type === 'system' && raw.uuid) {
      const sub = raw.subtype;
      const rawContent = (raw as { content?: unknown }).content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      let sysText: string | undefined;
      let sysVariant: 'compact' | 'error' | 'info' = 'info';
      if (sub === 'compact_boundary') {
        // canonical JSONL uses compactMetadata/preTokens; the CLI's stream-json
        // stdout (daemon stream files) uses compact_metadata/pre_tokens.
        const r = raw as {
          compactMetadata?: { trigger?: string; preTokens?: number };
          compact_metadata?: { trigger?: string; pre_tokens?: number };
        };
        const trigger = r.compactMetadata?.trigger ?? r.compact_metadata?.trigger;
        const pre = r.compactMetadata?.preTokens ?? r.compact_metadata?.pre_tokens;
        sysText = `Context compacted${pre ? ` (${Math.round(pre / 1000)}K tokens)` : ''}${trigger === 'auto' ? ' · auto' : ''}`;
        sysVariant = 'compact';
      } else if (sub === 'api_error') {
        const err = (raw as { error?: { formatted?: string; message?: string } }).error;
        sysText = `API error: ${err?.formatted ?? err?.message ?? content ?? 'unknown'}`;
        sysVariant = 'error';
      } else if (sub === 'informational' || sub === 'model_refusal_fallback' || sub === 'scheduled_task_fire') {
        sysText = content || undefined;
        sysVariant = 'info';
      } else if (sub === 'turn_retry') {
        // Daemon auto-retry of a turn killed by a transient upstream failure.
        // Info, not error: the turn error itself already rendered as api_error,
        // and this row is the recovery telling the user it's being handled.
        sysText = content || undefined;
        sysVariant = 'info';
      } else if (sub === 'turn_retry_stopped') {
        // The daemon gave up (budget/attempts spent, or a terminal error). This
        // one IS an error: nothing further is coming without the user acting.
        sysText = content || undefined;
        sysVariant = 'error';
      }
      if (sysText) {
        messageMap.set(raw.uuid, {
          role: 'system',
          timestamp: raw.timestamp ?? new Date().toISOString(),
          systemVariant: sysVariant,
          contentBlocks: [{ type: 'text' as const, text: sysText }],
        });
      }
      continue;
    }

    // Handle queue-operation entries (FIFO-injected user messages from mid-stream send).
    // These are interleaved at the correct chronological position in the JSONL.
    if (raw.type === 'queue-operation') {
      // Only parse Pattern B enqueues (no matching later user STRING — the message was
      // consumed mid-stream and never re-logged as a real user line). Pattern A enqueues
      // are in skipEnqueueIndices (their identical user STRING twin is emitted below).
      if (raw.operation === 'enqueue' && raw.content && !skipEnqueueIndices.has(i)) {
        const syntheticId = `queue-${raw.timestamp ?? i}`;
        messageMap.set(syntheticId, {
          role: 'user',
          timestamp: raw.timestamp ?? new Date().toISOString(),
          contentBlocks: [{ type: 'text' as const, text: raw.content }],
        });
      }
      continue;
    }

    if (!raw.message?.role || !['user', 'assistant'].includes(raw.message.role)) continue;

    const msgId = raw.message.id ?? raw.uuid ?? `${raw.timestamp}-${rawMessages.indexOf(raw)}`;
    const existing = messageMap.get(msgId);

    if (existing) {
      // Merge content blocks from duplicate lines (with deduplication).
      // Claude Code writes each content block as a separate JSONL line sharing
      // the same message.id. Daemon reconnects or stream replays can cause the
      // same line to appear multiple times. Without dedup, identical text blocks
      // get joined by '\n' producing repeated output (e.g. 4x the same sentence).
      if (raw.message.content) {
        const blocks = typeof raw.message.content === 'string'
          ? [{ type: 'text' as const, text: raw.message.content }]
          : raw.message.content;
        // Dedup strategy: text/thinking use content equality (no stable ID); tool_use uses block.id (UUID).
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'text' && b.text === block.text
            );
            if (isDup) continue;
          }
          if (block.type === 'thinking' && block.thinking) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'thinking' && b.thinking === block.thinking
            );
            if (isDup) continue;
          }
          // tool_use blocks: deduplicate by block.id
          if (block.type === 'tool_use' && block.id) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'tool_use' && b.id === block.id
            );
            if (isDup) continue;
          }
          existing.contentBlocks.push(block);
        }
      }
      if (raw.message.usage) {
        existing.usage = raw.message.usage;
      }
      // Inherit parent_tool_use_id from any line in the group
      if (raw.parent_tool_use_id && !existing.parentToolUseId) {
        existing.parentToolUseId = raw.parent_tool_use_id;
      }
      if (isInjectedLine(raw)) existing.injected = true;
    } else {
      messageMap.set(msgId, {
        role: raw.message.role,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        model: raw.message.model,
        usage: raw.message.usage,
        parentToolUseId: raw.parent_tool_use_id ?? undefined,
        walnutMessageId: raw.walnutMessageId ?? undefined,
        injected: isInjectedLine(raw) || undefined,
        contentBlocks: raw.message.content
          ? (typeof raw.message.content === 'string'
            ? [{ type: 'text' as const, text: raw.message.content }]
            : [...raw.message.content])
          : [],
      });
    }
  }

  // ── Skip synthetic walnut-injected user messages ──
  // writeSyntheticUserEvent() appends user events to the streams file for real-time display.
  // When the streams file is used as the history source (canonical unavailable), these
  // synthetic entries duplicate the canonical user entries already in the file (from Claude
  // stdout capture). Remove synthetic copies — the canonical entries are at the correct
  // chronological position; synthetic entries may be offset due to async append timing.
  for (const [key, msg] of messageMap) {
    if (msg.role === 'user' && msg.walnutMessageId) {
      messageMap.delete(key);
    }
  }

  // ── Build tool_use_id → tool_result text mapping ──
  // Scan all user messages for tool_result blocks and extract their text content.
  // This lets us associate tool results with their corresponding tool_use blocks.
  const toolResultMap = new Map<string, string>();
  // tool_use_ids whose result carried is_error — surfaces as tool.isError so the
  // UI can render ✗ instead of ✓ (1926 error results in the corpus were silently
  // shown as successes after any history reload).
  const errorResultIds = new Set<string>();
  // Track which tool_result IDs contained image content blocks (base64 skipped)
  const imageResultIds = new Set<string>();
  for (const [, msg] of messageMap) {
    if (msg.role !== 'user') continue;
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && block.tool_use_id && block.is_error) {
        errorResultIds.add(block.tool_use_id);
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        // Extract text from nested content array or direct string
        const nested = (block as Record<string, unknown>).content;
        let resultText = '';
        if (typeof nested === 'string') {
          resultText = nested;
        } else if (Array.isArray(nested)) {
          // Always extract text blocks (they may accompany image blocks in mixed results).
          // Image blocks are skipped — we use the tool input's file_path instead,
          // avoiding 130K+ base64 strings in the history pipeline.
          resultText = (nested as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
            .join('\n');
          // Track tool_result IDs that contained image blocks — the file path
          // from the tool input will be appended in the second pass.
          const hasImage = (nested as Array<{ type: string }>).some(c => c.type === 'image');
          if (hasImage && block.tool_use_id) {
            imageResultIds.add(block.tool_use_id);
          }
        }
        if (resultText) {
          toolResultMap.set(block.tool_use_id, resultText);
        }
      }
    }
  }

  // Convert to SessionHistoryMessage array
  // Track the last plan content written to ~/.claude/plans/ across messages
  let lastPlanContent: string | null = null;

  // Parallel array tracking which parentToolUseId each result entry belongs to
  const resultParentIds: (string | undefined)[] = [];

  const result: SessionHistoryMessage[] = [];
  for (const [mapMsgId, msg] of messageMap) {
    const textParts: string[] = [];
    const tools: SessionHistoryTool[] = [];
    let thinking: string | undefined;

    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const toolUseId = block.id;
        // Look up the result for this tool_use
        let toolResult = toolUseId ? toolResultMap.get(toolUseId) : undefined;

        // If the tool_result had image content blocks, append the file path from the
        // tool input so the frontend's findImagePaths() can detect and render it.
        // For remote sessions, rewriteHistoryRemoteImages() will SCP the file.
        if (toolUseId && imageResultIds.has(toolUseId) && block.input) {
          const imgPath = extractImageFilePathFromInput(block.input as Record<string, unknown>);
          if (imgPath) {
            toolResult = toolResult ? `${toolResult}\n${imgPath}` : imgPath;
          }
        }

        // Extract agentId from Task/Agent tool results.
        // Task: "agentId: XXX (for resuming...)" — hex agent ID
        // Agent (teams): "agent_id: name@team" — name@team format
        let agentId: string | undefined;
        let teamName: string | undefined;
        let teamAgentName: string | undefined;
        if (block.name === 'Task' && toolResult) {
          const matches = [...toolResult.matchAll(/agentId:\s*([a-f0-9]+)/g)];
          if (matches.length > 0) agentId = matches[matches.length - 1][1];
        } else if (block.name === 'Agent' && toolResult) {
          // Team Agent: result contains "agent_id: name@team".
          // Async (background) Agent: result contains "agentId: <hex>" — same
          // spelling as Task. Without this, background Agent boxes had no
          // agentId → the UI couldn't lazy-load their subagents/ transcript.
          const agentMatch = toolResult.match(/agent_id:\s*(\S+)/)
            ?? toolResult.match(/agentId:\s*([a-f0-9]+)/);
          if (agentMatch) agentId = agentMatch[1];
          // Also extract team_name from tool input
          if (typeof block.input?.team_name === 'string') {
            teamName = block.input.team_name;
            teamAgentName = typeof block.input?.name === 'string' ? block.input.name : undefined;
          }
        }

        // Capture plan content from Write tool targeting ~/.claude/plans/
        if (block.name === 'Write' && typeof block.input?.file_path === 'string'
          && block.input.file_path.includes('.claude/plans/')
          && typeof block.input.content === 'string' && block.input.content) {
          lastPlanContent = block.input.content;
          // Strip large content from the tool input to avoid showing it twice
          tools.push({ name: block.name, input: { ...block.input, content: '(see plan below)' }, toolUseId });
        } else if (block.name === 'ExitPlanMode') {
          // Attach plan content: prefer captured Write content, fall back to input.plan
          const planContent = lastPlanContent
            ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : undefined);
          const cleanInput = planContent && block.input?.plan
            ? { ...block.input, plan: '(see plan below)' }
            : (block.input ?? {});
          tools.push({
            name: block.name,
            input: cleanInput,
            toolUseId,
            ...(planContent ? { planContent } : {}),
          });
        } else {
          tools.push({
            name: block.name,
            input: block.input ?? {},
            toolUseId,
            ...(toolResult ? { result: toolResult.slice(0, 5000) } : {}),
            ...(toolUseId && errorResultIds.has(toolUseId) ? { isError: true } : {}),
            ...(agentId ? { agentId } : {}),
            // Subagent-run-over proof, one per agent flavor (inc-1783746028392):
            //  · background — task-notification stamped it into finishedBgToolUseIds
            //    (its tool_result is launch metadata written while the agent still
            //    runs, so result-presence proves NOTHING for bg).
            //  · sync inline (explicit run_in_background:false) — the call BLOCKS
            //    its parent turn, so a persisted tool_result can only exist after
            //    the run finished. Sync agents never get a task-notification, and
            //    the CLI persists their transcript to subagents/*.jsonl (NOT inline
            //    in this session's JSONL), so without this stamp their streamed
            //    lane blocks had no absorption evidence at all and pinned below
            //    every later turn until a page reload.
            // run_in_background ABSENT = background (CLI default) → notification only.
            ...(toolUseId && (finishedBgToolUseIds.has(toolUseId)
              || (GROUPABLE_TOOL_NAMES.has(block.name) && block.input?.run_in_background === false && !!toolResult))
              ? { bgTaskFinished: true } : {}),
            ...(teamName ? { teamName } : {}),
            ...(teamAgentName ? { teamAgentName } : {}),
          });
        }
      } else if (block.type === 'thinking' && block.thinking) {
        thinking = (thinking ? thinking + '\n' : '') + block.thinking;
      }
    }

    let text = textParts.join('\n').trim();

    // Skip messages with no visible content (e.g. tool_result-only user entries,
    // empty heartbeat lines). These produce ghost "You" bubbles in the UI.
    if (!text && tools.length === 0 && !thinking) continue;

    // CLI-injected user lines (internal plumbing re-logged as `user` — NOT what
    // the human typed): hide pure plumbing, rewrite human-action echoes to a
    // readable form. Single choke point — catches the real echo line AND the
    // Pattern-B synthetic from its queue-operation. See transformInjectedUserText.
    if (msg.role === 'user' && text.startsWith('<')) {
      const transformed = transformInjectedUserText(text);
      if (transformed === null) continue;
      if (transformed !== undefined) text = transformed;
    }

    // Skip assistant messages with no visible text and no tools.
    // These are typically abandoned API calls where Claude thought but never
    // produced a response before the call was retried with a new message ID.
    if (msg.role === 'assistant' && !text && tools.length === 0) continue;

    result.push({
      role: msg.role as 'user' | 'assistant' | 'system',
      text,
      timestamp: msg.timestamp,
      msgId: mapMsgId,
      ...(tools.length > 0 ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.usage ? { usage: msg.usage } : {}),
      ...(msg.walnutMessageId ? { walnutMessageId: msg.walnutMessageId } : {}),
      ...(msg.injected && msg.role === 'user' ? { injected: true } : {}),
      ...(msg.systemVariant ? { systemVariant: msg.systemVariant } : {}),
    });
    resultParentIds.push(msg.parentToolUseId);
  }

  // Group inline subagent children (e.g. Agent tool calls from Claude Code).
  // Unlike Task tools (which have separate JSONL files), Agent children are inline
  // in the same JSONL with parent_tool_use_id linking them to the parent tool_use.
  const grouped = groupInlineChildren(result, resultParentIds);

  // ── Orphan finished-agent ids (inc-1786496042099) ──
  // A finished-agent proof whose tool row does NOT exist in this parse: a NESTED
  // background agent's tool_use line lives only in the daemon stream file, never
  // in the canonical JSONL, so the bgTaskFinished stamp above has no row to land
  // on and the proof would otherwise be discarded. Attach the leftover ids to
  // the returned array (single choke point — every parse, full/tail/windowed,
  // is marked here; see getOrphanFinishedAgentIds).
  if (finishedBgToolUseIds.size > 0) {
    // Walk the PRE-grouping flat array: grouping only moves messages under
    // tool.childMessages, so `result` still holds every tool row of the parse.
    const presentToolIds = new Set<string>();
    for (const m of result) {
      for (const t of m.tools ?? []) {
        if (t.toolUseId) presentToolIds.add(t.toolUseId);
      }
    }
    const orphans = new Set<string>();
    for (const id of finishedBgToolUseIds) {
      if (!presentToolIds.has(id)) orphans.add(id);
    }
    if (orphans.size > 0) orphanFinishedParses.set(grouped, orphans);
  }
  return grouped;
}

/**
 * Read a single subagent's history by agentId (for lazy-load on demand).
 * Returns parsed child messages, or empty array if not found.
 *
 * `workflow=true` scans the nested subagents/workflows/<runId>/ layout used by
 * the dynamic-workflow tool; otherwise the flat subagents/ layout (Task/Team).
 */
export async function readSingleSubagentHistory(
  sessionId: string,
  agentId: string,
  cwd?: string,
  host?: string,
  workflow?: boolean,
): Promise<SessionHistoryMessage[]> {
  const content = workflow
    ? (await readWorkflowSubagentContent(sessionId, agentId, cwd, host))
        ?? (await readSingleSubagentContent(sessionId, agentId, cwd, host)) // fall back to flat layout
    : await readSingleSubagentContent(sessionId, agentId, cwd, host);
  if (!content) return [];
  try {
    return parseSessionMessages(content);
  } catch (err) {
    log.session.debug('failed to parse single subagent JSONL', {
      sessionId, agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Reconstruct a session's dynamic-workflow progress panel from the on-disk run
 * manifest (workflows/wf_<runId>.json). Used to repopulate the panel on page
 * reload / after server restart, when the live in-memory ClaudeCodeSession state
 * is gone. Returns null when the session never ran a workflow.
 *
 * The manifest stores the full accumulated `workflowProgress[]` in the same
 * format as the live event stream, so we run it through the SAME shared
 * accumulator — the reconstructed payload is byte-for-byte what the live panel
 * would have shown at the end of the run.
 */
export async function reconstructWorkflowProgress(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<SessionBackgroundTasksPayload | null> {
  const manifest = await readWorkflowManifest(sessionId, cwd, host);
  if (!manifest) return null;

  const phases = new Map<number, WorkflowPhaseInfo>();
  const agents = new Map<string, WorkflowAgentInfo>();
  accumulateWorkflowProgress(manifest.workflowProgress, phases, agents);

  // inFlight here is best-effort display state: derive it from the agents still
  // marked running rather than hardcoding 0. The manifest is normally written at
  // run-end (so this is 0), but if a reload ever catches a mid-run manifest this
  // reports honestly. Either way it's superseded by the next live snapshot, and
  // turn-boundary completion is driven by session_state_changed{idle}, NOT this.
  const agentList = sortedAgents(agents);
  const inFlight = agentList.filter(a => a.status === 'running').length;
  return {
    sessionId,
    workflowName: manifest.workflowName,
    inFlight,
    tasks: [],
    phases: sortedPhases(phases),
    agents: agentList,
    scriptSource: manifest.script,
    workflowDescription: manifest.summary,
  };
}

/**
 * Read subagent messages for a session (local or remote).
 * Uses readSubagentContents() from session-file-reader for transparent access.
 *
 * Returns a Map<agentId, SessionHistoryMessage[]> with parsed child messages.
 */
async function readSubagentMessages(sessionId: string, cwd?: string, host?: string): Promise<Map<string, SessionHistoryMessage[]>> {
  const result = new Map<string, SessionHistoryMessage[]>();

  const rawContents = await readSubagentContents(sessionId, cwd, host);
  for (const [agentId, content] of rawContents) {
    try {
      const messages = parseSessionMessages(content);
      if (messages.length > 0) {
        result.set(agentId, messages);
      }
    } catch (err) {
      log.session.debug('failed to parse subagent JSONL', {
        sessionId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Attach subagent child messages to their parent Task tool_use blocks.
 * Mutates the messages array in-place by populating tool.childMessages.
 */
function attachSubagentMessages(messages: SessionHistoryMessage[], subagentMap: Map<string, SessionHistoryMessage[]>): void {
  if (subagentMap.size === 0) return;
  for (const msg of messages) {
    if (!msg.tools) continue;
    for (const tool of msg.tools) {
      if (tool.name === 'Task' && tool.agentId && subagentMap.has(tool.agentId)) {
        tool.childMessages = subagentMap.get(tool.agentId);
      }
    }
  }
}

/**
 * Read and parse session history from Claude Code's JSONL file.
 * Returns an ordered array of user/assistant messages.
 *
 * Uses readSessionJsonlContent() for transparent local/remote file access.
 * When `host` is provided, falls back to reading from the remote host via SSH.
 */
export interface ReadHistoryOptions {
  /** Skip reading subagent JSONL files (default: false). When true, Task tools retain agentId but childMessages stays undefined — frontend lazy-loads on demand. */
  skipSubagents?: boolean;
  /** Tail-bounded caller (GET /history?tail=N): on a COLD cache, a file bigger
   *  than this reads only its last `maxColdReadBytes` (marked windowed) instead
   *  of transferring + parsing the whole JSONL. inc-1786572252481: ?tail=400
   *  bounded the RESPONSE but the server still pulled a 9.5 MB remote JSONL
   *  over SSH on every cold panel open (10–16 s). One-shot by design — the
   *  windowed cache entry only satisfies same-mtime tail-bounded requests, so
   *  the next read (turn append / full request) takes the normal full path and
   *  re-seeds full + incremental state. */
  maxColdReadBytes?: number;
}

/** Default bounded-window size for cold tail-bounded reads (see maxColdReadBytes). */
export const HISTORY_COLD_TAIL_READ_BYTES = 4 * 1024 * 1024;

/**
 * Incremental append-read (see HistoryIncrementalState). Reads only the bytes
 * appended since the last parse, re-parses the tail segment, and splices the
 * result onto the frozen prefix. Returns null (and clears the state) on any
 * hazard — rewrite detected, transport failure, tail overgrown — so the caller
 * falls back to a normal full read.
 */
async function tryIncrementalHistoryRead(
  sessionId: string,
  host: string | undefined,
  cached: ParsedHistoryCacheEntry,
  newMtimeMs: number,
  reader: InstanceType<(typeof import('./daemon-file-reader.js'))['DaemonFileReader']>,
): Promise<SessionHistoryMessage[] | null> {
  const inc = cached.inc!;
  try {
    // Re-read from the last parsed line's start: verifies the file wasn't
    // rewritten in place (/compact) AND picks up the appended bytes in one RPC.
    const res = await reader.readFileRange(inc.filePath, inc.lastLineStart);
    if (res === null) { cached.inc = undefined; return null; }
    const reread = res.content;
    // The re-read starts at the last parsed LINE's start, so its first line is
    // that line (byte offsets vs char offsets: slicing at the first '\n' is
    // char-safe; a byte-difference slice would corrupt on multi-byte chars).
    const firstLineEnd = reread.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? reread.slice(0, firstLineEnd) : reread;
    if (inc.lastLineCheck && !historyLineMatches(firstLine, inc.lastLineCheck)) {
      // Rewrite (or offset drift) — full re-parse next.
      cached.inc = undefined;
      return null;
    }
    // Appended region = everything past that verified line.
    const appended = firstLineEnd >= 0 ? reread.slice(firstLineEnd + 1) : '';
    // Only complete (newline-terminated) lines advance the parse state; a
    // trailing partial line is included in THIS response's parse but not in
    // the persisted offsets (it will be re-read complete next time).
    const lastNl = appended.lastIndexOf('\n');
    const completePart = lastNl >= 0 ? appended.slice(0, lastNl + 1) : '';
    const partialTail = lastNl >= 0 ? appended.slice(lastNl + 1) : appended;

    const newTailText = inc.tailText + completePart;
    if (Buffer.byteLength(newTailText, 'utf-8') > TAIL_SEGMENT_ROLL_BYTES) {
      // Tail overgrown — drop the state; next read is a full read that re-seeds
      // with a fresh boundary. (One full read per ~TAIL_SEGMENT_ROLL_BYTES of
      // appended content, vs one per mtime change before this existed.)
      cached.inc = undefined;
      return null;
    }

    // Cross-boundary tool completion: a prefix tool_use finally got its result
    // (or its background agent stopped). The segmented parse can't attach it —
    // bail to a full read for this (rare) event.
    if (inc.pendingToolIds.length && appended) {
      for (const id of inc.pendingToolIds) {
        if (appended.includes(id)) {
          cached.inc = undefined;
          return null;
        }
      }
    }

    // Parse tail segment (+ any partial line + synthetic user events) fresh.
    const tailWithPartial = partialTail ? newTailText + partialTail : newTailText;
    const merged = await mergeSyntheticUserEvents(sessionId, tailWithPartial);
    const tailMessages = parseSessionMessages(merged);
    const messages = [...inc.prefixMessages, ...tailMessages];

    // Orphan finished-agent ids: the tail parse only marked tailMessages (a
    // different object), and the merged array is new — union the cached ids
    // (proven in the frozen prefix on earlier rounds) with the tail parse's set
    // and mark the array actually handed out. An id whose tool row sits in the
    // prefix may appear here too — benign: it is genuinely finished, so extra
    // finished-parent evidence can only absorb blocks correctly, never wrongly.
    const orphanUnion = new Set<string>(cached.orphanFinishedIds ?? []);
    for (const id of getOrphanFinishedAgentIds(tailMessages) ?? []) orphanUnion.add(id);
    markOrphanFinishedAgentIds(messages, orphanUnion);

    try {
      const { bindEchoClaims } = await import('./echo-claims.js');
      bindEchoClaims(sessionId, messages);
    } catch { /* best-effort */ }

    // Advance persisted state (complete lines only).
    if (completePart) {
      const lastLineStartInPart = completePart.lastIndexOf('\n', completePart.length - 2) + 1;
      const lastLine = completePart.slice(lastLineStartInPart, -1);
      // parsedBytes previously ended just past the verified line's '\n';
      // completePart begins right after it.
      inc.parsedBytes += Buffer.byteLength(completePart, 'utf-8');
      inc.lastLineStart = inc.parsedBytes - Buffer.byteLength(lastLine, 'utf-8') - 1;
      inc.lastLineCheck = historyLineCheckOf(lastLine);
      inc.tailText = newTailText;
    }
    // Charge the same quantity the full-read path charges (raw source size), NOT
    // the sum of message .text lengths. Tool inputs/results dominate a coding
    // transcript and carry no .text, so the old formula under-reported a 100 MB
    // session as a few hundred KB — the byte budget never tripped and eviction
    // effectively never fired for any session refreshed via this path.
    //
    // inc.parsedBytes already spans the WHOLE parsed prefix including the rolling
    // tail segment (it was advanced by completePart just above, and tailText is a
    // window inside it), so it must not be added to newTailText.length — that
    // would double-count the tail. It is the single authoritative figure here.
    const approxChars = inc.parsedBytes;
    cacheSet(sessionId, {
      mtimeMs: newMtimeMs, messages, approxChars, inc,
      ...(orphanUnion.size > 0 ? { orphanFinishedIds: [...orphanUnion] } : {}),
    }, host);

    // Keep the restart-survival disk cache fresh (same as the full-read path).
    // mtime included so the post-restart mtime fast-path can validate it.
    if (messages.length > 0) {
      import('./history-disk-cache.js').then(({ writeHistoryCache }) => {
        writeHistoryCache(sessionId, messages, newMtimeMs, [...orphanUnion]);
      }).catch(() => {});
    }
    return messages;
  } catch (err) {
    log.session.debug('incremental history read failed — falling back to full read', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
    cached.inc = undefined;
    return null;
  }
}

/**
 * Seed incremental state after a successful full read+parse. Self-validating:
 * the candidate tail segment is parsed separately and compared (by msgId,
 * pairwise) against the tail of the full parse — mismatch means a cross-line
 * pass spanned the boundary, so seeding is skipped (correctness first; a later
 * full read retries with a different boundary).
 */
function seedIncrementalState(
  sessionId: string,
  result: ReadSessionResult,
  fullMessages: SessionHistoryMessage[],
  statPath: string | undefined,
): HistoryIncrementalState | undefined {
  const filePath = result.resolvedRemotePath ?? statPath;
  if (!filePath) return undefined;
  // Byte offsets only map into the canonical prefix of `content` (synthetic
  // stream events are appended past it).
  const canonical = result.canonicalChars !== undefined
    ? result.content.slice(0, result.canonicalChars)
    : result.content;
  if (!canonical.endsWith('\n') && canonical.length > 0) {
    // Trailing partial line — boundaries would be ambiguous; skip this round.
    // (Rare: the CLI writes whole lines; a mid-write race lands here.)
    return undefined;
  }
  // Candidate boundary: start of the line region occupying the last
  // TAIL_SEGMENT_KEEP_BYTES (in chars as a proxy; exact byte math done below).
  const keepFrom = Math.max(0, canonical.length - TAIL_SEGMENT_KEEP_BYTES);
  const boundaryChar = keepFrom === 0 ? 0 : canonical.indexOf('\n', keepFrom) + 1;
  if (boundaryChar <= 0 && keepFrom > 0) return undefined; // no newline past keepFrom
  const tailText = canonical.slice(boundaryChar);
  const prefixText = canonical.slice(0, boundaryChar);

  // Self-validation: prefix-parse ++ tail-parse must equal the full parse.
  // fullMessages includes synthetic events parsed from the merged content; the
  // segmented model reproduces that by re-merging synthetics into the tail.
  let prefixMessages: SessionHistoryMessage[];
  let tailMessages: SessionHistoryMessage[];
  try {
    prefixMessages = boundaryChar > 0 ? parseSessionMessages(prefixText) : [];
    const syntheticSuffix = result.canonicalChars !== undefined
      ? result.content.slice(result.canonicalChars)
      : '';
    tailMessages = parseSessionMessages(tailText + syntheticSuffix);
  } catch {
    return undefined;
  }
  if (prefixMessages.length + tailMessages.length !== fullMessages.length) return undefined;
  for (let i = 0; i < fullMessages.length; i++) {
    const seg = i < prefixMessages.length ? prefixMessages[i] : tailMessages[i - prefixMessages.length];
    const full = fullMessages[i];
    if (seg.msgId !== full.msgId || seg.role !== full.role || seg.text !== full.text) return undefined;
    // Tools must match too — a tool_use in the prefix whose tool_result line
    // sits in the tail would silently lose its result in the segmented parse
    // (same text, different tool state). Compare name/result/error pairwise.
    const segTools = seg.tools ?? [];
    const fullTools = full.tools ?? [];
    if (segTools.length !== fullTools.length) return undefined;
    for (let j = 0; j < fullTools.length; j++) {
      if (segTools[j].name !== fullTools[j].name
        || segTools[j].result !== fullTools[j].result
        || segTools[j].isError !== fullTools[j].isError
        || segTools[j].bgTaskFinished !== fullTools[j].bgTaskFinished) return undefined;
    }
  }

  // Prefix tool_use ids with no result yet — appended lines mentioning one
  // force a full re-read (see HistoryIncrementalState.pendingToolIds).
  const pendingToolIds: string[] = [];
  for (const m of prefixMessages) {
    for (const t of m.tools ?? []) {
      if (t.toolUseId && t.result === undefined) pendingToolIds.push(t.toolUseId);
    }
  }

  const parsedBytes = Buffer.byteLength(canonical, 'utf-8');
  const lastLineStartChar = canonical.lastIndexOf('\n', canonical.length - 2) + 1;
  const lastLine = canonical.slice(lastLineStartChar, -1);
  return {
    filePath,
    tailStartByte: Buffer.byteLength(prefixText, 'utf-8'),
    // Frozen prefix comes from the SEGMENTED parse (validated identical) so the
    // cached array is internally consistent with future tail re-parses.
    prefixMessages,
    parsedBytes,
    lastLineStart: parsedBytes - Buffer.byteLength(lastLine, 'utf-8') - 1,
    lastLineCheck: canonical.length > 0 ? historyLineCheckOf(lastLine) : null,
    tailText,
    pendingToolIds,
  };
}

/**
 * Tail-bounded history read for consumers that only need RECENT messages
 * (QMD content indexing keeps ≤50 KB; the phone transcript sweep keeps the
 * last 100 messages). For files ≤ maxTailBytes this is a plain
 * readSessionHistory (shares its cache + incremental path). For whales it
 * range-reads ONLY the last maxTailBytes and parses that window — a 233 MB
 * session costs one 4 MB read instead of a full transfer (the pre-fix sweep
 * pulled 167 GB/day through full reads).
 *
 * Messages that started before the window are absent — acceptable by contract
 * (callers slice the tail anyway). Returns null when the tail read fails
 * (caller decides whether to fall back to the full read).
 */
/**
 * Range-read and parse ONLY the last `maxTailBytes` of a session's JSONL.
 *
 * Extracted so both callers share it: readSessionHistoryTail (the deliberate
 * bounded reader) and readSessionHistory's byte-ceiling degradation path. The
 * latter must NOT call readSessionHistoryTail — that delegates back to
 * readSessionHistory for small files, which would recurse.
 *
 * Returns null when the window can't be read (no resolvable path, stat failure,
 * transport error) so the caller picks its own fallback.
 */
async function readSessionHistoryTailWindow(
  sessionId: string,
  cwd?: string,
  host?: string,
  maxTailBytes = 4 * 1024 * 1024,
): Promise<SessionHistoryMessage[] | null> {
  const daemonHost = host ?? '__local__';
  let statPath = cwd && isSafeForProjectEncoding(cwd)
    ? remoteJsonlPath(sessionId, cwd)
    : getResolvedRemotePath(sessionId, daemonHost);
  try {
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(daemonHost);
    if (!statPath) {
      // Hashed-cwd session (encoded cwd >200 chars) with no cached path. The
      // resolved-path cache is only seeded by a SUCCESSFUL full read — and a
      // file over the byte ceiling can never complete one, so for a hashed-cwd
      // whale the cache stays empty forever and the degradation path used to
      // die right here, serving an empty history for a healthy live session
      // (inc-1786390337224: 70 MB JSONL, "No conversation" on every load).
      // One fs.find resolves it; cache so the next read takes the stat fast-path.
      statPath = (await reader.findSessionPath(sessionId)) ?? undefined;
      if (!statPath) return null;
      setResolvedRemotePath(sessionId, daemonHost, statPath);
    }
    const st = await reader.stat(statPath);
    if (!st) return null;
    // Clamp the window to the reader's own ceiling. Without this, a ceiling set
    // BELOW the tail size makes the degradation path itself get refused, so the
    // fallback for an oversized file silently returns nothing — the fallback must
    // never be able to exceed the limit that triggered it.
    const window = Math.min(maxTailBytes, DaemonFileReader.maxReadBytes());
    const start = Math.max(0, st.size - window);
    const res = await reader.readFileRange(statPath, start);
    if (res === null) return null;
    // Skip the first (almost certainly partial) line when we didn't start at 0.
    let windowText = res.content;
    if (start > 0) {
      const nl = res.content.indexOf('\n');
      windowText = nl >= 0 ? res.content.slice(nl + 1) : '';
    }
    const merged = await mergeSyntheticUserEvents(sessionId, windowText);
    const parsed = parseSessionMessages(merged);
    // Echo-claim binding — same as the full-read path (:1572). Its absence here
    // silently killed the STRONGEST absorption evidence on exactly the sessions
    // that need it most: a whale transcript always degrades to this window, so
    // `walnutMessageId` was null on every message (verified live: 0 of 1752), and
    // the frontend's id-exact dedup pass was dead code for the entire session
    // (inc-1785993576822).
    try {
      const { bindEchoClaims } = await import('./echo-claims.js');
      bindEchoClaims(sessionId, parsed);
    } catch { /* best-effort — text dedup remains the fallback */ }
    markWindowedRead(parsed);
    return parsed;
  } catch (err) {
    log.session.debug('tail window read failed', {
      sessionId, host: daemonHost,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function readSessionHistoryTail(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
  maxTailBytes = 4 * 1024 * 1024,
): Promise<SessionHistoryMessage[] | null> {
  const daemonHost = host ?? '__local__';
  let statPath: string | undefined;
  if (cwd && isSafeForProjectEncoding(cwd)) {
    statPath = remoteJsonlPath(sessionId, cwd);
  } else {
    statPath = getResolvedRemotePath(sessionId, daemonHost);
  }
  if (statPath) {
    try {
      const { DaemonFileReader } = await import('./daemon-file-reader.js');
      const reader = new DaemonFileReader(daemonHost);
      const st = await reader.stat(statPath);
      if (st && st.size > maxTailBytes) {
        // Serve from the shared cache when fresh — same data, zero I/O.
        const cached = cacheGet(sessionId, host);
        if (cached && cached.mtimeMs === st.mtimeMs) return cached.messages;
        return await readSessionHistoryTailWindow(sessionId, cwd, host, maxTailBytes);
      }
    } catch (err) {
      log.session.debug('tail history stat/read failed — falling back to full read', {
        sessionId, host: daemonHost,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Small file (or no stat path): the normal cached/incremental path is cheap.
  return readSessionHistory(sessionId, cwd, host, outputFile, { skipSubagents: true });
}

/**
 * In-flight dedup for readSessionHistory.
 *
 * Five caller families hit this concurrently (attach, GET /history, the
 * stream-convergence probe, agent tools, the session summarizer) and the mtime
 * cache only helps AFTER a read finishes — two callers arriving in the same tick
 * both missed and both read the whole file. Observed: the same 38.9 MB JSONL read
 * twice inside one second (attach + the reconnecting UI's GET /history).
 *
 * Same pattern as `inflightByKey` in session-changes.ts. The key includes every
 * option that changes the RESULT (currently only skipSubagents, which decides
 * whether childMessages is populated), so a caller can never be served a
 * different shape than it asked for. Add to the key if ReadHistoryOptions grows.
 */
const historyInflightByKey = new Map<string, Promise<SessionHistoryMessage[]>>();

export function readSessionHistory(sessionId: string, cwd?: string, host?: string, outputFile?: string, options?: ReadHistoryOptions): Promise<SessionHistoryMessage[]> {
  const key = `${sessionId}@${host ?? '__local__'}|${options?.skipSubagents ? 's' : ''}|w${options?.maxColdReadBytes ?? ''}`;
  const existing = historyInflightByKey.get(key);
  if (existing) return existing;

  const run = readSessionHistoryInner(sessionId, cwd, host, outputFile, options);
  historyInflightByKey.set(key, run);
  void run.finally(() => {
    if (historyInflightByKey.get(key) === run) historyInflightByKey.delete(key);
  }).catch(() => { /* observed by the caller */ });
  return run;
}

async function readSessionHistoryInner(sessionId: string, cwd?: string, host?: string, outputFile?: string, options?: ReadHistoryOptions): Promise<SessionHistoryMessage[]> {
  let messages: SessionHistoryMessage[] | null = null;
  // Did we PROVE the transcript source exists (successful stat / reader returned
  // content)? Independent of how many messages the parse produced — see
  // markSourceFound. Every `return` below must stamp the array it hands back.
  let sourceFound = false;
  const handOff = (msgs: SessionHistoryMessage[]): SessionHistoryMessage[] => {
    if (sourceFound) markSourceFound(msgs);
    return msgs;
  };

  // Server-side mtime cache: check if JSONL hasn't changed since last parse.
  // Primarily benefits completed/historical sessions viewed repeatedly.
  //
  // Local: fs.stat on the canonical path (cheap).
  // Remote: one fs.stat RPC to the daemon — ~50ms and avoids re-fetching the
  //   whole JSONL over the tunnel (seconds for large sessions).
  // UNIFIED mtime-cache stat: both local (__local__) and remote go through the
  // daemon's fs.stat (DaemonFileReader → localDaemon for __local__). One path,
  // and the byte size it returns is what a future incremental byte-read needs.
  // Path resolution (identical for local & remote):
  //   1. cwd safe for our encoding (<=200 chars) → build the exact tilde path.
  //   2. Otherwise (cwd missing or hashed by Claude Code) → a previously resolved
  //      full path discovered via a prior full read.
  let mtimeMs: number | undefined;
  let statSize: number | undefined;
  let statPath: string | undefined;
  {
    const daemonHost = host ?? '__local__';
    if (cwd && isSafeForProjectEncoding(cwd)) {
      statPath = remoteJsonlPath(sessionId, cwd);
    } else {
      statPath = getResolvedRemotePath(sessionId, daemonHost);
    }
    if (statPath) {
      try {
        const { DaemonFileReader } = await import('./daemon-file-reader.js');
        const reader = new DaemonFileReader(daemonHost);
        const statResult = await reader.stat(statPath);
        if (statResult) {
          mtimeMs = statResult.mtimeMs;
          statSize = statResult.size;
          // The stat SUCCEEDED — the transcript file exists on disk, whatever the
          // parse yields. Every return below this point inherits that fact.
          sourceFound = true;
          const cached = cacheGet(sessionId, host);
          if (cached && cached.mtimeMs === mtimeMs) {
            // A windowed entry (bounded cold tail) may only answer callers that
            // are themselves tail-bounded — a full-read caller (Load earlier,
            // fork ancestor read) falls through to the real full read below,
            // which overwrites this entry with the full parse.
            if (!cached.windowed || options?.maxColdReadBytes) {
              // Cache hit — return cached messages (skipSubagents is the common path
              // now, so cached messages don't include childMessages; no mutation concern).
              return handOff(cached.messages);
            }
          }
          // In-memory miss (e.g. server just restarted) but the DISK cache may
          // still be current: validate its stored mtime against the live stat.
          // Without this, every restart triggered a full re-fetch of EVERY open
          // session's JSONL (observed: 383 reads / 1.8 GB in the hour after a
          // restart storm), saturating the daemon RPC path for minutes.
          if (!cached) {
            try {
              const { readHistoryCache } = await import('./history-disk-cache.js');
              const disk = await readHistoryCache(sessionId);
              if (disk?.mtimeMs !== undefined && disk.mtimeMs === mtimeMs) {
                log.session.info('history disk cache hit (mtime match) — skipping full read', {
                  sessionId, host: host ?? '__local__', messages: disk.messages.length,
                });
                // Re-mark orphan finished-agent ids: the WeakMap died with the
                // old process; the disk entry persisted the set explicitly.
                if (disk.finishedAgentIds?.length) {
                  markOrphanFinishedAgentIds(disk.messages, disk.finishedAgentIds);
                }
                // Seed the in-memory cache (no incremental state — that needs a
                // real parse pass; the next mtime change does one full read and
                // re-seeds it, same as any inc-state hazard).
                cacheSet(sessionId, {
                  mtimeMs, messages: disk.messages,
                  approxChars: statResult.size,
                  ...(disk.finishedAgentIds?.length ? { orphanFinishedIds: disk.finishedAgentIds } : {}),
                }, host);
                return handOff(disk.messages);
              }
            } catch { /* disk cache unusable — fall through to full read */ }
          }
          // mtime CHANGED but incremental state exists and the file only grew:
          // read + parse just the appended bytes instead of the whole file.
          if (cached?.inc && options?.skipSubagents && statResult.size >= cached.inc.parsedBytes) {
            const incMessages = await tryIncrementalHistoryRead(
              sessionId, host, cached, statResult.mtimeMs, reader,
            );
            if (incMessages) return handOff(incMessages);
            // Incremental failed (rewrite detected / transport) — state was
            // dropped; fall through to a normal full read that re-seeds.
          } else if (cached?.inc && statResult.size < cached.inc.parsedBytes) {
            // Shrink = /compact rewrote the file. Invalidate incremental state.
            cached.inc = undefined;
          }
        }
      } catch (err) {
        // stat failed (old daemon without fs.stat, transport error, or local
        // daemon mid-restart) — skip the cache and fall through to a full read.
        // Not fatal.
        log.session.debug('fs.stat via daemon failed, skipping history cache', {
          sessionId, host: daemonHost,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Bounded COLD read for tail-bounded callers (inc-1786572252481): the cache is
  // cold (server restart / eviction) and no incremental state can help, so the
  // fallthrough below would transfer + parse the WHOLE file — 10-16 s for a
  // 9.5 MB remote JSONL, all to serve ?tail=400. When the caller declared it only
  // needs the tail, read just the last window instead and mark it windowed (the
  // delta route then refuses anchorless cursors against it, same contract as the
  // byte-ceiling degradation). The windowed cache entry is quarantined: only
  // same-mtime tail-bounded requests hit it, so the next turn append or a
  // full-read caller does the normal full read and re-seeds everything.
  if (options?.maxColdReadBytes && statPath && statSize !== undefined
      && statSize > options.maxColdReadBytes) {
    const win = await readSessionHistoryTailWindow(sessionId, cwd, host, options.maxColdReadBytes);
    if (win) {
      log.session.info('history cold read bounded to tail window', {
        sessionId, host: host ?? '__local__', fileSize: statSize,
        windowBytes: options.maxColdReadBytes, messages: win.length,
      });
      if (mtimeMs !== undefined) {
        cacheSet(sessionId, {
          mtimeMs, messages: win, approxChars: options.maxColdReadBytes, windowed: true,
          ...(getOrphanFinishedAgentIds(win)?.size
            ? { orphanFinishedIds: [...getOrphanFinishedAgentIds(win)!] } : {}),
        }, host);
      }
      // NOT written to the disk cache: that store feeds full-read fallbacks
      // (SSH-down stale serving), which must never adopt a partial parse.
      //
      // Background warm-up (fire-and-forget): a plain full read re-seeds the
      // full cache + incremental state OFF the critical path, so the session's
      // next turn takes the cheap incremental append instead of re-pulling a
      // 4 MB window every mtime change (the sliding-window regime is correct
      // but 1000× the transfer of an incremental read on an active session).
      // Skipped for files over the reader's hard ceiling — their full read is
      // structurally impossible; they live in the sliding-window regime anyway.
      const { DaemonFileReader } = await import('./daemon-file-reader.js');
      if (statSize <= DaemonFileReader.maxReadBytes()) {
        setTimeout(() => {
          readSessionHistory(sessionId, cwd, host, outputFile, { skipSubagents: true })
            .catch(() => { /* warm-up is best-effort; next full request retries */ });
        }, 0).unref?.();
      }
      return handOff(win);
    }
    // Window read failed — fall through to the normal full read.
  }

  // A file over the reader's hard byte ceiling throws instead of materializing
  // (DaemonFileReader.maxReadBytes). Degrade to the BOUNDED tail window rather than
  // surfacing a load error: a very long transcript still renders its recent history,
  // which is what the UI shows anyway. Only this specific ceiling error degrades —
  // transport failures keep their existing contract.
  let result: Awaited<ReturnType<typeof readSessionJsonlContent>>;
  try {
    result = await readSessionJsonlContent(sessionId, cwd, host, outputFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('byte ceiling')) throw err;
    log.session.warn('history read hit the byte ceiling — serving a bounded tail instead', {
      sessionId, host: host ?? '__local__', error: msg,
    });
    // A byte-ceiling rejection is itself proof the file exists (and is huge).
    sourceFound = true;
    const tail = await readSessionHistoryTailWindow(sessionId, cwd, host);
    if (tail) return handOff(tail);
    // Tail unavailable too — last resort is the previous parse, else empty.
    return handOff(getCachedSessionHistory(sessionId, host) ?? []);
  }
  // Raw JSONL length — the cache's byte-budget proxy for the parsed messages.
  const sourceChars = result?.content.length ?? 0;
  if (result) {
    // The reader returned CONTENT — the source exists even if the stat fast-path
    // above never ran (unresolvable path, old daemon without fs.stat).
    sourceFound = true;
    // Remember the resolved path so the next read can use the mtime fast-path
    // even when cwd is unsafe for our canonical path encoding. Keyed by the
    // daemon host (__local__ for local) so local reads get the same fast-path.
    if (result.resolvedRemotePath) {
      setResolvedRemotePath(sessionId, host ?? '__local__', result.resolvedRemotePath);
    }
    try {
      messages = parseSessionMessages(result.content);

      // Echo-claim binding (Phase 1, ACP dialect): stamp walnutMessageId onto
      // the canonical user-echo lines of recently delivered batches, so the
      // frontend's optimistic dedup can match by EXACT id instead of text.
      // In-memory registry; no-op for sessions with no pending claims.
      try {
        const { bindEchoClaims } = await import('./echo-claims.js');
        bindEchoClaims(sessionId, messages);
      } catch { /* binding is best-effort — text dedup remains the fallback */ }

      // Diagnostic: detect user message ordering issues
      const userTextIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user' && messages[i].text?.trim()) userTextIndices.push(i);
      }
      if (userTextIndices.length > 1) {
        const lastAsst = messages.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1);
        const usersAfterLastAsst = userTextIndices.filter(i => i > lastAsst).length;
        if (usersAfterLastAsst > userTextIndices.length / 2) {
          log.session.warn('⚠️ user messages bunched at end of parsed history', {
            sessionId: sessionId.substring(0, 8),
            source: result.source,
            host: host ?? 'local',
            total: messages.length,
            userText: userTextIndices.length,
            lastAsstIdx: lastAsst,
            usersAfterLastAsst,
            userPositions: userTextIndices.slice(0, 20),
          });
        }
      }
    } catch (err) {
      log.session.warn('failed to parse session history', {
        sessionId, source: result.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!messages) return handOff([]);

  // Attach subagent child messages (works for both local and remote sessions).
  // When skipSubagents is true, Task tools retain agentId but childMessages stays
  // undefined — the frontend lazy-loads subagent content on demand.
  if (!options?.skipSubagents) {
    const hasTaskTools = messages.some(m => m.tools?.some(t => t.name === 'Task' && t.agentId));
    if (hasTaskTools) {
      const subagentMap = await readSubagentMessages(sessionId, cwd, host);
      attachSubagentMessages(messages, subagentMap);
    }
  }

  // Refresh plan content from disk. The plan file may have been updated after the
  // initial Write captured in the JSONL (e.g., agent continued editing the plan).
  // Replace ExitPlanMode planContent with the latest disk version so the PlanCard
  // shows current content on first load.
  //
  // Daemon-uniform: read through DaemonFileReader(host ?? '__local__') so this works
  // for BOTH local and remote sessions (previously local-only via direct fs — remote
  // plans were never refreshed). The plan path is absolute; the daemon reads it as-is.
  // Any failure (missing file, transport) is non-fatal — we keep the JSONL version.
  {
    let planFilePath: string | undefined;
    for (const msg of messages) {
      if (!msg.tools) continue;
      for (const tool of msg.tools) {
        if (tool.name === 'Write' && typeof tool.input?.file_path === 'string'
          && tool.input.file_path.includes('.claude/plans/')) {
          planFilePath = tool.input.file_path;
        }
      }
    }
    if (planFilePath) {
      try {
        const { DaemonFileReader } = await import('./daemon-file-reader.js');
        const reader = new DaemonFileReader(host ?? '__local__');
        const diskContent = await reader.readFile(planFilePath);
        if (diskContent) {
          for (const msg of messages) {
            if (!msg.tools) continue;
            for (const tool of msg.tools) {
              if (tool.name === 'ExitPlanMode' && tool.planContent) {
                tool.planContent = diskContent;
              }
            }
          }
        }
      } catch (err) {
        log.session.debug('failed to read plan file via daemon', {
          planFilePath, host: host ?? '__local__',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Only cache when skipSubagents — attachSubagentMessages mutates tool.childMessages
  // in place, so caching with children attached would share mutable state across consumers.
  if (mtimeMs !== undefined && options?.skipSubagents) {
    // Seed incremental append-read state so future mtime changes read only the
    // appended bytes (self-validating; undefined on any boundary hazard).
    // Only canonical daemon reads qualify — stream/outputFile fallbacks have no
    // stable byte-offset mapping to the canonical file.
    const inc = (result && (result.source === 'local' || result.source === 'remote'))
      ? seedIncrementalState(sessionId, result, messages, statPath)
      : undefined;
    // Orphan finished-agent ids: the parser already marked `messages` in the
    // WeakMap; persist the set on the entry so future INCREMENTAL reads (whose
    // tail parse can't see prefix notifications) union it back in.
    const orphanIds = getOrphanFinishedAgentIds(messages);
    cacheSet(sessionId, {
      mtimeMs, messages, approxChars: sourceChars,
      ...(inc ? { inc } : {}),
      ...(orphanIds && orphanIds.size > 0 ? { orphanFinishedIds: [...orphanIds] } : {}),
    }, host);
  }

  // Persist to disk cache (fire-and-forget) so history survives app restarts
  // and is available when remote JSONL is temporarily unreachable. mtime (when
  // the stat succeeded) lets the post-restart fast-path validate this entry
  // with one stat instead of a full JSONL re-fetch. Orphan finished-agent ids
  // ride along — they live OUTSIDE the messages array and would otherwise be
  // lost on a post-restart disk-cache hit.
  if (messages.length > 0) {
    const orphanForDisk = getOrphanFinishedAgentIds(messages);
    import('./history-disk-cache.js').then(({ writeHistoryCache }) => {
      writeHistoryCache(sessionId, messages, mtimeMs, orphanForDisk ? [...orphanForDisk] : undefined);
    }).catch(() => {});
  }

  return handOff(messages);
}

/**
 * Format a source session's conversation history for injection into a forked session.
 * Returns a text summary suitable for `append-system-prompt`, truncated to tokenBudget.
 *
 * Each message is formatted as:
 *   [turn N] User: <text>
 *   [turn N] Assistant [tool1, tool2]: <text>
 */
export function formatForkHistory(messages: SessionHistoryMessage[], tokenBudget = 50_000): string {
  const CHARS_PER_TOKEN = 3.5;
  const charBudget = Math.floor(tokenBudget * CHARS_PER_TOKEN);
  const MAX_PER_MSG = 2000;

  const lines: string[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role === 'system') continue; // UI notices (compact/api_error) — not conversation
    if (msg.role === 'user') turn++;
    const toolInfo = msg.tools?.length ? ` [${msg.tools.map(t => t.name).join(', ')}]` : '';
    const role = msg.role === 'user' ? 'User' : `Assistant${toolInfo}`;
    const text = msg.text.length > MAX_PER_MSG
      ? msg.text.slice(0, MAX_PER_MSG) + `... [${msg.text.length} chars total]`
      : msg.text;
    if (text.trim()) {
      lines.push(`[turn ${turn}] ${role}: ${text}`);
    }
  }

  const full = lines.join('\n\n');
  if (full.length <= charBudget) return full;

  // Tail-truncate: keep the most recent turns
  const truncated = full.slice(-charBudget);
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline > 0 ? truncated.slice(firstNewline + 1) : truncated;
  return '[...earlier conversation omitted]\n\n' + clean;
}

/**
 * Extract only the plan content from a session's JSONL file.
 * Scans for Write→~/.claude/plans/ and ExitPlanMode tool_use blocks
 * without building the full message array — lightweight fast path.
 *
 * Supports both local and remote sessions via readSessionJsonlContent().
 */
export async function extractPlanContent(sessionId: string, cwd?: string, host?: string): Promise<string | null> {
  // DAEMON-UNIFORM: read through readSessionJsonlContent (daemon for both local &
  // remote) — no findLocalJsonlPath + fsp.readFile bypass.
  const result = await readSessionJsonlContent(sessionId, cwd, host);
  const content = result?.content;
  if (!content) return null;

  try {
    const lines = content.split('\n').filter(Boolean);

    let lastWrittenPlan: string | null = null;
    let exitPlanContent: string | null = null;

    for (const line of lines) {
      let parsed: RawJsonlLine;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        log.session.debug('failed to parse JSONL line in plan extraction', {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!parsed.message?.content || typeof parsed.message.content === 'string') continue;

      for (const block of parsed.message.content) {
        if (block.type !== 'tool_use') continue;

        // Capture Write to ~/.claude/plans/
        if (block.name === 'Write'
          && typeof block.input?.file_path === 'string'
          && block.input.file_path.includes('.claude/plans/')
          && typeof block.input?.content === 'string'
          && block.input.content) {
          lastWrittenPlan = block.input.content;
        }

        // Capture ExitPlanMode
        if (block.name === 'ExitPlanMode') {
          exitPlanContent = typeof block.input?.plan === 'string' && block.input.plan
            ? block.input.plan
            : null;
        }
      }
    }

    // Prefer Write content (richer), fall back to ExitPlanMode.input.plan
    return lastWrittenPlan ?? exitPlanContent;
  } catch (err) {
    log.session.warn('failed to extract plan content', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── State recovery from CloudCode canonical JSONL ──

/**
 * Map a Claude CLI permissionMode string (as recorded in the canonical JSONL)
 * to our SessionMode. Delegates to the ONE registry in types.ts so recovery
 * understands every mode the CLI can write — incl. 'auto' and 'dontAsk'; before
 * that, an auto/dontAsk session recovered as "mode unknown" and kept whatever
 * stale mode the record held.
 *
 * ⚠️ Do NOT re-wire this as a source of truth for a session's mode. Every
 * transcript recorded before 2026-08 carries `bypassPermissions` on every line
 * regardless of the requested mode (the bare --dangerously-skip-permissions
 * flag hijacked it), so recovering from an old JSONL would relabel a plan
 * session as bypass. The one production caller was deliberately removed.
 */
function mapPermissionModeFromJsonl(permMode: string): string | null {
  return sessionModeFromCli(permMode);
}

/** State recovered from CloudCode canonical JSONL for crash recovery. */
export interface RecoveredSessionState {
  mode?: string;
  /** Full model string from the last init event (e.g. "global.anthropic.claude-opus-4-6-v1[1m]"). */
  model?: string;
  planFile?: string;
  planCompleted?: boolean;
  activity?: string;
  /** 'error' or 'agent_complete' if a result event was found. */
  workStatus?: string;
  /** Byte length of the JSONL content that was read during recovery.
   *  Used as fromOffset when attaching to remote daemons to skip stale replays. */
  jsonlByteLength?: number;
  /** True if the last TeamCreate/TeamDelete pair leaves the session in team mode. */
  teamActive?: boolean;
  /** Authoritative background-task set rebuilt from the replayed lifecycle events
   *  (task_started / task_updated / task_notification), keyed by task_id → latest status.
   *  This is the source of truth on recovery; the live session rebuilds its `_bgTasks` from
   *  it so "is work in flight" is DERIVED (count of non-terminal), never an accumulated
   *  counter that a duplicate / lost / out-of-order event could desync. */
  bgTasks?: Record<string, string>;
  /** Task ids the CLI flagged `is_backgrounded:true` (task_updated patch). The CLI's own
   *  turn-end does NOT wait for these (it emits result+idle while they run), so they are
   *  excluded from `bgTasksInFlight` gating — but kept here so the live session can rebuild
   *  its full set (UI still shows them). Incident 07fffbe5: dropping this field made a
   *  16-min backgrounded grep hold a finished turn "Running". */
  bgBackgroundedIds?: string[];
  /** DERIVED count of still-running background tasks (non-terminal entries in `bgTasks`,
   *  excluding backgrounded ones — the turn-over GATING count, mirroring
   *  ClaudeCodeSession._runningBgCount). Computed from the set, not accumulated. */
  bgTasksInFlight?: number;
  /** Last observed CLI session_state_changed.state, when present in the stream. */
  cliSessionState?: 'running' | 'idle' | 'requires_action';
  /** Pending control_request that was never answered (no matching control_response).
   *  Happens when Walnut server restarts while Claude Code is waiting for permission. */
  pendingControlRequest?: {
    request_id: string;
    request: { subtype: string; tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string; decision_reason?: string };
  };
}

/**
 * Extract latest session state from CloudCode's canonical JSONL file.
 *
 * Used by attachToExisting() on server restart to recover state that may not
 * have been persisted to sessions.json before a crash. Reads the source of
 * truth (Claude CLI's own JSONL) instead of our potentially-incomplete stream
 * capture file.
 *
 * Supports both local and remote sessions via readSessionJsonlContent().
 * Scans forward through the file, keeping only the LAST value of each field.
 */
/** Count background tasks whose status is non-terminal (still running). Derived view over
 *  the rebuilt task set — mirrors ClaudeCodeSession._runningBgCount so the replay and live
 *  paths agree by construction. `backgrounded` tasks (CLI's is_backgrounded flag) are
 *  excluded: the CLI's own turn-end doesn't wait for them (incident 07fffbe5). */
function runningBgCount(bgTasks: Map<string, string>, terminal: Set<string>, backgrounded: Set<string>): number {
  let n = 0;
  for (const [id, status] of bgTasks) {
    if (backgrounded.has(id)) continue;
    if (!terminal.has(status)) n++;
  }
  return n;
}

export async function recoverStateFromJsonl(sessionId: string, cwd?: string, host?: string): Promise<RecoveredSessionState | null> {
  // DAEMON-UNIFORM: read through readSessionJsonlContent (daemon for both local &
  // remote). This runs during crash recovery (attachToExisting); the local daemon
  // is auto-started by ensureRunning() inside the daemon connection, so no local
  // fs bypass is needed even on the bootstrap path.
  const result = await readSessionJsonlContent(sessionId, cwd, host);
  const content = result?.content;
  if (!content) return null;

  try {
    const lines = content.split('\n').filter(Boolean);

    const state: RecoveredSessionState = {
      jsonlByteLength: Buffer.byteLength(content, 'utf-8'),
    };
    // Authoritative background-task set, rebuilt by REPLAYING lifecycle events into a
    // task_id → status map (NOT an accumulated +1/-1 counter). This mirrors the live path
    // (ClaudeCodeSession._bgTasks): a duplicate / out-of-order / lost / new-kind event can
    // never desync a derived count the way it desyncs an accumulator. "Terminal is terminal":
    // once a task reaches a terminal status, later started/progress events don't revive it.
    const bgTasks = new Map<string, string>();
    // Tasks the CLI flagged is_backgrounded — excluded from the gating count (sticky: no
    // event un-backgrounds a task). Mirrors the live handler in claude-code-session.ts.
    const bgBackgrounded = new Set<string>();
    const BG_TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        log.session.debug('failed to parse JSONL line in state recovery', {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const type = parsed.type as string | undefined;

      // ── model: extract from system init events only ──
      // Init events have the full model ID (e.g. "global.anthropic.claude-opus-4-6-v1[1m]").
      // NEVER use assistant message model — subagents use different models (e.g. Haiku).
      // Multiple init events = multiple --resume cycles. Prefer the version with [1m]
      // suffix — later resumes may have lost it due to the processNext default bug.
      // If no [1m] version exists, use the last init event's model as fallback.
      if (type === 'system' && parsed.subtype === 'init' && typeof parsed.model === 'string') {
        // De-duplicate [1m][1m] → [1m] from old resume bug
        const initModel = (parsed.model as string).replace(/(\[1m\])+$/, '[1m]');
        if (initModel.endsWith('[1m]')) {
          state.model = initModel;  // [1m] found — lock it in
        } else if (!state.model?.endsWith('[1m]')) {
          state.model = initModel;  // no [1m] yet — use this as fallback
        }
        // else: already have a [1m] version, don't overwrite with non-[1m]
      }

      // ── permissionMode: CLI ground truth for session mode ──
      // The `permissionMode` field appears on 'user' type lines (set at send time)
      // and occasionally on 'system' status events. We read it from ALL line types
      // because it's the CLI's own report of what mode it's running in.
      //
      // However, this is NOT a complete picture — see EnterPlanMode detection below.
      if (typeof parsed.permissionMode === 'string') {
        const mapped = mapPermissionModeFromJsonl(parsed.permissionMode);
        if (mapped) state.mode = mapped;
      }

      if (type === 'user' && parsed.subtype !== 'walnut-injected') {
        // A user message after a result means the session was resumed —
        // clear workStatus so we don't incorrectly report agent_complete.
        // Skip synthetic walnut-injected events (written by Walnut for dedup, not real turns).
        if (state.workStatus) {
          state.workStatus = undefined;
          state.activity = undefined;
        }
      }

      // ── Background-task lifecycle (dynamic workflows / subagents) ──
      // Rebuild the authoritative task SET so we can tell, after reconnect/restart, whether
      // a replayed `result` is a real turn-over or just an intermediate result emitted while
      // background work continues. In-flight is DERIVED (count of non-terminal) at the end.
      if (type === 'system') {
        const subtype = (parsed as Record<string, unknown>).subtype as string | undefined;
        const taskId = (parsed as Record<string, unknown>).task_id as string | undefined;
        if (subtype === 'task_started' && taskId != null) {
          // Terminal is terminal: a replayed/out-of-order started must not revive a finished task.
          if (!BG_TERMINAL.has(bgTasks.get(taskId) ?? '')) bgTasks.set(taskId, 'running');
        } else if (subtype === 'task_notification' && taskId != null) {
          const status = ((parsed as Record<string, unknown>).status as string | undefined) ?? 'completed';
          bgTasks.set(taskId, status);
        } else if (subtype === 'task_updated' && taskId != null) {
          // A task_updated whose patch.status is terminal is the FIRST terminal signal on
          // newer CLIs — record it (idempotent with the later task_notification).
          const patch = (parsed as Record<string, unknown>).patch as Record<string, unknown> | undefined;
          const patchStatus = patch?.status as string | undefined;
          if (patchStatus) bgTasks.set(taskId, patchStatus);
          // is_backgrounded → exclude from gating (see runningBgCount / incident 07fffbe5).
          if (patch?.is_backgrounded === true) bgBackgrounded.add(taskId);
        } else if (subtype === 'task_progress' && taskId != null) {
          if (!bgTasks.has(taskId)) bgTasks.set(taskId, 'running');
        } else if (subtype === 'session_state_changed') {
          const s = (parsed as Record<string, unknown>).state as
            | 'running' | 'idle' | 'requires_action' | undefined;
          state.cliSessionState = s;
          // idle is the turn-over TRIGGER, not turn-over itself. POC-verified (see memory
          // claude-code-session-state-semantics): the CLI emits idle ~20×/run — between
          // every sub-agent / phase — because its idle-wait loop excludes
          // in_process_teammate tasks. So a mid-workflow restart's JSONL almost always
          // contains idle events while tasks are still in flight. The turn is over only
          // when idle coincides with NO running task in the set. The OLD code unconditionally
          // set agent_complete on ANY idle, which marked a still-running workflow complete on
          // restart (defeating the recovery this whole block exists for). Gate on the derived
          // running-count; "terminal is terminal" keeps the set monotone toward done.
          if (s === 'idle' && runningBgCount(bgTasks, BG_TERMINAL, bgBackgrounded) === 0) { state.workStatus = 'agent_complete'; }
          else if (s === 'running') { state.workStatus = undefined; }
        }
      }

      // result events indicate turn completion — BUT a dynamic-workflow turn emits one
      // result per background subagent completion, and the main turn's result lands
      // while subagents still run. So a `result` is only a real turn-over when no
      // background work remains AND the CLI hasn't told us it's still running. When
      // session_state events are present, they own workStatus (handled above); we only
      // fall back to result-implies-complete when bg work is quiescent.
      if (type === 'result') {
        const isErr = (parsed as Record<string, unknown>).is_error;
        if (isErr) {
          state.workStatus = 'error';
        } else if (runningBgCount(bgTasks, BG_TERMINAL, bgBackgrounded) === 0 && state.cliSessionState !== 'running') {
          state.workStatus = 'agent_complete';
        }
        // else: intermediate result during live background work — leave workStatus as-is.
      }

      // Scan assistant messages for tool_use blocks
      if (type === 'assistant') {
        const msg = (parsed as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;

          const name = block.name as string;
          state.activity = `Using ${name}`;

          // ── EnterPlanMode: mid-turn mode change detection ──
          // When Claude calls EnterPlanMode, the CLI switches to plan mode and emits
          // a `system subtype=status permissionMode=plan` event in the STREAM output.
          // However, this system status event is NOT written to the CloudCode canonical
          // JSONL (~/.claude/projects/.../*.jsonl) — only to Walnut's stream copy.
          //
          // The canonical JSONL only records `permissionMode` on `user` type lines
          // (set at the time the message was sent). If EnterPlanMode happens mid-turn
          // (same turn as the user message), the user line still says the OLD mode
          // (e.g., bypassPermissions), and no subsequent line corrects it.
          //
          // Therefore we detect EnterPlanMode from the tool_use block as the
          // authoritative signal that the session switched to plan mode.
          if (name === 'EnterPlanMode') {
            state.mode = 'plan';
          }

          // Write to ~/.claude/plans/ → planFile
          if (name === 'Write'
            && typeof block.input?.file_path === 'string'
            && block.input.file_path.includes('.claude/plans/')) {
            state.planFile = block.input.file_path;
          }

          // ── ExitPlanMode: plan is done, but mode does NOT change ──
          // In `-p` (non-interactive) mode, ExitPlanMode returns is_error=true
          // because the CLI needs an interactive user to approve the plan exit.
          // The CLI does NOT actually switch permission modes — it stays in plan.
          // It also does NOT emit a system status event for this.
          //
          // So we only set planCompleted=true here. The mode stays whatever it was
          // (typically 'plan' from EnterPlanMode above). We do NOT set mode='bypass'
          // because the CLI never said it switched — and a bypass session that
          // voluntarily called EnterPlanMode→ExitPlanMode should keep its original
          // bypass mode, not be incorrectly labeled as plan.
          if (name === 'ExitPlanMode') {
            state.planCompleted = true;
          }

          // ── TeamCreate / TeamDelete: team mode detection ──
          // Mirrors live detection in claude-code-session.ts (handleStreamEvent).
          // Needed so _teamActive survives server restart — without this, the
          // dispatcher's teamActive guard has no signal and every intermediate
          // team result triggers triage.
          if (name === 'TeamCreate') {
            state.teamActive = true;
          }
          if (name === 'TeamDelete') {
            state.teamActive = false;
          }
        }
      }

      // ── control_request / control_response: detect orphaned permission requests ──
      // Claude Code emits control_request when it needs permission for a tool.
      // Walnut responds with control_response via FIFO. If the server crashes/restarts
      // between these two events, Claude Code's stdin read loop freezes waiting for
      // control_response — it ignores all other FIFO input (user messages pile up
      // unread). No internal timeout exists, so the session hangs permanently.
      // Track the last unmatched control_request so attachToExisting() can recover it.
      if (type === 'control_request') {
        const req = parsed as { request_id?: string; request?: Record<string, unknown> };
        if (req.request_id && req.request) {
          state.pendingControlRequest = {
            request_id: req.request_id,
            request: req.request as NonNullable<RecoveredSessionState['pendingControlRequest']>['request'],
          };
        }
      }
      if (type === 'control_response') {
        // A control_response means the pending request was answered — clear it.
        // Match by request_id to avoid clearing the wrong request in edge cases
        // (e.g., rapid sequential control_request events).
        const resp = parsed as { response?: { request_id?: string } };
        const respId = resp.response?.request_id;
        if (respId && state.pendingControlRequest?.request_id === respId) {
          state.pendingControlRequest = undefined;
        } else if (!respId) {
          // Fallback: if no request_id in response, clear unconditionally
          state.pendingControlRequest = undefined;
        }
      }
      if (type === 'control_cancel_request') {
        // The CLI WITHDREW the request (turn abort / restart) — it is no longer
        // answerable. Without this, recovery resurrects a request the CLI has
        // already discarded (incident a172ce49: permanent Waiting badge).
        const cancel = parsed as { request_id?: string };
        if (cancel.request_id && state.pendingControlRequest?.request_id === cancel.request_id) {
          state.pendingControlRequest = undefined;
        }
      }
    }

    // Finalize the background-task set: expose the rebuilt set + the DERIVED running count
    // (gating semantics — backgrounded tasks excluded) + which ids were backgrounded so the
    // live session can rebuild its full set with the flag intact.
    if (bgTasks.size > 0) {
      state.bgTasks = Object.fromEntries(bgTasks);
      state.bgTasksInFlight = runningBgCount(bgTasks, BG_TERMINAL, bgBackgrounded);
      if (bgBackgrounded.size > 0) state.bgBackgroundedIds = [...bgBackgrounded];
    }

    return state;
  } catch (err) {
    log.session.warn('failed to recover state from canonical JSONL', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Read session history with reverse pagination (page 1 = most recent messages).
 * Reuses readSessionHistory() for the full parse (including SSH fallback), then slices.
 */
export async function readSessionHistoryPaginated(
  sessionId: string,
  cwd?: string,
  opts?: { pageSize: number; page: number },
  host?: string,
  outputFile?: string,
): Promise<{ messages: SessionHistoryMessage[]; pagination: PaginationMeta }> {
  const pageSize = opts?.pageSize ?? 20;
  const page = opts?.page ?? 1;

  try {
    const allMessages = await readSessionHistory(sessionId, cwd, host, outputFile);
    const total = allMessages.length;
    const totalPages = Math.ceil(total / pageSize);

    if (total === 0) {
      return { messages: [], pagination: { page, pageSize, total: 0, totalPages: 0 } };
    }

    // Reverse order: page 1 = newest, page N = oldest
    const reversed = [...allMessages].reverse();
    const start = (page - 1) * pageSize;
    const messages = reversed.slice(start, start + pageSize);

    return {
      messages,
      pagination: { page, pageSize, total, totalPages },
    };
  } catch (err) {
    log.session.warn('failed to read session history (paginated)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], pagination: { page, pageSize, total: 0, totalPages: 0 } };
  }
}

/**
 * Download a single file from a remote host via the daemon's fs.read command.
 * Returns true on success, false on failure (graceful degradation).
 * Writes a .src.json sidecar so /api/local-image can revalidate the mirror.
 */
async function downloadImageViaDaemon(host: string, remotePath: string, localPath: string): Promise<boolean> {
  try {
    const { downloadToMirror } = await import('./remote-image-mirror.js')
    return (await downloadToMirror(host, remotePath, localPath)) !== null
  } catch { return false }
}

/**
 * Rewrite remote image paths in session history messages to local paths.
 * Used when replaying history for a remote session — downloads images via
 * the daemon (not SCP) and rewrites paths so the UI can render them.
 */
export async function rewriteHistoryRemoteImages(
  messages: SessionHistoryMessage[],
  host: string,
  sessionId: string,
  cwd?: string,
): Promise<SessionHistoryMessage[]> {
  const cache = new Map<string, string>()
  const fs = await import('node:fs')

  // Pre-scan: build filename → absolute path hints from tool inputs/results.
  // Tool inputs (e.g. Bash `cp` commands, file paths) contain full absolute paths
  // that are more accurate than CWD-based resolution for relative filenames.
  const filePathHints = new Map<string, string[]>()
  const isUsefulHint = (p: string) =>
    !p.startsWith(LOCAL_HOME) &&        // skip local filesystem paths
    p.lastIndexOf('/') > 0              // require ≥2 path components
  const addHint = (p: string) => {
    const bn = path.basename(p)
    const arr = filePathHints.get(bn)
    if (arr) { if (!arr.includes(p)) arr.push(p) }
    else filePathHints.set(bn, [p])
  }
  for (const msg of messages) {
    if (!msg.tools) continue
    for (const tool of msg.tools) {
      const inputStr = typeof tool.input === 'string'
        ? tool.input
        : (tool.input ? JSON.stringify(tool.input) : '')
      for (const p of findImagePaths(inputStr)) {
        if (isUsefulHint(p)) addHint(p)
      }
      if (tool.result) {
        for (const p of findImagePaths(tool.result)) {
          if (isUsefulHint(p)) addHint(p)
        }
      }
    }
  }

  /**
   * Rewrite image paths in a text string: detect remote paths, map to local,
   * and fire-and-forget daemon downloads for images not yet on disk.
   */
  const rewriteText = (text: string): string => {
    let rewritten = text

    // Pass 1: absolute remote paths
    const remotePaths = findImagePaths(text)
    for (const remotePath of remotePaths) {
      // Skip local paths
      if (remotePath.startsWith(LOCAL_HOME) || remotePath.startsWith(REMOTE_IMAGES_DIR)) continue

      let localPath = cache.get(remotePath)
      if (!localPath) {
        // Hash-keyed slot (falls back to a legacy bare-basename mirror only when
        // its sidecar proves the same origin) — two dirs' same-named chart.png
        // must not share one slot.
        localPath = resolveSessionMirrorPath(sessionId, remotePath)
        cache.set(remotePath, localPath)

        if (!fs.existsSync(localPath)) {
          downloadImageViaDaemon(host, remotePath, localPath).catch(() => {})
        } else {
          // Pre-sidecar mirror file: record its origin so /api/local-image can
          // revalidate it (the download-once mirror otherwise stays stale forever).
          backfillMirrorSidecar(localPath, host, remotePath)
        }
      }
      rewritten = rewritten.split(remotePath).join(localPath)
    }

    // Pass 2: relative image filenames resolved against remote CWD
    if (cwd) {
      const relNames = findRelativeImageNames(rewritten)
      for (const relName of relNames) {
        const basename = path.basename(relName)
        const hintPaths = filePathHints.get(basename) ?? []
        const cwdPath = `${cwd.replace(/\/$/, '')}/${relName}`
        const tmpPath = `/tmp/${basename}`
        const candidates = [...hintPaths]
        if (!candidates.includes(cwdPath)) candidates.push(cwdPath)
        if (!candidates.includes(tmpPath)) candidates.push(tmpPath)

        if (candidates.some(c => cache.has(c))) continue

        let localPath = cache.get(`rel:${relName}`)
        if (!localPath) {
          // Slot keyed by the cwd-resolved path (deterministic even though the
          // download races several candidates); any candidate's sidecar may
          // claim a legacy bare-basename mirror.
          localPath = resolveSessionMirrorPath(sessionId, cwdPath, candidates)
          cache.set(`rel:${relName}`, localPath)

          if (!fs.existsSync(localPath)) {
            const lp = localPath
            ;(async () => {
              for (const candidate of candidates) {
                const ok = await downloadImageViaDaemon(host, candidate, lp)
                if (ok) return
              }
            })().catch(() => {})
          } else {
            // Same backfill as the absolute-path branch: best origin guess is
            // the first candidate (tool-input hints beat cwd/tmp fallbacks).
            if (candidates[0]) backfillMirrorSidecar(localPath, host, candidates[0])
          }
        }
        const escaped = relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nameRe = new RegExp(`(?<=^|[\\s"'\`=:(])${escaped}(?=[\\s"'\`),;\\]}]|$)`, 'g')
        rewritten = rewritten.replace(nameRe, () => localPath!)
      }
    }

    return rewritten
  }

  for (const msg of messages) {
    if (msg.text) {
      msg.text = rewriteText(msg.text)
    }
    if (msg.tools) {
      for (const tool of msg.tools) {
        if (tool.result) {
          tool.result = rewriteText(tool.result)
        }
      }
    }
  }

  return messages
}
