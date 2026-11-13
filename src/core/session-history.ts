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
  type SessionJsonlHint,
} from './session-file-reader.js';
import { accumulateWorkflowProgress, sortedPhases, sortedAgents } from './workflow-progress.js';
import { sessionModeFromCli, type InPlaceRewindCut, type JsonlLineCheck } from './types.js';
import type { PersistedHistoryInc } from './history-disk-cache.js';
import type { SkippedRewindCut } from './transcript-chain.js';
import type { SessionBackgroundTasksPayload, WorkflowPhaseInfo, WorkflowAgentInfo } from './event-types.js';
import os from 'node:os';
import path from 'node:path';
import { findImagePaths, findRelativeImageNames } from '../providers/session-io.js';
import { REMOTE_IMAGES_DIR } from '../constants.js';
import { backfillMirrorSidecar, resolveSessionMirrorPath, looksAlreadyMirrored, startMirrorDownload } from './remote-image-mirror.js';
import { noteMessageBlockTypes, noteTranscriptLineType } from './transcript-line-types.js';
import { _resetTailWindowsForTesting, dropTailWindows, setTailWindowShedding } from './history-tail-window.js';
import { isByteCeilingError } from './byte-ceiling.js';

// The parser itself (parseSessionMessages and the row types) lives in history-parse.ts, pure, so
// the session daemon can bundle it; this module re-exports all of it and gives it the logger.
export * from './history-parse.js';
import {
  aboutChildRows, chainFilterMarks, getChainFilterMark, logSkippedRewindCuts, markMessageAbout,
  getOrphanFinishedAgentIds, markOrphanFinishedAgentIds, NO_QUEUE_DEAD_KEYS, parseSessionMessages, rewindCutsKey, setHistoryParseHooks,
  type PaginationMeta, type ParseSessionMessagesOptions, type RawJsonlLine, type SessionHistoryMessage,
} from './history-parse.js';
setHistoryParseHooks({
  warn: (message, fields) => log.session.warn(message, fields),
  debug: (message, fields) => log.session.debug(message, fields),
  noteLineType: (line, version) => noteTranscriptLineType(line, version),
  noteBlockTypes: (content, line, version) => noteMessageBlockTypes(content, line, version),
});

/** Cached homedir — avoids repeated syscall on each history request */
const LOCAL_HOME = os.homedir();

// ── Server-side parsed history cache (mtime-based, for completed/historical sessions) ──

interface ParsedHistoryCacheEntry {
  mtimeMs: number;
  /** The transcript's size at the stat this entry answers. With mtime it is the
   *  freshness key: a Linux kernel stamps files once a tick (10 ms at HZ=100),
   *  so a line appended in the tick of the last read keeps the mtime and only
   *  the size tells (`isFresh`). Absent on an entry from before it was kept. */
  size?: number;
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
  /** The incremental state the disk cache kept, not yet resumed (resumeFromKept). */
  diskInc?: PersistedHistoryInc;
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
  lastLineCheck: JsonlLineCheck | null;
  /** Raw text of the current tail segment [tailStartByte, parsedBytes). */
  tailText: string;
  /** Bytes of the tail the seed kept: the roll size counts from it (incrementalTailRolls). */
  seedTailBytes?: number;
  /** The recorded in-place rewinds the dead set below was computed from (rewindCutsKey). */
  cutsKey?: string;
  /** tool_use ids in the FROZEN PREFIX that still lack a result (long-running
   *  tools, background Task agents). If an appended line references one (its
   *  tool_result finally arrived, or a <task-notification> proves the agent
   *  stopped), the segmented parse can't attach it across the boundary —
   *  incremental bails to a full read for that (rare) event. */
  pendingToolIds: string[];
  /** Rewind-cut dead set at seed time (null = nothing dropped). The tail
   *  re-parse applies THIS exact set so its rows stay consistent with the
   *  frozen prefix. Safe to freeze: the set is deterministic given (cuts,
   *  file), appended lines sit after every cut's anchor and can never join
   *  it, and a new rewind commit invalidates this whole cache entry. */
  deadUuids: Set<string> | null;
  /** Queue dead keys paired with `deadUuids` (same computeRewindDeadSet call)
   *  — the tail re-parse suppresses Pattern-B enqueues whose identity key
   *  (queueEnqueueKey) is in the set. */
  queueDeadKeys: Set<string>;
}

/** Tail segment re-parsed on every delta; rolled into the prefix past this. */
// Claude Code's own error reply, read the same way by every reader of a session's lines.
export { CLI_ERROR_PREFIX } from './sessions/cli-error-reply.js';

const TAIL_SEGMENT_ROLL_BYTES = 4 * 1024 * 1024;
/** After a roll, keep this much as the new tail (fresh lookbehind window). */
const TAIL_SEGMENT_KEEP_BYTES = 1 * 1024 * 1024;

export function historyLineCheckOf(line: string): JsonlLineCheck {
  return { len: line.length, head: line.slice(0, 64), tail: line.slice(-64) };
}
function historyLineMatches(line: string, check: JsonlLineCheck): boolean {
  return line.length === check.len && line.slice(0, 64) === check.head && line.slice(-64) === check.tail;
}

// ── In-place rewind cuts ──
//
// An in-place rewind (`--resume <sid> --resume-session-at <uuid>`, NO
// --fork-session) keeps BOTH branches in one transcript: the CLI resets its
// file pointer and appends the new branch under the same session id, hanging
// it off the rewind point via parentUuid (live-verified: the first post-rewind
// user line's parentUuid IS the rewind-point uuid). The file ALONE cannot say
// which branch was rewound away: innocent forks (an api_error line at EOF
// re-parenting the next user message, a mid-turn slash-command branch off
// pre-turn state) are topologically identical to rewind branches, and an
// always-on chain walk measurably deleted 8.4% of rendered rows from real
// never-rewound sessions. The CLI itself disambiguates via RUNTIME state (the
// --resume-session-at argv); Walnut persists that state as
// record.inPlaceRewinds ({uuid, lastUuidAtCommit, at}) at rewind commit and
// replays it against the file FRESH at every read — computeRewindDeadSet
// (src/core/transcript-chain.ts) resolves both uuids to line indices and kills
// exactly the region between the rewind point and the commit-time last tree
// line. Lines appended after the commit sit past the anchor by construction,
// so no seam guard is needed on the incremental path, and a session with no
// recorded rewind is provably served unfiltered. An out-of-band rewind done in
// a terminal (no Walnut commit) simply shows both branches — the pre-port
// status quo.


/** The session's recorded in-place rewind cuts (record.inPlaceRewinds), or
 *  undefined when it has none (the overwhelmingly common case — this is the
 *  ONLY record read the history path does, and it's a primary-key SELECT).
 *  Dynamic import breaks the session-tracker ↔ session-history cycle. */
async function getInPlaceRewinds(sessionId: string): Promise<InPlaceRewindCut[] | undefined> {
  try {
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const cuts = record?.inPlaceRewinds;
    return cuts && cuts.length > 0 ? cuts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop every cached parse for a session — in-memory entry (with its
 * incremental state), and the disk cache. Called at in-place rewind commit:
 * the FILE hasn't changed (same mtime), but what the file MEANS has, so every
 * mtime-validated cache would happily keep serving the abandoned turns.
 */
export async function invalidateSessionHistoryCaches(sessionId: string, host?: string): Promise<void> {
  cacheDelete(cacheKey(sessionId));
  if (host) cacheDelete(cacheKey(sessionId, host));
  dropTailWindows(`${cacheKey(sessionId)}|`);
  if (host) dropTailWindows(`${cacheKey(sessionId, host)}|`);
  // The over-ceiling dead-set memo is keyed on the FILE's identity, which a new
  // cut does not change — so it has to be dropped explicitly here, or a rewind
  // of a rewind would keep serving the previous rewind's dead set.
  displayProbeMemoDrop(sessionId);
  try {
    const { deleteHistoryCache } = await import('./history-disk-cache.js');
    await deleteHistoryCache(sessionId);
  } catch { /* best-effort — a stale disk entry only survives until the next write */ }
  try {
    const { deleteHistoryView } = await import('./history-view-snapshot.js');
    await deleteHistoryView(sessionId);
  } catch { /* best-effort, as above */ }
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

/** The entry still answers a stat of the transcript: same mtime, and same size when both are known. */
function isFresh(entry: ParsedHistoryCacheEntry, mtimeMs: number, size: number | undefined): boolean {
  return entry.mtimeMs === mtimeMs && (entry.size === undefined || size === undefined || entry.size === size);
}
let historyCacheChars = 0;

/**
 * Resolved remote path cache — sessionId@host → full remote path of the JSONL
 * as it actually exists on the remote host. Populated after the first successful
 * `readSessionJsonlContent` for sessions whose cwd encoding is unsafe (> 200
 * chars, Claude Code hashes them and we can't replicate the hash). Lets the
 * mtime-stat fast path work for these sessions on subsequent reads.
 */
const remoteResolvedPaths = new Map<string, string>();
const MAX_RESOLVED_PATHS = 2000;
function resolvedPathKey(sessionId: string, host: string): string { return `${sessionId}@${host}`; }
function getResolvedRemotePath(sessionId: string, host: string): string | undefined {
  return remoteResolvedPaths.get(resolvedPathKey(sessionId, host));
}
function setResolvedRemotePath(sessionId: string, host: string, fullPath: string): void {
  const key = resolvedPathKey(sessionId, host);
  locateMisses.delete(key);
  remoteResolvedPaths.delete(key);
  remoteResolvedPaths.set(key, fullPath);
  if (remoteResolvedPaths.size > MAX_RESOLVED_PATHS) {
    const oldest = remoteResolvedPaths.keys().next().value;
    if (oldest) remoteResolvedPaths.delete(oldest);
  }
}
/** The cache as a hint for the readers of the session's sibling files
 *  (subagents/, workflows/): they read from it and fill it. */
function sessionJsonlHint(sessionId: string, host: string | undefined): SessionJsonlHint {
  const daemonHost = host ?? '__local__';
  const hint: SessionJsonlHint = {
    path: getResolvedRemotePath(sessionId, daemonHost),
    onFound: (fullPath) => {
      hint.path = fullPath;
      setResolvedRemotePath(sessionId, daemonHost, fullPath);
    },
  };
  return hint;
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
  _resetTailWindowsForTesting();
  parsedHistoryCache.clear();
  historyCacheChars = 0;
  historyCacheBudgetChars = MAX_HISTORY_CACHE_CHARS;
  displayProbeMemo.clear();
}

// ── Over-ceiling DISPLAY dead-set memo ──
// The byte-ceiling branch below deliberately writes NO history cache entry, so a
// rewound over-ceiling session would re-ask its host daemon on EVERY read, and
// each ask makes that host stream and parse the whole transcript (seconds of CPU
// and hundreds of MB of transient RSS on a very large one) inside a route with no
// deadline. The answer is a pure function of (recorded cuts, file bytes), so it is
// memoized on the file's identity: an appended transcript re-probes, a quiet one
// never does. Bounded, and dropped for a session whenever its history caches are
// (a new cut changes the answer without changing the file).
//
// ONLY the display path memoizes. The rewind gate/commit probes keep fresh-read
// semantics on purpose — they decide what to persist.

interface DisplayDeadSet {
  deadUuids: string[];
  queueDeadKeys: string[];
  skippedCuts: SkippedRewindCut[];
  truncated: boolean;
}
const displayProbeMemo = new Map<string, DisplayDeadSet>();
const DISPLAY_PROBE_MEMO_MAX = 32;
/** A short, dedicated deadline: this call sits in a route with none of its own,
 *  and a slow answer must degrade to the unfiltered tail rather than pin the
 *  request. The rewind-path calls keep their own (much longer) budget. */
const DISPLAY_PROBE_TIMEOUT_MS = 10_000;

const displayProbeKey = (sessionId: string, host: string | undefined, mtimeMs: number, size: number): string =>
  `${sessionId}|${host ?? '__local__'}|${mtimeMs}|${size}`;

function displayProbeMemoGet(key: string): DisplayDeadSet | undefined {
  const hit = displayProbeMemo.get(key);
  if (hit) { // LRU touch
    displayProbeMemo.delete(key);
    displayProbeMemo.set(key, hit);
  }
  return hit;
}

function displayProbeMemoSet(key: string, value: DisplayDeadSet): void {
  displayProbeMemo.delete(key);
  displayProbeMemo.set(key, value);
  while (displayProbeMemo.size > DISPLAY_PROBE_MEMO_MAX) {
    const oldest = displayProbeMemo.keys().next().value;
    if (oldest === undefined) break;
    displayProbeMemo.delete(oldest);
  }
}

/** Drop every memoized dead set for a session (its cuts changed). */
function displayProbeMemoDrop(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const key of [...displayProbeMemo.keys()]) {
    if (key.startsWith(prefix)) displayProbeMemo.delete(key);
  }
}

/**
 * The dead set for an over-ceiling rewound transcript: memo first, else one
 * bounded RPC to the session's host. Returns null when no answer is available
 * (no capable daemon, RPC failure, timeout) — the caller then serves unfiltered.
 *
 * `mtimeMs`/`size` are the caller's own stat when it has one; without it the
 * answer is still memoized under the identity the DAEMON reports (the probe
 * returns mtimeMs/size for exactly this reason), so a later read that does have
 * a stat can hit it.
 */
async function resolveOverCeilingDeadSet(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  rewindCuts: readonly InPlaceRewindCut[],
  mtimeMs?: number,
  size?: number,
): Promise<DisplayDeadSet | null> {
  const callerKey = mtimeMs !== undefined && size !== undefined
    ? displayProbeKey(sessionId, host, mtimeMs, size)
    : null;
  if (callerKey) {
    const hit = displayProbeMemoGet(callerKey);
    if (hit) {
      log.session.debug('over-ceiling dead set served from the memo (no RPC)', {
        sessionId, host: host ?? '__local__', deadUuids: hit.deadUuids.length,
      });
      return hit;
    }
  }
  try {
    const { probeRewindViaDaemon } = await import('./sessions/session-rewind.js');
    const probe = await probeRewindViaDaemon(
      { sessionId, cwd, host },
      { cuts: rewindCuts, timeoutMs: DISPLAY_PROBE_TIMEOUT_MS },
    );
    if (!probe || !probe.deadUuids) return null;
    const value: DisplayDeadSet = {
      deadUuids: probe.deadUuids,
      queueDeadKeys: probe.queueDeadKeys ?? [],
      skippedCuts: probe.skippedCuts ?? [],
      truncated: probe.truncated === true,
    };
    displayProbeMemoSet(
      callerKey ?? displayProbeKey(sessionId, host, probe.mtimeMs, probe.size),
      value,
    );
    return value;
  } catch (err) {
    log.session.debug('rewind probe failed on the byte-ceiling path', {
      sessionId, host: host ?? '__local__',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Memory pressure (memory-pressure.ts) cuts the budget to a quarter and drops
// the least recent entries at once: a parsed transcript nobody is reading is
// exactly the cold memory the kernel compresses, and every major GC has to
// touch it again. The entry read last stays, whatever its size.
let historyCacheBudgetChars = MAX_HISTORY_CACHE_CHARS;

export function setHistoryCacheShedding(shedding: boolean): { dropped: number; chars: number } {
  setTailWindowShedding(shedding);
  historyCacheBudgetChars = shedding ? Math.floor(MAX_HISTORY_CACHE_CHARS / 4) : MAX_HISTORY_CACHE_CHARS;
  let dropped = 0;
  if (shedding) {
    const keys = [...parsedHistoryCache.keys()];
    const newest = keys[keys.length - 1];
    for (const k of keys) {
      if (historyCacheChars <= historyCacheBudgetChars) break;
      if (k === newest) continue;
      cacheDelete(k);
      dropped += 1;
    }
  }
  return { dropped, chars: historyCacheChars };
}

function cacheSet(sessionId: string, entry: ParsedHistoryCacheEntry, host?: string): void {
  const key = cacheKey(sessionId, host);
  cacheDelete(key);
  parsedHistoryCache.set(key, entry);
  historyCacheChars += entry.approxChars;
  // Evict LRU until BOTH bounds hold. The just-inserted entry is exempt (it may
  // alone exceed the budget — see MAX_HISTORY_CACHE_CHARS comment).
  for (const oldest of parsedHistoryCache.keys()) {
    if (parsedHistoryCache.size <= MAX_HISTORY_CACHE && historyCacheChars <= historyCacheBudgetChars) break;
    if (oldest === key) continue;
    cacheDelete(oldest);
  }
}

// Re-export for backward compatibility
export { encodeProjectPath };
export { findLocalJsonlPath as findSessionJsonlPath } from './session-file-reader.js';
// A hook's added context reads as one injected row; the phone transcript names it the same way.
export { HOOK_CONTEXT_PREFIX, hookContextText } from '../lib/walnut-added.js';

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
  const jsonl = sessionJsonlHint(sessionId, host);
  const content = workflow
    ? (await readWorkflowSubagentContent(sessionId, agentId, cwd, host, jsonl))
        ?? (await readSingleSubagentContent(sessionId, agentId, cwd, host, jsonl)) // fall back to flat layout
    : await readSingleSubagentContent(sessionId, agentId, cwd, host, jsonl);
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
  const manifest = await readWorkflowManifest(sessionId, cwd, host, sessionJsonlHint(sessionId, host));
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
  newSize?: number,
  at?: { mtimeMs: number; size: number; epoch?: string },
): Promise<SessionHistoryMessage[] | null> {
  let inc = cached.inc!;
  try {
    // Re-read from the last parsed line's start: verifies the file wasn't
    // rewritten in place (/compact) AND picks up the appended bytes in one RPC.
    // `at` only when the stat was of this very file: then a read of the same bytes in flight is joined.
    const res = await reader.readFileRange(inc.filePath, inc.lastLineStart, at);
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

    const newTailText = inc.tailText + completePart;
    // Tail overgrown: roll it in memory, never with a read of the whole file
    // (2026-11-03: that read was 4 of the 5 left for a 28 MB transcript a day).
    let rolledOrphans: Set<string> | undefined;
    if (incrementalTailRolls(inc, newTailText)) {
      const rolled = await rollIncrementalTail(sessionId, inc, newTailText);
      if (!rolled) { cached.inc = undefined; return null; }
      inc = rolled.inc;
      cached.inc = rolled.inc;
      rolledOrphans = rolled.orphanIds;
    }

    // No seam guard on appended lines: the dead set is deterministic given
    // (cuts, file), appended lines sit after every cut's commit-time anchor and
    // can never join it, and a new rewind commit invalidates this whole cache
    // entry. An out-of-band rewind done in a terminal (no Walnut commit) simply
    // shows both branches — the pre-port status quo.
    //
    // Parse tail segment (+ any partial line + synthetic user events) fresh,
    // applying the SAME dead set + keys the seed's full parse computed —
    // the tail's rows must stay consistent with the frozen prefix.
    // A rolled state already holds this read's complete lines in its own tail.
    const tailNow = rolledOrphans ? inc.tailText : newTailText;
    const tailWithPartial = partialTail ? tailNow + partialTail : tailNow;
    const merged = await mergeSyntheticUserEvents(sessionId, tailWithPartial);
    const tailMessages = parseSessionMessages(merged, {
      chainFilter: { deadUuids: inc.deadUuids, queueDeadKeys: inc.queueDeadKeys },
    });
    const messages = [...inc.prefixMessages, ...tailMessages];
    // A turn begun in the prefix gives its asker to the tail's replies (grouped rows: all top level).
    markMessageAbout(messages);

    // Orphan finished-agent ids: the tail parse only marked tailMessages (a
    // different object), and the merged array is new — union the cached ids
    // (proven in the frozen prefix on earlier rounds) with the tail parse's set
    // and mark the array actually handed out. An id whose tool row sits in the
    // prefix may appear here too — benign: it is genuinely finished, so extra
    // finished-parent evidence can only absorb blocks correctly, never wrongly.
    const orphanUnion = new Set<string>(cached.orphanFinishedIds ?? []);
    for (const id of getOrphanFinishedAgentIds(tailMessages) ?? []) orphanUnion.add(id);
    for (const id of rolledOrphans ?? []) orphanUnion.add(id);
    markOrphanFinishedAgentIds(messages, orphanUnion);

    // Rewind-filter facts must be answerable on EVERY handed-out array, not
    // just full reads (same pattern as markOrphanFinishedAgentIds above): the
    // merged array is new each round, so re-mark it with the state's set.
    chainFilterMarks.set(messages, {
      deadUuids: inc.deadUuids,
      queueDeadKeys: inc.queueDeadKeys,
      droppedCount: inc.deadUuids?.size ?? 0,
    });

    try {
      const { bindEchoClaims } = await import('./echo-claims.js');
      bindEchoClaims(sessionId, messages);
    } catch { /* best-effort */ }

    // Advance persisted state (complete lines only; a roll already did).
    if (completePart && !rolledOrphans) {
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
    // would double-count the tail. The retained dead set rides the entry too:
    // ~40 chars per uuid (36-char uuid + Set overhead).
    const approxChars = inc.parsedBytes + (inc.deadUuids?.size ?? 0) * 40;
    cacheSet(sessionId, {
      mtimeMs: newMtimeMs, ...(newSize !== undefined ? { size: newSize } : {}), messages, approxChars, inc,
      ...(orphanUnion.size > 0 ? { orphanFinishedIds: [...orphanUnion] } : {}),
    }, host);

    // Keep the restart-survival disk cache fresh (same as the full-read path).
    // mtime included so the post-restart mtime fast-path can validate it.
    if (messages.length > 0) {
      // The state as of THIS read, taken now: the next read advances the same object.
      const incForDisk = incrementalStateForDisk(inc);
      import('./history-disk-cache.js').then(({ writeHistoryCache }) => {
        writeHistoryCache(sessionId, messages, newMtimeMs, [...orphanUnion], newSize, incForDisk);
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
 * A tail past the roll size, rolled in memory: a new boundary inside the tail, its
 * first part frozen onto the prefix. The tail's own parse is the truth for every row
 * past the prefix, so the new boundary is checked against that parse with the seed's
 * own gate (seedIncrementalState over the tail), and no byte before the old boundary
 * is read again. Undefined when no boundary passes: the caller then reads whole.
 */
async function rollIncrementalTail(
  sessionId: string,
  inc: HistoryIncrementalState,
  tailText: string,
): Promise<{ inc: HistoryIncrementalState; orphanIds: Set<string> } | undefined> {
  const content = await mergeSyntheticUserEvents(sessionId, tailText);
  const tailParse = parseSessionMessages(content, { chainFilter: { deadUuids: inc.deadUuids, queueDeadKeys: inc.queueDeadKeys } });
  chainFilterMarks.set(tailParse, { deadUuids: inc.deadUuids, queueDeadKeys: inc.queueDeadKeys, droppedCount: inc.deadUuids?.size ?? 0 });
  const why: { reason?: string } = {};
  const st = seedIncrementalState(sessionId, { content, source: 'local', canonicalChars: tailText.length, resolvedRemotePath: inc.filePath }, tailParse, inc.filePath, why);
  if (!st) {
    log.session.debug('incremental tail roll found no boundary — full read', { sessionId, reason: why.reason });
    return undefined;
  }
  const orphanIds = new Set(getOrphanFinishedAgentIds(st.prefixMessages) ?? []);
  return {
    inc: {
      ...st,
      tailStartByte: inc.tailStartByte + st.tailStartByte,
      parsedBytes: inc.tailStartByte + st.parsedBytes,
      lastLineStart: inc.tailStartByte + st.lastLineStart,
      prefixMessages: [...inc.prefixMessages, ...st.prefixMessages],
      pendingToolIds: [...inc.pendingToolIds, ...st.pendingToolIds],
      deadUuids: inc.deadUuids,
      queueDeadKeys: inc.queueDeadKeys,
      ...(inc.cutsKey !== undefined ? { cutsKey: inc.cutsKey } : {}),
    },
    orphanIds,
  };
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
  why?: { reason?: string },
): HistoryIncrementalState | undefined {
  const skip = (reason: string): undefined => { if (why) why.reason = reason; return undefined; };
  const filePath = result.resolvedRemotePath ?? statPath;
  if (!filePath) return skip('no-path');
  // Byte offsets only map into the canonical prefix of `content` (synthetic
  // stream events are appended past it).
  const canonical = result.canonicalChars !== undefined
    ? result.content.slice(0, result.canonicalChars)
    : result.content;
  if (!canonical.endsWith('\n') && canonical.length > 0) {
    // Trailing partial line — boundaries would be ambiguous; skip this round.
    // (Rare: the CLI writes whole lines; a mid-write race lands here.)
    return skip('partial-line');
  }
  // Candidate boundary: start of the line region occupying the last
  // TAIL_SEGMENT_KEEP_BYTES (in chars as a proxy; exact byte math done below).
  const keepFrom = Math.max(0, canonical.length - TAIL_SEGMENT_KEEP_BYTES);
  let boundaryChar = keepFrom === 0 ? 0 : canonical.indexOf('\n', keepFrom) + 1;
  if (boundaryChar <= 0 && keepFrom > 0) return skip('no-boundary'); // no newline past keepFrom

  // Self-validation: prefix-parse ++ tail-parse must equal the full parse.
  // fullMessages includes synthetic events parsed from the merged content; the
  // segmented model reproduces that by re-merging synthetics into the tail.
  // The rewind filter's dead set + queue keys are read off the full parse's
  // mark and applied IDENTICALLY to both segments — anything else fails the
  // equality gate below on every filtered session and incremental seeding
  // silently dies (the full-read-per-mtime-change regime). Both inputs are
  // position-free (uuid set + line-identity keys), so segment parses reproduce
  // the full parse exactly.
  const mark = getChainFilterMark(fullMessages);
  const deadUuids = mark?.deadUuids ?? null;
  const queueDeadKeys = mark?.queueDeadKeys ?? NO_QUEUE_DEAD_KEYS;
  const segFilter: ParseSessionMessagesOptions = { chainFilter: { deadUuids, queueDeadKeys } };
  const syntheticSuffix = result.canonicalChars !== undefined
    ? result.content.slice(result.canonicalChars)
    : '';
  // One boundary tried: the two segment parses, or why they are not the full parse.
  const tryBoundary = (at: number): { prefixMessages: SessionHistoryMessage[]; tailMessages: SessionHistoryMessage[] } | { reason: string } => {
    let prefixMessages: SessionHistoryMessage[];
    let tailMessages: SessionHistoryMessage[];
    try {
      prefixMessages = at > 0 ? parseSessionMessages(canonical.slice(0, at), segFilter) : [];
      tailMessages = parseSessionMessages(canonical.slice(at) + syntheticSuffix, segFilter);
    } catch {
      return { reason: 'parse-error' };
    }
    if (prefixMessages.length + tailMessages.length !== fullMessages.length) return { reason: 'count-mismatch' };
    // A row still in the CLI's queue moves to where the CLI takes it, and that line
    // lands after the boundary, where a tail re-parse cannot reach the enqueue: never
    // freeze one into the prefix.
    if (prefixMessages.some((m) => m.queued)) return { reason: 'queued-in-prefix' };
    for (let i = 0; i < fullMessages.length; i++) {
      const seg = i < prefixMessages.length ? prefixMessages[i] : tailMessages[i - prefixMessages.length];
      const full = fullMessages[i];
      if (seg.msgId !== full.msgId || seg.role !== full.role || seg.text !== full.text) return { reason: 'row-mismatch' };
      // Tools must match too — a tool_use in the prefix whose tool_result line
      // sits in the tail would silently lose its result in the segmented parse
      // (same text, different tool state). Compare name/result/error pairwise.
      const segTools = seg.tools ?? [];
      const fullTools = full.tools ?? [];
      if (segTools.length !== fullTools.length) return { reason: 'tool-mismatch' };
      for (let j = 0; j < fullTools.length; j++) {
        if (segTools[j].name !== fullTools[j].name
          || segTools[j].result !== fullTools[j].result
          || segTools[j].isError !== fullTools[j].isError
          || segTools[j].bgTaskFinished !== fullTools[j].bgTaskFinished) return { reason: 'tool-mismatch' };
      }
    }
    return { prefixMessages, tailMessages };
  };
  // A boundary that splits a tool call from its result, or freezes a queued row,
  // fails; the next try moves it before what it split (2026-11-03: one 28 MB
  // transcript failed every seed this way and was read whole 54 times a day).
  let tried = tryBoundary(boundaryChar);
  // Each try parses the whole transcript on the loop: a very large one gets one.
  const attempts = canonical.length > SEED_RETRY_MAX_CHARS ? 1 : SEED_ATTEMPTS;
  for (let attempt = 1; 'reason' in tried && attempt < attempts; attempt++) {
    const earlier = earlierSeedBoundary(canonical, boundaryChar, tried.reason);
    if (earlier === null) break;
    boundaryChar = earlier;
    tried = tryBoundary(boundaryChar);
  }
  if ('reason' in tried) {
    if (tried.reason === 'parse-error' || tried.reason === 'queued-in-prefix') return skip(tried.reason);
    if (why) why.reason = tried.reason;
    // The never-seed regime is a silent perf cliff — make a gate failure under an
    // active rewind filter observable (one debug line per seed attempt).
    if (deadUuids && deadUuids.size > 0) {
      log.session.debug('incremental seed equality gate failed under rewind filter — session stays on full reads', {
        sessionId, deadUuids: deadUuids.size,
      });
    }
    return undefined;
  }
  const { prefixMessages } = tried;
  const tailText = canonical.slice(boundaryChar);
  const prefixText = canonical.slice(0, boundaryChar);

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
    seedTailBytes: Buffer.byteLength(tailText, 'utf-8'),
    pendingToolIds,
    deadUuids,
    queueDeadKeys,
  };
}

/** Seed boundaries tried in all (each costs a parse of the transcript). */
const SEED_ATTEMPTS = 3;
/** Past this a transcript gets one seed try: a parse of it holds the loop too long to repeat. */
const SEED_RETRY_MAX_CHARS = 64 * 1024 * 1024;
/** A boundary is never moved so far back that the tail re-parsed on every read passes this. */
const SEED_MAX_TAIL_CHARS = 3 * 1024 * 1024;

/**
 * A boundary before what the one at `at` split, or null: the line of the last
 * prefix mention of a tool id the tail names without its tool_use (its result or
 * its background agent's notice came after the boundary), and for a queued row
 * the last enqueue before it; with neither, one keep window further back.
 */
export function earlierSeedBoundary(canonical: string, at: number, reason: string): number | null {
  let to = at;
  const tail = canonical.slice(at);
  // Only as far back as a tail may grow: a mention further back cannot be reached anyway,
  // and an id merely quoted in the tail (a grep of a transcript) must not scan the whole file.
  const lo = Math.max(0, canonical.length - SEED_MAX_TAIL_CHARS);
  const before = lo < at ? canonical.slice(lo, at) : '';
  const calls = new Set<string>();
  for (const m of tail.matchAll(/"id":"(toolu_[A-Za-z0-9_]{8,})"/g)) calls.add(m[1]!);
  const seen = new Set<string>();
  for (const m of tail.matchAll(/toolu_[A-Za-z0-9_]{8,}/g)) {
    const id = m[0];
    if (seen.has(id) || calls.has(id)) continue;
    seen.add(id);
    const prior = before.lastIndexOf(id);
    if (prior >= 0 && lo + prior < to) to = lo + prior;
  }
  if (reason === 'queued-in-prefix') {
    const enqueue = before.lastIndexOf('"operation":"enqueue"');
    if (enqueue >= 0 && lo + enqueue < to) to = lo + enqueue;
  }
  if (to === at) to = at - TAIL_SEGMENT_KEEP_BYTES;
  if (to <= 0) return canonical.length <= SEED_MAX_TAIL_CHARS && at > 0 ? 0 : null;
  const line = canonical.lastIndexOf('\n', to) + 1;
  if (line >= at || canonical.length - line > SEED_MAX_TAIL_CHARS) return null;
  return line;
}

/**
 * Whether the tail outgrew its segment: past the roll size, counted from the
 * tail the seed kept (a boundary moved back keeps a bigger one).
 */
export function incrementalTailRolls(inc: { seedTailBytes?: number }, newTailText: string): boolean {
  const limit = Math.max(TAIL_SEGMENT_ROLL_BYTES, (inc.seedTailBytes ?? 0) + TAIL_SEGMENT_ROLL_BYTES - TAIL_SEGMENT_KEEP_BYTES);
  return Buffer.byteLength(newTailText, 'utf-8') > limit;
}

/** Which recorded rewinds a dead set was computed from: a state kept across another set is never resumed. */

/** A row's identity for the restore check: its msgId, else its role and the head of its text. */
const prefixRowKey = (m: SessionHistoryMessage | undefined): string => (m ? (m.msgId ?? `${m.role}:${m.text.slice(0, 64)}`) : '');

/**
 * The incremental state as the disk cache keeps it, beside `messages` (whose first
 * prefixCount rows are its prefix). The tail's text is not kept: a resume reads it back
 * from the transcript (one range read, from tailStartByte), so a write stays the size
 * of the messages it already holds.
 */
export function incrementalStateForDisk(inc: HistoryIncrementalState): PersistedHistoryInc {
  const n = inc.prefixMessages.length;
  const children: number[] = [];
  inc.prefixMessages.forEach((m, i) => { if (aboutChildRows.has(m)) children.push(i); });
  return {
    v: 2, filePath: inc.filePath, tailStartByte: inc.tailStartByte, parsedBytes: inc.parsedBytes,
    lastLineStart: inc.lastLineStart, lastLineCheck: inc.lastLineCheck,
    ...(inc.seedTailBytes !== undefined ? { seedTailBytes: inc.seedTailBytes } : {}),
    pendingToolIds: [...inc.pendingToolIds], prefixCount: n,
    ...(n > 0 ? { prefixLastKey: prefixRowKey(inc.prefixMessages[n - 1]) } : {}),
    ...(children.length ? { aboutChildren: children } : {}),
    cutsKey: inc.cutsKey ?? '',
    deadUuids: inc.deadUuids ? [...inc.deadUuids] : null, queueDeadKeys: [...inc.queueDeadKeys],
  };
}

/**
 * The state back from the disk cache, its tail text still to be read (resumeIncrementalState),
 * or undefined when `messages` is not the parse it was kept with.
 */
export function incrementalStateFromDisk(p: PersistedHistoryInc, messages: SessionHistoryMessage[]): HistoryIncrementalState | undefined {
  if (p.prefixCount > messages.length) return undefined;
  if (p.prefixCount > 0 && prefixRowKey(messages[p.prefixCount - 1]) !== p.prefixLastKey) return undefined;
  const prefixMessages = messages.slice(0, p.prefixCount);
  for (const i of p.aboutChildren ?? []) if (prefixMessages[i]) aboutChildRows.add(prefixMessages[i]!);
  return {
    filePath: p.filePath, tailStartByte: p.tailStartByte, prefixMessages,
    parsedBytes: p.parsedBytes, lastLineStart: p.lastLineStart, lastLineCheck: p.lastLineCheck, tailText: '',
    ...(p.seedTailBytes !== undefined ? { seedTailBytes: p.seedTailBytes } : {}),
    cutsKey: p.cutsKey,
    pendingToolIds: [...p.pendingToolIds],
    deadUuids: p.deadUuids ? new Set(p.deadUuids) : null,
    queueDeadKeys: p.queueDeadKeys.length ? new Set(p.queueDeadKeys) : NO_QUEUE_DEAD_KEYS,
  };
}

/**
 * Resume the incremental state the disk cache kept (2026-11-03: 126 of a day's 247 cold
 * reads were a session's first after a restart, each then read whole), or null to read
 * as before. Not for a full-history caller, another file, a shrunk file, a tail-bounded
 * caller whose range would pass its window (a long run while nobody watched), or a dead
 * set computed from rewinds other than the ones recorded now.
 */
async function resumeFromKept(
  sessionId: string,
  host: string | undefined,
  entry: ParsedHistoryCacheEntry,
  stat: { path: string; mtimeMs: number; size: number },
  reader: InstanceType<(typeof import('./daemon-file-reader.js'))['DaemonFileReader']>,
  options: ReadHistoryOptions | undefined,
): Promise<SessionHistoryMessage[] | null> {
  const kept = entry.diskInc!;
  entry.diskInc = undefined;
  if (!options?.skipSubagents || kept.filePath !== stat.path || stat.size < kept.parsedBytes) return null;
  if (options.maxColdReadBytes && stat.size - kept.tailStartByte > options.maxColdReadBytes) return null;
  if (kept.cutsKey !== rewindCutsKey(await getInPlaceRewinds(sessionId))) return null;
  const inc = incrementalStateFromDisk(kept, entry.messages);
  if (!inc) return null;
  entry.inc = inc;
  const out = await resumeIncrementalState(sessionId, host, entry, stat.mtimeMs, reader, stat.size).catch(() => null);
  log.session.info(out ? 'history incremental read resumed from disk cache' : 'history incremental resume from disk cache failed — full read', {
    sessionId, host: host ?? '__local__', fileSize: stat.size, appendedBytes: stat.size - kept.parsedBytes,
  });
  if (!out) entry.inc = undefined;
  return out;
}

/**
 * Resume a kept state on the transcript as it is now: one range read from the tail's
 * start gives back the tail text (checked against the last parsed line) and whatever was
 * appended since, which the incremental read then takes from the same bytes. Null when
 * the transcript no longer holds what the state says (a rewrite), or the read failed.
 */
async function resumeIncrementalState(
  sessionId: string,
  host: string | undefined,
  entry: ParsedHistoryCacheEntry,
  newMtimeMs: number,
  reader: InstanceType<(typeof import('./daemon-file-reader.js'))['DaemonFileReader']>,
  newSize: number,
): Promise<SessionHistoryMessage[] | null> {
  const inc = entry.inc!;
  const res = await reader.readFileRange(inc.filePath, inc.tailStartByte);
  if (!res) return null;
  const bytes = Buffer.from(res.content, 'utf-8');
  const tailBytes = inc.parsedBytes - inc.tailStartByte;
  if (bytes.length < tailBytes) return null;
  const tailText = bytes.subarray(0, tailBytes).toString('utf-8');
  if (tailBytes > 0) {
    if (!tailText.endsWith('\n')) return null;
    const lastLine = tailText.slice(tailText.lastIndexOf('\n', tailText.length - 2) + 1, -1);
    if (inc.lastLineCheck && !historyLineMatches(lastLine, inc.lastLineCheck)) return null;
  }
  inc.tailText = tailText;
  // The incremental read re-reads from the last parsed line: serve it from these bytes.
  const fromLastLine = bytes.subarray(inc.lastLineStart - inc.tailStartByte).toString('utf-8');
  const served = {
    readFileRange: async (p: string, start: number) => (p === inc.filePath && start === inc.lastLineStart
      ? { content: fromLastLine, fileSize: res.fileSize }
      : reader.readFileRange(p, start)),
  } as unknown as typeof reader;
  return tryIncrementalHistoryRead(sessionId, host, entry, newMtimeMs, served, newSize);
}

/** The seed and its state shape, for tests and scripts/history-incremental-replay.ts. */
export { seedIncrementalState as _seedIncrementalStateForTesting, rollIncrementalTail as _rollIncrementalTailForTesting, TAIL_SEGMENT_ROLL_BYTES as _TAIL_SEGMENT_ROLL_BYTES };
export type { HistoryIncrementalState as _HistoryIncrementalState };

/**
 * The JSONL path a window read uses, or undefined when it cannot be found.
 * Hashed-cwd session (encoded cwd >200 chars) with no cached path: the
 * resolved-path cache is only seeded by a SUCCESSFUL full read, and a file over
 * the byte ceiling can never complete one, so for a hashed-cwd whale the cache
 * stays empty forever and the window read used to die right here, serving an
 * empty history for a healthy live session (inc-1786390337224: 70 MB JSONL,
 * "No conversation" on every load). One fs.find resolves it; cached so the next
 * read takes the stat fast-path.
 */
export async function resolveHistoryWindowPath(
  sessionId: string,
  cwd: string | undefined,
  daemonHost: string,
  reader: { stat(p: string): Promise<{ mtimeMs: number; size: number; epoch?: string } | null>; findSessionPath(sessionId: string): Promise<string | null> },
): Promise<string | undefined> {
  return (await locateTranscript(reader, sessionId, cwd, daemonHost))?.path;
}

/** True when the session has recorded in-place rewinds, which no window can filter. */
export async function hasInPlaceRewinds(sessionId: string): Promise<boolean> {
  return (await getInPlaceRewinds(sessionId)) !== undefined;
}

/**
 * Parse a run of whole JSONL lines cut from the end of a session's file (a
 * window), the way every window read does: Walnut's injected user lines merged
 * in, echo claims bound, and the result marked windowed.
 */
export async function parseHistoryWindowText(
  sessionId: string,
  windowText: string,
  parseOpts?: ParseSessionMessagesOptions,
): Promise<SessionHistoryMessage[]> {
  const merged = await mergeSyntheticUserEvents(sessionId, windowText);
  const parsed = parseSessionMessages(merged, parseOpts);
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
}

/**
 * Tail-bounded history read for consumers that only need RECENT messages
 * (search content indexing keeps ≤50 KB; the phone transcript sweep keeps the
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
 *
 * `parseOpts` is normally absent — a window cannot resolve rewind cut anchors on
 * its own (they may precede its start), so it parses UNFILTERED by design. The
 * one caller that passes it has a PRECOMPUTED dead set for the whole file (the
 * daemon's rewind probe), which is exactly the missing piece.
 */
export async function readSessionHistoryTailWindow(
  sessionId: string,
  cwd?: string,
  host?: string,
  maxTailBytes = 4 * 1024 * 1024,
  parseOpts?: ParseSessionMessagesOptions,
): Promise<SessionHistoryMessage[] | null> {
  const daemonHost = host ?? '__local__';
  try {
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(daemonHost);
    const statPath = await resolveHistoryWindowPath(sessionId, cwd, daemonHost, reader);
    if (!statPath) return null;
    const st = await reader.stat(statPath);
    if (!st) return null;
    // Clamp the window to the reader's own ceiling. Without this, a ceiling set
    // BELOW the tail size makes the degradation path itself get refused, so the
    // fallback for an oversized file silently returns nothing — the fallback must
    // never be able to exceed the limit that triggered it.
    const window = Math.min(maxTailBytes, DaemonFileReader.maxReadBytes());
    const start = Math.max(0, st.size - window);
    // Shared with a read of the same window already in flight (the transcript
    // sweep's, say): one transfer for both.
    const res = await reader.readFileRange(statPath, start, st);
    if (res === null) return null;
    // Skip the first (almost certainly partial) line when we didn't start at 0.
    let windowText = res.content;
    if (start > 0) {
      const nl = res.content.indexOf('\n');
      windowText = nl >= 0 ? res.content.slice(nl + 1) : '';
    }
    return await parseHistoryWindowText(sessionId, windowText, parseOpts);
  } catch (err) {
    log.session.debug('tail window read failed', {
      sessionId, host: daemonHost,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Parse the JSONL lines that START inside [start, end) of a session's file, the
 * unit older pages are read in once a file is past the full read's byte ceiling
 * (session-history-pages.ts). Which lines a window owns is jsonl-window.ts's
 * rule: windows laid end to end read every line once, and a call keeps its
 * result. Same line-based parse as the tail window. Walnut's injected user
 * lines ride along only when their time falls inside the window, or every page
 * would carry all of them. null = not readable this way: no resolvable path, or
 * a session with in-place rewinds (their cut anchors resolve against the whole
 * file, the same reason readSessionHistoryTail skips its window for them).
 */
export async function readSessionHistoryRange(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  start: number,
  end: number,
): Promise<{ messages: SessionHistoryMessage[]; fileSize: number; epoch?: string } | null> {
  if (await getInPlaceRewinds(sessionId)) return null;
  const daemonHost = host ?? '__local__';
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  const reader = new DaemonFileReader(daemonHost);
  const st = await locateTranscript(reader, sessionId, cwd, daemonHost);
  if (!st) return null;
  const statPath = st.path;
  const stop = Math.min(end, st.size);
  if (start >= stop) return { messages: [], fileSize: st.size, epoch: st.epoch };
  const { readJsonlLineWindow } = await import('./jsonl-window.js');
  const text = await readJsonlLineWindow(reader, statPath, start, stop, DaemonFileReader.maxReadBytes());
  if (text === null) return null;
  const stamps = text.match(/"timestamp":"([^"]+)"/g) ?? [];
  const first = stamps[0]?.slice(13, -1);
  const last = stamps[stamps.length - 1]?.slice(13, -1);
  let merged = text;
  if (first && last) {
    const injected = (await mergeSyntheticUserEvents(sessionId, '')).split('\n').filter((line) => {
      const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
      return ts !== undefined && ts >= first && ts <= last;
    });
    if (injected.length > 0) merged = text + '\n' + injected.join('\n');
  }
  const messages = parseSessionMessages(merged);
  try {
    const { bindEchoClaims } = await import('./echo-claims.js');
    bindEchoClaims(sessionId, messages);
  } catch { /* best-effort, as on the tail window */ }
  markWindowedRead(messages);
  return { messages, fileSize: st.size, epoch: st.epoch };
}

/**
 * ONE tool's result, read from the JSONL without the retained-row cap.
 *
 * Why this exists: HISTORY_TOOL_RESULT_MAX bounds what a WHOLE-transcript parse
 * keeps for every row at once, which is a real constraint on a list read and no
 * constraint at all on "show me this one step's output". Reading the row again
 * with the cap lifted for its tool_use_id alone is what makes a long result
 * readable to its end, at the cost of one bounded read + parse per expansion
 * (the caller only pays it for a row it already knows was cut).
 *
 * `maxChars` still bounds the answer: the caller pages, so a 25 MB result is never
 * materialized whole. `resultChars` on the returned row reports the true source
 * length even when this read is itself the thing that stopped short.
 *
 * Selection is by tool_use_id, never by position: the id is unique across the file,
 * so a rewound branch or a re-split message cannot be mistaken for the live row.
 * Returns undefined when the window has no such tool (rewound away, compacted, or
 * outside the bounded window) — the caller keeps the capped text it already has.
 */
export async function readSessionRowToolResult(
  sessionId: string,
  toolUseId: string,
  maxChars: number,
  cwd?: string,
  host?: string,
): Promise<{ text: string; sourceChars: number } | undefined> {
  if (!toolUseId || maxChars <= 0) return undefined;
  const parsed = await readSessionHistoryTailWindow(
    sessionId, cwd, host, HISTORY_COLD_TAIL_READ_BYTES,
    { toolResultMax: { toolUseId, max: maxChars } },
  );
  if (!parsed) return undefined;
  // Newest-first: a drawer is opened on something the user just watched happen.
  for (let i = parsed.length - 1; i >= 0; i--) {
    for (const tool of parsed[i].tools ?? []) {
      if (tool.toolUseId !== toolUseId || typeof tool.result !== 'string') continue;
      return { text: tool.result, sourceChars: tool.resultChars ?? tool.result.length };
    }
  }
  return undefined;
}

export async function readSessionHistoryTail(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
  maxTailBytes = 4 * 1024 * 1024,
  /** The caller reads the same session again soon (the transcript sweep): keep its window. */
  opts?: { poll?: boolean },
): Promise<SessionHistoryMessage[] | null> {
  const daemonHost = host ?? '__local__';
  {
    try {
      const { DaemonFileReader } = await import('./daemon-file-reader.js');
      const reader = new DaemonFileReader(daemonHost);
      const st = await locateTranscript(reader, sessionId, cwd, daemonHost);
      if (st && st.size > maxTailBytes) {
        // Serve from the shared cache when fresh — same data, zero I/O.
        const cached = cacheGet(sessionId, host);
        if (cached && isFresh(cached, st.mtimeMs, st.size)
            && (!cached.windowed || cached.approxChars >= Math.min(maxTailBytes, DaemonFileReader.maxReadBytes()))) return cached.messages;
        // A session with recorded in-place rewinds can't use the window: the
        // cut anchors resolve against the FULL file, and the cut/anchor lines
        // may precede the window's start — an unfilterable window would serve
        // the rewound-away branch as live. Fall through to the full
        // (cut-filtering) read instead.
        if (!(await getInPlaceRewinds(sessionId))) {
          if (!opts?.poll) return await readSessionHistoryTailWindow(sessionId, cwd, host, maxTailBytes);
          // Kept between reads and grown by the appended bytes: an unchanged
          // transcript moves nothing, a grown one about what was added.
          const { readTailWindow } = await import('./history-tail-window.js');
          const window = Math.min(maxTailBytes, DaemonFileReader.maxReadBytes());
          return await readTailWindow(
            `${cacheKey(sessionId, host)}|${window}`, reader, st.path, st, window,
            (text) => parseHistoryWindowText(sessionId, text),
          );
        }
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
  // Set when the LOCAL daemon failed to answer the stat at all (timeout, no
  // connection), as opposed to answering with an error.
  let localDaemonDown: string | undefined;
  {
    const daemonHost = host ?? '__local__';
    {
      try {
        const { DaemonFileReader } = await import('./daemon-file-reader.js');
        const reader = new DaemonFileReader(daemonHost);
        const statResult = await locateTranscript(reader, sessionId, cwd, daemonHost);
        if (statResult) statPath = statResult.path;
        if (statResult) {
          mtimeMs = statResult.mtimeMs;
          statSize = statResult.size;
          // The stat SUCCEEDED — the transcript file exists on disk, whatever the
          // parse yields. Every return below this point inherits that fact.
          sourceFound = true;
          const cached = cacheGet(sessionId, host);
          if (cached && isFresh(cached, mtimeMs, statSize)) {
            // A windowed entry (bounded cold tail) may only answer callers that
            // are themselves tail-bounded — a full-read caller (Load earlier,
            // fork ancestor read) falls through to the real full read below,
            // which overwrites this entry with the full parse.
            if (!cached.windowed || (options?.maxColdReadBytes && cached.approxChars >= options.maxColdReadBytes)) {
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
              if (disk?.mtimeMs !== undefined && disk.mtimeMs === mtimeMs && (disk.size === undefined || disk.size === statResult.size)) {
                log.session.info('history disk cache hit (mtime match) — skipping full read', {
                  sessionId, host: host ?? '__local__', messages: disk.messages.length,
                });
                // Re-mark orphan finished-agent ids: the WeakMap died with the
                // old process; the disk entry persisted the set explicitly.
                if (disk.finishedAgentIds?.length) {
                  markOrphanFinishedAgentIds(disk.messages, disk.finishedAgentIds);
                }
                // Seed the in-memory cache. The incremental state the entry kept
                // rides along unread: the next mtime change resumes from it.
                cacheSet(sessionId, {
                  mtimeMs, size: statResult.size, messages: disk.messages,
                  approxChars: statResult.size,
                  ...(disk.inc ? { diskInc: disk.inc } : {}),
                  ...(disk.finishedAgentIds?.length ? { orphanFinishedIds: disk.finishedAgentIds } : {}),
                }, host);
                return handOff(disk.messages);
              }
              // The transcript grew since the entry was written (a turn while the
              // server restarted, or the entry was evicted from memory).
              if (disk?.inc && disk.mtimeMs !== undefined) {
                if (disk.finishedAgentIds?.length) markOrphanFinishedAgentIds(disk.messages, disk.finishedAgentIds);
                const resumed = await resumeFromKept(sessionId, host, {
                  mtimeMs: disk.mtimeMs, ...(disk.size !== undefined ? { size: disk.size } : {}),
                  messages: disk.messages, approxChars: disk.inc.parsedBytes, diskInc: disk.inc,
                  ...(disk.finishedAgentIds?.length ? { orphanFinishedIds: disk.finishedAgentIds } : {}),
                }, statResult, reader, options);
                if (resumed) return handOff(resumed);
              }
            } catch { /* disk cache unusable — fall through to full read */ }
          }
          // A disk hit's kept state, its first change since: resume from it.
          if (cached && !cached.inc && cached.diskInc) {
            const resumed = await resumeFromKept(sessionId, host, cached, statResult, reader, options);
            if (resumed) return handOff(resumed);
          }
          // mtime CHANGED but incremental state exists and the file only grew:
          // read + parse just the appended bytes instead of the whole file.
          if (cached?.inc && options?.skipSubagents && statResult.size >= cached.inc.parsedBytes) {
            const incMessages = await tryIncrementalHistoryRead(
              sessionId, host, cached, statResult.mtimeMs, reader, statResult.size,
              statResult.path === cached.inc.filePath ? { mtimeMs: statResult.mtimeMs, size: statResult.size, epoch: statResult.epoch } : undefined,
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
        const error = err instanceof Error ? err.message : String(err);
        log.session.debug('fs.stat via daemon failed, skipping history cache', {
          sessionId, host: daemonHost, error,
        });
        if (!host && !error.startsWith('fs.stat failed:')) localDaemonDown = error;
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
  // A session with recorded in-place rewinds skips the window: the cut anchors
  // resolve against the FULL file, and a window that can't resolve them would
  // serve the rewound-away branch as live — take the full read below instead.
  // Fetched lazily HERE — after every cache fast-path has had its chance to
  // return — so the common case (no recorded rewind) pays this one PK SELECT
  // only when a real read is happening anyway.
  const rewindCuts = await getInPlaceRewinds(sessionId);

  if (options?.maxColdReadBytes && !rewindCuts && statPath && statSize !== undefined
      && statSize > options.maxColdReadBytes) {
    const win = await readSessionHistoryTailWindow(sessionId, cwd, host, options.maxColdReadBytes);
    if (win) {
      log.session.info('history cold read bounded to tail window', {
        sessionId, host: host ?? '__local__', fileSize: statSize,
        windowBytes: options.maxColdReadBytes, messages: win.length,
      });
      if (mtimeMs !== undefined) {
        // A timed-out preview may finish after the larger refresh. Never replace
        // that fresh, more complete parse with its smaller window.
        const current = cacheGet(sessionId, host);
        if (!current || !isFresh(current, mtimeMs, statSize)
            || (current.windowed && current.approxChars < options.maxColdReadBytes)) {
          cacheSet(sessionId, {
            mtimeMs, size: statSize, messages: win, approxChars: options.maxColdReadBytes, windowed: true,
            ...(getOrphanFinishedAgentIds(win)?.size
              ? { orphanFinishedIds: [...getOrphanFinishedAgentIds(win)!] } : {}),
          }, host);
        }
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

  // A file over the reader's hard byte ceiling (DaemonFileReader.maxReadBytes)
  // cannot be read whole. Degrade to the BOUNDED tail window rather than surfacing
  // a load error: a very long transcript still renders its recent history, which
  // is what the UI shows anyway. Only this specific ceiling degrades; transport
  // failures keep their existing contract. A designed answer, not a fault, so it
  // is logged at info (as a warn chain it ran ~2,000 times a day, 2026-11-13).
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  const serveOverCeilingTail = async (fileSize: number | undefined): Promise<SessionHistoryMessage[]> => {
    log.session.info('history over the byte ceiling — serving a bounded tail', {
      sessionId, host: host ?? '__local__', fileSize, limit: DaemonFileReader.maxReadBytes(),
    });
    // Over the ceiling is itself proof the file exists (and is huge).
    sourceFound = true;
    // Resolving the cut anchors needs the WHOLE file, which this transport
    // cannot read — but the session's HOST can read it. Ask its daemon for the dead
    // set (transcript.rewindProbe: only uuids cross the tunnel, memoized on the
    // file's identity, bounded by its own short deadline) and apply it to the
    // bounded tail. No answer, an answer past the probe's cap, or an answer whose
    // every cut was skipped → the documented degrade: serve the tail UNFILTERED,
    // which may include abandoned-branch lines, and say so in the log.
    let tailParseOpts: ParseSessionMessagesOptions | undefined;
    if (rewindCuts) {
      const dead = await resolveOverCeilingDeadSet(sessionId, cwd, host, rewindCuts, mtimeMs, statSize);
      if (dead) logSkippedRewindCuts(dead.skippedCuts);
      // "Every cut skipped" is NOT a filter that found nothing dead — it is the
      // unfilterable case wearing an empty dead set, so it takes the warn.
      const resolvedAnyCut = !!dead && !dead.truncated && dead.skippedCuts.length < rewindCuts.length;
      if (dead && resolvedAnyCut) {
        tailParseOpts = {
          chainFilter: {
            deadUuids: dead.deadUuids.length > 0 ? new Set(dead.deadUuids) : null,
            queueDeadKeys: new Set(dead.queueDeadKeys),
          },
        };
        log.session.info('over-ceiling rewound transcript filtered by the host daemon probe', {
          sessionId, host: host ?? '__local__', cuts: rewindCuts.length,
          deadUuids: dead.deadUuids.length, skippedCuts: dead.skippedCuts.length,
        });
      } else {
        log.session.warn('rewound transcript over the byte ceiling — bounded tail is served UNFILTERED', {
          sessionId, host: host ?? '__local__', cuts: rewindCuts.length,
          reason: !dead ? 'no_probe_answer' : dead.truncated ? 'dead_set_over_cap' : 'all_cuts_skipped',
          skippedCuts: dead?.skippedCuts.length ?? 0,
        });
      }
    }
    const tail = await readSessionHistoryTailWindow(sessionId, cwd, host, undefined, tailParseOpts);
    if (tail) return handOff(tail);
    // Tail unavailable too — last resort is the previous parse, else empty.
    return handOff(getCachedSessionHistory(sessionId, host) ?? []);
  };
  // The stat already says the whole read would be refused: go straight to the
  // tail instead of spending a round trip on a read that cannot complete.
  if (statPath && statSize !== undefined && statSize > DaemonFileReader.maxReadBytes()) {
    return serveOverCeilingTail(statSize);
  }
  let result: Awaited<ReturnType<typeof readSessionJsonlContent>>;
  try {
    result = await readSessionJsonlContent(sessionId, cwd, host, outputFile, {
      throwOnReadFailure: true, localDaemonError: localDaemonDown,
      knownPath: getResolvedRemotePath(sessionId, host ?? '__local__'),
    });
  } catch (err) {
    // No stat, or the file grew past the ceiling after it: the read refused it.
    if (!isByteCeilingError(err)) throw err;
    return serveOverCeilingTail(undefined);
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
      // Rewind-cut filter, fused into the parse (single per-line JSON.parse).
      // The content STRING is never rewritten — ReadSessionResult.canonicalChars
      // slicing in seedIncrementalState depends on the original string.
      // (A cut whose anchors are missing from the file is reported back as a
      // skippedCuts entry and warned about by logSkippedRewindCuts below —
      // computeRewindDeadSet itself stays log-free so it can run in the daemon
      // bundle. Named degrade, serve-all.)
      messages = parseSessionMessages(result.content, {
        chainFilter: 'auto',
        ...(rewindCuts ? { rewindCuts } : {}),
      });
      const chainMark = getChainFilterMark(messages);
      if (chainMark && chainMark.droppedCount > 0) {
        log.session.info('history rewind filter', {
          sessionId, droppedLines: chainMark.droppedCount, cuts: rewindCuts?.length ?? 0,
        });
      }

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
  let seeded: HistoryIncrementalState | undefined;
  if (mtimeMs !== undefined && options?.skipSubagents) {
    // Seed incremental append-read state so future mtime changes read only the
    // appended bytes (self-validating; undefined on any boundary hazard).
    // Only canonical daemon reads qualify — stream/outputFile fallbacks have no
    // stable byte-offset mapping to the canonical file.
    const inc = (result && (result.source === 'local' || result.source === 'remote'))
      ? seedIncrementalState(sessionId, result, messages, statPath)
      : undefined;
    if (inc) inc.cutsKey = rewindCutsKey(rewindCuts);
    seeded = inc;
    // Orphan finished-agent ids: the parser already marked `messages` in the
    // WeakMap; persist the set on the entry so future INCREMENTAL reads (whose
    // tail parse can't see prefix notifications) union it back in.
    const orphanIds = getOrphanFinishedAgentIds(messages);
    // The rewind dead set is retained with the entry (via inc and the parse
    // mark) — charge it to the byte budget: ~40 chars per uuid.
    const deadSetChars = (getChainFilterMark(messages)?.deadUuids?.size ?? 0) * 40;
    cacheSet(sessionId, {
      mtimeMs, ...(statSize !== undefined ? { size: statSize } : {}), messages, approxChars: sourceChars + deadSetChars,
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
    const incForDisk = seeded ? incrementalStateForDisk(seeded) : undefined;
    import('./history-disk-cache.js').then(({ writeHistoryCache }) => {
      writeHistoryCache(sessionId, messages, mtimeMs, orphanForDisk ? [...orphanForDisk] : undefined, statSize, incForDisk);
    }).catch(() => {});
  }

  return handOff(messages);
}


/** Plan candidates found in one stretch of transcript lines, read in file order. */
interface PlanFold {
  /** Content of the LAST Write to a `.claude/plans/` file. */
  lastWrittenPlan: string | null;
  /** An ExitPlanMode was met at all, even one whose input carried no plan. */
  exitSeen: boolean;
  /** `plan` input of the LAST ExitPlanMode (null when that one had none). */
  exitPlanContent: string | null;
}

/**
 * Fold transcript lines into their plan candidates. The whole-file read and the
 * over-ceiling tail scan share it, so both apply one rule: the last Write to a
 * plans/ file wins (richer), else the last ExitPlanMode's `plan` input.
 * Throws only on a line shape the loop cannot walk; callers turn that into null.
 */
function foldPlanLines(lines: Iterable<string>): PlanFold {
  const fold: PlanFold = { lastWrittenPlan: null, exitSeen: false, exitPlanContent: null };
  for (const line of lines) {
    if (!line) continue;
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
        fold.lastWrittenPlan = block.input.content;
      }

      // Capture ExitPlanMode
      if (block.name === 'ExitPlanMode') {
        fold.exitSeen = true;
        fold.exitPlanContent = typeof block.input?.plan === 'string' && block.input.plan
          ? block.input.plan
          : null;
      }
    }
  }
  return fold;
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
  //
  // A transcript over the reader's byte ceiling (DaemonFileReader.maxReadBytes)
  // can never be read whole: the reader refuses it, and readSessionJsonlContent
  // re-throws that refusal on purpose. Uncaught here it turned GET /plan into a
  // 500 for every long session (a 63 MB transcript, 2026-10-01). The plan a user
  // opens is the newest one, which sits near the end, so only this specific
  // refusal degrades to a bounded scan of the tail; transport failures keep
  // their existing contract.
  let result: Awaited<ReturnType<typeof readSessionJsonlContent>>;
  try {
    result = await readSessionJsonlContent(sessionId, cwd, host);
  } catch (err) {
    if (!isByteCeilingError(err)) throw err;
    log.session.info('plan extraction over the byte ceiling — scanning the transcript tail instead', {
      sessionId, host: host ?? '__local__', error: err instanceof Error ? err.message : String(err),
    });
    return extractPlanFromTranscriptTail(sessionId, cwd, host);
  }
  const content = result?.content;
  if (!content) return null;

  try {
    const fold = foldPlanLines(content.split('\n').filter(Boolean));
    // Prefer Write content (richer), fall back to ExitPlanMode.input.plan
    return fold.lastWrittenPlan ?? fold.exitPlanContent;
  } catch (err) {
    log.session.warn('failed to extract plan content', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** One step of the over-ceiling plan scan; clamped to the reader's own ceiling. */
const PLAN_TAIL_WINDOW_BYTES = 4 * 1024 * 1024;
/** Steps before giving up: 32 MiB of transcript at the default window. */
const PLAN_TAIL_MAX_WINDOWS = 8;
/** Wall-clock budget for steps after the first, so a slow tunnel cannot pin the route. */
const PLAN_TAIL_SCAN_BUDGET_MS = 30_000;
/** fs.readRange piece size. Matches DaemonFileReader's chunking: one piece is one
 *  WS frame, and frames over a few MB get killed by some proxies. */
const PLAN_TAIL_PIECE_BYTES = 1024 * 1024;

/**
 * Locate a transcript on its host and stat it: every stat of a transcript goes
 * through here. Same order as readSessionJsonlContent: a path an earlier read
 * found, then the cwd-encoded path, then fs.find (remembered). The find covers a
 * hashed cwd (encoded form over 200 chars) AND a cwd the CLI stored under its
 * symlink-resolved encoding: a session started in /home/u/x on a host where
 * /home/u links to /local/home/u lives under `-local-home-u-x`. Stat-ing only the
 * encoded path said "no file" for such a session, so every reader skipped its
 * cache and its append-only read and read the whole file again, each minute
 * (2026-10-31: about 700 whole reads, 4 GB, an hour from one host).
 */
async function locateTranscript(
  reader: { stat(p: string): Promise<{ mtimeMs: number; size: number; epoch?: string } | null>; findSessionPath(sessionId: string): Promise<string | null> },
  sessionId: string,
  cwd: string | undefined,
  daemonHost: string,
): Promise<{ path: string; size: number; mtimeMs: number; epoch?: string } | null> {
  const memo = getResolvedRemotePath(sessionId, daemonHost);
  const direct = [
    memo,
    cwd && isSafeForProjectEncoding(cwd) ? remoteJsonlPath(sessionId, cwd, daemonHost) : undefined,
  ].filter((p): p is string => !!p);
  for (const p of new Set(direct)) {
    const st = await reader.stat(p);
    // Remembered (and kept recent) where it was found, so the next stat goes there first.
    if (st) { setResolvedRemotePath(sessionId, daemonHost, p); return { ...st, path: p }; }
  }
  // No file yet (a session that has not written one, an old one swept away): a find
  // walks every project dir, so a miss is remembered for a while instead of walked
  // again by each caller of the same read.
  const missKey = resolvedPathKey(sessionId, daemonHost);
  const missAt = locateMisses.get(missKey);
  if (missAt !== undefined && Date.now() - missAt < LOCATE_MISS_MS) return null;
  let found: string | null;
  try {
    found = await reader.findSessionPath(sessionId);
  } catch {
    return null; // not located; the caller's own read decides what failed
  }
  if (!found) {
    locateMisses.set(missKey, Date.now());
    if (locateMisses.size > MAX_RESOLVED_PATHS) locateMisses.delete(locateMisses.keys().next().value!);
    return null;
  }
  const st = await reader.stat(found);
  if (!st) return null;
  setResolvedRemotePath(sessionId, daemonHost, found);
  return { ...st, path: found };
}

/** A transcript not found is not looked for again for this long (locateTranscript). */
const LOCATE_MISS_MS = 60_000;
const locateMisses = new Map<string, number>();

/** Bytes [start, end) of a file, in frame-sized pieces. Null when the file is gone. */
async function readTranscriptBytes(
  reader: import('./daemon-file-reader.js').DaemonFileReader,
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer | null> {
  const pieces: Buffer[] = [];
  let offset = start;
  while (offset < end) {
    const res = await reader.readRangeBytes(filePath, offset, Math.min(PLAN_TAIL_PIECE_BYTES, end - offset));
    if (res === null) return null;
    if (res.buf.length > 0) {
      pieces.push(res.buf);
      offset += res.buf.length;
    }
    if (res.eof || res.buf.length === 0) break;
  }
  return Buffer.concat(pieces);
}

/**
 * The newest plan in a transcript too large to read whole, found by stepping
 * BACKWARD through bounded windows from the end of the file.
 *
 * Each window is folded in file order with the same rule as the whole read, and
 * the scan stops at the first window that yields a plan: a Write to a plans/
 * file there is the newest Write in the file, so it wins outright; otherwise
 * the newest ExitPlanMode decides. That ExitPlanMode is final once met, so when
 * it carried no plan the scan keeps stepping back for a Write only and ignores
 * older ExitPlanModes, exactly as the whole read would. The one place this can
 * differ from the whole read: a Write further back than the window holding the
 * newest ExitPlanMode plan is not looked for, so the newest plan is served
 * rather than an older written one.
 *
 * A line can straddle a window edge, so the leading partial line of each window
 * is carried as BYTES and prepended to the next (earlier) window; decoding only
 * whole lines means a window edge can never split a multi-byte character. The
 * scan is bounded by PLAN_TAIL_MAX_WINDOWS windows and a time budget, then
 * answers null: "no plan found" beats a request that pins the route.
 */
async function extractPlanFromTranscriptTail(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<string | null> {
  const daemonHost = host ?? '__local__';
  const startedAt = Date.now();
  try {
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(daemonHost);
    const target = await locateTranscript(reader, sessionId, cwd, daemonHost);
    if (!target) return null;
    const windowBytes = Math.min(PLAN_TAIL_WINDOW_BYTES, DaemonFileReader.maxReadBytes());
    const floor = Math.max(0, target.size - windowBytes * PLAN_TAIL_MAX_WINDOWS);

    let end = target.size;
    let carry: Buffer = Buffer.alloc(0);
    let exitSeen = false;
    let exitPlan: string | null = null;
    let plan: string | null = null;
    while (end > floor && plan === null) {
      if (end < target.size && Date.now() - startedAt > PLAN_TAIL_SCAN_BUDGET_MS) break;
      const start = Math.max(floor, end - windowBytes);
      const bytes = await readTranscriptBytes(reader, target.path, start, end);
      if (bytes === null) break;
      const buf = carry.length > 0 ? Buffer.concat([bytes, carry]) : bytes;
      end = start;
      let body = buf;
      if (start > 0) {
        // Everything before the first newline belongs to a line that began
        // earlier in the file: carry it into the next window.
        const nl = buf.indexOf(0x0a);
        if (nl < 0) { carry = buf; continue; }
        carry = Buffer.from(buf.subarray(0, nl));
        body = buf.subarray(nl + 1);
      }
      const fold = foldPlanLines(body.toString('utf-8').split('\n'));
      if (fold.lastWrittenPlan) {
        plan = fold.lastWrittenPlan;
      } else {
        if (!exitSeen && fold.exitSeen) {
          exitSeen = true;
          exitPlan = fold.exitPlanContent;
        }
        if (exitPlan) plan = exitPlan;
      }
    }
    log.session.info('plan extraction scanned the transcript tail', {
      sessionId, host: daemonHost, fileSize: target.size,
      scannedBytes: target.size - end, found: plan !== null,
    });
    return plan;
  } catch (err) {
    log.session.warn('plan extraction from the transcript tail failed', {
      sessionId, host: daemonHost,
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
  // The rewrite is in place, and the in-memory history cache hands the same
  // message objects to every request, so a message already rewritten at this
  // size is skipped (its paths are mirror slots now, which both
  // passes below leave alone anyway): on a remote session every request (cache
  // hits and 400-row deltas included) used to run the image regexes and an
  // existsSync per path over the WHOLE history again.
  const pending = messages.filter((msg) => rewrittenImages.get(msg) !== imageRewriteSignature(msg))
  if (pending.length === 0) return messages

  const cache = new Map<string, string>()
  const fs = await import('node:fs')

  // Pre-scan: build filename → absolute path hints from tool inputs/results.
  // Tool inputs (e.g. Bash `cp` commands, file paths) contain full absolute paths
  // that are more accurate than CWD-based resolution for relative filenames.
  // Per message the scan is memoized under the same signature as the rewrite.
  const filePathHints = new Map<string, string[]>()
  const addHint = (p: string) => {
    const bn = path.basename(p)
    const arr = filePathHints.get(bn)
    if (arr) { if (!arr.includes(p)) arr.push(p) }
    else filePathHints.set(bn, [p])
  }
  for (const msg of messages) {
    if (!msg.tools) continue
    const signature = imageRewriteSignature(msg)
    const memo = imageHints.get(msg)
    const hints = memo && memo.signature === signature ? memo.paths : scanImageHints(msg)
    if (!memo || memo.signature !== signature) imageHints.set(msg, { signature, paths: hints })
    for (const p of hints) addHint(p)
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
      // Skip local paths, and anything that is (or embeds) a mirror slot already
      // — re-mirroring rewritten text mints a second, undownloadable slot and
      // re-attempts its download on every single replay. See looksAlreadyMirrored.
      if (remotePath.startsWith(LOCAL_HOME) || remotePath.startsWith(REMOTE_IMAGES_DIR)) continue
      if (looksAlreadyMirrored(remotePath)) continue

      let localPath = cache.get(remotePath)
      if (!localPath) {
        // Hash-keyed slot (falls back to a legacy bare-basename mirror only when
        // its sidecar proves the same origin) — two dirs' same-named chart.png
        // must not share one slot.
        localPath = resolveSessionMirrorPath(sessionId, remotePath)
        cache.set(remotePath, localPath)

        if (!fs.existsSync(localPath)) {
          // Published: the <img> for this slot can arrive before the bytes do.
          const lp = localPath
          startMirrorDownload(host, lp, () => downloadImageViaDaemon(host, remotePath, lp)).catch(() => {})
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
        // A relative name can embed a mirror slot too: the corrupted shape
        // `images/tmp/open-walnut/images/remote/<sid>/<hash>-x.png` matches the
        // relative-name regex, and joining it onto cwd invents a path that has
        // never existed on any host.
        if (looksAlreadyMirrored(relName)) continue
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
            startMirrorDownload(host, lp, async () => {
              for (const candidate of candidates) {
                if (await downloadImageViaDaemon(host, candidate, lp)) return true
              }
              return false
            }).catch(() => {})
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

  for (const msg of pending) {
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
    rewrittenImages.set(msg, imageRewriteSignature(msg))
  }

  return messages
}

/** Messages whose image paths were already rewritten, by content size (see rewriteHistoryRemoteImages). */
const rewrittenImages = new WeakMap<SessionHistoryMessage, string>()
/** Absolute image paths found in a message's tool inputs and results, under the same signature. */
const imageHints = new WeakMap<SessionHistoryMessage, { signature: string; paths: string[] }>()

const imageRewriteSignature = (msg: SessionHistoryMessage): string =>
  `${msg.text?.length ?? 0}:${msg.tools?.reduce((n, t) => n + (t.result?.length ?? 0), 0) ?? 0}`

function scanImageHints(msg: SessionHistoryMessage): string[] {
  const isUsefulHint = (p: string) =>
    !p.startsWith(LOCAL_HOME) &&        // skip local filesystem paths
    !looksAlreadyMirrored(p) &&         // a rewritten path is not a source of truth
    p.lastIndexOf('/') > 0              // require at least two path components
  const paths: string[] = []
  for (const tool of msg.tools ?? []) {
    const inputStr = typeof tool.input === 'string'
      ? tool.input
      : (tool.input ? JSON.stringify(tool.input) : '')
    for (const p of findImagePaths(inputStr)) {
      if (isUsefulHint(p) && !paths.includes(p)) paths.push(p)
    }
    if (tool.result) {
      for (const p of findImagePaths(tool.result)) {
        if (isUsefulHint(p) && !paths.includes(p)) paths.push(p)
      }
    }
  }
  return paths
}
