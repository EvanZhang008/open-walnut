/**
 * LaneTimeline — a subagent's transcript rendered with the main chat's own rows.
 *
 * Two inputs, one look. While the agent runs, its lane is read straight out of the
 * streaming buffer (`StreamingLane`: the Agent tool_call anchor plus the blocks
 * stamped with its toolUseId); once it has finished, its transcript is the persisted
 * messages the parser embedded under the Agent tool or the subagent endpoint returns
 * (`LaneHistoryTimeline`). Both apply the merges the main conversation applies:
 * consecutive finished tools fold into one "Ran 3 commands, read a file ›" row,
 * adjacent thinking into one "Thinking ›" row, system notices into one
 * "N system messages ›" row, while a tool still executing stays a full in-flight
 * card with its running dot. A running lane ends in the same "… is working…"
 * indicator the main chat pins to a live turn, clocked from the agent's start.
 *
 * Rendered inside the Background tasks panel (never in the chat), and by the
 * workflow transcript modal.
 */

import { useMemo } from 'react';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';
import type { KnownAgent } from './BackgroundTasksPanel';
import { groupLaneChildren } from '@/stream/group-blocks';
import { laneRows, type ToolBlock } from '@/stream/lane-rows';
import { useLiveAgentsForSession } from '@/stores/background-agents-store';
import {
  SessionMessage, SessionThinking, GenericToolCall, TaskGroupPrompt, ToolRunShell, toolRunPhrase, agentModelLabel,
  isToolOnlyMessage, isThinkingOnlyMessage, isTextPlusMergeableTools, MergedHistoryToolRun, SystemGroupRun,
  systemGroupMemberFromHistory, type SystemGroupMember,
} from './SessionMessage';
import { StreamingBlockView, WorkingIndicator, countStreamChars } from './StreamingBlockView';

interface LaneHandlers {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

// ── Streaming lane ─────────────────────────────────────────────────────────────

export interface StreamingLaneProps extends LaneHandlers {
  taskBlock: ToolBlock;
  /** The lane's blocks, root-flattened (every depth), in stream order. */
  childBlocks: StreamingBlock[];
  /** The agent is still running: the tail row pulses and the working indicator
   *  shows. Defaults to "not settled by the conversation" (see streamAgentSettled). */
  live?: boolean;
}

/** "Explore agent" / "Agent" — who the working indicator says is working. */
function laneAgentLabel(input?: Record<string, unknown>): string {
  const type = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
  return type ? `${type} agent` : 'Agent';
}

export function StreamingLane(props: StreamingLaneProps) {
  const { taskBlock, childBlocks, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen } = props;
  const live = props.live ?? !streamAgentSettled(taskBlock);
  // childBlocks arrive root-flattened; selfId lets groupLaneChildren re-derive
  // the per-level structure (a nested Agent's blocks go under its own header).
  const rows = laneRows(groupLaneChildren(taskBlock.toolUseId, childBlocks));
  const startedAt = useLiveAgentsForSession(sessionId).get(taskBlock.toolUseId)?.startedAt;
  const handlers = { sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen };
  const tailIdx = rows.length - 1;
  return (
    <>
      <TaskGroupPrompt input={taskBlock.input} />
      {rows.map((row, i) => {
        const isTail = live && i === tailIdx;
        if (row.kind === 'agent') {
          return (
            <NestedStreamingAgent key={`nested-${row.item.taskBlock.toolUseId}`} taskBlock={row.item.taskBlock} childBlocks={row.item.childBlocks} {...handlers} />
          );
        }
        if (row.kind === 'run') {
          const phrase = toolRunPhrase(row.blocks.map(b => b.name ?? 'unknown'));
          const failCount = row.blocks.filter(b => b.status === 'error').length;
          return (
            <div key={`run-${row.blocks[0].toolUseId}`} className="session-msg-bare">
              <ToolRunShell phrase={phrase} failCount={failCount}>
                {row.blocks.map((b, bi) => (
                  <GenericToolCall
                    key={b.toolUseId ?? bi}
                    tool={{ name: b.name ?? 'unknown', input: b.input ?? {} }}
                    status={b.status === 'error' ? 'error' : 'done'}
                    result={b.result}
                    {...handlers}
                  />
                ))}
              </ToolRunShell>
            </div>
          );
        }
        if (row.kind === 'thinking') {
          const text = row.blocks.map(b => b.content).filter(s => s.trim()).join('\n\n');
          return (
            <div key={`think-${i}`} className="session-msg-bare">
              <SessionThinking text={text} live={isTail} />
            </div>
          );
        }
        const b = row.block;
        if (b.type === 'text') {
          return (
            <div key={`text-${i}`} className="session-msg session-msg-assistant">
              <div className="session-msg-content">
                <StreamingBlockView block={b} live={isTail} {...handlers} />
              </div>
            </div>
          );
        }
        // A tool still executing (the in-flight card), a plan card, a plan write.
        return (
          <div key={`block-${i}`} className="session-msg-bare">
            <StreamingBlockView block={b} live={isTail} {...handlers} />
          </div>
        );
      })}
      {live && (
        <WorkingIndicator
          label={laneAgentLabel(taskBlock.input)}
          tokens={Math.round(countStreamChars(childBlocks) / 4)}
          startedAt={startedAt}
        />
      )}
    </>
  );
}

/** A nested Agent this agent spawned: one inert header line with its own lane
 *  beneath it (depth is content inside the reader, never a chip). */
function NestedStreamingAgent(props: StreamingLaneProps) {
  const { taskBlock, childBlocks } = props;
  const isDone = taskBlock.status === 'done';
  const isError = taskBlock.status === 'error';
  const subagentType = typeof taskBlock.input?.subagent_type === 'string' ? taskBlock.input.subagent_type : '';
  const modelChip = agentModelLabel(taskBlock.input);
  const toolCount = childBlocks.filter(b => b.type === 'tool_call').length;
  return (
    <div className={`task-group task-group--nested ${isDone ? 'task-group--done' : ''} ${isError ? 'task-group--error' : ''}`}>
      <div className="task-group-header">
        <span className={`task-group-icon ${!isDone && !isError ? 'task-group-icon--running' : ''}`}>
          {isError ? '✗' : isDone ? '✓' : <span className="task-group-streaming-dot" />}
        </span>
        <span className="task-group-label">{taskBlock.name}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        {modelChip && <span className="task-group-model">{modelChip}</span>}
        <span className="task-group-description">{streamAgentDescription(taskBlock)}</span>
        {toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="task-group-body"><StreamingLane {...props} live={!isDone && !isError} /></div>
    </div>
  );
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
    result: taskBlock.result || undefined,
    promptInput: taskBlock.input,
  };
}

// ── Persisted lane ─────────────────────────────────────────────────────────────

type HistoryPart =
  | { kind: 'msg'; m: SessionHistoryMessage; suppressTools?: boolean }
  | { kind: 'run'; memberMsgs: SessionHistoryMessage[] }
  | { kind: 'system-run'; systemMembers: SystemGroupMember[] };

/** The main chat's history merge pass (SessionChatHistory's history-parts walk)
 *  without its render window and fork divider: tool-only messages fold into one
 *  run, adjacent thinking into one row, a prose+tools message renders its prose
 *  and dissolves its tools forward into the next run, system rows group. */
export function laneHistoryParts(messages: readonly SessionHistoryMessage[]): HistoryPart[] {
  const parts: HistoryPart[] = [];
  let run: SessionHistoryMessage[] = [];
  let systemRun: SessionHistoryMessage[] = [];
  const flushRun = () => { if (run.length) parts.push({ kind: 'run', memberMsgs: run }); run = []; };
  const flushSystem = () => {
    if (systemRun.length === 1) parts.push({ kind: 'msg', m: systemRun[0] });
    else if (systemRun.length > 1) parts.push({ kind: 'system-run', systemMembers: systemRun.map(systemGroupMemberFromHistory) });
    systemRun = [];
  };
  for (const m of messages) {
    if (m.role === 'system') { flushRun(); systemRun.push(m); continue; }
    flushSystem();
    if (isToolOnlyMessage(m)) { run.push(m); continue; }
    flushRun();
    const prev = parts[parts.length - 1];
    let msg = m;
    if (prev?.kind === 'msg' && isThinkingOnlyMessage(prev.m) && m.role === 'assistant' && (m.thinking ?? '').trim()) {
      if (isThinkingOnlyMessage(m)) {
        prev.m = { ...prev.m, thinking: `${prev.m.thinking}\n\n${m.thinking}` };
        continue;
      }
      msg = { ...m, thinking: `${prev.m.thinking}\n\n${m.thinking}` };
      parts.pop();
    }
    if (isTextPlusMergeableTools(msg)) {
      parts.push({ kind: 'msg', m: msg, suppressTools: true });
      run.push({ ...msg, text: '', thinking: undefined });
      continue;
    }
    parts.push({ kind: 'msg', m: msg });
  }
  flushRun();
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
          const first = part.memberMsgs[0];
          return (
            <div key={`run-${first.msgId ?? i}`} className="session-msg-bare">
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
          <SessionMessage key={part.m.msgId ?? `${part.m.role}:${part.m.timestamp}:${i}`} message={part.m} suppressTools={part.suppressTools} {...handlers} />
        );
      })}
      {live && (
        <WorkingIndicator label={agentLabel ?? 'Agent'} tokens={Math.round(countHistoryChars(messages) / 4)} startedAt={startedAt} />
      )}
    </>
  );
}
