/**
 * SubagentRunner — turns a subagent request into a REAL Claude Code session
 * running with that agent's persona.
 *
 * Listens on 'subagent-runner' for:
 *   - subagent:start → quickStartSession({ walnutAgent: true, agentId, … })
 *   - subagent:send  → performSessionSend to the session that run owns
 *
 * Emits:
 *   - subagent:started → ['main-ai']
 *   - subagent:error   → ['main-ai']
 *
 * A run IS a session: the run id is the session id the CLI adopts
 * (preassignedSessionId), so a run shows up in the session tree, streams
 * through the normal session pipeline, and its transcript is the session's own
 * JSONL. That identity is also why a `subagent:send` still lands after a server
 * restart even though this ledger is in-memory: the id resolves through the
 * session records on disk.
 *
 * The ledger therefore holds metadata only (which session/task a run created,
 * plus its status at launch). Turn-by-turn progress and completion live on the
 * session record, which every session surface already reads; nothing here
 * mirrors it.
 */

import { randomUUID } from 'node:crypto';
import { bus, EventNames, eventData } from '../core/event-bus.js';
import { quickStartSession } from '../core/sessions/quick-start.js';
import { resolveAskAgent, askProjectFor, type AskAgentRef } from '../core/sessions/ask-agent.js';
import { performSessionSend } from '../core/sessions/session-send-core.js';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { AgentRun } from '../core/types.js';

/** A tracked run: the AgentRun the dispatch tools read, plus the session it owns. */
type TrackedRun = AgentRun & {
  /** The session the run launched. Equal to `runId` (see the file header). */
  sessionId?: string;
  /** The task quickStartSession created for the run. */
  createdTaskId?: string;
};

/** Ledger cap. A run is ~200 bytes of metadata, but this process lives for
 *  weeks and a per-event hook can dispatch continuously, so the oldest entries
 *  are dropped once the map grows past this. Dropping one only loses the
 *  `subagent_list` row: the session and its task are on disk, and a send to the
 *  run id still resolves through them. */
const MAX_TRACKED_RUNS = 200;

export class SubagentRunner {
  readonly runs = new Map<string, TrackedRun>();

  /** In-flight LAUNCHES, not concurrent agents: each start is a whole-store
   *  read-modify-write (task create) plus a spawn, so a burst of hook-triggered
   *  dispatches is admitted a few at a time instead of convoying the task lock.
   *  The session itself is not counted — once spawned it is the session
   *  machinery's to schedule, and this runner never learns when it finishes. */
  private launching = 0;
  private launchQueue: Array<() => void> = [];
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 20) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  init(): void {
    bus.subscribe('subagent-runner', async (event) => {
      switch (event.name) {
        case EventNames.SUBAGENT_START:
          await this.handleStart(eventData<'subagent:start'>(event));
          break;

        case EventNames.SUBAGENT_SEND:
          await this.handleSend(eventData<'subagent:send'>(event));
          break;
      }
    });
    log.subagent.info('SubagentRunner initialized');
  }

  destroy(): void {
    this.runs.clear();
    this.launchQueue = [];
    this.launching = 0;
    bus.unsubscribe('subagent-runner');
  }

  getAllRuns(): AgentRun[] {
    return Array.from(this.runs.values()).map(({ sessionId: _sessionId, createdTaskId: _createdTaskId, ...run }) => run);
  }

  getRun(runId: string): TrackedRun | undefined {
    return this.runs.get(runId);
  }

  /** Stop the turns of runs still live for a task, optionally one agent's only.
   *  Interrupt (not kill): the run's session stays in the tree with its
   *  transcript, exactly like the composer's stop button, so a stale dispatch
   *  cannot keep writing while the human works on the same task. */
  cancelRunsForTask(taskId: string, agentId?: string): number {
    let cancelled = 0;
    for (const run of this.runs.values()) {
      if (run.taskId !== taskId) continue;
      if (agentId && run.agentId !== agentId) continue;
      if (run.status !== 'running' && run.status !== 'queued') continue;
      run.status = 'error';
      run.error = 'cancelled';
      run.completedAt = new Date().toISOString();
      cancelled++;
      if (run.sessionId) {
        bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: run.sessionId }, ['session-runner'], { source: 'subagent-runner' });
      }
      log.subagent.info('cancelled run for task', { runId: run.runId, agentId: run.agentId, taskId });
    }
    return cancelled;
  }

  // ── Private ──

  private async handleStart(data: {
    agentId?: string;
    task: string;
    taskId?: string;
    model?: string;
    context?: string;
  }): Promise<void> {
    const requestedId = data.agentId?.trim() || 'general';
    // Resolved here rather than left to quickStartSession so an unknown id is a
    // subagent:error the dispatcher's caller can read, and so the run's title
    // and project can use the agent's name.
    let agent: AskAgentRef | undefined;
    try {
      agent = await resolveAskAgent(requestedId);
    } catch (err) {
      this.emitStartError(requestedId, data, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!agent) {
      this.emitStartError(requestedId, data, `Agent "${requestedId}" not found.`);
      return;
    }

    // The run id IS the session id the CLI adopts (see the file header).
    const runId = randomUUID();
    const title = `${agent.name}: ${data.task.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
    // A hook run files next to the work that triggered it; a dispatch with no
    // task goes to the agent's own "Ask …" project.
    const project = (data.taskId ? await taskProject(data.taskId) : undefined) ?? askProjectFor(agent);

    const run: TrackedRun = {
      runId,
      agentId: agent.id,
      task: data.task,
      taskId: data.taskId,
      runner: 'cli',
      status: 'queued',
      startedAt: new Date().toISOString(),
      sessionId: runId,
    };
    this.trackRun(run);
    log.subagent.info('run queued', { runId, agentId: agent.id, taskId: data.taskId, task: data.task.slice(0, 100) });

    await this.acquireLaunchSlot();
    try {
      const task = await quickStartSession({
        message: launchMessage(data),
        cwd: WALNUT_HOME,
        // The persona bundle (system prompt + standing memory + skills index +
        // walnut MCP mount) rides this flag — without it the session would spawn
        // as a bare coding agent with no idea whose run it is.
        walnutAgent: true,
        agentId: agent.id,
        taskTitle: title,
        project,
        // Background automation, same call as a routine: an explicit null keeps
        // every dispatch off the pinned board.
        taskMeta: { pinTier: null },
        preassignedSessionId: runId,
        ...(data.model ? { model: data.model } : {}),
        source: 'subagent',
      });
      run.status = 'running';
      run.createdTaskId = task.id;
      log.subagent.info('run started', {
        runId, agentId: agent.id, sessionId: runId, taskId: data.taskId, createdTaskId: task.id,
      });
      bus.emit(EventNames.SUBAGENT_STARTED, {
        runId,
        agentId: agent.id,
        agentName: agent.name,
        task: data.task,
        taskId: data.taskId,
      }, ['main-ai'], { source: 'subagent-runner' });
    } catch (err) {
      run.status = 'error';
      run.completedAt = new Date().toISOString();
      // QuickStartError's message is the caller-facing one (unknown agent,
      // rejected project); anything else is a real fault and says so.
      run.error = err instanceof Error ? err.message : String(err);
      // skipNotify: server.ts's subagent:error handler publishes the richer
      // 'Subagent Error' notification (task ref + deep links) for this failure.
      log.subagent.error('run error', { runId, agentId: agent.id, error: run.error, skipNotify: true });
      bus.emit(EventNames.SUBAGENT_ERROR, {
        runId,
        agentId: agent.id,
        task: data.task,
        taskId: data.taskId,
        error: run.error,
      }, ['main-ai'], { source: 'subagent-runner' });
    } finally {
      this.releaseLaunchSlot();
    }
  }

  private async handleSend(data: { runId: string; message: string }): Promise<void> {
    const run = this.runs.get(data.runId);
    // Fall back to the run id itself: it IS a session id, so a send after a
    // server restart (empty ledger) still reaches the right session.
    const target = run?.sessionId ?? data.runId;
    try {
      const result = await performSessionSend({
        to: target,
        text: data.message,
        // Nowhere to route a reply to — this dispatcher is not a session.
        expectReply: false,
      });
      log.subagent.info('run message delivered', {
        runId: data.runId, sessionId: result.targetSessionId, delivery: result.delivery,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.subagent.warn('run message failed', { runId: data.runId, error: message });
      bus.emit(EventNames.SUBAGENT_ERROR, {
        runId: data.runId,
        ...(run ? { agentId: run.agentId, taskId: run.taskId } : {}),
        error: message,
      }, ['main-ai'], { source: 'subagent-runner' });
    }
  }

  private emitStartError(
    agentId: string,
    data: { task: string; taskId?: string },
    error: string,
  ): void {
    log.subagent.warn('run rejected', { agentId, error, skipNotify: true });
    bus.emit(EventNames.SUBAGENT_ERROR, {
      agentId,
      error,
      task: data.task,
      taskId: data.taskId,
    }, ['main-ai'], { source: 'subagent-runner' });
  }

  private trackRun(run: TrackedRun): void {
    this.runs.set(run.runId, run);
    if (this.runs.size <= MAX_TRACKED_RUNS) return;
    // Insertion order is launch order, so the first keys are the oldest runs.
    for (const key of this.runs.keys()) {
      if (this.runs.size <= MAX_TRACKED_RUNS) break;
      if (key === run.runId) continue;
      this.runs.delete(key);
    }
  }

  // ── Launch slots ──

  private acquireLaunchSlot(): Promise<void> {
    if (this.launching < this.maxConcurrent) {
      this.launching++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.launchQueue.push(() => {
        this.launching++;
        resolve();
      });
    });
  }

  private releaseLaunchSlot(): void {
    this.launching--;
    const next = this.launchQueue.shift();
    if (next) next();
  }
}

/** The trigger task's project, or undefined when there is no readable task. */
async function taskProject(taskId: string): Promise<string | undefined> {
  try {
    const { getTask } = await import('../core/task-manager.js');
    const task = await getTask(taskId);
    return task.project || undefined;
  } catch {
    return undefined;
  }
}

/** The first message the session receives: the caller's extra context, then the
 *  prompt. The agent's task-scoped context sources need a task id the persona
 *  builder does not take, so the trigger task is NAMED here and the session
 *  reads it through the CLI instead. */
function launchMessage(data: { task: string; taskId?: string; context?: string }): string {
  const parts: string[] = [];
  if (data.taskId) {
    parts.push(`Triggering task: ${data.taskId} (read it with \`walnut tools call task_get '{"id":"${data.taskId}"}'\`).`);
  }
  if (data.context?.trim()) parts.push(data.context.trim());
  parts.push(data.task);
  return parts.join('\n\n');
}

// ── Singleton ──

export const subagentRunner = new SubagentRunner();
