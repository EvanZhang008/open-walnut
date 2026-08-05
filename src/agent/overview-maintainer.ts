/**
 * Overview maintainer — the task-lifecycle learning hook.
 *
 * On task:created / task:completed (event bus), spawn a small maintainer agent
 * for the task's PROJECT, WITH REAL TOOLS (not a JSON-return contract):
 * - ALWAYS: append one progress entry to the project skill's history log
 *   (skill_manage log_append — rotation/naming stays 100% in code).
 * - WHEN WARRANTED: edit the project SKILL.md (direction/status changes).
 * - RARELY: create a new class-level skill (fires a UI notification, no
 *   confirmation gate — the maintainer doesn't know everything; some tasks
 *   reveal recurring work worth a skill).
 *
 * Gating (all in code, not the model):
 * - main tasks only (parent_task_id set → subtask → skip);
 * - task must have a non-empty project, and that project must already own a
 *   skill (resolved by name across the skill grouping dirs) — else skip silently;
 * - bulk sources (sync/reconcile/migration) never trigger;
 * - repeated events for the same task+phase are deduped;
 * - runs are serialized (one maintainer agent at a time).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../core/types.js';
import type { ToolDefinition } from './tools.js';
import { skillManageTool } from './tools/skill-manage-tool.js';
import { skillViewTool } from './tools/skill-view-tool.js';
import {
  appendSkillHistoryLog,
  resolveProjectSkillDir,
  skillDir,
  skillHistoryDir,
  type ProjectSkillLocation,
} from '../core/overview-log.js';
import { bus, EventNames, type BusEvent } from '../core/event-bus.js';
import { addNotification as addFeedNotification } from '../core/notifications/store.js';
import { usageTracker } from '../core/usage/index.js';
import { log } from '../logging/index.js';

const SUBSCRIBER = 'overview-maintainer';
/** Sources that bulk-import tasks — a hook storm, not real lifecycle events. */
const SKIP_SOURCE = /sync|reconcile|migration|plugin/i;
const DEDUP_CAP = 500;
const LOG_TAIL_CHARS = 3000;

const handled = new Set<string>();
let queueTail: Promise<void> = Promise.resolve();

export function resetMaintainerState(): void {
  handled.clear();
  queueTail = Promise.resolve();
}

function notifySkillCreated(skillName: string, category: string): void {
  const timestamp = Date.now();
  const title = `New skill: ${skillName}`;
  const body = `The overview maintainer created skill '${skillName}' (category: ${category}) from a task lifecycle event. Review it in Skills.`;
  bus.emit('skill:notification', { name: skillName, category, title, body, timestamp }, ['web-ui'], {
    source: 'task-hook',
  });
  void addFeedNotification({
    kind: 'skill', severity: 'success', title, body, timestamp,
    dedupKey: `skill:${skillName}:${timestamp}`,
  }).catch((err) => log.agent.warn('overview-maintainer: failed to persist skill notification', {
    skillName, error: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * The name skill_manage/skill_view use to address this project's skill — its
 * discovery key (bare dir name; `<category>/overview` only for overview skills).
 */
function skillManageName(location: ProjectSkillLocation): string {
  return location.name === 'overview'
    ? `${location.skillCategory}/${location.name}`
    : location.name;
}

/**
 * The maintainer's tool set: skill_manage restricted IN CODE to
 * log_append (forced to this project's skill) / patch/edit (that skill only) /
 * create (pass-through + notification), plus read-only skill_view.
 */
export function buildMaintainerTools(location: ProjectSkillLocation): ToolDefinition[] {
  // skill_manage addresses a skill by its DISCOVERY KEY, which for a project
  // skill is the bare directory name (only `overview` skills are keyed
  // `<category>/overview`). Passing `<category>/<name>` here made every
  // patch/edit fail with "skill not found".
  const skillKey = skillManageName(location);
  const wrappedSkillManage: ToolDefinition = {
    ...skillManageTool,
    async execute(params, meta) {
      const action = String(params.action ?? '');

      if (action === 'log_append') {
        const content = String(params.content ?? '').trim();
        if (!content) return 'Error: content is required for log_append.';
        try {
          // Target is forced — the maintainer only writes ITS project's log.
          const result = appendSkillHistoryLog(location.skillCategory, location.name, content, 'task-hook');
          return `Progress entry appended to ${location.name}'s history log${result.rotated ? ` (volume rotated: previous archived as ${result.archivedVolume})` : ''}. This update is complete — do not repeat it.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (action === 'patch' || action === 'edit') {
        if (params.name !== skillKey) {
          return `Error: the maintainer may only ${action} the '${skillKey}' skill. For other learnings, use create (rare) or leave them to the butler.`;
        }
        return skillManageTool.execute(params, meta);
      }

      if (action === 'create') {
        const result = await skillManageTool.execute(params, meta);
        if (typeof result === 'string' && /^Skill '.*' created/.test(result)) {
          notifySkillCreated(String(params.name ?? ''), String(params.category ?? location.skillCategory));
        }
        return result;
      }

      return `Error: action '${action}' is not available to the overview maintainer. Allowed: log_append (always), patch/edit of '${skillKey}' (when warranted), create (rare).`;
    },
  };
  return [wrappedSkillManage, skillViewTool];
}

const MAINTAINER_SYSTEM = `You are Walnut's overview maintainer — a small background agent that keeps one project's skill current. You run after task lifecycle events. You have real tools; your only writes go through them. Be brief and factual; never invent progress. Reply with ONE line summarizing what you did.`;

function trim(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}… [truncated]` : t;
}

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

export function buildMaintainerPrompt(task: Task, eventName: string, location: ProjectSkillLocation): string {
  const skillKey = skillManageName(location);
  const skillPath = `${location.skillCategory}/${location.name}`;
  const overview = readFileSafe(path.join(skillDir(location.skillCategory, location.name), 'SKILL.md'));
  const logRaw = readFileSafe(path.join(skillHistoryDir(location.skillCategory, location.name), 'log.md'));
  const logTail = logRaw.length > LOG_TAIL_CHARS ? `…${logRaw.slice(-LOG_TAIL_CHARS)}` : logRaw;
  const event = eventName === EventNames.TASK_COMPLETED ? 'completed' : 'created';

  const payload = [
    `- Title: ${task.title}`,
    `- Project: ${task.project || 'Inbox'}`,
    `- Status: ${task.status}  Phase: ${task.phase}`,
    task.description?.trim() ? `- Description: ${trim(task.description, 500)}` : '',
    task.summary?.trim() ? `- Summary: ${trim(task.summary, 500)}` : '',
    task.note?.trim() ? `- Note:\n${trim(task.note, 1200)}` : '',
    event === 'completed' && task.completed_at ? `- Completed at: ${task.completed_at}` : `- Created at: ${task.created_at}`,
  ].filter(Boolean).join('\n');

  return `[Task ${event}] in project "${location.name}".

## Task
${payload}

## Current project skill (skills/${skillPath}/SKILL.md)
${overview || '(empty)'}

## Recent progress log tail (history/log.md)
${logTail || '(no entries yet)'}

## Your job — in preference order
1. ALWAYS: append exactly ONE concise progress entry — skill_manage action=log_append, category="${location.skillCategory}", name="${location.name}". 1-3 sentences: what happened and why it matters. For a created task, note the new workstream; for a completed one, note the outcome. Don't restate what the log tail already says.
2. WHEN WARRANTED (most events are NOT): if this event materially changes the project's direction, status, or decisions (milestone done, workstream started/dropped), update the skill — skill_manage action=patch, name="${skillKey}" — a surgical edit that keeps it organized.
3. RARELY: if the task reveals a recurring CLASS of work no existing skill covers, create one — skill_manage action=create with a class-level name (never a task-specific artifact). The user is notified automatically; don't ask.
4. Never delete anything. When done, reply with one line.`;
}

export interface MaintainerRunOptions {
  system: string;
  tools: ToolDefinition[];
  source: string;
  maxToolRounds: number;
}

export type MaintainerRunner = (
  userMessage: string,
  options: MaintainerRunOptions,
) => Promise<{ response: string }>;

async function defaultRunner(userMessage: string, options: MaintainerRunOptions): Promise<{ response: string }> {
  const { runAgentLoop } = await import('./loop.js');
  const result = await runAgentLoop(userMessage, [], {
    onTextDelta: () => {},
    onUsage: (usage) => {
      try {
        usageTracker.record({
          source: 'task-hook',
          model: usage.model ?? 'unknown',
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          agentId: 'overview-maintainer',
        });
      } catch { /* non-critical */ }
    },
  }, {
    system: options.system,
    tools: options.tools,
    source: options.source,
    maxToolRounds: options.maxToolRounds,
  });
  return { response: result.response };
}

/**
 * All gating + serialized execution for one task lifecycle event.
 * Resolves when THIS task's maintainer run finishes (tests await it);
 * the bus handler calls it fire-and-forget.
 */
export async function maybeRunForTaskEvent(
  eventName: string,
  task: Task | undefined,
  source: string,
  runner: MaintainerRunner = defaultRunner,
): Promise<boolean> {
  if (!task?.id || !task.project?.trim()) return false; // Inbox has no project skill
  if (task.parent_task_id) return false; // subtasks never trigger
  if (SKIP_SOURCE.test(source)) return false;

  const dedupKey = `${eventName}:${task.id}`;
  if (handled.has(dedupKey)) return false;
  handled.add(dedupKey);
  if (handled.size > DEDUP_CAP) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }

  const location = resolveProjectSkillDir(task.project);
  if (!location) {
    log.agent.debug('overview-maintainer: no skill for project, skipping', {
      taskId: task.id, project: task.project,
    });
    return false;
  }

  // Serialize: one maintainer agent at a time; each run waits for the prior tail.
  const prior = queueTail;
  let done!: () => void;
  queueTail = new Promise<void>((resolve) => { done = resolve; });
  await prior;

  try {
    log.agent.info('overview-maintainer: running for task event', {
      taskId: task.id, event: eventName, project: location.name,
    });
    const prompt = buildMaintainerPrompt(task, eventName, location);
    const result = await runner(prompt, {
      system: MAINTAINER_SYSTEM,
      tools: buildMaintainerTools(location),
      source: 'task-hook',
      maxToolRounds: 8,
    });
    log.agent.info('overview-maintainer: run complete', {
      taskId: task.id, project: location.name, summary: result.response.slice(0, 200),
    });
    return true;
  } catch (err) {
    log.agent.warn('overview-maintainer: run failed', {
      taskId: task.id, project: location.name, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    done();
  }
}

/** Subscribe to task lifecycle events. Call once at server startup. */
export function startOverviewMaintainer(): void {
  bus.subscribe(SUBSCRIBER, (event: BusEvent) => {
    if (event.name !== EventNames.TASK_CREATED && event.name !== EventNames.TASK_COMPLETED) return;
    const task = (event.data as { task?: Task } | undefined)?.task;
    void maybeRunForTaskEvent(event.name, task, event.source).catch((err) => {
      log.agent.warn('overview-maintainer: handler error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, { global: true, interest: ['task:created', 'task:completed'] });
  log.agent.info('overview-maintainer: started');
}

export function stopOverviewMaintainer(): void {
  bus.unsubscribe(SUBSCRIBER);
  resetMaintainerState();
}
