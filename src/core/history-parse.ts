/**
 * The transcript parser: Claude Code's JSONL lines to the rows every history surface shows.
 *
 * Pure and synchronous: no I/O, no logger, no Walnut state beyond what a caller passes. It is the
 * ONE parser, shared by the server (session-history.ts re-exports all of it) and the session
 * daemon, which builds a session's first-paint view next to its transcript
 * (src/providers/history-ready-core.ts, 'history-ready-v1'). Keep its imports lean: the daemon
 * twins bundle this file and everything it imports (the "one parser" block of
 * tests/providers/history-ready-twins.test.ts walks the import graph). A change to it, or to
 * anything it imports, changes HISTORY_PARSER_VERSION: run
 * `bun scripts/history-parser-version.mjs --write` (tests/core/history-parser-version-ratchet.test.ts).
 * Diagnostics and the transcript-format canary go through `parseHooks`, which
 * session-history.ts points at the server's logger; the daemon leaves them quiet.
 *
 * Moved verbatim from session-history.ts (2026-11-11); the history docs there still describe it.
 */

import { redactAiOnly } from '../lib/ai-only-envelope.js';
import { hookContextText } from '../lib/walnut-added.js';
import { NATIVE_PEER_TAGS, nonHumanOrigin } from '../lib/history-session-envelope.js';
import type { InPlaceRewindCut } from './types.js';
import { projectUserText } from './sessions/user-text-projection.js';
import { withLegacyHintCutoff } from './sessions/legacy-hint-lines.js';
import type { CarriedHint } from './hints/hint-format.js';
import { cutEnd } from './text-cut.js';
import { COMPACTED_MESSAGE, compactedDetail } from './stream/compaction-notice.js';
import { hookFailureNotice } from './stream/hook-notice.js';
import { computeRewindDeadSet, queueEnqueueKey, type SkippedRewindCut } from './transcript-chain.js';
import { isCacheWarmupText } from './sessions/side-thread-warmup.js';
import { IDLE_COMPACT_HISTORY_TEXT, IDLE_COMPACT_UUID_PREFIX } from './sessions/prompt-cache.js';
import { isWalnutCommandNotice, walnutCommandNotice } from './sessions/walnut-commands.js';
import { messageAbout, readAboutTag } from './org/message-about.js';
import { CLI_ERROR_PREFIX, isCliErrorReply } from './sessions/cli-error-reply.js';
import { SIDE_THREAD_DIGEST_TAG, stripSideThreadDigestRequest } from './sessions/side-thread-digest.js';

/**
 * The parse's shape version: a cached or kept parse (the history disk cache, the first-paint
 * view, a daemon's ready view) written under another number is dropped, never served. The bump
 * log lives beside HISTORY_CACHE_SCHEMA's re-export in history-disk-cache.ts.
 */
export const HISTORY_CACHE_SCHEMA = 12;

/** A transcript line as the format canary reads it (transcript-line-types.ts CanaryLine). */
export interface ParseCanaryLine {
  type?: unknown;
  version?: unknown;
  claude_code_version?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
}

/** Where the parse's diagnostics go. Quiet until a caller points them somewhere. */
export interface HistoryParseHooks {
  warn(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  noteLineType(line: ParseCanaryLine, fallbackVersion?: string): void;
  noteBlockTypes(content: unknown, line: ParseCanaryLine, fallbackVersion?: string): void;
}
const quiet = (): void => {};
const parseHooks: HistoryParseHooks = { warn: quiet, debug: quiet, noteLineType: quiet, noteBlockTypes: quiet };

/** Point the parse's diagnostics at a logger (the server's, in session-history.ts). */
export function setHistoryParseHooks(hooks: Partial<HistoryParseHooks>): void {
  Object.assign(parseHooks, hooks);
}

/** Rewind-filter facts attached to a parse result (WeakMap on the ARRAY, same
 *  pattern as windowedParses below): what the 'auto' cut replay computed, so
 *  seedIncrementalState can reuse the EXACT set + windows for its segment
 *  parses and the full-read path can log without recomputing. */
export interface ChainFilterMark {
  deadUuids: Set<string> | null;
  queueDeadKeys: Set<string>;
  droppedCount: number;
}
export const chainFilterMarks = new WeakMap<object, ChainFilterMark>();
/** The rewind-filter facts for a parse produced with `chainFilter: 'auto'`. */
export function getChainFilterMark(messages: object): ChainFilterMark | undefined {
  return chainFilterMarks.get(messages);
}

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


/**
 * Characters of a tool_result a parsed row RETAINS.
 *
 * The bound is on what every row of a whole-transcript parse keeps at once (and
 * what the mtime cache then holds for the session's lifetime) — a 25 MB `result`
 * on one row would be paid for by every reader of that cache. It is deliberately
 * NOT a bound on how much of a result a human can read: a single-row read lifts it
 * for exactly one tool_use_id (see readSessionRowToolResult), because there the
 * whole-transcript argument buys nothing.
 *
 * A row that was cut carries `resultChars` = the length it HAD, so no reader can
 * mistake a prefix for the whole output.
 */
export const HISTORY_TOOL_RESULT_MAX = 5_000;

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  /** Characters the tool_result HAD when `result` is only its first
   *  HISTORY_TOOL_RESULT_MAX (absent = `result` is the whole output). Counted on
   *  the source, so a reader can say "showing the first N of M" and a full-text
   *  read knows there is more to fetch. */
  resultChars?: number;
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
  /** For role='system': the secondary half of the row (the numbers on a
   *  compaction). Split out so a reloaded row renders IDENTICALLY to the live
   *  one — the same headline plus the same muted detail — instead of folding
   *  everything into one parenthesised string. */
  systemDetail?: string;
  /** For role='system': Claude Code's own error reply ("Prompt is too long", an API error), not the model's answer. */
  cliError?: true;
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
  /** A `queue-<ts>` user row that ran mid-turn: the uuid it was SENT under, which the
   *  CLI records only on its `queued_command` attachment (`source_uuid`), never as a
   *  line uuid. A question's anchor and meta are keyed by that uuid, so this is how
   *  the row is found again. Not a transcript line id: `msgId` stays `queue-…`. */
  sourceUuid?: string;
  /** This row's CONTENT can still change: the ACP fold marks its active text/thinking
   *  segment; the /history route also marks an Agent/Task row awaiting its late
   *  `bgTaskFinished`, or a tool row awaiting its result. The client re-asks for these ids on its next delta, which
   *  is the only way a prefix synced mid-flight ever gets corrected
   *  (inc-1785965937858). See src/core/history-delta.ts. */
  unsettled?: boolean;
  /** A user row still in Claude Code's queue: sent, not yet handed to the model.
   *  It has no place in the conversation yet (the CLI puts it where it takes it),
   *  so the parse moves it past everything written since its enqueue and a chat
   *  draws it after the live output, never above words the model wrote first. */
  queued?: boolean;
  /** True for CLI-injected user lines the human did NOT type (skill content
   *  dumps, compaction continuation summaries, image-read metadata, auto
   *  "Continue" prompts). Detected via the CLI's own flags — canonical JSONL
   *  marks them isMeta/isCompactSummary/isVisibleInTranscriptOnly, stream-json
   *  stdout maps all of those to isSynthetic (QueryEngine emit path). The UI
   *  renders these as a collapsed context row, never a "You" bubble. */
  injected?: boolean;
  /** User rows: the CLI's own `origin` says a person did not type it (`peer`, `task-notification`,
   *  any kind but `human`), or its tag is another session's mail. `sentBy` reads `agent` for it
   *  whatever its text looks like (sessions/transcript-sent-by.ts). */
  agentOrigin?: boolean;
  /** User rows: the message hints Walnut sent with it (hints/hint-format.ts). */
  hints?: CarriedHint[];
  /** User rows whose display differs from what the model received: the text as
   *  received, hints and every other machine wrapper included (the raw view). */
  rawText?: string;
  /** Assistant rows: the tasks this message is about (core/org/message-about.ts), drawn under it
   *  in Main's, a VP's and a lead's chat: the `<walnut-about>` line it ended with (taken off
   *  `text`), else its turn's asker and the tasks the turn sent to. */
  about?: string[];
  /** `about` came from the message's own line, not the turn's fallback. */
  aboutTagged?: boolean;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Internal: raw JSONL line shape ──

export interface RawJsonlLine {
  type: string;
  subtype?: string;
  /** Where the CLI says a user line came from (`{kind: "human" | "peer" | "task-notification" | …}`). */
  origin?: { kind?: string } | null;
  /** Claude Code version that wrote the line (canonical transcript lines). */
  version?: string;
  uuid?: string;
  timestamp?: string;
  /** parentUuid chain edge (tree lines only). Not consumed here — the rewind
   *  filter is uuid-anchored (transcript-chain.ts computeRewindDeadSet); the
   *  chain walk itself only runs at rewind-commit validation time. */
  parentUuid?: string | null;
  /** Legacy inline-subagent flag (leaf selection in computeCliLoadedChain). */
  isSidechain?: boolean;
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
  commandOutcome?: { kind?: string };
  local_command_outcome?: { kind?: string };
  local_command_source?: string;
  /** Claude Code's own error reply (transcript: isApiErrorMessage; stream capture: `error` with the synthetic model). */
  isApiErrorMessage?: boolean;
  error?: unknown;
  // queue-operation fields (FIFO-injected user messages)
  operation?: string;
  content?: string;
  /** type='attachment' lines; `queued_command` carries a mid-turn send as the model saw it,
   *  and `source_uuid` is the uuid the line was sent under (the CLI writes no user line). */
  attachment?: { type?: string; prompt?: unknown; source_uuid?: unknown; content?: unknown; hookEvent?: unknown };
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

/** Text of a `queued_command` attachment's prompt: a string, or a content array
 *  whose first text block holds it (an image send). */
export function queuedCommandText(prompt: unknown): string | undefined {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return undefined;
  const tb = prompt.find((b): b is { type: 'text'; text: string } =>
    (b as { type?: string })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string');
  return tb?.text;
}


/** CLI-flagged injected user line (not typed by the human). Canonical JSONL:
 *  isMeta / isCompactSummary / isVisibleInTranscriptOnly; stream-json stdout
 *  folds all of those into isSynthetic. walnut-injected synthetic events are
 *  handled separately (walnutMessageId dedup) — excluded here. */
export function isInjectedLine(raw: RawJsonlLine): boolean {
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
export function groupInlineChildren(
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

export interface ParseSessionMessagesOptions {
  /** In-place rewind filter (see transcript-chain.ts computeRewindDeadSet),
   *  three modes:
   *  - `'auto'`: replay `rewindCuts` against THIS content (the full-read path).
   *    The result array gets a ChainFilterMark so seedIncrementalState can
   *    reuse the exact set + keys.
   *  - `{ deadUuids, queueDeadKeys }`: apply a precomputed set (the
   *    incremental tail parse and the seed's two segment parses). MUST be the
   *    exact pair the full parse computed, or the seed's equality gate fails
   *    and incremental state never seeds.
   *  - absent: no filtering (subagent files own their own transcripts; a tail
   *    window can't resolve the cut anchors and is unfilterable by design). */
  chainFilter?: 'auto' | {
    deadUuids: Set<string> | null;
    queueDeadKeys?: Set<string>;
  };
  /** The session's recorded in-place rewind cuts (record.inPlaceRewinds),
   *  looked up by the CALLER — this function does no I/O. Only meaningful with
   *  'auto'; absent/empty = identity (never-rewound sessions pay nothing). */
  rewindCuts?: readonly InPlaceRewindCut[];
  /** Retain up to `max` characters of ONE tool's result instead of
   *  HISTORY_TOOL_RESULT_MAX. Scoped to a single tool_use_id on purpose: the
   *  single-row detail read needs one row whole, and raising the cap for every
   *  row of the same parse would multiply the peak by the number of long results
   *  in the transcript. Every other row keeps the default. */
  toolResultMax?: { toolUseId: string; max: number };
  /** The legacy-hint cutoff (ms, legacy-hint-lines.ts) for this parse only: a session daemon
   *  serving several servers passes the asking server's value here and never sets a global. */
  legacyHintCutoffMs?: number;
  /** Retain up to this many characters of EVERY tool result (an engine switch
   *  carries the whole active context, sessions/engine-switch-context.ts). A
   *  one-off read: list reads never pass it. */
  toolResultMaxAll?: number;
}

/** `result` (cut to `max`) plus `resultChars` when there WAS more — see
 *  HISTORY_TOOL_RESULT_MAX. `>` not `>=`: a result of exactly `max` characters
 *  lost nothing, so it must not be reported as cut. */
export function toolResultFields(text: string, max: number): { result: string; resultChars?: number } {
  // The cut lands on a code-point boundary (see core/text-cut.ts): this text is
  // delivered verbatim in a row's `resultPreview` and in the detail read, and a cut
  // through an emoji leaves a lone surrogate that a strict JSON decoder rejects for
  // the WHOLE response. `resultChars` keeps counting the source in UTF-16 code units.
  return text.length > max ? { result: text.slice(0, cutEnd(text, max)), resultChars: text.length } : { result: text };
}

/** Shared empty set — the no-filter path never allocates per parse. */
export const NO_QUEUE_DEAD_KEYS: Set<string> = new Set();

/** Warn once per rewind cut the replay refused to apply (see the type's doc in
 *  transcript-chain.ts — that module has no logger, so its callers own this). */
export function logSkippedRewindCuts(skipped: readonly SkippedRewindCut[] | undefined): void {
  for (const cut of skipped ?? []) {
    parseHooks.warn('rewind cut anchor missing or duplicated in transcript — cut skipped, region served unfiltered', {
      cutUuid: cut.cutUuid,
      lastUuidAtCommit: cut.lastUuidAtCommit,
      cutFound: cut.cutFound,
      anchorFound: cut.anchorFound,
      cutDuplicated: cut.cutDuplicated,
      anchorDuplicated: cut.anchorDuplicated,
    });
  }
}

/**
 * A row still in Claude Code's queue (`queued`) has no place yet: the CLI takes
 * queued lines in order (FIFO) and the row goes where it is taken. Until then
 * everything the CLI wrote after its enqueue was written before the model saw it,
 * so the row moves to the end. In place, the reply being written under it read as
 * its answer, and a question asked there took that reply into its turn.
 *
 * Only the last turn's rows move (no real user row after them): a queued row with
 * a user line after it is an orphan a dead process left (a later line was taken
 * first), which stays where it was sent and stops being `queued`, so it never
 * blocks the incremental parse. Moves `parentIds` with the rows.
 */
/**
 * A `/compact` is filed after the compaction it made: the CLI writes the boundary, the continuation
 * summary, then the command line (probed, CLI 2.1.312). Shown in the order it happened, the command
 * first. Only the summary may sit between them; anything else and the row stays where it is.
 */
export function floatCompactCommands(rows: SessionHistoryMessage[], parentIds: (string | undefined)[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isCommand = (r.role === 'user' && /^\/compact(\s|$)/.test(r.text)) || (r.role === 'system' && isWalnutCommandNotice(r.text));
    if (!isCommand) continue;
    for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
      const above = rows[j];
      if (above.role === 'system' && above.systemVariant === 'compact') {
        rows.splice(j, 0, rows.splice(i, 1)[0]);
        parentIds.splice(j, 0, parentIds.splice(i, 1)[0]);
        break;
      }
      if (!(above.role === 'user' && above.injected)) break;
    }
  }
}

export function floatQueuedRows(rows: SessionHistoryMessage[], parentIds: (string | undefined)[]): void {
  let lastUser = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role === 'user' && !r.injected && !r.queued) { lastUser = i; break; }
  }
  const moved: Array<{ row: SessionHistoryMessage; parent: string | undefined }> = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].queued) continue;
    // An orphan never moves again: nothing to re-ask for (a re-asked user row
    // rebuilds the history, history-delta.ts), so it is settled where it is.
    if (i < lastUser) { delete rows[i].queued; delete rows[i].unsettled; continue; }
    moved.unshift({ row: rows.splice(i, 1)[0], parent: parentIds.splice(i, 1)[0] });
  }
  for (const m of moved) { rows.push(m.row); parentIds.push(m.parent); }
}

/**
 * Core parsing logic: parse raw JSONL content string into SessionHistoryMessage[].
 * Deduplicates by message.id, handles queue-operations. Optionally applies the
 * in-place rewind filter INSIDE the single per-line JSON.parse (fused — no
 * second parse pass, no rewrite of the content string: ReadSessionResult.
 * canonicalChars slicing in seedIncrementalState depends on the original).
 */
export function parseSessionMessages(content: string, opts?: ParseSessionMessagesOptions): SessionHistoryMessage[] {
  if (opts?.legacyHintCutoffMs === undefined) return parseSessionMessagesWith(content, opts);
  return withLegacyHintCutoff(opts.legacyHintCutoffMs, () => parseSessionMessagesWith(content, opts));
}

function parseSessionMessagesWith(content: string, opts?: ParseSessionMessagesOptions): SessionHistoryMessage[] {
  const lines = content.split('\n').filter(Boolean);

  // Parse all lines
  let rawMessages: RawJsonlLine[] = [];
  for (const line of lines) {
    try {
      rawMessages.push(JSON.parse(line));
    } catch (err) {
      parseHooks.debug('failed to parse JSONL entry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Format canary (transcript-line-types.ts): warn once per process about a
  // line kind this parser does not know. Output is unaffected. The CLI version
  // comes from any line that carries one (api-request-blob lines carry none).
  let cliVersion: string | undefined;
  for (const raw of rawMessages) {
    if (typeof raw?.version === 'string') { cliVersion = raw.version; break; }
  }
  for (const raw of rawMessages) {
    if (raw && typeof raw === 'object') parseHooks.noteLineType(raw, cliVersion);
  }

  // ── In-place rewind filter (see transcript-chain.ts computeRewindDeadSet) ──
  let deadUuids: Set<string> | null = null;
  let queueDeadKeys: Set<string> = NO_QUEUE_DEAD_KEYS;
  let chainMark: ChainFilterMark | undefined;
  if (opts?.chainFilter === 'auto') {
    const deadSet = computeRewindDeadSet(rawMessages, opts.rewindCuts ?? []);
    deadUuids = deadSet.deadUuids;
    queueDeadKeys = deadSet.queueDeadKeys;
    chainMark = { deadUuids, queueDeadKeys, droppedCount: deadSet.droppedCount };
    // computeRewindDeadSet has no logger (it is bundled into the daemon), so the
    // named degrade is reported back and warned about here — one line per cut it
    // refused to apply, whose region is therefore served UNFILTERED.
    logSkippedRewindCuts(deadSet.skippedCuts);
  } else if (opts?.chainFilter) {
    deadUuids = opts.chainFilter.deadUuids;
    queueDeadKeys = opts.chainFilter.queueDeadKeys ?? NO_QUEUE_DEAD_KEYS;
  }
  // Drop dead TREE lines before any fold pass consumes them. Non-tree lines
  // (no uuid — 16.4% of real lines) always pass through: they are never in the
  // dead set. A queue-operation enqueue echo of a rewound-away message is
  // suppressed by its IDENTITY KEY being in queueDeadKeys (below) — never by
  // text matching (deleted live rows on repeated short texts like "continue",
  // missed batched twins) and never by a time window (file order is not time
  // order, so a [min,max] window over the region reached back past the rewind
  // point and deleted live pre-cut rows).
  if (deadUuids && deadUuids.size > 0) {
    const dead = deadUuids;
    rawMessages = rawMessages.filter((raw) => !(raw.uuid && dead.has(raw.uuid)));
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
    sourceUuid?: string;
    unsettled?: boolean;
    queued?: boolean;
    injected?: boolean;
    agentOrigin?: boolean;
    systemVariant?: 'compact' | 'error' | 'info';
    systemDetail?: string;
    cliError?: true;
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
  const userTwinTexts: Array<{ index: number; content: string; claimed: boolean; injected: boolean }> = [];
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
      // A slash command's line is the CLI's tags around what was sent: its twin enqueue holds the
      // command as typed ("/compact <args>"), so the two are matched by the shown form.
      const shown = /^<command-(name|message|args)>/.test(text) ? transformInjectedUserText(text) : undefined;
      userTwinTexts.push({ index: i, content: typeof shown === 'string' ? shown : text, claimed: false, injected: isInjectedLine(raw) });
    }
  }
  const skipEnqueueIndices = new Set<number>();
  /** Enqueue index to the user line it claimed as its twin (Pattern A). */
  const twinOfEnqueue = new Map<number, number>();
  // ── Removed pass (runs first) ──
  // `remove` means a message left the CLI's queue, for one of two reasons (CLI
  // query.ts): it ran mid-turn, handed to the model as a `queued_command`
  // attachment just before the remove, or it was dropped unrun (a Stop with
  // cancel_queued, Esc in the CLI's own UI) with no attachment and no user line.
  // Only a dropped one was never part of the conversation, so only its enqueue is
  // skipped. The one that ran stays a Pattern B row at its enqueue, where it was
  // sent. Reading every remove as a drop hid 1084 of 1086 mid-turn sends in a local
  // scan: history lost the message and its Delivered bubble sat below the later
  // turns (inc-1790637095180). First, so a resend of the same text keeps its twin.
  const pairedEnqueues = new Set<number>();
  const claimedAttachments = new Set<number>();
  /** Enqueues whose twin is their attachment: they must not claim a user line. */
  const ranMidTurn = new Set<number>();
  /** Enqueue index to the uuid its attachment says it was sent under. */
  const sourceUuidOf = new Map<number, string>();
  /** Attachment index to the enqueue it carries. A send that ran mid-turn is placed
   *  at its `queued_command` attachment, the line the CLI writes where it hands the
   *  message to the model (Claude Code renders it there too), never at its enqueue:
   *  everything the model wrote between the two was written before it saw the
   *  message, and drawn under it read as its answer (2026-10-31). */
  const enqueueOfAttachment = new Map<number, number>();
  /** A text-less enqueue to the text its remove gave it. A line whose content is
   *  blocks (a send with pictures, providers/user-line-images-core.ts) is enqueued
   *  with no text; its `remove` and its `queued_command` attachment carry the text.
   *  Walk the CLI's queue (FIFO for a dequeue) to learn which enqueue a remove took. */
  const textOfBlocksEnqueue = new Map<number, string>();
  /** A remove with no text to the text its attachment carries. An older CLI (2.1.284) logs a
   *  picture line taken mid-turn as a text-less enqueue AND a text-less remove (reason
   *  `absorbed_mid_turn`); only its `queued_command` attachment holds the blocks. Without this,
   *  every picture sent mid-turn had no row at all (2026-11-03: the VP's chat, 26 of 26). */
  const textOfTextlessRemove = new Map<number, string>();
  /** A remove with no text to the text-less enqueue the walk gave it (the still-queued count reads it). */
  const enqueueOfTextlessRemove = new Map<number, number>();
  {
    const queue: number[] = [];
    const takenAttachments = new Set<number>();
    for (let i = 0; i < rawMessages.length; i++) {
      const raw = rawMessages[i];
      if (raw.type !== 'queue-operation') continue;
      if (raw.operation === 'enqueue') queue.push(i);
      else if (raw.operation === 'dequeue') queue.shift();
      else if (raw.operation === 'remove' && raw.content) {
        let at = queue.findIndex(j => rawMessages[j].content === raw.content);
        // The walk's FIFO is a guess (the CLI takes a `next` before a `later`), so a
        // remove whose text an earlier enqueue carries is that one's, never a text-less one's.
        const named = at < 0 && rawMessages.some((e, k) => k < i && e.type === 'queue-operation'
          && e.operation === 'enqueue' && e.content === raw.content);
        if (at < 0 && !named) {
          at = queue.findIndex(j => !rawMessages[j].content);
          if (at >= 0) textOfBlocksEnqueue.set(queue[at], raw.content);
        }
        if (at >= 0) queue.splice(at, 1);
      } else if (raw.operation === 'remove') {
        // No text: the oldest text-less enqueue it took, and the picture line's own attachment
        // nearest the remove (after that enqueue). None found: a line dropped unrun, still hidden.
        const at = queue.findIndex(j => !rawMessages[j].content);
        if (at < 0) continue;
        const j = queue[at];
        queue.splice(at, 1);
        enqueueOfTextlessRemove.set(i, j);
        let best = -1;
        const lo = Math.max(j + 1, i - PATTERN_A_LOOKAHEAD);
        const hi = Math.min(rawMessages.length - 1, i + PATTERN_A_LOOKAHEAD);
        for (let k = lo; k <= hi; k++) {
          const e = rawMessages[k];
          if (takenAttachments.has(k) || e.type !== 'attachment' || e.attachment?.type !== 'queued_command' || !Array.isArray(e.attachment.prompt)) continue;
          if (best < 0 || Math.abs(k - i) < Math.abs(best - i)) best = k;
        }
        const text = best >= 0 ? queuedCommandText(rawMessages[best].attachment!.prompt) : undefined;
        if (!text) continue;
        takenAttachments.add(best);
        textOfBlocksEnqueue.set(j, text);
        textOfTextlessRemove.set(i, text);
      }
    }
  }
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'queue-operation' || raw.operation !== 'remove') continue;
    const content = raw.content || textOfTextlessRemove.get(i);
    if (!content) continue;
    let j = i - 1;
    for (; j >= 0; j--) {
      const e = rawMessages[j];
      if (e.type === 'queue-operation' && e.operation === 'enqueue' && e.content === content
        && !pairedEnqueues.has(j)) break;
    }
    // A line of blocks: its text-less enqueue, which the queue walk above gave this text.
    let blocksText: string | undefined;
    if (j < 0) {
      for (let k = i - 1; k >= 0; k--) {
        if (textOfBlocksEnqueue.get(k) === content && !pairedEnqueues.has(k)) { j = k; break; }
      }
      if (j < 0) continue;
      blocksText = content;
    }
    pairedEnqueues.add(j);
    // The attachment usually precedes the remove, but the two writes race (15 of
    // 1084 land after it), so look a window past it too, never past a later enqueue
    // of the same text: that is a resend with its own fate.
    const wanted = content.trim();
    const end = Math.min(rawMessages.length, i + 1 + PATTERN_A_LOOKAHEAD);
    let ran = false;
    for (let k = j + 1; k < end; k++) {
      const e = rawMessages[k];
      if (k > i && e.type === 'queue-operation' && e.operation === 'enqueue' && blocksText === undefined && e.content === content) break;
      if (claimedAttachments.has(k) || e.type !== 'attachment' || e.attachment?.type !== 'queued_command') continue;
      if (queuedCommandText(e.attachment.prompt)?.trim() === wanted) {
        claimedAttachments.add(k);
        enqueueOfAttachment.set(k, j);
        ran = true;
        const src = e.attachment.source_uuid;
        if (typeof src === 'string' && src) sourceUuidOf.set(j, src);
        break;
      }
    }
    if (ran) ranMidTurn.add(j);
    else skipEnqueueIndices.add(j);
  }
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'queue-operation' || raw.operation !== 'enqueue' || !raw.content) continue;
    if (skipEnqueueIndices.has(i) || ranMidTurn.has(i)) continue;
    // Claim the earliest not-yet-claimed real user line within the lookahead window whose
    // text matches. Found → Pattern A (skip enqueue). None → Pattern B (emit synthetic msg).
    const wanted = raw.content.trim();
    // A peer message from another Claude Code session is enqueued as the bare
    // native tag (NATIVE_PEER_TAGS), but the CLI logs the user turn with its own
    // framing around that tag ("Another Claude session sent a message: … "), so
    // the twin CONTAINS the enqueue rather than equalling it. That framed line is
    // always CLI-injected (isMeta), which keeps a human merely quoting the tag
    // from being claimed as the twin.
    const wrapped = NATIVE_PEER_TAGS.some((t) => wanted.startsWith(`<${t}`));
    const twin = userTwinTexts.find(
      u => !u.claimed && u.index > i && u.index - i <= PATTERN_A_LOOKAHEAD
        && (u.content.trim() === wanted || (wrapped && u.injected && u.content.includes(wanted))),
    );
    if (twin) {
      twin.claimed = true;
      skipEnqueueIndices.add(i);
      twinOfEnqueue.set(i, twin.index);
    }
  }
  // ── Resent enqueues ──
  // The CLI's queue lives in its process. A line queued in a process that then ended
  // (a stop, a crash) is never taken, and Walnut writes it again to the next process:
  // two identical enqueues, then ONE user line, which the pass above gave to the
  // FIRST, leaving the resend to render as a second copy (2026-10-29 acceptance run).
  // Inside one process two identical lines queued before either runs are drained
  // together (the joined line below) or run mid-turn (remove), never as one line, so
  // a later identical enqueue sitting between an enqueue and its twin, with no dequeue
  // before it, is the same message sent again: it shares that twin. A dequeue in
  // between means the first was taken (its line may still be on its way, behind the
  // prompt hooks), so a second identical send after it is the user's own and stays.
  for (const [i, t] of twinOfEnqueue) {
    const text = rawMessages[i].content?.trim();
    for (let j = i + 1; j < t; j++) {
      const e = rawMessages[j];
      if (e.type !== 'queue-operation') continue;
      if (e.operation === 'dequeue') break;
      if (e.operation === 'enqueue' && e.content?.trim() === text
        && !skipEnqueueIndices.has(j) && !ranMidTurn.has(j)) skipEnqueueIndices.add(j);
    }
  }

  // ── Still-queued enqueues ──
  // An enqueue the CLI has not yet taken from its queue (no dequeue/remove after it,
  // FIFO) has no place yet: the CLI writes its user line where it RUNS it, after
  // whatever turn it waited behind (a permission deny's reply, say). A read in that
  // window emits it as a Pattern B row at the enqueue; once the user line lands, the
  // pass above skips it as Pattern A and the row moves. Such a row is unsettled, so
  // the client re-asks for it and a vanished id rebuilds instead of keeping both
  // (2026-10-25: a message sent over a Write card showed twice, above and below the
  // deny reply). Only the unsettled flag depends on this count: an orphan enqueue a
  // dead process left behind just stays unsettled, which costs one id per delta.
  // A dequeue is logged BEFORE its user line (the CLI runs the prompt's hooks in
  // between), so an enqueue taken with nothing written after its dequeue is still
  // unplaced too; anything the CLI writes after it means its line is in.
  const stillQueued = new Set<number>();
  {
    const queue: number[] = [];
    const taken: Array<{ at: number; by: number }> = [];
    let lastLine = -1;
    for (let i = 0; i < rawMessages.length; i++) {
      const raw = rawMessages[i];
      if (raw.type === 'user' || raw.type === 'assistant') lastLine = i;
      if (raw.type !== 'queue-operation') continue;
      if (raw.operation === 'enqueue') queue.push(i);
      else if (raw.operation === 'dequeue') {
        const at = queue.shift();
        if (at !== undefined) taken.push({ at, by: i });
      } else if (raw.operation === 'remove') {
        let at = raw.content ? queue.findIndex(j => rawMessages[j].content === raw.content) : -1;
        // A line of blocks was enqueued with no text (see textOfBlocksEnqueue).
        if (at < 0 && raw.content) at = queue.findIndex(j => textOfBlocksEnqueue.get(j) === raw.content);
        // A remove with no text took the text-less enqueue the first walk paired it with, never the head.
        if (at < 0 && !raw.content && enqueueOfTextlessRemove.has(i)) at = queue.indexOf(enqueueOfTextlessRemove.get(i)!);
        queue.splice(at >= 0 ? at : 0, 1);
      }
    }
    for (const i of queue) stillQueued.add(i);
    for (const t of taken) if (t.by > lastLine) stillQueued.add(t.at);
  }
  // Only a CLI that logs where it takes a queued line makes a line not logged as
  // taken one still waiting, whose row moves to the end (`queued`, floatQueuedRows).
  // A mid-turn take (a `remove` naming the line, a `queued_command` attachment)
  // proves it. A dequeue alone proves it only while no earlier send was left untaken
  // (a typed prompt after it): an older CLI that logged turn-start dequeues but
  // nothing for a line it ran mid-turn leaves exactly such rows, which then stay
  // where they were sent.
  const logsMidTurnTakes = rawMessages.some((r) => (r.type === 'queue-operation' && r.operation === 'remove' && !!r.content)
    || (r.type === 'attachment' && r.attachment?.type === 'queued_command'));
  let logsTakes = logsMidTurnTakes;
  if (!logsTakes && stillQueued.size > 0 && rawMessages.some((r) => r.type === 'queue-operation' && r.operation === 'dequeue')) {
    const firstWaiting = Math.min(...stillQueued);
    // A typed prompt: text, or blocks that are not tool results (a send with pictures).
    logsTakes = !rawMessages.some((r, i) => i > firstWaiting && r.type === 'user' && !isInjectedLine(r)
      && (typeof r.message?.content === 'string'
        || (Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type !== 'tool_result')
          && !r.message.content.some((b) => b?.type === 'text' && b.text?.startsWith('[Request interrupted')))));
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
    if (skipEnqueueIndices.has(i) || ranMidTurn.has(i)) continue;
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

  /** One user row for the queue-operation enqueue at `j` (Pattern B: the CLI never
   *  re-logged it as a user line). Rewind leak fix: an enqueue written inside a
   *  dead region is the queue echo of a rewound-away message, its real twin
   *  filtered out above, so it is suppressed by IDENTITY (the region enqueue's own
   *  timestamp+content key, computeRewindDeadSet): a live enqueue with identical
   *  text outside the region survives unless it also shares the exact
   *  millisecond, and the synthetic `queue-<timestamp>` id collapses that pair. */
  const emitQueueRow = (j: number): void => {
    const raw = rawMessages[j];
    const text = raw.content || textOfBlocksEnqueue.get(j);
    if (!text || skipEnqueueIndices.has(j)) return;
    if (queueDeadKeys.size > 0 && queueDeadKeys.has(queueEnqueueKey(raw))) return;
    const syntheticId = `queue-${raw.timestamp ?? j}`;
    const sourceUuid = sourceUuidOf.get(j);
    messageMap.set(syntheticId, {
      role: 'user',
      timestamp: raw.timestamp ?? new Date().toISOString(),
      ...(sourceUuid ? { sourceUuid } : {}),
      ...(stillQueued.has(j) ? { unsettled: true, ...(logsTakes ? { queued: true } : {}) } : {}),
      contentBlocks: [{ type: 'text' as const, text }],
    });
  };

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];

    const failedLocalCommand = (raw.type === 'system' && raw.subtype === 'local_command'
      && raw.commandOutcome?.kind === 'failed')
      || (raw.type === 'assistant' && !raw.parent_tool_use_id
        && raw.local_command_outcome?.kind === 'failed');
    if (failedLocalCommand && raw.uuid) {
      const source = raw.local_command_source ?? raw.content ?? '';
      const text = raw.type === 'assistant' && Array.isArray(raw.message?.content)
        ? raw.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim()
        : (source.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/)?.[1]?.trim() ?? '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (text) messageMap.set(raw.uuid, {
        role: 'system',
        timestamp: raw.timestamp ?? new Date().toISOString(),
        systemVariant: 'error',
        contentBlocks: [{ type: 'text' as const, text }],
      });
      continue;
    }

    // ── System lines the user should SEE (corpus-audited 2026-07) ──
    // The CLI logs meaningful conversation events as type='system' lines that
    // were previously dropped entirely — the user saw an unexplained gap:
    //   compact_boundary        "Context compacted (410K tokens)" — why history shrank
    //   api_error               connection/API failures mid-turn — why a turn stalled
    //   informational           e.g. "Model X restricted … using Y instead"
    //   model_refusal_fallback  safeguard retry notices
    //   scheduled_task_fire     why a turn started with no user message
    //   hook_response           only when the user's hook FAILED (hook-notice.ts)
    // (Live streaming already surfaces compact via SESSION_SYSTEM_EVENT; history
    // reloads lost it. Noise subtypes — stop_hook_summary, turn_duration,
    // away_summary, local_command — stay hidden.)
    if (raw.type === 'system' && raw.uuid) {
      const sub = raw.subtype;
      const rawContent = (raw as { content?: unknown }).content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      let sysText: string | undefined;
      let sysDetail: string | undefined;
      let sysVariant: 'compact' | 'error' | 'info' = 'info';
      if (sub === 'compact_boundary') {
        // canonical JSONL uses compactMetadata/preTokens; the CLI's stream-json
        // stdout (daemon stream files) uses compact_metadata/pre_tokens.
        const r = raw as {
          compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
          compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
        };
        // Headline + detail, exactly the two pieces the live row is built from
        // (compaction-notice.ts owns both), so a reload re-renders the SAME row
        // rather than a differently-punctuated restatement of it.
        const cm = {
          trigger: r.compactMetadata?.trigger ?? r.compact_metadata?.trigger,
          preTokens: r.compactMetadata?.preTokens ?? r.compact_metadata?.pre_tokens,
          postTokens: r.compactMetadata?.postTokens ?? r.compact_metadata?.post_tokens,
        };
        sysText = COMPACTED_MESSAGE;
        sysDetail = compactedDetail(cm);
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
      } else if (sub === 'hook_response') {
        // Same rule as the live row (hook-notice.ts): only a failed hook shows.
        const failed = hookFailureNotice(raw as unknown as Record<string, unknown>);
        if (failed) {
          sysText = failed.message;
          sysDetail = failed.detail;
          sysVariant = 'error';
        }
      }
      if (sysText) {
        messageMap.set(raw.uuid, {
          role: 'system',
          timestamp: raw.timestamp ?? new Date().toISOString(),
          systemVariant: sysVariant,
          ...(sysDetail ? { systemDetail: sysDetail } : {}),
          contentBlocks: [{ type: 'text' as const, text: sysText }],
        });
      }
      continue;
    }

    // Handle queue-operation entries (FIFO-injected user messages from mid-stream send).
    if (raw.type === 'queue-operation') {
      // Only Pattern B enqueues make a row (no matching later user STRING: the message
      // was consumed mid-stream and never re-logged as a real user line). Pattern A
      // enqueues are in skipEnqueueIndices (their user STRING twin is emitted below).
      // A send that ran mid-turn is emitted at its attachment (below), not here.
      if (raw.operation === 'enqueue' && !ranMidTurn.has(i)) emitQueueRow(i);
      continue;
    }

    // The CLI handed a queued send to the model here: its row goes here.
    if (raw.type === 'attachment' && raw.attachment?.type === 'queued_command') {
      const j = enqueueOfAttachment.get(i);
      if (j !== undefined) emitQueueRow(j);
      continue;
    }

    // A hook's added context (`hook_additional_context`: Walnut's post-compaction
    // open items, its temp-write and clone-identity notes, the user's own hooks)
    // reaches the model and was in no row (2026-10-29, the user: nothing added to
    // a turn may stay invisible). It reads as an injected context row.
    if (raw.type === 'attachment' && raw.attachment?.type === 'hook_additional_context') {
      const added = hookContextText(raw.attachment.content, raw.attachment.hookEvent);
      if (added) {
        messageMap.set(raw.uuid ?? `hook-${raw.timestamp ?? i}`, {
          role: 'user',
          timestamp: raw.timestamp ?? new Date().toISOString(),
          injected: true,
          contentBlocks: [{ type: 'text' as const, text: added }],
        });
      }
      continue;
    }

    if (!raw.message?.role || !['user', 'assistant'].includes(raw.message.role)) continue;
    // Only the transcript's own message lines are messages. Claude Code 2.1.284
    // also writes `api-request-blob` lines: a copy of each request message as the
    // model received it (instruction files, MEMORY.md, hints merged in), with a
    // role but no uuid or timestamp. Read as rows they showed that context as
    // the conversation, stamped "now" (2026-10-29). A line with no type is an
    // older capture and stays a message.
    if (raw.type !== undefined && raw.type !== 'user' && raw.type !== 'assistant') continue;
    parseHooks.noteBlockTypes(raw.message.content, raw, cliVersion);

    // Claude Code's own error reply ("Prompt is too long", "API Error: ..."): the model never answered,
    // so it is a runtime error line, never the assistant's answer (2026-11-06: it read as one).
    if (raw.message.role === 'assistant' && !raw.parent_tool_use_id && isCliErrorReply(raw)) {
      const text = typeof raw.message.content === 'string' ? raw.message.content.trim()
        : (raw.message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
      if (text) messageMap.set(raw.uuid ?? raw.message.id ?? `cli-error-${raw.timestamp ?? i}`, {
        role: 'system',
        timestamp: raw.timestamp ?? new Date().toISOString(),
        systemVariant: 'error',
        cliError: true,
        contentBlocks: [{ type: 'text' as const, text: `${CLI_ERROR_PREFIX}${text}` }],
      });
      continue;
    }

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
      if (nonHumanOrigin(raw.origin)) existing.agentOrigin = true;
    } else {
      messageMap.set(msgId, {
        role: raw.message.role,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        model: raw.message.model,
        usage: raw.message.usage,
        parentToolUseId: raw.parent_tool_use_id ?? undefined,
        walnutMessageId: raw.walnutMessageId ?? undefined,
        injected: isInjectedLine(raw) || undefined,
        agentOrigin: nonHumanOrigin(raw.origin) || undefined,
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
  const rowResultMax = opts?.toolResultMax;
  const resultMaxFor = (toolUseId: string | undefined): number =>
    toolUseId && rowResultMax && rowResultMax.toolUseId === toolUseId
      ? rowResultMax.max
      : opts?.toolResultMaxAll ?? HISTORY_TOOL_RESULT_MAX;
  // Track the last plan content written to ~/.claude/plans/ across messages
  let lastPlanContent: string | null = null;
  // A side-thread cache warm-up is plumbing: its tagged user line is dropped
  // below, and so is the one assistant reply that answers it.
  let dropWarmupReply = false;

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
            ...(toolResult ? toolResultFields(toolResult, resultMaxFor(toolUseId)) : {}),
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
    // What the model really received, kept when the display differs (the raw view).
    const receivedText = msg.role === 'user' ? text : '';

    // Skip messages with no visible content (e.g. tool_result-only user entries,
    // empty heartbeat lines). These produce ghost "You" bubbles in the UI.
    if (!text && tools.length === 0 && !thinking) continue;

    // CLI-injected user lines (internal plumbing re-logged as `user` — NOT what
    // the human typed): hide pure plumbing, rewrite human-action echoes to a
    // readable form. Single choke point — catches the real echo line AND the
    // Pattern-B synthetic from its queue-operation. See transformInjectedUserText.
    // The digest REQUEST is checked before the `<` gate and anywhere in the line:
    // the CLI joins everything pending into one user line, so a follow-up the user
    // typed can sit in front of the tag. Its REPLY stays visible — that is what
    // makes "inject summary" reviewable.
    if (msg.role === 'user' && text.includes(SIDE_THREAD_DIGEST_TAG)) {
      const remainder = stripSideThreadDigestRequest(text);
      if (!remainder) continue;
      text = remainder;
    }
    // Another session's mail rewritten for display ("[Teammate x] …") keeps its origin: the
    // rewritten text no longer shows it is not a person's.
    let peerMail = false;
    if (msg.role === 'user' && text.startsWith('<')) {
      if (isCacheWarmupText(text)) { dropWarmupReply = true; continue; }
      const transformed = transformInjectedUserText(text);
      if (transformed === null) continue;
      if (transformed !== undefined) { text = transformed; peerMail = /^<teammate-message/.test(receivedText); }
    }
    // A command Walnut sent itself (an idle compaction, the recovery of a full context): its own
    // words say so, and it is Walnut's notice, never the user's message (sessions/walnut-commands.ts).
    // Before the words, the idle compaction's bare `/compact` was known only by its uuid, which the
    // CLI keeps for a line it reads at once (not for one it queued first).
    const walnutNotice = msg.role !== 'user' ? undefined
      : walnutCommandNotice(text) ?? (mapMsgId.startsWith(IDLE_COMPACT_UUID_PREFIX) && text.trim() === '/compact' ? IDLE_COMPACT_HISTORY_TEXT : undefined);
    if (walnutNotice) {
      result.push({ role: 'system', text: walnutNotice, timestamp: msg.timestamp, msgId: mapMsgId, systemVariant: 'info' });
      resultParentIds.push(msg.parentToolUseId);
      continue;
    }
    if (msg.role === 'assistant' && dropWarmupReply) {
      dropWarmupReply = false;
      // Unconditional: the warm-up told the model "no tools", so a reply that
      // ran some anyway is still warm-up plumbing, not user-relevant activity —
      // letting it through rendered a floating "Ready." + "Ran 2 commands" row.
      continue;
    }

    // Machine wrappers on a user line (display only): the message hints
    // (`<system-reminder>` blocks, hints/hint-format.ts) and a `---walnut-refs---`
    // card block for any entity pill the human dropped in. The CLI echoes all of
    // it into its JSONL, so without this every user bubble renders the machine
    // text as if the human had typed it. Stripping HERE (not in each surface)
    // fixes web, phone, notification previews and search snippets at once.
    // Echo-claim binding compares against the same stripped form
    // (echo-claims.ts candidateTexts). The hints are kept beside the text, so a
    // surface can say which ones the message carried.
    let hints: CarriedHint[] = [];
    if (msg.role === 'user') ({ text, hints } = projectUserText(text, msg.timestamp));

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
      ...(msg.sourceUuid ? { sourceUuid: msg.sourceUuid } : {}),
      ...(msg.unsettled ? { unsettled: true } : {}),
      ...(msg.queued ? { queued: true } : {}),
      ...(msg.injected && msg.role === 'user' ? { injected: true } : {}),
      ...((msg.agentOrigin || peerMail) && msg.role === 'user' ? { agentOrigin: true } : {}),
      ...(msg.systemVariant ? { systemVariant: msg.systemVariant } : {}),
      ...(msg.systemDetail ? { systemDetail: msg.systemDetail } : {}),
      ...(msg.cliError ? { cliError: true as const } : {}),
      ...(hints.length ? { hints } : {}),
      // The raw view is a person's view too: an AI-only brief shows its fold (lib/ai-only-envelope.ts).
      ...(receivedText && receivedText !== text ? { rawText: redactAiOnly(receivedText) } : {}),
    });
    resultParentIds.push(msg.parentToolUseId);
  }

  floatCompactCommands(result, resultParentIds);
  floatQueuedRows(result, resultParentIds);
  markMessageAbout(result, resultParentIds);

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
  // 'auto' chain walks mark their result so the full-read path can log/degrade
  // and seedIncrementalState can reuse the exact set for its segment parses.
  if (chainMark) chainFilterMarks.set(grouped, chainMark);
  return grouped;
}

/** Rows a subagent wrote (they had a parent tool), remembered across the incremental read's re-pass. */
export const aboutChildRows = new WeakSet<SessionHistoryMessage>();

/**
 * Each top-level assistant row's tasks (message-about.ts); the `<walnut-about>` line leaves its text.
 * Runs again over the incremental read's merged rows (prefix + new tail), because a turn's fallback
 * reads from where the turn began, which may sit in the frozen prefix: a tagged row keeps what its
 * tag said (its line is gone by then), every other row is computed afresh.
 */
export function markMessageAbout(rows: SessionHistoryMessage[], parentIds: readonly (string | undefined)[] = []): void {
  const top: number[] = [];
  rows.forEach((row, i) => {
    if (parentIds[i]) aboutChildRows.add(row);
    // A child row whose parent tool is not in the file stays top level after grouping: still a child.
    else if (!aboutChildRows.has(row)) top.push(i);
  });
  const about = messageAbout(top.map((i) => rows[i]!));
  top.forEach((i, k) => {
    const row = rows[i]!;
    if (row.aboutTagged) return;
    // The line leaves the text even when it named no task.
    if (row.role === 'assistant' && row.text.includes('<walnut-about')) {
      const tag = readAboutTag(row.text);
      row.text = tag.text;
      // A tag naming no task still settles it: no fallback on a later pass.
      if (tag.tagged) row.aboutTagged = true;
    }
    const hit = about.get(k);
    if (!hit) { delete row.about; return; }
    row.about = hit.ids;
    if (hit.tagged) row.aboutTagged = true;
  });
}

export function rewindCutsKey(cuts: readonly Pick<InPlaceRewindCut, 'uuid' | 'lastUuidAtCommit'>[] | undefined): string {
  if (!cuts || cuts.length === 0) return '';
  const last = cuts[cuts.length - 1]!;
  return `${cuts.length}:${last.uuid}:${last.lastUuidAtCommit}`;
}
