/**
 * Transcript rewind PROBE core — the rewind machinery's host-local half.
 *
 * Rewind asks four questions of a session's JSONL, and every one of them used
 * to be answered by shuttling the WHOLE file over the SSH tunnel through
 * DaemonFileReader (which refuses anything past its byte ceiling, so a long
 * transcript made rewind fail outright and made a rewound session's history
 * render UNFILTERED):
 *
 *   1. is this uuid on the chain the CLI would load?  (`--resume-session-at`
 *      exits 1 otherwise)              → computeCliLoadedChain
 *   2. which chain message sits just BEFORE it and survives the CLI's own
 *      resume-time filters? (the uuid a rewind actually resumes at, because
 *      rewind means "back to before I sent that") → resumeAnchorBefore
 *   3. what is the LAST tree line right now, and which enqueues trail it?
 *      (the cut a commit records)      → commitAnchorOf
 *   4. which enqueue echoes did the rewound message itself drain? (they sit
 *      BEFORE it, so no uuid-anchored region reaches them) → targetQueueKeys
 *   5. which lines are dead for display?
 *      (recorded cuts replayed)        → computeRewindDeadSet
 *
 * All five are pure functions of the parsed lines, so they belong next to the
 * file: this module runs INSIDE the daemon (`transcript.rewindProbe`) and only
 * the small answer crosses the tunnel. See AGENTS.md "Design Principle:
 * host-local work belongs to the DAEMON". Precedent + shape: session-changes-
 * core.ts (`changes.compute`).
 *
 * Dependency-lean on purpose (node builtins + transcript-chain.ts + the path
 * resolver from session-changes-core.ts, no logging) so bun can bundle it into
 * the binary twin AND ship it as the `transcript-rewind-core.cjs` sidecar the
 * source twin require()s. The server keeps the same functions for its fallback
 * path, so both sides answer identically.
 *
 * Never refuses on size: the entire point is that the daemon can read what the
 * tunnel cannot. The file is streamed LINE BY LINE and each line is reduced to
 * the handful of fields the walk reads, so a very large transcript does not
 * become an equally large heap of retained strings.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import {
  TRANSCRIPT_TREE_TYPES,
  computeCliLoadedChain,
  computeRewindDeadSet,
  queueEnqueueKey,
  type TranscriptChainLine,
  type SkippedRewindCut,
} from '../core/transcript-chain.js';
import { resolveJsonlPathHostLocal } from './session-changes-core.js';

/** A recorded in-place rewind cut, as it rides the wire (see InPlaceRewindCut). */
export interface RewindProbeCut {
  uuid: string;
  lastUuidAtCommit: string;
  trailingQueueKeys?: string[];
}

/**
 * What the CLI's resume-time filters need to know about ONE transcript line.
 *
 * `--resume-session-at <uuid>` resolves against the messages the CLI has
 * ALREADY deserialized (print.ts:5106 runs after loadConversationForResume), and
 * deserialization drops some assistant messages. A uuid the CLI dropped makes it
 * exit 1 at spawn, so picking a resume anchor means predicting those three
 * filters — ported below from deserializeMessagesWithInterruptDetection
 * (utils/messages.ts). They only ever remove ASSISTANT messages.
 */
export interface ResumeSurvivalFacts {
  type: string;
  /** `message.id` — filter 2 spares a thinking-only message when a sibling
   *  sharing this id carries real content (they get merged later). */
  messageId?: string;
  /** `message.content` is a non-empty array (all three filters no-op otherwise). */
  hasBlocks?: boolean;
  /** Every block is thinking / redacted_thinking. */
  allThinking?: boolean;
  /** Every block is a text block holding only whitespace (hasOnlyWhitespaceTextContent). */
  whitespaceOnly?: boolean;
  /** Ids of this line's `tool_use` blocks. */
  toolUseIds?: string[];
  /** Ids this line RESOLVES via `tool_result` blocks. */
  toolResultIds?: string[];
}

/** A transcript line plus the facts a resume-anchor choice needs. Structurally a
 *  TranscriptChainLine, so every chain function takes it unchanged. */
export interface RewindTranscriptLine extends TranscriptChainLine {
  resume?: ResumeSurvivalFacts;
  /** The user line's comparable text, kept ONLY for the one uuid a probe was
   *  asked about (targetQueueKeys needs it). Every other line's text is dropped
   *  during slimming — that is what keeps a whale transcript's structure in
   *  memory at all. The server's fallback path parses raw lines, so it reads the
   *  text off `message.content` instead and never sets this. */
  twinText?: string;
}

const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/**
 * Read the resume-filter facts off a raw parsed JSONL line. Returns undefined
 * for lines the CLI never loads as messages (no uuid / not a tree type), which
 * are exactly the lines that can never be a resume anchor.
 */
export function resumeFactsOf(raw: Record<string, unknown>): ResumeSurvivalFacts | undefined {
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  if (!type || !TRANSCRIPT_TREE_TYPES.has(type) || typeof raw.uuid !== 'string') return undefined;
  const facts: ResumeSurvivalFacts = { type };
  const message = raw.message as { id?: unknown; content?: unknown } | undefined;
  if (!message || typeof message !== 'object') return facts;
  if (typeof message.id === 'string') facts.messageId = message.id;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return facts;
  facts.hasBlocks = true;
  const toolUseIds: string[] = [];
  const toolResultIds: string[] = [];
  let allThinking = true;
  let whitespaceOnly = true;
  for (const block of content as Array<Record<string, unknown>>) {
    const blockType = typeof block?.type === 'string' ? block.type : '';
    if (!THINKING_BLOCKS.has(blockType)) allThinking = false;
    // hasOnlyWhitespaceTextContent: ANY non-text block, or any text block with
    // real characters, makes the message valid.
    if (blockType !== 'text') whitespaceOnly = false;
    else if (typeof block.text === 'string' && block.text.trim() !== '') whitespaceOnly = false;
    if (blockType === 'tool_use' && typeof block.id === 'string') toolUseIds.push(block.id);
    if (blockType === 'tool_result' && typeof block.tool_use_id === 'string') {
      toolResultIds.push(block.tool_use_id);
    }
  }
  if (allThinking) facts.allThinking = true;
  if (whitespaceOnly) facts.whitespaceOnly = true;
  if (toolUseIds.length > 0) facts.toolUseIds = toolUseIds;
  if (toolResultIds.length > 0) facts.toolResultIds = toolResultIds;
  return facts;
}

export interface ResumeAnchorResult {
  /** The uuid to hand `--resume-session-at`, or null when there is none. */
  uuid: string | null;
  /** Why there is none: the target is off-chain, or it is the first message the
   *  CLI would load (nothing before it to resume at). */
  reason?: 'target_off_chain' | 'no_survivor_before_target';
}

/**
 * The uuid a rewind to `targetUuid` should actually resume at: the nearest
 * message BEFORE it on the CLI-loaded chain that the CLI will still have after
 * deserializing.
 *
 * Why before and not at: the CLI's own `/rewind` restores "the point BEFORE you
 * sent this message" — it slices `messages.slice(0, index)` (exclusive) and puts
 * that message's text back in the input box (REPL.tsx restoreMessageSync). The
 * `--resume-session-at` flag is INCLUSIVE (`slice(0, index + 1)`), so resuming
 * at the target itself would leave the message the human is taking back in the
 * model's context. Resuming at its predecessor is the same conversation the
 * interactive rewind produces.
 *
 * A candidate must also be UNIQUE in the file: this uuid becomes the recorded
 * cut's start, and computeRewindDeadSet refuses a duplicated cut anchor (it
 * cannot tell which occurrence bounds the dead region), which would leave the
 * abandoned branch visible.
 */
export function resumeAnchorBefore(
  lines: readonly RewindTranscriptLine[],
  chain: readonly string[],
  targetUuid: string,
): ResumeAnchorResult {
  const targetIdx = chain.indexOf(targetUuid);
  if (targetIdx < 0) return { uuid: null, reason: 'target_off_chain' };

  const onChain = new Set(chain);
  const facts = new Map<string, ResumeSurvivalFacts>();
  const countOfUuid = new Map<string, number>();
  const resolvedToolUseIds = new Set<string>();
  const messageIdsWithRealContent = new Set<string>();
  for (const line of lines) {
    const uuid = line.uuid;
    if (typeof uuid !== 'string') continue;
    countOfUuid.set(uuid, (countOfUuid.get(uuid) ?? 0) + 1);
    if (!line.resume || !onChain.has(uuid)) continue;
    if (!facts.has(uuid)) facts.set(uuid, line.resume);
    for (const id of line.resume.toolResultIds ?? []) resolvedToolUseIds.add(id);
    if (line.resume.type === 'assistant' && line.resume.messageId
      && line.resume.hasBlocks && !line.resume.allThinking) {
      messageIdsWithRealContent.add(line.resume.messageId);
    }
  }

  const survives = (uuid: string): boolean => {
    if ((countOfUuid.get(uuid) ?? 0) !== 1) return false;
    const f = facts.get(uuid);
    if (!f) return false;
    // Only assistant messages are ever filtered out on resume.
    if (f.type !== 'assistant' || !f.hasBlocks) return true;
    // 1. filterUnresolvedToolUses: dropped when ALL of its tool_use blocks lack
    //    a tool_result anywhere in the loaded conversation.
    if (f.toolUseIds && f.toolUseIds.length > 0
      && f.toolUseIds.every((id) => !resolvedToolUseIds.has(id))) return false;
    // 2. filterOrphanedThinkingOnlyMessages.
    if (f.allThinking && !(f.messageId && messageIdsWithRealContent.has(f.messageId))) return false;
    // 3. filterWhitespaceOnlyAssistantMessages.
    if (f.whitespaceOnly) return false;
    return true;
  };

  for (let i = targetIdx - 1; i >= 0; i--) {
    const candidate = chain[i]!;
    if (survives(candidate)) return { uuid: candidate };
  }
  return { uuid: null, reason: 'no_survivor_before_target' };
}

export interface RewindProbeInput {
  sessionId: string;
  /** Session cwd when known — resolves the canonical JSONL path directly. */
  cwd?: string;
  /** Claude home (the daemon passes `$HOME/.claude`; tests pass a temp dir). */
  claudeHome: string;
  /** Rewind point to validate against the chain the CLI would load. */
  uuid?: string;
  /** Recorded cuts to replay for display filtering. */
  cuts?: RewindProbeCut[];
  /** Test seam: lower the dead-set cap (default DEFAULT_MAX_DEAD_UUIDS). Not
   *  sent over the wire — the daemon always uses the default. */
  maxDeadUuids?: number;
}

export interface RewindProbeOutput {
  jsonlPath: string;
  mtimeMs: number;
  size: number;
  /** Non-empty lines read (corrupt ones included — they exist in the file). */
  lineCount: number;
  /** The leaf `--resume` would load from, or null when there is no tree line. */
  leafUuid: string | null;
  /** Only when `input.uuid` was given: is it on the CLI-loaded chain? */
  onChain?: boolean;
  /** Only when `input.uuid` is ON the chain: the uuid to hand
   *  `--resume-session-at` so the conversation ends just BEFORE the target
   *  (resumeAnchorBefore). null = the target is the first message the CLI would
   *  load, so there is nothing before it to resume at. */
  resumeAnchorUuid?: string | null;
  /** Uuid of the LAST tree line in file order (null = no tree lines at all). */
  lastUuidAtCommit: string | null;
  /** Identity keys of the queue enqueues sitting PAST that last tree line. */
  trailingQueueKeys: string[];
  /** Only when `input.uuid` was given: identity keys of the enqueue echoes that
   *  uuid's own message drained (targetQueueKeys). They sit BEFORE it, so a
   *  commit has to capture them or the rewound message stays on screen. */
  targetQueueKeys?: string[];
  /** Only when `input.cuts` was given: the dead tree-line uuids ([] = none). */
  deadUuids?: string[];
  /** Only when `input.cuts` was given: the dead queue identity keys. */
  queueDeadKeys?: string[];
  /** Only when `input.cuts` was given: cuts the replay refused to apply. */
  skippedCuts?: SkippedRewindCut[];
  /** The dead set blew past the cap, so nothing is reported — the caller serves
   *  UNFILTERED and says so. Cheap insurance against a rewind-to-line-1 on a
   *  very large transcript producing a multi-MB reply frame. */
  truncated?: boolean;
}

/** Above this many dead uuids the probe reports `truncated` instead. */
export const DEFAULT_MAX_DEAD_UUIDS = 200_000;

/**
 * The cut anchor as a rewind COMMIT sees it: the last tree line in the file
 * right now, plus the identity keys of any queue enqueues that trail it (uuid-
 * less lines sit outside every uuid-anchored region, so they must be captured
 * on the cut record or a rewound-away queued message re-renders forever).
 *
 * ONE implementation, shared by the daemon probe and the server's fallback read
 * — the two must agree on what "end of file" means or a cut records an anchor
 * the reader can't reproduce.
 */
export function commitAnchorOf(
  lines: readonly TranscriptChainLine[],
): { lastUuidAtCommit: string | null; trailingQueueKeys: string[] } {
  let lastUuidAtCommit: string | null = null;
  let lastTreeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l && typeof l.uuid === 'string' && typeof l.type === 'string'
      && TRANSCRIPT_TREE_TYPES.has(l.type)) {
      lastUuidAtCommit = l.uuid;
      lastTreeIdx = i;
      break;
    }
  }
  const trailingQueueKeys: string[] = [];
  if (lastTreeIdx >= 0) {
    for (let i = lastTreeIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l && l.type === 'queue-operation' && l.operation === 'enqueue') {
        trailingQueueKeys.push(queueEnqueueKey(l));
      }
    }
  }
  return { lastUuidAtCommit, trailingQueueKeys };
}

/**
 * The comparable text of a user line — what the history parser matches a queue
 * enqueue against. String content, or the first text block of an array content
 * (the CLI logs a mid-turn send either way; the array shape carries image refs
 * alongside the text). Mirrors the twin extraction in session-history.ts.
 */
function comparableUserText(line: RewindTranscriptLine): string | undefined {
  if (typeof line.twinText === 'string') return line.twinText;
  const c = line.message?.content as unknown;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const tb = (c as Array<Record<string, unknown>>).find(
      (b) => b?.type === 'text' && typeof b.text === 'string');
    if (tb) return tb.text as string;
  }
  return undefined;
}

/** How far back the enqueue echo of a user line can sit. Same window (and same
 *  measured corpus: p50=2, p90=4 lines) as session-history.ts's forward
 *  PATTERN_A_LOOKAHEAD — this is that pairing read from the other end. */
const ENQUEUE_LOOKBACK = 50;

/**
 * Identity keys of the queue enqueues that the REWOUND MESSAGE ITSELF drained.
 *
 * Every message Walnut sends reaches the CLI through the FIFO, so the CLI logs a
 * `queue-operation` enqueue for it and then, a line or two later, the real user
 * line. The history parser pairs the two by content and shows ONE row
 * (session-history.ts, Pattern A). The enqueue is written when the message
 * ARRIVES, so it sits BEFORE the user line — and therefore before the rewind
 * cut's anchor, outside the `(cut, last]` region computeRewindDeadSet can reach.
 * Kill the user line without it and the orphaned enqueue re-renders as a
 * Pattern-B row: the message the human just rewound away is still on screen
 * (measured live, 2026-09-03, on every in-place rewind).
 *
 * So the commit captures those keys onto the cut record, the same way it already
 * captures enqueues that TRAIL the anchor. Pairing is by content, bounded to the
 * lines just before the target: an enqueue is only claimed when its text is
 * exactly the target's, or when a contiguous run of enqueues '\n'-joins to it
 * (the CLI drains a queue of ≥2 into ONE prompt). No match → no key, and the
 * worst case is the row we already have today.
 */
export function targetQueueKeys(
  lines: readonly RewindTranscriptLine[],
  targetUuid: string,
): string[] {
  const targetIdx = lines.findIndex((l) => l?.uuid === targetUuid);
  if (targetIdx < 0) return [];
  const wanted = comparableUserText(lines[targetIdx]!)?.trim();
  if (!wanted) return [];

  const before: Array<{ key: string; content: string }> = [];
  for (let i = Math.max(0, targetIdx - ENQUEUE_LOOKBACK); i < targetIdx; i++) {
    const l = lines[i];
    if (l?.type === 'queue-operation' && l.operation === 'enqueue' && typeof l.content === 'string') {
      before.push({ key: queueEnqueueKey(l), content: l.content });
    }
  }
  // Exact twin: the CLOSEST preceding enqueue with this text. Closest, not
  // first: on a repeated short send ("continue") the nearest one is the echo of
  // THIS message, and an earlier identical enqueue belongs to a live row.
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i]!.content.trim() === wanted) return [before[i]!.key];
  }
  // Batched twin: a run of queued messages the CLI drained into one prompt.
  for (let s = 0; s < before.length - 1; s++) {
    let joined = before[s]!.content;
    for (let e = s + 1; e < before.length; e++) {
      joined += '\n' + before[e]!.content;
      if (joined.trim() === wanted) return before.slice(s, e + 1).map((b) => b.key);
    }
  }
  return [];
}

/**
 * Reduce one parsed JSONL line to the fields the chain machinery reads.
 *
 * A transcript line carries the full message payload; the walk needs topology.
 * Keeping only these fields is what lets the daemon hold a very large file's
 * structure in memory at all. `message.content` is kept as a list of block
 * TYPES for user lines only — computeCliLoadedChain's DAG recovery detects a
 * tool_result user line that way, and dropping it would make the probe disagree
 * with the server's fallback parse on parallel-tool transcripts.
 */
function slimTranscriptLine(raw: Record<string, unknown>): RewindTranscriptLine {
  const line: RewindTranscriptLine = {};
  if (typeof raw.type === 'string') line.type = raw.type;
  if (typeof raw.subtype === 'string') line.subtype = raw.subtype;
  if (typeof raw.uuid === 'string') line.uuid = raw.uuid;
  if (typeof raw.parentUuid === 'string') line.parentUuid = raw.parentUuid;
  else if (raw.parentUuid === null) line.parentUuid = null;
  if (raw.isSidechain === true) line.isSidechain = true;
  if (typeof raw.timestamp === 'string') line.timestamp = raw.timestamp;
  if (typeof raw.operation === 'string') line.operation = raw.operation;
  // Top-level `content` is only read for queue-operation lines (their identity key).
  if (line.type === 'queue-operation' && typeof raw.content === 'string') {
    line.content = raw.content;
  }
  const meta = raw.compactMetadata as { preservedSegment?: Record<string, unknown> } | undefined;
  const seg = meta && typeof meta === 'object' ? meta.preservedSegment : undefined;
  if (seg && typeof seg === 'object') {
    line.compactMetadata = {
      preservedSegment: {
        ...(typeof seg.headUuid === 'string' ? { headUuid: seg.headUuid } : {}),
        ...(typeof seg.anchorUuid === 'string' ? { anchorUuid: seg.anchorUuid } : {}),
        ...(typeof seg.tailUuid === 'string' ? { tailUuid: seg.tailUuid } : {}),
      },
    };
  }
  const message = raw.message as { id?: unknown; content?: unknown } | undefined;
  if (message && typeof message === 'object') {
    const id = typeof message.id === 'string' ? message.id : undefined;
    const blocks = line.type === 'user' && Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
        .map((b) => ({ type: typeof b?.type === 'string' ? b.type : '' }))
      : undefined;
    if (id !== undefined || blocks !== undefined) {
      line.message = {
        ...(id !== undefined ? { id } : {}),
        ...(blocks !== undefined ? { content: blocks } : {}),
      };
    }
  }
  const resume = resumeFactsOf(raw);
  if (resume) line.resume = resume;
  return line;
}

/**
 * Stream the JSONL and return its slimmed lines in file order.
 *
 * `keepTextForUuid` is the ONE line whose text is retained (targetQueueKeys
 * pairs it against the enqueues before it). Keeping every user line's text
 * instead would defeat the point of slimming on a whale transcript.
 */
async function readSlimTranscript(
  jsonlPath: string,
  keepTextForUuid?: string,
): Promise<{ lines: RewindTranscriptLine[]; lineCount: number }> {
  const lines: RewindTranscriptLine[] = [];
  let lineCount = 0;
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of rl) {
      if (!text) continue;
      lineCount++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // partial/corrupt line — not a transcript line
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const raw = parsed as Record<string, unknown>;
      const slim = slimTranscriptLine(raw);
      if (keepTextForUuid && slim.uuid === keepTextForUuid) {
        const c = (raw.message as { content?: unknown } | undefined)?.content;
        if (typeof c === 'string') slim.twinText = c;
        else if (Array.isArray(c)) {
          const tb = (c as Array<Record<string, unknown>>).find(
            (b) => b?.type === 'text' && typeof b.text === 'string');
          if (tb) slim.twinText = tb.text as string;
        }
      }
      lines.push(slim);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { lines, lineCount };
}

/**
 * Answer every rewind question about ONE session's transcript, host-local.
 * Returns null when the JSONL can't be found (the caller decides: fall back to
 * its own read, or report "not found").
 */
export async function probeTranscriptRewindHostLocal(
  input: RewindProbeInput,
): Promise<RewindProbeOutput | null> {
  const jsonlPath = await resolveJsonlPathHostLocal(input.sessionId, input.cwd, input.claudeHome);
  if (!jsonlPath) return null;
  let st: fs.Stats;
  try {
    st = await fsp.stat(jsonlPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const { lines, lineCount } = await readSlimTranscript(jsonlPath, input.uuid);
  const anchor = commitAnchorOf(lines);
  const loaded = computeCliLoadedChain(lines);

  const out: RewindProbeOutput = {
    jsonlPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    lineCount,
    leafUuid: loaded.leafUuid,
    lastUuidAtCommit: anchor.lastUuidAtCommit,
    trailingQueueKeys: anchor.trailingQueueKeys,
  };
  if (input.uuid) {
    out.onChain = loaded.chainUuids.has(input.uuid);
    // Only meaningful for an on-chain target; off-chain is refused before the
    // anchor matters.
    if (out.onChain) {
      out.resumeAnchorUuid = resumeAnchorBefore(lines, loaded.chain, input.uuid).uuid;
    }
    out.targetQueueKeys = targetQueueKeys(lines, input.uuid);
  }

  if (input.cuts) {
    const deadSet = computeRewindDeadSet(lines, input.cuts);
    const cap = input.maxDeadUuids ?? DEFAULT_MAX_DEAD_UUIDS;
    const dead = deadSet.deadUuids ? [...deadSet.deadUuids] : [];
    if (dead.length > cap) {
      out.truncated = true;
      out.deadUuids = [];
      out.queueDeadKeys = [];
    } else {
      out.deadUuids = dead;
      out.queueDeadKeys = [...deadSet.queueDeadKeys];
    }
    out.skippedCuts = deadSet.skippedCuts;
  }
  return out;
}
