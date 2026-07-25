/**
 * Unit tests for dynamic-workflow / background-task turn-boundary logic.
 *
 * A dynamic workflow (`ultracode` → Workflow tool) fans out many background
 * subagents that outlive the main agent's text turn. The CLI emits MANY `result`
 * events for one such turn (the main "launched in background" result PLUS one per
 * subagent completion fed back via ask()), so `result` is NOT a turn boundary.
 *
 * ⚠️ `session_state_changed{state:'idle'}` is NOT a one-shot end-of-turn signal.
 * POC-verified (see memory claude-code-session-state-semantics): the CLI emits
 * `idle` ~20×/run — between every sub-agent / phase — because its idle-wait loop
 * excludes `in_process_teammate` tasks. So idle == "foreground quiet right now". The
 * turn is over only at an idle that arrives AFTER every task in the authoritative set
 * (`_bgTasks`, id→status) is terminal. In-flight is DERIVED (count of non-terminal),
 * NOT an accumulated counter — so a duplicate / lost / out-of-order / new-kind lifecycle
 * event cannot desync it (the level-triggered, k8s-style design). idle is just the
 * completion trigger. (Gated by CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, which the daemon
 * sets; when absent we complete via `result` + the set.)
 *
 * These tests verify the handleStreamLine() branches in ClaudeCodeSession:
 *   1. running → task_progress×N → idle: stays 'running' mid-workflow, only
 *      flips to AGENT_COMPLETE on the trailing idle.
 *   2. multiple results (incl. origin=task-notification) don't complete early.
 *   3. NORMAL single-turn session (no workflow) still completes (regression guard),
 *      and a trailing idle does NOT double-fire SESSION_RESULT.
 *   4. session-history replay reconstructs bgTasksInFlight / cliSessionState.
 *   5. old CLI (no session_state_changed) falls back to the counter — no deadlock.
 *   6. mid-workflow idle×N while tasks in flight does NOT complete (the real bug:
 *      idle fired with bgInFlight=5 → false await_human). Completes only at idle@0.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { recoverStateFromJsonl } from '../../src/core/session-history.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'
import { WALNUT_HOME, CLAUDE_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

// ── JSONL event builders ──

function makeInitEvent(sessionId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/tmp', model: 'mock-model', tools: ['Read', 'Edit', 'Bash'],
    mcp_servers: [], permissionMode: 'default',
  })
}

function makeAssistantEvent(sessionId: string, text = 'Working on it'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_001', type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: sessionId,
  })
}

/** A normal turn-over result (no background-work origin). */
function makeResultEvent(sessionId: string, cost = 0.003, text = 'Done'): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1500, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

/** A result the CLI produced while processing a background completion notification.
 *  origin.kind='task-notification' → never a turn boundary. */
function makeTaskNotificationResultEvent(sessionId: string, cost: number, text: string): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 800, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: cost,
    origin: { kind: 'task-notification' },
    usage: { input_tokens: 50, output_tokens: 20 },
  })
}

function makeSessionStateEvent(sessionId: string, state: 'running' | 'idle' | 'requires_action'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state })
}

function makeTaskStartedEvent(
  sessionId: string, taskId: string,
  opts: { workflowName?: string; description?: string; subagentType?: string; taskType?: string } = {},
): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_started', session_id: sessionId, task_id: taskId,
    workflow_name: opts.workflowName, description: opts.description, subagent_type: opts.subagentType,
    task_type: opts.taskType,
  })
}

function makeTaskProgressEvent(
  sessionId: string, taskId: string,
  opts: { summary?: string; tokens?: number; lastTool?: string } = {},
): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_progress', session_id: sessionId, task_id: taskId,
    summary: opts.summary, last_tool_name: opts.lastTool,
    usage: opts.tokens != null ? { total_tokens: opts.tokens } : undefined,
  })
}

function makeTaskNotificationEvent(sessionId: string, taskId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: taskId, status,
  })
}

/** A task_updated status patch. Newer CLIs emit this with patch.status='completed' just
 *  BEFORE the matching task_notification — the exact event that wedged incident …afr3cs:
 *  it pre-set the task's status to 'completed', and the OLD decrement (gated on
 *  status==='running') then skipped, leaking the in-flight counter forever. */
function makeTaskUpdatedEvent(
  sessionId: string, taskId: string, patch: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_updated', session_id: sessionId, task_id: taskId, patch,
  })
}

/** A top-level dynamic-workflow task_started, carrying the generated script. */
function makeWorkflowStartedEvent(
  sessionId: string, taskId: string,
  opts: { workflowName?: string; description?: string; prompt?: string } = {},
): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_started', session_id: sessionId, task_id: taskId,
    task_type: 'local_workflow', workflow_name: opts.workflowName,
    description: opts.description, prompt: opts.prompt,
  })
}

/** A task_progress carrying a workflow_progress[] snapshot. Pass phases + the
 *  currently-active agents (the CLI only sends active ones per snapshot). */
function makeWorkflowProgressEvent(
  sessionId: string, taskId: string,
  phases: Array<{ index: number; title: string }>,
  agents: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_progress', session_id: sessionId, task_id: taskId,
    workflow_progress: [
      ...phases.map(p => ({ type: 'workflow_phase', ...p })),
      ...agents.map(a => ({ type: 'workflow_agent', ...a })),
    ],
  })
}

// ── Helpers ──

interface MockTransport {
  isRemote: boolean
  hasPipe: boolean
  processName: string
  pid: number | null
  outputFile: string | null
  host: string | null
  fileSize: number
  imageCache: Map<string, string>
  lastEventAt: number
  tailOffset: number
}

function createMockTransport(overrides: Partial<MockTransport> = {}): MockTransport {
  return {
    isRemote: false, hasPipe: false, processName: 'claude', pid: null,
    outputFile: null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    ...overrides,
  }
}

function feedLines(session: ClaudeCodeSession, lines: string[]): void {
  const handle = session as unknown as { handleStreamLine(line: string): void }
  for (const line of lines) handle.handleStreamLine(line)
}

/** Wire up a remote FIFO-alive session (the dynamic-workflow common case: a
 *  long-running CLI on clouddev that stays alive between turns). */
function makeRunningRemoteSession(taskId: string): ClaudeCodeSession {
  const session = new ClaudeCodeSession(taskId, 'test-project')
  const transport = createMockTransport({ isRemote: true, hasPipe: true })
  ;(session as unknown as { _transport: unknown })._transport = transport
  ;(session as unknown as { _active: boolean })._active = true
  ;(session as unknown as { _processStatus: string })._processStatus = 'running'
  return session
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await new Promise(r => setTimeout(r, 200))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  Test 1: running → task_progress×N → idle
// ═══════════════════════════════════════════════════════════════════

describe('Dynamic workflow: stays running until idle', () => {
  it('intermediate result while bg work in flight does NOT complete; idle does', async () => {
    const sid = 'wf-running-until-idle'
    const session = makeRunningRemoteSession('task-wf-1')

    const resultEvents: Array<Record<string, unknown>> = []
    const bgSnapshots: Array<{ inFlight: number; tasks: unknown[]; workflowName?: string }> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
      if (e.name === EventNames.SESSION_BACKGROUND_TASKS) {
        bgSnapshots.push(e.data as { inFlight: number; tasks: unknown[]; workflowName?: string })
      }
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Workflow launched in background'),
      makeTaskStartedEvent(sid, 'bg-A', { workflowName: 'review-changes', description: 'Review bugs' }),
      makeTaskStartedEvent(sid, 'bg-B', { workflowName: 'review-changes', description: 'Review perf' }),
    ])

    // Two background tasks now in flight; status must be running, workflow name surfaced.
    expect(session.hasActiveBackgroundWork()).toBe(true)
    expect(session.processStatus).toBe('running')
    expect(session.workflowName).toBe('review-changes')
    expect(session.backgroundTasks.length).toBe(2)

    // Heartbeats — still running, no completion.
    feedLines(session, [
      makeTaskProgressEvent(sid, 'bg-A', { summary: 'reading files', tokens: 1200, lastTool: 'Read' }),
      makeTaskProgressEvent(sid, 'bg-B', { summary: 'profiling', tokens: 3400, lastTool: 'Bash' }),
    ])
    expect(session.processStatus).toBe('running')
    expect(resultEvents.length).toBe(0)

    // The main turn's own `result` arrives while subagents still run — must NOT complete.
    feedLines(session, [makeResultEvent(sid, 0.01, 'Workflow launched in background')])
    expect(session.processStatus).toBe('running')
    expect(session.hasActiveBackgroundWork()).toBe(true)
    expect(resultEvents.length).toBe(0)

    // Subagents finish one by one.
    feedLines(session, [makeTaskNotificationEvent(sid, 'bg-A', 'completed')])
    expect(session.hasActiveBackgroundWork()).toBe(true) // bg-B still running
    feedLines(session, [makeTaskNotificationEvent(sid, 'bg-B', 'completed')])
    // Counter is now 0, but without the authoritative idle we keep deferring to it.
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(resultEvents.length).toBe(0) // notifications alone never emit a turn result

    // Authoritative turn-over.
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(session.processStatus).toBe('idle')
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(resultEvents.length).toBe(1) // completed exactly once, driven by idle

    // The UI snapshot stream reflected the in-flight peak then drained to 0.
    expect(Math.max(...bgSnapshots.map(s => s.inFlight))).toBe(2)
    expect(bgSnapshots[bgSnapshots.length - 1].inFlight).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 2: multiple results (incl. origin=task-notification) don't complete early
// ═══════════════════════════════════════════════════════════════════

describe('Dynamic workflow: result-flood does not trigger premature completion', () => {
  it('task-notification-origin results are bookkeeping only', async () => {
    const sid = 'wf-result-flood'
    const session = makeRunningRemoteSession('task-wf-2')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Launching workflow'),
      makeTaskStartedEvent(sid, 'bg-1', { workflowName: 'audit' }),
      makeTaskStartedEvent(sid, 'bg-2', { workflowName: 'audit' }),
      // The CLI feeds each subagent completion back as a fresh result with
      // origin.kind='task-notification'. These must be pure noise.
      makeTaskNotificationResultEvent(sid, 0.02, 'Subagent 1 found 2 bugs'),
      makeTaskNotificationResultEvent(sid, 0.03, 'Subagent 2 found 1 bug'),
    ])

    // Despite TWO result events, the turn is not over — no SESSION_RESULT emitted.
    expect(resultEvents.length).toBe(0)
    expect(session.processStatus).toBe('running')
    // fullText captured from the latest result for display, but no completion.
    expect((session as unknown as { fullText: string }).fullText).toBe('Subagent 2 found 1 bug')

    // Finish + idle.
    feedLines(session, [
      makeTaskNotificationEvent(sid, 'bg-1', 'completed'),
      makeTaskNotificationEvent(sid, 'bg-2', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 3: NORMAL single-turn session still completes (regression guard)
// ═══════════════════════════════════════════════════════════════════

describe('Regression: normal single-turn session completes normally', () => {
  it('no workflow → result completes the turn immediately', async () => {
    const sid = 'normal-single-turn'
    const session = makeRunningRemoteSession('task-normal-1')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Hello'),
      makeResultEvent(sid, 0.003, 'Hello'),
    ])

    // No background work was ever started → the result completes the turn at once.
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(session.processStatus).toBe('idle')
    expect(session.active).toBe(true) // FIFO-alive: process stays up for next turn
    expect(resultEvents.length).toBe(1)
  })

  it('trailing idle after a normal result does NOT double-fire SESSION_RESULT', async () => {
    // With the daemon now setting CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, even a
    // normal turn ends with a session_state_changed{idle}. It must be a no-op
    // because the result handler already completed the turn.
    const sid = 'normal-with-trailing-idle'
    const session = makeRunningRemoteSession('task-normal-2')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Answer'),
      makeResultEvent(sid, 0.003, 'Answer'),
    ])
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')

    // Trailing authoritative idle — already completed, must not re-emit.
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 4: session-history replay reconstructs bg state
// ═══════════════════════════════════════════════════════════════════

describe('session-history replay: reconstructs bgTasksInFlight / cliSessionState', () => {
  /** Write JSONL to the canonical local Claude Code path so recoverStateFromJsonl finds it. */
  async function writeJsonl(sessionId: string, cwd: string, lines: string[]) {
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd))
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  }

  it('mid-workflow JSONL → bgTasksInFlight>0, no agent_complete', async () => {
    const sid = 'replay-midflow'
    const cwd = '/Users/test/wf-project'
    await writeJsonl(sid, cwd, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg-A', { workflowName: 'audit' }),
      makeTaskStartedEvent(sid, 'bg-B', { workflowName: 'audit' }),
      makeResultEvent(sid, 0.01, 'Workflow launched in background'),
      makeTaskNotificationEvent(sid, 'bg-A', 'completed'),
    ])

    const state = await recoverStateFromJsonl(sid, cwd)
    expect(state).not.toBeNull()
    // Two started, one finished → one still in flight; the replayed result must
    // NOT have been mistaken for turn-over.
    expect(state!.bgTasksInFlight).toBe(1)
    expect(state!.workStatus).not.toBe('agent_complete')
  })

  it('completed-workflow JSONL → idle owns workStatus, counter drained to 0', async () => {
    const sid = 'replay-complete'
    const cwd = '/Users/test/wf-project2'
    await writeJsonl(sid, cwd, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg-A', { workflowName: 'audit' }),
      makeTaskStartedEvent(sid, 'bg-B', { workflowName: 'audit' }),
      makeResultEvent(sid, 0.01, 'Workflow launched in background'),
      makeTaskNotificationEvent(sid, 'bg-A', 'completed'),
      makeTaskNotificationEvent(sid, 'bg-B', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])

    const state = await recoverStateFromJsonl(sid, cwd)
    expect(state).not.toBeNull()
    expect(state!.bgTasksInFlight).toBe(0)
    expect(state!.cliSessionState).toBe('idle')
    expect(state!.workStatus).toBe('agent_complete')
  })

  it('mid-workflow JSONL ENDING in idle while bg>0 → still running, NOT agent_complete', async () => {
    // The realistic restart: a workflow run emits idle ~20×/run between sub-agents.
    // A server restart mid-workflow recovers JSONL whose tail contains an idle even
    // though tasks are live. The OLD replay set agent_complete + zeroed the counter on
    // ANY idle → marked a running workflow complete on restart. Gate on the counter.
    const sid = 'replay-idle-bg-live'
    const cwd = '/Users/test/wf-project3'
    await writeJsonl(sid, cwd, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg-A', { workflowName: 'audit' }),
      makeTaskStartedEvent(sid, 'bg-B', { workflowName: 'audit' }),
      makeTaskStartedEvent(sid, 'bg-C', { workflowName: 'audit' }),
      makeResultEvent(sid, 0.01, 'Workflow launched in background'),
      makeTaskNotificationEvent(sid, 'bg-A', 'completed'),
      // The CLI flips idle between sub-agents while B + C still run.
      makeSessionStateEvent(sid, 'idle'),
    ])

    const state = await recoverStateFromJsonl(sid, cwd)
    expect(state).not.toBeNull()
    // 3 started, 1 finished → 2 in flight; idle must NOT have zeroed it.
    expect(state!.bgTasksInFlight).toBe(2)
    expect(state!.cliSessionState).toBe('idle')
    // A mid-workflow idle is NOT turn-over: must NOT recover as agent_complete.
    expect(state!.workStatus).not.toBe('agent_complete')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 5: old CLI (no session_state_changed) — counter fallback, no deadlock
// ═══════════════════════════════════════════════════════════════════

describe('Fallback: old CLI without session_state_changed does not deadlock', () => {
  it('counter drains to 0 → next result completes the turn', async () => {
    const sid = 'wf-no-state-events'
    const session = makeRunningRemoteSession('task-wf-fallback')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Launching'),
      makeTaskStartedEvent(sid, 'bg-1'),
      // Intermediate result while the single bg task runs — counter holds it running
      // even though NO session_state_changed was ever emitted.
      makeResultEvent(sid, 0.01, 'Workflow launched in background'),
    ])
    expect((session as unknown as { _sessionStateSeen: boolean })._sessionStateSeen).toBe(false)
    expect(session.hasActiveBackgroundWork()).toBe(true)
    expect(session.processStatus).toBe('running')
    expect(resultEvents.length).toBe(0)

    // Subagent finishes → counter hits 0.
    feedLines(session, [makeTaskNotificationEvent(sid, 'bg-1', 'completed')])
    expect(session.hasActiveBackgroundWork()).toBe(false)

    // With the counter drained and no idle to wait for, the NEXT result legitimately
    // completes the turn — proving the fallback never deadlocks.
    feedLines(session, [makeResultEvent(sid, 0.02, 'All workflow tasks complete')])
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 6: workflow_progress[] parsing — per-subagent visibility
// ═══════════════════════════════════════════════════════════════════

describe('Dynamic workflow: workflow_progress[] → phases + per-agent breakdown', () => {
  /** Latest SESSION_BACKGROUND_TASKS snapshot. */
  function lastSnapshot(): Record<string, unknown> | undefined {
    return snaps[snaps.length - 1]
  }
  let snaps: Array<Record<string, unknown>> = []

  function wire(): ClaudeCodeSession {
    snaps = []
    const session = makeRunningRemoteSession('task-wfp')
    bus.subscribe('web-ui', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_BACKGROUND_TASKS) snaps.push(e.data as Record<string, unknown>)
    })
    return session
  }

  it('captures script + accumulates agents by agentId across phase boundaries, skipping ghosts', () => {
    const sid = 'wfp-accumulate'
    const session = wire()

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Workflow launched in background'),
      makeWorkflowStartedEvent(sid, 'wf-top', {
        workflowName: 'review-changes',
        description: 'Review changes across two dimensions',
        prompt: "export const meta = { name: 'review-changes' }\nphase('Fan out')",
      }),
    ])

    // Script + name + description captured from task_started.
    let snap = lastSnapshot()!
    expect(snap.workflowName).toBe('review-changes')
    expect(snap.scriptSource).toContain("name: 'review-changes'")
    expect(snap.workflowDescription).toBe('Review changes across two dimensions')

    // Snapshot 1 (Fan out phase): 2 ghosts (no agentId) + 2 real agents.
    feedLines(session, [
      makeWorkflowProgressEvent(sid, 'wf-top',
        [{ index: 1, title: 'Fan out' }, { index: 2, title: 'Synthesize' }],
        [
          { index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', state: 'start' }, // ghost
          { index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', state: 'start' }, // ghost
          { index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'a-bugs', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'start', promptPreview: 'Review bugs' },
          { index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'a-perf', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'start', promptPreview: 'Review perf' },
        ]),
    ])
    snap = lastSnapshot()!
    let agents = snap.agents as Array<Record<string, unknown>>
    // Ghosts (no agentId) skipped → exactly 2 real agents, both running.
    expect(agents.length).toBe(2)
    expect(agents.every(a => a.status === 'running')).toBe(true)
    expect(agents.find(a => a.agentId === 'a-bugs')!.promptPreview).toBe('Review bugs')
    expect((snap.phases as unknown[]).length).toBe(2)

    // Snapshot 2 (Synthesize phase): the CLI now sends only the bugs/perf agents as
    // done WITH resultPreview, plus a NEW synthesize agent. Union must reach 3 agents.
    feedLines(session, [
      makeWorkflowProgressEvent(sid, 'wf-top',
        [{ index: 1, title: 'Fan out' }, { index: 2, title: 'Synthesize' }],
        [
          { index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'a-bugs', state: 'done', tokens: 1200, durationMs: 1800, resultPreview: 'Found 2 bugs' },
          { index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'a-perf', state: 'done', tokens: 3400, durationMs: 2100, resultPreview: 'Found 1 perf issue' },
          { index: 3, label: 'synthesize', phaseIndex: 2, phaseTitle: 'Synthesize', agentId: 'a-syn', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'start', promptPreview: 'Combine findings' },
        ]),
    ])
    snap = lastSnapshot()!
    agents = snap.agents as Array<Record<string, unknown>>
    // Union across snapshots: bugs + perf (carried over) + synthesize (new) = 3.
    expect(agents.length).toBe(3)
    const bugs = agents.find(a => a.agentId === 'a-bugs')!
    expect(bugs.status).toBe('completed')
    expect(bugs.resultPreview).toBe('Found 2 bugs')
    // Merge-don't-clobber: promptPreview from snapshot 1 survives snapshot 2 omitting it.
    expect(bugs.promptPreview).toBe('Review bugs')
    expect(agents.find(a => a.agentId === 'a-syn')!.status).toBe('running')

    // Counts the UI derives: 2 done / 3 total · 1 running.
    const done = agents.filter(a => ['completed', 'failed', 'stopped'].includes(a.status as string)).length
    const running = agents.filter(a => a.status === 'running').length
    expect(done).toBe(2)
    expect(running).toBe(1)
  })

  it('resets workflow agents when a fresh workflow opens (no leak across turns)', () => {
    const sid = 'wfp-reset'
    const session = wire()
    feedLines(session, [
      makeInitEvent(sid),
      makeWorkflowStartedEvent(sid, 'wf-1', { workflowName: 'first', prompt: 'first-script' }),
      makeWorkflowProgressEvent(sid, 'wf-1', [{ index: 1, title: 'P1' }],
        [{ index: 1, agentId: 'old-1', state: 'done', resultPreview: 'old' }]),
    ])
    expect((lastSnapshot()!.agents as unknown[]).length).toBe(1)

    // A new local_workflow task_started must wipe the prior run's agents + script.
    feedLines(session, [
      makeWorkflowStartedEvent(sid, 'wf-2', { workflowName: 'second', prompt: 'second-script' }),
    ])
    const snap = lastSnapshot()!
    expect((snap.agents as unknown[]).length).toBe(0)
    expect(snap.scriptSource).toBe('second-script')
    expect(snap.workflowName).toBe('second')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 7: mid-workflow idle storm — the real incident (idle@bgInFlight=5)
// ═══════════════════════════════════════════════════════════════════
//
// Reproduces a real remote-session incident: the CLI emitted ~20
// session_state_changed{idle} during ONE workflow run — one between every
// sub-agent — because its idle-wait loop excludes in_process_teammate tasks. The
// real replay showed 18/20 idles firing with 1–5 tasks still in flight, including
// a run of idle@bgInFlight=5 (the panel's "5 running"). The OLD code treated the
// first such idle as turn-over → hard-reset the counter to 0 → AGENT_COMPLETE →
// the agent self-reported await_human_action while the workflow was still running.
//
// The fix: idle completes the turn ONLY when our bgTasksInFlight counter has
// drained to 0; a mid-workflow idle is ignored (status stays running, counter
// untouched). This test feeds the real interleaved pattern and asserts no
// premature completion + exactly one completion at the final idle@0.
describe('Dynamic workflow: mid-workflow idle storm does NOT complete prematurely', () => {
  it('idle fired repeatedly while tasks in flight stays running; completes only at idle@bgInFlight=0', () => {
    const sid = 'wf-idle-storm'
    const session = makeRunningRemoteSession('task-idle-storm')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })

    // In-flight is DERIVED from the task set (no scalar counter exists anymore).
    const inFlight = () => (session as unknown as { _runningBgCount(): number })._runningBgCount()

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Launching workflow'),
      // Fan out 5 sub-agents (each a real task with its own task_started, like the
      // local_agent tasks the wiki-skill workflow spawned).
      makeTaskStartedEvent(sid, 't1', { workflowName: 'agentsmd-batch' }),
      makeTaskStartedEvent(sid, 't2', { workflowName: 'agentsmd-batch' }),
      makeTaskStartedEvent(sid, 't3', { workflowName: 'agentsmd-batch' }),
      makeTaskStartedEvent(sid, 't4', { workflowName: 'agentsmd-batch' }),
      makeTaskStartedEvent(sid, 't5', { workflowName: 'agentsmd-batch' }),
    ])
    expect(inFlight()).toBe(5)
    expect(session.processStatus).toBe('running')

    // The main turn's own result arrives early ("launched in background") — withheld.
    feedLines(session, [makeResultEvent(sid, 0.5, 'Workflow launched in background')])
    expect(resultEvents.length).toBe(0)
    expect(session.processStatus).toBe('running')

    // Now the idle STORM: the CLI flips running⇄idle between sub-agents. Feed 10
    // idles while all 5 tasks are still running. NONE may complete the turn, and the
    // counter must NOT be reset — this is the exact bug.
    for (let i = 0; i < 10; i++) {
      feedLines(session, [
        makeSessionStateEvent(sid, 'idle'),
        makeSessionStateEvent(sid, 'running'),
      ])
      expect(inFlight()).toBe(5)               // counter never clobbered
      expect(resultEvents.length).toBe(0)      // never completed
      expect(session.processStatus).toBe('running')
      expect(session.hasActiveBackgroundWork()).toBe(true)
    }

    // Tasks drain one by one, each followed by a mid-workflow idle (still not over).
    for (const tid of ['t1', 't2', 't3', 't4']) {
      feedLines(session, [
        makeTaskNotificationEvent(sid, tid, 'completed'),
        makeSessionStateEvent(sid, 'idle'),
      ])
      expect(resultEvents.length).toBe(0)      // 4 still>0 … down to 1, never 0 yet
      expect(session.processStatus).toBe('running')
    }
    expect(inFlight()).toBe(1)

    // Last task finishes → counter hits 0. The NEXT idle is the real turn-over.
    feedLines(session, [makeTaskNotificationEvent(sid, 't5', 'completed')])
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(resultEvents.length).toBe(0)        // notification alone never completes

    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(resultEvents.length).toBe(1)        // completed exactly once, at idle@0
    expect(session.processStatus).toBe('idle')

    // A further trailing idle (the CLI keeps emitting them) must be a no-op.
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(resultEvents.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 8: task_updated-before-notification — the counter-leak wedge
// ═══════════════════════════════════════════════════════════════════
//
// Reproduces incident inc-…afr3cs (session ab736795): a plan-mode turn fanned out 2
// `local_agent` Explore subagents. The REAL CLI emits, per task:
//     task_started → … → task_updated{patch.status:'completed'} → task_notification
// i.e. a task_updated flips the task's status to 'completed' BEFORE the notification.
// The OLD decrement gated on `_bgTasks[id].status === 'running'`, so by the time the
// notification arrived the status was already 'completed' and the decrement was SKIPPED.
// Both tasks leaked → bgTasksInFlight stuck at 2 → hasActiveBackgroundWork() forever true
// → the trailing idle hit "awaiting drain" and never completed → the session showed green
// "Running" 29 min after the turn ended (server.log: remainingInFlight:2 logged TWICE).
//
// The existing tests never sent task_updated, so they passed against the buggy code. This
// asserts the counter drains to 0 and the turn completes exactly once through the real
// task_updated→task_notification ordering.
describe('Dynamic workflow: task_updated before task_notification still drains the counter', () => {
  it('task_updated{completed} then task_notification drains exactly once; idle completes', () => {
    const sid = 'wf-updated-before-notif'
    const session = makeRunningRemoteSession('task-updated-notif')

    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })
    // In-flight is DERIVED from the task set (no scalar counter exists anymore).
    const inFlight = () => (session as unknown as { _runningBgCount(): number })._runningBgCount()

    // Two local_agent subagents fan out (the real incident's shape).
    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Researching in background'),
      makeTaskStartedEvent(sid, 'a34e', { description: 'Explore CDK stack', subagentType: 'Explore' }),
      makeTaskStartedEvent(sid, 'a5e5', { description: 'Explore IAM role', subagentType: 'Explore' }),
    ])
    expect(inFlight()).toBe(2)
    expect(session.hasActiveBackgroundWork()).toBe(true)

    // The main turn's own result lands while subagents run — withheld.
    feedLines(session, [makeResultEvent(sid, 1.75, 'Launched research')])
    expect(resultEvents.length).toBe(0)

    // Task A reaches terminal the REAL way: task_updated{completed} THEN task_notification.
    feedLines(session, [
      makeTaskUpdatedEvent(sid, 'a34e', { status: 'completed', end_time: 1782511274842 }),
    ])
    expect(inFlight()).toBe(1)                      // drained by task_updated (the fix)
    feedLines(session, [
      makeTaskNotificationEvent(sid, 'a34e', 'completed'),
    ])
    expect(inFlight()).toBe(1)                      // notification must NOT double-decrement

    // Task B, same ordering.
    feedLines(session, [
      makeTaskUpdatedEvent(sid, 'a5e5', { status: 'completed', end_time: 1782511393401 }),
      makeTaskNotificationEvent(sid, 'a5e5', 'completed'),
    ])
    expect(inFlight()).toBe(0)                       // counter fully drained — no leak
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(resultEvents.length).toBe(0)             // notifications alone never complete

    // The trailing authoritative idle now completes the turn (pre-fix it wedged here).
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })

  it('replay of a task_updated→notification JSONL drains bgTasksInFlight to 0', async () => {
    // The session-history replay path must agree with the live path: a JSONL tail where
    // each task has BOTH task_updated{completed} and task_notification must reconstruct
    // bgTasksInFlight=0 (drained once per task), not -0-with-double-count or a leak.
    const sid = 'replay-updated-before-notif'
    const cwd = '/Users/test/wf-updated'
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd))
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `${sid}.jsonl`), [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'a34e', { description: 'Explore A' }),
      makeTaskStartedEvent(sid, 'a5e5', { description: 'Explore B' }),
      makeResultEvent(sid, 1.75, 'Launched research'),
      makeTaskUpdatedEvent(sid, 'a34e', { status: 'completed' }),
      makeTaskNotificationEvent(sid, 'a34e', 'completed'),
      makeTaskUpdatedEvent(sid, 'a5e5', { status: 'completed' }),
      makeTaskNotificationEvent(sid, 'a5e5', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ].join('\n') + '\n')

    const state = await recoverStateFromJsonl(sid, cwd)
    expect(state).not.toBeNull()
    expect(state!.bgTasksInFlight).toBe(0)          // drained once per task, no leak
    expect(state!.cliSessionState).toBe('idle')
    expect(state!.workStatus).toBe('agent_complete') // idle@0 → genuine turn-over
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Test 9: level-triggered architecture resilience (the "100% reliable" proof)
// ═══════════════════════════════════════════════════════════════════
//
// The fix replaced the edge-triggered ++/-- counter with a DERIVED in-flight count over
// an authoritative task set. These tests prove the failure modes that permanently desync
// an accumulator are all benign here: duplicate events and out-of-order events. (A genuinely
// LOST terminal event with the CLI still alive is backstopped by process-death turn completion,
// not reconciled in-process — see the note at the end of this describe block.)
describe('Architecture resilience: derived count (no accumulator desync)', () => {
  const inFlight = (s: ClaudeCodeSession) => (s as unknown as { _runningBgCount(): number })._runningBgCount()

  it('duplicate task_started / task_notification never desync the derived count', () => {
    const sid = 'resilience-dup-events'
    const session = makeRunningRemoteSession('task-dup')
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'd1'),
      makeTaskStartedEvent(sid, 'd1'),        // duplicate start (daemon replay) — still 1
      makeTaskStartedEvent(sid, 'd2'),
    ])
    expect(inFlight(session)).toBe(2)          // an accumulator would read 3

    feedLines(session, [
      makeTaskNotificationEvent(sid, 'd1', 'completed'),
      makeTaskNotificationEvent(sid, 'd1', 'completed'),  // duplicate terminal — still idempotent
    ])
    expect(inFlight(session)).toBe(1)          // an accumulator would read -1/0 (desync)
    feedLines(session, [makeTaskNotificationEvent(sid, 'd2', 'completed')])
    expect(inFlight(session)).toBe(0)
    expect(session.hasActiveBackgroundWork()).toBe(false)
  })

  it('out-of-order: a late task_started/task_progress cannot revive a terminal task', () => {
    const sid = 'resilience-out-of-order'
    const session = makeRunningRemoteSession('task-ooo')
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'x1'),
      makeTaskNotificationEvent(sid, 'x1', 'completed'),
      // Reordered stragglers arriving AFTER terminal — must NOT resurrect the task.
      makeTaskStartedEvent(sid, 'x1'),
      makeTaskProgressEvent(sid, 'x1', { summary: 'late heartbeat' }),
    ])
    expect(inFlight(session)).toBe(0)
    expect(session.hasActiveBackgroundWork()).toBe(false)
  })

})

// ═══════════════════════════════════════════════════════════════════
//  Test 10: L2 — daemon-authoritative PULL reconcile (lost-terminal self-heal)
// ═══════════════════════════════════════════════════════════════════
//
// The disease Layer 1 could NOT cure: a terminal event genuinely LOST in transport (SSH flap /
// daemon-restart gap) while the CLI stays alive — the task set holds a phantom 'running' forever.
// The cure is the daemon (source of truth — it persisted every event in the append-only jsonl):
// reconcileFromDaemon() PULLs its task state and adopts any terminal status Walnut missed, WITHOUT
// guessing liveness. See docs/plan/daemon-source-of-truth-versioned-events.md.
describe('L2: daemon-authoritative PULL reconcile (reconcileFromDaemon)', () => {
  const inFlight = (s: ClaudeCodeSession) => (s as unknown as { _runningBgCount(): number })._runningBgCount()

  // Build a remote session whose transport exposes a getState() returning the given daemon truth.
  function makeSessionWithDaemonState(
    taskId: string,
    daemonTasks: Record<string, { status: string; v: number }>,
  ): ClaudeCodeSession {
    const session = makeRunningRemoteSession(taskId)
    const taskState = {
      tasks: Object.fromEntries(Object.entries(daemonTasks).map(([id, t]) => [id, { ...t, t: 0 }])),
      resourceVersion: Math.max(0, ...Object.values(daemonTasks).map(t => t.v)),
      updatedAt: 0,
      derivedRunning: Object.values(daemonTasks).filter(t => !['completed', 'failed', 'stopped', 'cancelled'].includes(t.status)).length,
      recentTransitions: [],
    }
    ;(session as unknown as { _transport: Record<string, unknown> })._transport.getState = async () => taskState
    return session
  }

  it('adopts a daemon-terminal status for a task Walnut still holds running (lost-terminal heal)', async () => {
    const sid = 'l2-lost-terminal'
    // Daemon (source of truth) says g2 completed; Walnut's live stream missed that notification.
    const session = makeSessionWithDaemonState('task-l2-lost', {
      g1: { status: 'completed', v: 100 },
      g2: { status: 'completed', v: 200 },
    })
    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })
    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Launching'),
      makeTaskStartedEvent(sid, 'g1'),
      makeTaskStartedEvent(sid, 'g2'),
      makeResultEvent(sid, 0.5, 'Workflow launched in background'),
      makeTaskNotificationEvent(sid, 'g1', 'completed'), // g1 delivered; g2's terminal LOST
      makeSessionStateEvent(sid, 'idle'),                // idle while g2 still 'running' locally
    ])
    // Pre-reconcile: g2 keeps us in flight, turn correctly withheld (no premature complete).
    expect(inFlight(session)).toBe(1)
    expect(resultEvents.length).toBe(0)

    // PULL the daemon truth → adopt g2=completed → withheld turn completes exactly once.
    await (session as unknown as { reconcileFromDaemon(): Promise<void> }).reconcileFromDaemon()
    expect(inFlight(session)).toBe(0)
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(resultEvents.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })

  it('leaves a task running when the daemon ALSO reports it running (no false heal)', async () => {
    const sid = 'l2-still-running'
    // Daemon agrees h1 is still running — reconcile must NOT complete the turn.
    const session = makeSessionWithDaemonState('task-l2-live', {
      h1: { status: 'running', v: 100 },
    })
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'h1'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(inFlight(session)).toBe(1)
    await (session as unknown as { reconcileFromDaemon(): Promise<void> }).reconcileFromDaemon()
    // Daemon confirms it's genuinely running → still in flight, turn stays open.
    expect(inFlight(session)).toBe(1)
    expect(session.hasActiveBackgroundWork()).toBe(true)
  })

  it('is a no-op when the transport cannot answer (getState returns null) — keeps local state', async () => {
    const sid = 'l2-no-answer'
    const session = makeRunningRemoteSession('task-l2-null')
    ;(session as unknown as { _transport: Record<string, unknown> })._transport.getState = async () => null
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'k1'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(inFlight(session)).toBe(1)
    // No authoritative answer (disconnected / old daemon) → do NOT guess, keep current state.
    await (session as unknown as { reconcileFromDaemon(): Promise<void> }).reconcileFromDaemon()
    expect(inFlight(session)).toBe(1)
    expect(session.hasActiveBackgroundWork()).toBe(true)
  })

  it('does NOT complete the turn while the CLI is still running (only when idle)', async () => {
    const sid = 'l2-cli-running'
    const session = makeSessionWithDaemonState('task-l2-cli', {
      r1: { status: 'completed', v: 100 },
    })
    const resultEvents: Array<Record<string, unknown>> = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
    })
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'r1'),
      makeSessionStateEvent(sid, 'running'), // CLI actively running, not idle
    ])
    await (session as unknown as { reconcileFromDaemon(): Promise<void> }).reconcileFromDaemon()
    // The task is reconciled to terminal (daemon truth), but the turn must NOT complete while the
    // CLI is mid-turn — completion only fires on an idle (the normal turn-over trigger).
    expect(inFlight(session)).toBe(0)
    expect(resultEvents.length).toBe(0)
  })

  // inc-1784012867247: reconcileFromDaemon() corrected `_bgTasks` in memory but never told
  // the browser — a "Background tasks 3/4" panel stayed pinned at a stale snapshot for 56+
  // minutes after every task had actually gone terminal, because nothing re-broadcast the
  // corrected set. This is the choke point: any adoption must re-emit.
  it('re-broadcasts SESSION_BACKGROUND_TASKS after adopting a daemon-authoritative correction', async () => {
    const sid = 'l2-rebroadcast'
    const session = makeSessionWithDaemonState('task-l2-rebroadcast', {
      z1: { status: 'completed', v: 100 },
    })
    const snapshots: Array<Record<string, unknown>> = []
    bus.subscribe('web-ui', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_BACKGROUND_TASKS) snapshots.push(e.data as Record<string, unknown>)
    })
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'z1'),
      makeSessionStateEvent(sid, 'running'),
    ])
    const preCorrectionCount = snapshots.length
    await (session as unknown as { reconcileFromDaemon(): Promise<void> }).reconcileFromDaemon()
    expect(snapshots.length).toBeGreaterThan(preCorrectionCount)
    const latest = snapshots[snapshots.length - 1]
    const tasks = latest.tasks as Array<{ taskId: string; status: string }>
    expect(tasks.find(t => t.taskId === 'z1')?.status).toBe('completed')
    expect(latest.inFlight).toBe(0)
  })

  // inc-1784012867247's actual failure mode: the lost-terminal task was `is_backgrounded`
  // (detached from turn-over gating), so hasActiveBackgroundWork()/_runningBgCount() already
  // read 0 for it — the exact condition isBackgroundWorkActive's callers use to decide
  // whether reconcileFromDaemon() is even worth calling. hasPendingBackgroundTasks() must see
  // it anyway (any non-terminal entry, backgrounded or not) or the session gets ZERO ticks
  // that ever PULL the daemon's authoritative state for it.
  it('hasPendingBackgroundTasks() stays true for a backgrounded (turn-detached) task with no terminal event yet', async () => {
    const sid = 'l2-backgrounded-pending'
    const session = makeRunningRemoteSession('task-l2-backgrounded')
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg1'),
      { type: 'system', subtype: 'task_updated', task_id: 'bg1', patch: { is_backgrounded: true } } as unknown as string,
    ].map(l => typeof l === 'string' ? l : JSON.stringify(l)))
    const s = session as unknown as { hasPendingBackgroundTasks(): boolean }
    expect(session.hasActiveBackgroundWork()).toBe(false) // backgrounded → excluded from turn-over gating
    expect(s.hasPendingBackgroundTasks()).toBe(true) // but still non-terminal → worth reconciling
  })

  it('hasPendingBackgroundTasks() is false once every task (including backgrounded) is terminal', async () => {
    const sid = 'l2-backgrounded-done'
    const session = makeRunningRemoteSession('task-l2-backgrounded-done')
    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg2'),
      JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'bg2', patch: { is_backgrounded: true } }),
      makeTaskNotificationEvent(sid, 'bg2', 'completed'),
    ])
    const s = session as unknown as { hasPendingBackgroundTasks(): boolean }
    expect(s.hasPendingBackgroundTasks()).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Regression: session_state_changed{running} persists process_status
//  to SQLite, not just the in-memory field.
//
//  A message injected directly into the daemon's FIFO (phone → EC2 bridge →
//  daemon, bypassing this class's own writeMessage()) only ever surfaces as a
//  session_state_changed{running} system event on the stream — there's no
//  other signal that a turn started. Before this fix, that branch updated
//  only this._processStatus and emitted a bus-only event; the SQLite record
//  stayed on whatever the PREVIOUS turn left behind (idle/error/stopped)
//  for the entire duration of the new turn, since the only other writer
//  (SESSION_RESULT/SESSION_ERROR) fires exclusively at turn-END.
// ═══════════════════════════════════════════════════════════════════

describe('session_state_changed{running} persists to session tracker', () => {
  it('flips the SQLite process_status from idle to running (not just in-memory)', async () => {
    const sid = 'wf-running-persist'
    const { importSessionRecord, getSessionByClaudeId } = await import('../../src/core/session-tracker.js')

    // Seed a tracker row left 'idle' by a prior turn — the exact stale state
    // a phone-injected message would otherwise be read against mid-turn.
    await importSessionRecord({
      claudeSessionId: sid,
      taskId: 'task-wf-running-persist',
      project: 'test-project',
    })

    const session = new ClaudeCodeSession('task-wf-running-persist', 'test-project')
    const transport = createMockTransport({ isRemote: true, hasPipe: true })
    ;(session as unknown as { _transport: unknown })._transport = transport
    ;(session as unknown as { _active: boolean })._active = true
    ;(session as unknown as { _processStatus: string })._processStatus = 'idle'

    feedLines(session, [
      makeInitEvent(sid),
      makeSessionStateEvent(sid, 'running'),
    ])

    expect(session.processStatus).toBe('running')

    // The tracker write is fire-and-forget (dynamic import + async write) —
    // give it a tick to land before reading back.
    await new Promise((r) => setTimeout(r, 200))

    const record = await getSessionByClaudeId(sid)
    expect(record).not.toBeNull()
    expect(record!.process_status).toBe('running')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  task_type passthrough — the UI splits background AGENTS from TASKS
// ═══════════════════════════════════════════════════════════════════

describe('task_type rides task_started into the SESSION_BACKGROUND_TASKS snapshot', () => {
  it('exposes taskType per task so the panel can group agents vs plain tasks', () => {
    const sid = 'wf-task-type'
    const session = makeRunningRemoteSession('task-type-passthrough')

    const snaps: Array<Record<string, unknown>> = []
    bus.subscribe('web-ui', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_BACKGROUND_TASKS) snaps.push(e.data as Record<string, unknown>)
    })

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'ag-1', { description: 'Explore repo', subagentType: 'Explore', taskType: 'local_agent' }),
      makeTaskStartedEvent(sid, 'sh-1', { description: 'npm run build', taskType: 'local_shell' }),
      // A recovered/legacy event with no task_type must still flow (field absent).
      makeTaskStartedEvent(sid, 'un-1', { description: 'mystery task' }),
    ])

    const tasks = snaps[snaps.length - 1]!.tasks as Array<Record<string, unknown>>
    const byId = new Map(tasks.map(t => [t.taskId, t]))
    expect(byId.get('ag-1')!.taskType).toBe('local_agent')
    expect(byId.get('sh-1')!.taskType).toBe('local_shell')
    expect(byId.get('un-1')!.taskType).toBeUndefined()

    // A later task_progress (which never carries task_type) must not clobber it.
    feedLines(session, [makeTaskProgressEvent(sid, 'ag-1', { tokens: 500 })])
    const after = (snaps[snaps.length - 1]!.tasks as Array<Record<string, unknown>>)
      .find(t => t.taskId === 'ag-1')!
    expect(after.taskType).toBe('local_agent')
    expect(after.tokens).toBe(500)
  })
})
