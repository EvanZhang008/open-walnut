/**
 * LaneTimeline — a subagent's transcript rendered with the main chat's own rows.
 *
 * One input shape, one renderer. While the agent runs, its lane is read straight
 * out of the streaming buffer (the Agent tool_call anchor plus the blocks stamped
 * with its toolUseId) and turned into the messages its transcript will hold
 * (`laneMessagesFromStream`); once it has finished, its transcript is the persisted
 * messages the parser embedded under the Agent tool or the subagent endpoint
 * returns. `LaneHistoryTimeline` draws both, keyed by what each row shows, so the
 * saved transcript takes over the rows the stream drew. It applies the merges the
 * main conversation applies: consecutive tools (a running one included, the row
 * then breathes) and the thinking around them fold into one "Ran 3 commands, read
 * a file ›" row, thinking with no tool around it into one "Thinking ›" row, system
 * notices into one "N system messages ›" row. A running lane ends in the same
 * "… is working…" indicator the main chat pins to a live turn, clocked from the
 * agent's start.
 *
 * Rendered inside the Background tasks panel (never in the chat), and by the
 * workflow transcript modal.
 */

import { useMemo } from 'react';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';
import type { KnownAgent } from './BackgroundTasksPanel';
import { agentResultText } from './background-ledger';
import { GROUPABLE_STREAM_TOOLS, isTransparentBlock } from '@/stream/group-blocks';
import {
  SessionMessage, isToolOnlyMessage, isThinkingOnlyMessage, isTextPlusMergeableTools, mergeThinkingOnly, trailingThinkingOnlyStart,
  MergedHistoryToolRun, SystemGroupRun, systemGroupMemberFromHistory, type SystemGroupMember,
} from './SessionMessage';
import { WorkingIndicator, streamReplyText } from './StreamingBlockView';

interface LaneHandlers {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

// ── Streaming lane ─────────────────────────────────────────────────────────────

export type ToolBlock = StreamingBlock & { type: 'tool_call' };

/** A running agent's lane in the stream buffer: its Agent call and every block
 *  stamped with it (any depth), root-flattened, in stream order. */
export interface LiveLane {
  taskBlock: ToolBlock;
  childBlocks: readonly StreamingBlock[];
}

/** When each streamed message of a lane first showed: its time until the saved one's. */
const laneSeenAt = new Map<string, string>();
function seenAt(id: string | undefined): string {
  if (!id) return new Date().toISOString();
  let at = laneSeenAt.get(id);
  if (!at) {
    at = new Date().toISOString();
    laneSeenAt.set(id, at);
    if (laneSeenAt.size > 500) laneSeenAt.delete(laneSeenAt.keys().next().value!);
  }
  return at;
}

/**
 * A live lane as the transcript its agent will save: one message per model
 * message (msgId) with its reasoning, its words and its calls (a call still
 * running says so in `liveStatus`), a nested agent's lane under its call. The
 * reader draws the stream and the saved transcript through the same
 * LaneHistoryTimeline, so when the agent finishes the saved rows take over the
 * rows the stream drew (2026-11-01, the user: streaming and finished must look
 * exactly the same, "no flash"; the reader used to flip to "Loading
 * transcript…" and build every row again).
 */
/**
 * What names a lane message on both sides: its msgId when it has words or
 * reasoning (the stream names a message on those), else its first call (a
 * message of calls alone carries no msgId while it streams).
 */
export function laneMessageKey(m: SessionHistoryMessage): string | undefined {
  if ((m.text ?? '').trim() || (m.thinking ?? '').trim()) return m.msgId ?? m.tools?.[0]?.toolUseId;
  return m.tools?.[0]?.toolUseId ?? m.msgId;
}

/** A built message, reused while none of the blocks it came from changed (the
 *  reducer replaces a block whenever it grows), so an unchanged row keeps its
 *  memo while the lane streams. Keyed by its first block. */
const builtLaneMessages = new WeakMap<StreamingBlock, { blocks: StreamingBlock[]; msg: SessionHistoryMessage }>();

export function laneMessagesFromStream(rootId: string, childBlocks: readonly StreamingBlock[]): SessionHistoryMessage[] {
  const byParent = new Map<string, StreamingBlock[]>();
  for (const b of childBlocks) {
    const parent = 'parentToolUseId' in b ? b.parentToolUseId : undefined;
    if (!parent) continue;
    let list = byParent.get(parent);
    if (!list) { list = []; byParent.set(parent, list); }
    list.push(b);
  }
  // Every block a message came from, its nested lanes' included.
  const sources = new Map<SessionHistoryMessage, StreamingBlock[]>();
  const build = (parent: string, depth: number, ancestors: StreamingBlock[][]): SessionHistoryMessage[] => {
    const out: SessionHistoryMessage[] = [];
    let cur: SessionHistoryMessage | null = null;
    for (const b of byParent.get(parent) ?? []) {
      if (b.type !== 'text' && b.type !== 'thinking' && b.type !== 'tool_call') continue;
      // Nothing to draw yet (an empty tail, a placeholder call): the saved
      // transcript never has it either.
      if (isTransparentBlock(b)) continue;
      // A call belongs to the message whose reasoning and words came before it
      // (the stream names a message on those, never on a call).
      const msgId: string | undefined = b.type === 'tool_call' ? (cur as SessionHistoryMessage | null)?.msgId : b.msgId;
      if (!cur || (b.type !== 'tool_call' && cur.msgId !== msgId)) {
        cur = { role: 'assistant', text: '', ...(msgId ? { msgId } : {}), timestamp: seenAt(msgId ?? (b.type === 'tool_call' ? b.toolUseId : undefined)) };
        out.push(cur);
        sources.set(cur, []);
      }
      sources.get(cur)!.push(b);
      for (const list of ancestors) list.push(b);
      if (b.type === 'thinking') {
        if (b.content.trim()) cur.thinking = cur.thinking ? `${cur.thinking}\n\n${b.content}` : b.content;
      } else if (b.type === 'text') {
        const text = streamReplyText(b.content);
        cur.text = cur.text ? `${cur.text}\n\n${text}` : text;
      } else {
        const nested = GROUPABLE_STREAM_TOOLS.has(b.name) && depth < 8 ? build(b.toolUseId, depth + 1, [...ancestors, sources.get(cur)!]) : [];
        (cur.tools ??= []).push({
          name: b.name ?? 'unknown', input: b.input ?? {}, toolUseId: b.toolUseId,
          ...(b.result !== undefined ? { result: b.result } : {}),
          ...(b.status === 'error' ? { isError: true } : {}),
          liveStatus: b.status === 'error' ? 'error' : b.status === 'calling' ? 'calling' : 'done',
          ...(nested.length ? { childMessages: nested } : {}),
        });
      }
    }
    return out.map((m) => {
      const from = sources.get(m)!;
      const known = builtLaneMessages.get(from[0]);
      if (known && known.blocks.length === from.length && known.blocks.every((x, i) => x === from[i])) return known.msg;
      builtLaneMessages.set(from[0], { blocks: from, msg: m });
      return m;
    });
  };
  return build(rootId, 0, []);
}

/** "Explore agent" / "Agent": who the working indicator says is working. */
export function laneAgentLabel(input?: Record<string, unknown>): string {
  const type = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
  return type ? `${type} agent` : 'Agent';
}

export function streamAgentDescription(taskBlock: ToolBlock): string {
  return typeof taskBlock.input?.description === 'string'
    ? taskBlock.input.description
    : typeof taskBlock.input?.prompt === 'string'
      ? (taskBlock.input.prompt as string).slice(0, 80) + ((taskBlock.input.prompt as string).length > 80 ? '...' : '')
      : 'Task';
}

/** Same rule the history parser applies (session-history.ts, bgTaskFinished): a
 *  SYNC agent (explicit run_in_background:false) blocks its turn, so its settled
 *  tool_result proves the run is over; a BACKGROUND agent's tool_result is launch
 *  metadata written while it still runs, so only the ledger can finish it. */
export function streamAgentSettled(taskBlock: ToolBlock): boolean {
  if (taskBlock.status === 'error') return true;
  return taskBlock.input?.run_in_background === false && taskBlock.status === 'done';
}

/** What the chat knows about a streaming Agent tool_call, for the chip + panel:
 *  identity and title from the input, done/failed from the block status. (Its live
 *  lane reaches the panel separately, through the lane registry.) */
export function knownAgentFromStream(taskBlock: ToolBlock): KnownAgent {
  const failed = taskBlock.status === 'error';
  const finished = streamAgentSettled(taskBlock);
  return {
    toolUseId: taskBlock.toolUseId,
    description: streamAgentDescription(taskBlock),
    subagentType: typeof taskBlock.input?.subagent_type === 'string' ? taskBlock.input.subagent_type : undefined,
    finished,
    failed,
    running: !finished,
    result: agentResultText(taskBlock.result),
    promptInput: taskBlock.input,
  };
}

// ── Persisted lane ─────────────────────────────────────────────────────────────

type HistoryPart =
  | { kind: 'msg'; m: SessionHistoryMessage; suppressTools?: boolean }
  | { kind: 'run'; memberMsgs: SessionHistoryMessage[] }
  | { kind: 'system-run'; systemMembers: SystemGroupMember[] };

/** The main chat's history merge pass (SessionChatHistory's history-parts walk)
 *  without its render window and fork divider: tool-only messages and the
 *  thinking-only messages around them fold into one run (reasoning that led to
 *  the next answer included), thinking with no run before it is one row
 *  (absorbed by a following message's own thinking), a prose+tools message
 *  renders its prose and dissolves its tools forward into the next run, system
 *  rows group. */
export function laneHistoryParts(messages: readonly SessionHistoryMessage[]): HistoryPart[] {
  const parts: HistoryPart[] = [];
  let run: SessionHistoryMessage[] = [];
  let systemRun: SessionHistoryMessage[] = [];
  const pushStretch = (msgs: SessionHistoryMessage[]) => {
    if (msgs.some(m => (m.tools?.length ?? 0) > 0)) parts.push({ kind: 'run', memberMsgs: msgs });
    else if (msgs.length) parts.push({ kind: 'msg', m: mergeThinkingOnly(msgs) });
  };
  /** `ended` = a visible non-member follows (trailingThinkingOnlyStart keeps the
   *  whole run together either way). */
  const flushRun = (ended: boolean) => {
    const split = ended ? trailingThinkingOnlyStart(run) : run.length;
    pushStretch(run.slice(0, split));
    pushStretch(run.slice(split));
    run = [];
  };
  const flushSystem = () => {
    if (systemRun.length === 1) parts.push({ kind: 'msg', m: systemRun[0] });
    else if (systemRun.length > 1) parts.push({ kind: 'system-run', systemMembers: systemRun.map(systemGroupMemberFromHistory) });
    systemRun = [];
  };
  for (const m of messages) {
    if (m.role === 'system') { flushRun(true); systemRun.push(m); continue; }
    flushSystem();
    if (isToolOnlyMessage(m) || isThinkingOnlyMessage(m)) { run.push(m); continue; }
    flushRun(true);
    // A message whose own thinking follows a thinking-only part absorbs it, so
    // the reasoning before an answer is one "Thinking ›" row above the prose.
    // Right after a run, that reasoning rides the run instead (the main chat's rule).
    const prev = parts[parts.length - 1];
    let msg = m;
    if (prev?.kind === 'msg' && isThinkingOnlyMessage(prev.m) && m.role === 'assistant' && (m.thinking ?? '').trim()) {
      msg = { ...m, thinking: `${prev.m.thinking}\n\n${m.thinking}` };
      parts.pop();
    } else if (prev?.kind === 'run' && m.role === 'assistant' && (m.thinking ?? '').trim()) {
      prev.memberMsgs.push({ ...m, text: '', tools: undefined });
      msg = { ...m, thinking: undefined };
    }
    if (isTextPlusMergeableTools(msg)) {
      parts.push({ kind: 'msg', m: msg, suppressTools: true });
      run.push({ ...msg, text: '', thinking: undefined });
      continue;
    }
    parts.push({ kind: 'msg', m: msg });
  }
  flushRun(false);
  flushSystem();
  return parts;
}

/** Rough size of a persisted transcript (chars), for the working indicator's
 *  token figure — the same chars/4 estimate the main chat uses for a live turn. */
function countHistoryChars(messages: readonly SessionHistoryMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += (m.text ?? '').length + (m.thinking ?? '').length;
    for (const t of m.tools ?? []) {
      n += (t.result ?? '').length;
      try { n += JSON.stringify(t.input ?? {}).length; } catch { /* non-serializable input */ }
    }
  }
  return n;
}

export function LaneHistoryTimeline({ messages, live, startedAt, agentLabel, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: LaneHandlers & {
  messages: readonly SessionHistoryMessage[];
  /** The agent is still running (the caller polls): show the working indicator. */
  live?: boolean;
  /** When the agent started (ledger clock) — the indicator's elapsed counts from here. */
  startedAt?: number;
  /** Who is working, for the indicator ("Explore agent"). */
  agentLabel?: string;
}) {
  const parts = useMemo(() => laneHistoryParts(messages), [messages]);
  const handlers = { sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen };
  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === 'run') {
          // Keyed by the run's first member, as the live run is (runRowKey).
          const first = part.memberMsgs[0];
          const key = first.thinking ? first.msgId : first.tools?.[0]?.toolUseId;
          return (
            <div key={`run-${key ?? i}`} className="session-msg-bare">
              <MergedHistoryToolRun messages={part.memberMsgs} {...handlers} />
            </div>
          );
        }
        if (part.kind === 'system-run') {
          return (
            <div key={`sys-${i}`} className="session-msg-bare">
              <SystemGroupRun members={part.systemMembers} />
            </div>
          );
        }
        return (
          <SessionMessage key={laneMessageKey(part.m) ?? `${part.m.role}:${part.m.timestamp}:${i}`} message={part.m} suppressTools={part.suppressTools} {...handlers} />
        );
      })}
      {live && (
        <WorkingIndicator label={agentLabel ?? 'Agent'} tokens={Math.round(countHistoryChars(messages) / 4)} startedAt={startedAt} />
      )}
    </>
  );
}
