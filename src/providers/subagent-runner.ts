/**
 * SubagentRunner — event-bus subscriber that manages embedded subagent runs.
 *
 * Listens on 'subagent-runner' for:
 *   - subagent:start → resolve agent definition, acquire semaphore, run embedded loop
 *   - subagent:send  → resume an existing run with new message
 *
 * Emits:
 *   - subagent:started → ['main-ai']
 *   - subagent:result  → ['main-ai']
 *   - subagent:error   → ['main-ai']
 *
 * Phase 1 — Session UI Parity:
 *   - Creates a SessionRecord (provider='embedded') for each run
 *   - Writes JSONL history to ~/.walnut/sessions/streams/embedded-{runId}.jsonl
 *   - Emits session:text-delta, session:tool-use, session:tool-result events
 *   - Updates SessionRecord on completion/error
 *   → Embedded sessions appear in the session tree and stream in real-time
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bus, EventNames, eventData } from '../core/event-bus.js';
import { TRIAGE_AGENTS as TRIAGE_AGENT_IDS } from '../core/session-tracker.js';
import { getAgent } from '../core/agent-registry.js';
import { getConfig } from '../core/config-manager.js';
import { buildSubagentSystemPrompt, buildSubagentToolSet } from '../agent/subagent-context.js';
import { buildStatefulMemorySection, extractMemoryUpdate } from '../agent/stateful-memory.js';
import { buildFilteredSkillsPrompt } from '../core/skill-loader.js';
import { loadContextSources } from '../agent/context-sources.js';
import { getProjectMemory, appendProjectMemory, updateProjectSummary } from '../core/project-memory.js';
import { SESSION_STREAMS_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { usageTracker } from '../core/usage/index.js';
import type { AgentDefinition, AgentRun } from '../core/types.js';
import type { MessageParam } from '../agent/model.js';

// ── Embedded JSONL Writer ──

/**
 * Append-only JSONL writer that produces the same format as CLI sessions.
 * This enables readSessionHistory() and SessionChatHistory to render
 * embedded sessions without any modification.
 */
class EmbeddedJsonlWriter {
  private msgCounter = 0;

  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  writeInit(sessionId: string): void {
    this.appendLine({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  writeUserMessage(text: string): void {
    const id = `user-${++this.msgCounter}`;
    this.appendLine({
      type: 'user',
      uuid: id,
      timestamp: new Date().toISOString(),
      message: { id, role: 'user', content: text },
    });
  }

  writeAssistantText(text: string, model?: string): void {
    const id = `asst-${++this.msgCounter}`;
    this.appendLine({
      type: 'assistant',
      uuid: id,
      timestamp: new Date().toISOString(),
      message: {
        id,
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
      },
    });
  }

  writeToolUse(toolName: string, toolUseId: string, input: unknown, model?: string): void {
    const id = `asst-tool-${++this.msgCounter}`;
    this.appendLine({
      type: 'assistant',
      uuid: id,
      timestamp: new Date().toISOString(),
      message: {
        id,
        role: 'assistant',
        model,
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      },
    });
  }

  writeToolResult(toolUseId: string, result: string): void {
    const id = `tool-result-${++this.msgCounter}`;
    this.appendLine({
      type: 'user',
      uuid: id,
      timestamp: new Date().toISOString(),
      message: {
        id,
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
      },
    });
  }

  writeResult(usage: { input_tokens: number; output_tokens: number }): void {
    this.appendLine({
      type: 'result',
      timestamp: new Date().toISOString(),
      usage,
    });
  }

  private appendLine(obj: unknown): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(obj) + '\n');
    } catch (err) {
      log.subagent.warn('failed to write JSONL', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Semaphore ──

interface Semaphore {
  active: number;
  max: number;
  queue: Array<() => void>;
}

// ── SubagentRunner ──

export class SubagentRunner {
  readonly runs = new Map<string, AgentRun & { _history?: MessageParam[] }>();
  private semaphore: Semaphore;

  constructor(maxConcurrent = 20) {
    this.semaphore = { active: 0, max: maxConcurrent, queue: [] };
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
    this.semaphore.queue = [];
    bus.unsubscribe('subagent-runner');
  }

  getAllRuns(): AgentRun[] {
    return Array.from(this.runs.values()).map(({ _history, ...run }) => run);
  }

  getRun(runId: string): (AgentRun & { _history?: MessageParam[] }) | undefined {
    return this.runs.get(runId);
  }

  // ── Private ──

  private async handleStart(data: {
    agentId?: string;
    task: string;
    taskId?: string;
    model?: string;
    region?: string;
    deniedTools?: string[];
    context?: string;
    context_override?: { taskId?: string; sessionId?: string };
  }): Promise<void> {
    const agentId = data.agentId ?? 'general';
    const agentDef = await getAgent(agentId);
    if (!agentDef) {
      bus.emit(EventNames.SUBAGENT_ERROR, {
        error: `Agent "${agentId}" not found.`,
        task: data.task,
        taskId: data.taskId,
      }, ['main-ai'], { source: 'subagent-runner' });
      return;
    }

    const runId = randomBytes(8).toString('hex');
    const config = await getConfig();
    const subagentConfig = config.agent?.subagent;

    const model = data.model ?? agentDef.model ?? subagentConfig?.model ?? config.agent?.model;
    const region = data.region ?? agentDef.region ?? subagentConfig?.region ?? config.agent?.region;
    const maxTokens = agentDef.max_tokens ?? subagentConfig?.max_tokens ?? config.agent?.maxTokens;
    const maxToolRounds = agentDef.max_tool_rounds ?? subagentConfig?.max_tool_rounds ?? 10;

    const run: AgentRun & { _history?: MessageParam[] } = {
      runId,
      agentId,
      task: data.task,
      taskId: data.taskId,
      runner: 'embedded',
      status: 'queued',
      startedAt: new Date().toISOString(),
      _history: [],
    };
    this.runs.set(runId, run);

    log.subagent.info('run queued', { runId, agentId, taskId: data.taskId, task: data.task.slice(0, 100) });

    // ── Create SessionRecord for UI visibility ──
    let taskProject = 'embedded';
    if (data.taskId) {
      try {
        const { getTask } = await import('../core/task-manager.js');
        const task = await getTask(data.taskId);
        taskProject = task.project || task.category || 'embedded';
      } catch {
        // Task may not exist — use default
      }
    }

    const title = `${agentDef.name}: ${data.task.slice(0, 80)}`;
    try {
      const { createSessionRecord } = await import('../core/session-tracker.js');
      await createSessionRecord(runId, data.taskId ?? '', taskProject, process.cwd(), {
        provider: 'embedded',
        title,
        mode: 'default',
      });
    } catch (err) {
      log.subagent.warn('failed to create session record for embedded run', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Link non-triage embedded sessions to task.session_ids so they appear in the UI.
    // Uses addSessionToHistory (not linkSessionSlot) to avoid occupying the exec slot,
    // which would block CLI sessions from starting.
    // Triage sessions (turn-complete-triage, message-send-triage) are high-volume
    // housekeeping and remain hidden — accessible via triage history instead.
    if (data.taskId && !TRIAGE_AGENT_IDS.has(agentId)) {
      try {
        const { addSessionToHistory } = await import('../core/task-manager.js');
        await addSessionToHistory(data.taskId, runId);
      } catch {
        // Task may not exist or link may fail — non-fatal
      }
    }

    // Emit session:started for UI
    bus.emit(EventNames.SESSION_STARTED, {
      sessionId: runId,
      taskId: data.taskId,
      project: taskProject,
      title,
      provider: 'embedded',
    }, ['*'], { source: 'subagent-runner' });

    // Emit started event — routed to main-ai for agent loop awareness
    bus.emit(EventNames.SUBAGENT_STARTED, {
      runId,
      agentId,
      agentName: agentDef.name,
      task: data.task,
      taskId: data.taskId,
    }, ['main-ai'], { source: 'subagent-runner' });

    await this.acquireSemaphore();
    run.status = 'running';
    log.subagent.info('run starting', { runId, agentId, semaphoreActive: this.semaphore.active, semaphoreMax: this.semaphore.max });

    this.runEmbedded(run, agentDef, data, { model, region, maxTokens, maxToolRounds }).catch((err) => {
      log.subagent.error('embedded run failed', { runId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  private async runEmbedded(
    run: AgentRun & { _history?: MessageParam[] },
    agentDef: AgentDefinition,
    data: { task: string; taskId?: string; deniedTools?: string[]; context?: string; context_override?: { taskId?: string; sessionId?: string } },
    opts: { model?: string; region?: string; maxTokens?: number; maxToolRounds: number; resume?: boolean },
  ): Promise<void> {
    const isResume = opts.resume === true;

    // ── JSONL writer for session history ──
    const jsonlPath = path.join(SESSION_STREAMS_DIR, `embedded-${run.runId}.jsonl`);
    const jsonl = new EmbeddedJsonlWriter(jsonlPath);
    // On resume, skip init (file already has init line) — just append user message
    if (!isResume) {
      jsonl.writeInit(run.runId);
    }
    jsonl.writeUserMessage(data.task);

    try {
      // Load context sources (task details, project memory, etc.) based on agent definition
      const contextSourcesInput = data.context_override ?? { taskId: data.taskId };
      const contextBlock = await loadContextSources(agentDef, contextSourcesInput);
      const combinedContext = [contextBlock, data.context].filter(Boolean).join('\n\n');
      log.subagent.info('context loaded', { runId: run.runId, taskId: data.taskId, contextLength: combinedContext.length });
      let systemPrompt = buildSubagentSystemPrompt(agentDef, data.task, combinedContext || undefined);
      const toolSet = await buildSubagentToolSet(agentDef, data.deniedTools);

      // Resolve {auto} token in stateful memory_project path
      const resolvedStateful = agentDef.stateful ? { ...agentDef.stateful } : undefined;
      if (resolvedStateful?.memory_project?.includes('{auto}') && data.taskId) {
        try {
          const { getTask } = await import('../core/task-manager.js');
          const task = await getTask(data.taskId);
          const autoPath = `${task.category.toLowerCase()}/${task.project.toLowerCase()}`;
          resolvedStateful.memory_project = resolvedStateful.memory_project.replace('{auto}', autoPath);
        } catch (err) {
          log.subagent.warn('failed to resolve {auto} in memory_project', {
            runId: run.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Inject selected skills into system prompt
      if (agentDef.skills?.length) {
        try {
          const skillsPrompt = await buildFilteredSkillsPrompt(agentDef.skills);
          if (skillsPrompt) {
            systemPrompt += '\n\n' + skillsPrompt;
          }
        } catch (err) {
          log.subagent.warn('failed to build skills prompt', {
            runId: run.runId,
            skills: agentDef.skills,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (resolvedStateful) {
        const memory = getProjectMemory(resolvedStateful.memory_project);
        systemPrompt += '\n\n' + buildStatefulMemorySection(memory, resolvedStateful);
      }

      const { runAgentLoop } = await import('../agent/loop.js');
      const totalUsage = { input_tokens: 0, output_tokens: 0 };
      let lastToolUseId = '';

      log.subagent.info('embedded loop starting', { runId: run.runId, agentId: run.agentId, model: opts.model, maxRounds: opts.maxToolRounds });
      const result = await runAgentLoop(data.task, run._history ?? [], {
        onText: (text) => {
          jsonl.writeAssistantText(text, opts.model);
          bus.emit(EventNames.SESSION_TEXT_DELTA, {
            sessionId: run.runId,
            delta: text,
          }, ['*'], { source: 'subagent-runner' });
          this.updateSessionLastActive(run.runId);
        },
        onToolCall: (toolName, input) => {
          lastToolUseId = `toolu_emb_${randomBytes(6).toString('hex')}`;
          jsonl.writeToolUse(toolName, lastToolUseId, input, opts.model);
          bus.emit(EventNames.SESSION_TOOL_USE, {
            sessionId: run.runId,
            toolUseId: lastToolUseId,
            toolName,
            input,
          }, ['*'], { source: 'subagent-runner' });
          this.updateSessionActivity(run.runId, toolName);
        },
        onToolResult: (_toolName, resultText) => {
          const toolUseId = lastToolUseId;
          jsonl.writeToolResult(toolUseId, resultText);
          bus.emit(EventNames.SESSION_TOOL_RESULT, {
            sessionId: run.runId,
            toolUseId,
            result: resultText.slice(0, 2000),
          }, ['*'], { source: 'subagent-runner' });
        },
        onUsage: (usage) => {
          if (usage.input_tokens) totalUsage.input_tokens += usage.input_tokens;
          if (usage.output_tokens) totalUsage.output_tokens += usage.output_tokens;
          try { usageTracker.record({ source: 'subagent', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, runId: run.runId, taskId: data.taskId, parent_source: 'agent' }); } catch {}
        },
      }, {
        system: systemPrompt,
        tools: toolSet,
        modelConfig: {
          model: opts.model,
          region: opts.region,
          maxTokens: opts.maxTokens,
        },
        maxToolRounds: opts.maxToolRounds,
        source: 'subagent',
      });

      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      run.result = result.response;
      run.usage = totalUsage;
      run._history = result.messages;
      log.subagent.info('embedded loop completed', { runId: run.runId, agentId: run.agentId, responseLength: result.response.length, usage: totalUsage });

      jsonl.writeResult(totalUsage);

      // Update SessionRecord on completion
      try {
        const { updateSessionRecord } = await import('../core/session-tracker.js');
        await updateSessionRecord(run.runId, {
          process_status: 'stopped',
          work_status: 'agent_complete',
          activity: undefined,
          last_status_change: new Date().toISOString(),
        });
      } catch (err) {
        log.subagent.warn('failed to update session record on completion', {
          runId: run.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Route only to main-ai (not ['*']) — prevents web-ui subscriber from
      // broadcasting the full result to browsers, which would bypass compact
      // triage summary logic in the main-ai handler.
      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: run.runId,
        taskId: data.taskId,
        result: result.response.slice(0, 2000),
        usage: totalUsage,
      }, ['main-ai'], { source: 'subagent-runner' });

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: run.runId,
        taskId: data.taskId,
        process_status: 'stopped',
        work_status: 'agent_complete',
      }, ['*'], { source: 'subagent-runner', urgency: 'urgent' });

      // Notify UI to clear optimistic messages (the turn consumed 1 queued message)
      if (isResume) {
        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId: run.runId,
          count: 1,
        }, ['*'], { source: 'subagent-runner' });
      }

      // If stateful: persist memory update (use resolvedStateful for {auto}-resolved path)
      if (resolvedStateful && result.response) {
        try {
          const memoryUpdate = extractMemoryUpdate(result.response);
          if (memoryUpdate) {
            updateProjectSummary(resolvedStateful.memory_project, agentDef.name, memoryUpdate);
          }
          appendProjectMemory(
            resolvedStateful.memory_project,
            result.response.slice(0, 500),
            resolvedStateful.memory_source ?? agentDef.id,
          );
          log.subagent.info('stateful memory updated', { runId: run.runId, memoryProject: resolvedStateful.memory_project });
        } catch (err) {
          log.subagent.warn('stateful memory update failed', {
            runId: run.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.subagent.info('run completed', {
        runId: run.runId,
        agentId: run.agentId,
        usage: totalUsage,
        responseLength: result.response.length,
      });

      log.subagent.info('subagent result emitted', { runId: run.runId, sessionId: run.runId, taskId: data.taskId });
      bus.emit(EventNames.SUBAGENT_RESULT, {
        runId: run.runId,
        agentId: run.agentId,
        agentName: agentDef.name,
        task: data.task,
        taskId: data.taskId,
        result: result.response,
        usage: totalUsage,
      }, ['main-ai'], { source: 'subagent-runner' });
    } catch (err) {
      run.status = 'error';
      run.completedAt = new Date().toISOString();
      run.error = err instanceof Error ? err.message : String(err);

      log.subagent.error('run error', { runId: run.runId, error: run.error });

      // Update SessionRecord on error
      try {
        const { updateSessionRecord } = await import('../core/session-tracker.js');
        await updateSessionRecord(run.runId, {
          process_status: 'stopped',
          work_status: 'error',
          activity: undefined,
          last_status_change: new Date().toISOString(),
        });
      } catch {}

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: run.runId,
        taskId: data.taskId,
        process_status: 'stopped',
        work_status: 'error',
      }, ['*'], { source: 'subagent-runner', urgency: 'urgent' });

      // Clear optimistic messages on error too
      if (isResume) {
        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId: run.runId,
          count: 1,
        }, ['*'], { source: 'subagent-runner' });
      }

      bus.emit(EventNames.SUBAGENT_ERROR, {
        runId: run.runId,
        agentId: run.agentId,
        task: data.task,
        taskId: data.taskId,
        error: run.error,
      }, ['main-ai'], { source: 'subagent-runner' });
    } finally {
      this.releaseSemaphore();
    }
  }

  private async handleSend(data: { runId: string; message: string }): Promise<void> {
    const run = this.runs.get(data.runId);
    if (!run) {
      bus.emit(EventNames.SUBAGENT_ERROR, {
        runId: data.runId,
        error: `No run found for ID: ${data.runId}`,
      }, ['main-ai'], { source: 'subagent-runner' });
      return;
    }

    const agentDef = await getAgent(run.agentId);
    if (!agentDef) {
      bus.emit(EventNames.SUBAGENT_ERROR, {
        runId: data.runId,
        error: `Agent "${run.agentId}" not found.`,
      }, ['main-ai'], { source: 'subagent-runner' });
      return;
    }

    const config = await getConfig();
    const subagentConfig = config.agent?.subagent;

    const model = agentDef.model ?? subagentConfig?.model ?? config.agent?.model;
    const region = agentDef.region ?? subagentConfig?.region ?? config.agent?.region;
    const maxTokens = agentDef.max_tokens ?? subagentConfig?.max_tokens ?? config.agent?.maxTokens;
    const maxToolRounds = agentDef.max_tool_rounds ?? subagentConfig?.max_tool_rounds ?? 10;

    run.status = 'running';
    log.subagent.info('resuming run', { runId: data.runId, agentId: run.agentId, taskId: run.taskId, messageLength: data.message.length });

    // Update session record back to running
    try {
      const { updateSessionRecord } = await import('../core/session-tracker.js');
      await updateSessionRecord(data.runId, {
        process_status: 'running',
        work_status: 'in_progress',
        last_status_change: new Date().toISOString(),
      });
    } catch {}

    // Notify UI that the queued message has been picked up
    bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
      sessionId: data.runId,
      count: 1,
    }, ['*'], { source: 'subagent-runner' });

    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: data.runId,
      taskId: run.taskId,
      process_status: 'running',
      work_status: 'in_progress',
    }, ['*'], { source: 'subagent-runner', urgency: 'urgent' });

    await this.acquireSemaphore();

    this.runEmbedded(run, agentDef, {
      task: data.message,
      taskId: run.taskId,
    }, { model, region, maxTokens, maxToolRounds, resume: true }).catch((err) => {
      log.subagent.error('resume run failed', { runId: data.runId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  // ── Session record helpers (fire-and-forget, throttled) ──

  private lastActiveFlush = new Map<string, number>();
  private static readonly LAST_ACTIVE_THROTTLE_MS = 5_000;

  private updateSessionLastActive(runId: string): void {
    const now = Date.now();
    const last = this.lastActiveFlush.get(runId) ?? 0;
    if (now - last < SubagentRunner.LAST_ACTIVE_THROTTLE_MS) return;
    this.lastActiveFlush.set(runId, now);

    import('../core/session-tracker.js').then(({ updateSessionRecord }) => {
      updateSessionRecord(runId, { lastActiveAt: new Date().toISOString() }).catch(() => {});
    }).catch(() => {});
  }

  private updateSessionActivity(runId: string, toolName: string): void {
    this.lastActiveFlush.set(runId, Date.now());

    import('../core/session-tracker.js').then(({ updateSessionRecord }) => {
      updateSessionRecord(runId, {
        activity: toolName,
        lastActiveAt: new Date().toISOString(),
      }).catch(() => {});
    }).catch(() => {});
  }

  // ── Semaphore ──

  private acquireSemaphore(): Promise<void> {
    if (this.semaphore.active < this.semaphore.max) {
      this.semaphore.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.semaphore.queue.push(() => {
        this.semaphore.active++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.semaphore.active--;
    const next = this.semaphore.queue.shift();
    if (next) next();
  }
}

// ── Singleton ──

export const subagentRunner = new SubagentRunner();
