/**
 * chat-order: where a sent message sits in a chat, decided in ONE place.
 *
 * The order of a conversation is the order in which Claude Code TOOK each of the
 * user's lines: a line the model got at a tool boundary of a running turn, or as
 * the start of a new turn. The CLI says so itself (`command_lifecycle` `started`,
 * keyed by the uuid Walnut sent the line under); the server keeps that as a
 * `user_line` marker block in the live stream, and the transcript parser places a
 * mid-turn row at its `queued_command` attachment (src/core/session-history.ts).
 * So history and the live stream tell the same order, and every surface reads it
 * from here:
 *
 *  - a bubble whose line was taken sits at its marker;
 *  - a bubble whose line was not taken yet sits after all live output: it waits
 *    in the queue, and whatever streams meanwhile was written before the model
 *    saw it;
 *  - the words after a marker answer that line. A `[Qn]` reply tag only moves
 *    them to question n when the line asked a question: the model repeats the
 *    tag it saw last, and on 2026-10-31 a main-chat message's answer opened
 *    with the question's tag and was filed under that question.
 *
 * Before this the order was guessed per surface: a bubble froze at the block
 * count when it was SENT, the question card drew every unsent-yet question
 * before the live answer, and a live block belonged to the newest tag before
 * it, so one long turn (a background agent keeps it open) filed every later
 * answer under the last question.
 *
 * A stream with no marker at all (an engine or CLI that does not report its
 * queue) keeps the send-time position (`sentAt`).
 *
 * Pure: unit tested in tests/web/stream/chat-order.test.ts.
 */
import type { StreamingBlock, StreamingUserLineBlock } from '@/stream/stream-reducer';

/** Where each taken line is in the live blocks. */
export interface TakenLines {
  /** uuid → index of its marker block. */
  at: ReadonlyMap<string, number>;
  /** queue row id → index of the marker of the line that carried it. */
  rowAt: ReadonlyMap<string, number>;
  /** Marker indices, ascending. */
  indices: readonly number[];
  /** The stream reports taken lines (at least one marker): an unmarked bubble
   *  is still queued, not lost to an older format. */
  reports: boolean;
}

const NO_LINES: TakenLines = { at: new Map(), rowAt: new Map(), indices: [], reports: false };

export function takenLinesOf(blocks: readonly StreamingBlock[]): TakenLines {
  let at: Map<string, number> | null = null;
  const rowAt = new Map<string, number>();
  let indices: number[] | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'user_line') continue;
    (at ??= new Map()).set(b.uuid, i);
    for (const id of b.rowIds ?? []) rowAt.set(id, i);
    (indices ??= []).push(i);
  }
  return at && indices ? { at, rowAt, indices, reports: true } : NO_LINES;
}

/** What a bubble's place depends on. */
export interface OrderBubble {
  /** The uuid the line was sent under, when the send chose one. */
  userUuid?: string;
  /** The queue row id (a marker lists the rows its line carried). */
  queueId?: string;
  /** pending / received: never reached the CLI. */
  status?: string;
}

/**
 * Index of the block a bubble renders BEFORE (blocks.length = after all of them).
 * `sentAt` is the block count when it was sent: used only when the stream does
 * not report taken lines.
 */
export function bubbleIndexOf(
  bubble: OrderBubble,
  lines: TakenLines,
  blocksLength: number,
  sentAt: number | undefined,
): number {
  const taken = (bubble.userUuid ? lines.at.get(bubble.userUuid) : undefined)
    ?? (bubble.queueId ? lines.rowAt.get(bubble.queueId) : undefined);
  if (taken !== undefined) return taken;
  // Not taken yet: it waits in the queue, below everything written so far.
  if (lines.reports || bubble.status === 'pending' || bubble.status === 'received') return blocksLength;
  return Math.min(sentAt ?? blocksLength, blocksLength);
}

/**
 * The question every live block answers, decided by the taken lines: null for a
 * block before the first marker, or where this view knows nothing of the lines
 * (the caller keeps its older rules there).
 *
 * `lineKey(line)`: the question that line was asked in ('' = the main
 * conversation), null when this client knows nothing of the line.
 * `lineSeqs(line)`: the question numbers the line asked for (its `question`
 * hint; [] for a line that asked none), null when unknown.
 * `tagOf` reads a main-lane text block's `[Qn]` reply tag.
 *
 * A line taken at the START of a turn (markers with only notices between them:
 * the CLI drained those lines together) owns the turn: the words after it answer
 * the newest known line of that run, and a reply tag on the turn's first words
 * names its owner when a line of the run asked a question (after a line typed in
 * the main conversation the model's `[Qn]` is an echo of the last tag it saw).
 *
 * A line taken MID-TURN (the turn already wrote something) that asked a question
 * owns nothing by position: the turn goes on with its own work, and only a text
 * block opening with a reply tag is that question's answer, that block and no
 * further (2026-11-03: the running turn's reply, untagged, was filed under the
 * question asked during it). A line typed in the main conversation and taken
 * mid-turn still takes what follows, as the transcript reads.
 *
 * The same rule files persisted rows (web/src/utils/question-tag.ts
 * withTagAnchors, tagged-reply-split.ts).
 */
export function liveLineOwners(
  blocks: readonly StreamingBlock[],
  lines: TakenLines,
  lineKey: (line: StreamingUserLineBlock) => string | null,
  lineSeqs: (line: StreamingUserLineBlock) => readonly number[] | null,
  tagOf: (block: StreamingBlock) => { key: string; seq: number } | null,
  /** Where each finished turn's blocks end (ascending): a turn with no taken line
   *  of its own (a follow-up the CLI started for background work) answers none. */
  turnEnds: readonly number[] = [],
): Array<string | null> {
  const out: Array<string | null> = new Array(blocks.length).fill(null);
  if (!lines.reports) return out;
  const asks = (line: StreamingUserLineBlock) => { const s = lineSeqs(line); return s === null || s.length > 0; };
  let run: StreamingUserLineBlock[] = [];
  let runAsks = false;
  let runOpen = false;
  let runMid = false;
  let anyLine = false;
  /** The turn wrote something (a marker after it was taken mid-turn). */
  let wrote = false;
  /** Whose turn it is: the line that started it, or a main line taken since. */
  let base: string | null = null;
  /** The turn-start run's first words are still to come (their tag may name the owner). */
  let firstWords = false;
  let nextEnd = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    while (nextEnd < turnEnds.length && turnEnds[nextEnd] <= i) {
      if (turnEnds[nextEnd] === i) {
        run = []; runAsks = false; runOpen = false; runMid = false; anyLine = false; wrote = false; base = null; firstWords = false;
      }
      nextEnd++;
    }
    if (b.type === 'user_line') {
      if (!runOpen) { run = []; runAsks = false; runMid = wrote; }
      run.push(b);
      runOpen = true;
      anyLine = true;
      if (asks(b)) runAsks = true;
      // The newest known line of the run that may own what follows by position.
      let owner: string | null = null;
      for (let k = run.length - 1; k >= 0 && owner === null; k--) {
        if (runMid && asks(run[k])) continue;
        owner = lineKey(run[k]);
      }
      if (!runMid) { base = owner; firstWords = true; } else if (owner !== null) base = owner;
      out[i] = base;
      continue;
    }
    if (b.type !== 'system') { runOpen = false; wrote = true; }
    if (!anyLine) continue;
    const words = b.type === 'text' && !b.parentToolUseId && /\S/.test(b.content);
    const tag = words ? tagOf(b) : null;
    if (words && firstWords) {
      firstWords = false;
      if (tag && runAsks && !runMid) { base = tag.key; out[i] = base; continue; }
    }
    out[i] = tag && runAsks ? tag.key : base;
  }
  return out;
}

/**
 * Uuids (and the queue row ids they carry) of the lines Claude Code took MID-TURN
 * that asked a question (the same
 * reading as liveLineOwners): such a line never owns the running turn, so the
 * live turn's key and the turn book skip its bubble.
 */
export function midTurnQuestionLines(
  blocks: readonly StreamingBlock[],
  lines: TakenLines,
  lineSeqs: (line: StreamingUserLineBlock) => readonly number[] | null,
  turnEnds: readonly number[] = [],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!lines.reports) return out;
  let wrote = false;
  let runOpen = false;
  let runMid = false;
  let nextEnd = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    while (nextEnd < turnEnds.length && turnEnds[nextEnd] <= i) {
      if (turnEnds[nextEnd] === i) { wrote = false; runOpen = false; runMid = false; }
      nextEnd++;
    }
    if (b.type === 'user_line') {
      if (!runOpen) runMid = wrote;
      runOpen = true;
      const seqs = lineSeqs(b);
      if (runMid && (seqs === null || seqs.length > 0)) {
        out.add(b.uuid);
        for (const id of b.rowIds ?? []) out.add(id);
      }
      continue;
    }
    if (b.type !== 'system') { runOpen = false; wrote = true; }
  }
  return out;
}

/**
 * The transcript rows at the end still in Claude Code's queue (`queued`: the
 * parser moved them past everything written since their enqueue). They are not
 * placed yet, so they are no history row: not a dedup twin for a bubble, not the
 * head of a turn. While the session's queue shows as bubbles they draw nothing;
 * with none (another device's send, a queue this view never held) each draws
 * where an untaken bubble sits, after all live output.
 */
export function splitQueuedTail<R extends { queued?: boolean }>(rows: R[]): { rows: R[]; queued: readonly R[] } {
  let start = rows.length;
  while (start > 0 && rows[start - 1].queued) start--;
  // Unchanged rows keep their identity: memos downstream key on it.
  if (start === rows.length) return { rows, queued: NONE as readonly R[] };
  return { rows: rows.slice(0, start), queued: rows.slice(start) };
}
const NONE: readonly never[] = [];

/**
 * A question card's live part in the chat's own order: `seq` is the timeline
 * filtered to this question (its bubbles, and the live text blocks whose page is
 * this question), in timeline order. Each bubble opens a round answered by the
 * newest text after it and before the next bubble (one message per turn, as the
 * card shows it); text before the first bubble answers the card's last persisted
 * turn (`lead`). The card once drew every bubble first and the live answer last,
 * so a follow-up sent while the answer still streamed sat above it (2026-10-31).
 */
export function cardLiveRounds<U, B>(
  seq: ReadonlyArray<{ user: U } | { block: B }>,
  canAnswer: (user: U) => boolean = () => true,
): { lead?: B; rounds: Array<{ bubble: U; live?: B }> } {
  let lead: B | undefined;
  let answering: { bubble: U; live?: B } | undefined;
  const rounds: Array<{ bubble: U; live?: B }> = [];
  for (const e of seq) {
    if ('user' in e) {
      const round = { bubble: e.user };
      rounds.push(round);
      if (canAnswer(e.user)) answering = round;
    } else if (answering) answering.live = e.block;
    else lead = e.block;
  }
  return lead === undefined ? { rounds } : { lead, rounds };
}
