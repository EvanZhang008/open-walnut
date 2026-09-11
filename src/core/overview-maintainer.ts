/**
 * Overview maintainer — the task-lifecycle learning hook.
 *
 * On task:created / task:completed (event bus), ask the model ONE question about
 * the task's PROJECT and apply its answer in code:
 * - ALWAYS: append one progress entry to the project skill's history log
 *   (rotation/naming stays 100% in code, see overview-log.ts).
 * - WHEN WARRANTED: replace the project SKILL.md body (direction/status changes).
 * - RARELY: create a new class-level skill (fires a UI notification, no
 *   confirmation gate — some tasks reveal recurring work worth a skill).
 *
 * ONE-SHOT, NOT A TOOL LOOP: the model answers with a single JSON object and
 * every write happens here, so a malformed or truncated answer writes NOTHING
 * instead of half-applying itself. The three writes below are exactly what the
 * old tool set allowed; no other file can be touched from an answer.
 *
 * Gating (all in code, not the model):
 * - main tasks only (parent_task_id set → subtask → skip);
 * - task must have a non-empty project, and that project must already own a
 *   skill (resolved by name across the skill grouping dirs) — else skip silently;
 * - bulk sources (sync/reconcile/migration) never trigger;
 * - repeated events for the same task+phase are deduped;
 * - runs are serialized (one maintainer run at a time).
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Task } from './types.js';
import {
  appendSkillHistoryLog,
  resolveProjectSkillDir,
  skillDir,
  skillHistoryDir,
  type ProjectSkillLocation,
} from './overview-log.js';
import { getSkill, createSkill, updateSkill } from './skill-store.js';
import { recordSkillCreated, recordSkillPatched } from './skill-usage.js';
import { screenSkillWrite } from './memory-safety.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import { addNotification as addFeedNotification } from './notifications/store.js';
import { usageTracker, type UsageSource } from './usage/index.js';
import { log } from '../logging/index.js';

const SUBSCRIBER = 'overview-maintainer';
/** Sources that bulk-import tasks — a hook storm, not real lifecycle events. */
const SKIP_SOURCE = /sync|reconcile|migration|plugin/i;
const DEDUP_CAP = 500;
const LOG_TAIL_CHARS = 3000;

/** One progress entry is 1-3 sentences; anything longer is the model dumping
 *  the whole task into the log, which is what the curated SKILL.md is for. */
const MAX_LOG_CHARS = 2000;
/** A full SKILL.md body. Past this the answer is not a project doc any more. */
const MAX_SKILL_CHARS = 60_000;
/**
 * A rewrite may shrink the doc (that is what "keep it organized" means) but not
 * collapse it: below this fraction of the current body the answer is a summary
 * or a truncation, and applying it would silently destroy the project's history.
 */
const MIN_SKILL_KEEP_RATIO = 0.5;
/** The routing signal in the skill index — same hard limit the index assumes. */
const MAX_SKILL_DESC_CHARS = 60;
/** Ceiling for one maintainer answer. A full SKILL.md rewrite needs room. */
const MAINTAINER_MAX_TOKENS = 8000;
/** A background hook must never hold the model call open indefinitely. */
const MAINTAINER_TIMEOUT_MS = 120_000;

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
 * The name the skill store addresses this project's skill by — its discovery
 * key (bare dir name; `<category>/overview` only for overview skills).
 */
function skillManageName(location: ProjectSkillLocation): string {
  return location.name === 'overview'
    ? `${location.skillCategory}/${location.name}`
    : location.name;
}

/** Sweep the file kinds into the search index (best-effort, background) so a
 *  just-written skill is findable without waiting for the periodic sweep. */
function refreshSkillIndex(): void {
  void import('./search/wiring.js')
    .then(({ isSearchV2Enabled, sweepSearchV2Files }) => {
      if (isSearchV2Enabled()) return sweepSearchV2Files();
    })
    .catch((err) => log.agent.debug('overview-maintainer: search index refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    }));
}

/** Extract the raw frontmatter object from a SKILL.md (empty when absent/invalid). */
function parseRawFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1]);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The body after the frontmatter — what a rewrite replaces and is sized against. */
function skillBody(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match ? match[1] : raw).trim();
}

function buildSkillMd(opts: {
  name: string;
  description: string;
  type: 'action' | 'knowledge';
  content: string;
  /** Existing frontmatter to merge (preserves category override, custom keys). */
  base?: Record<string, unknown>;
}): string {
  const fm = yaml.dump(
    { ...(opts.base ?? {}), name: opts.name, description: opts.description, type: opts.type },
    { lineWidth: 120 },
  );
  return `---\n${fm}---\n\n${opts.content.trim()}\n`;
}

const MAINTAINER_SYSTEM = `You are Walnut's overview maintainer — a small background job that keeps one project's skill current. You run after task lifecycle events. You do not act; you answer with ONE JSON object and the caller performs every write. Be brief and factual; never invent progress.`;

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

## Your answer
Reply with ONE JSON object and nothing else (no prose, no explanation):

{
  "log": "required, 1-3 sentences",
  "skill": "optional, the FULL new SKILL.md body",
  "new_skill": { "name": "kebab-case", "category": "${location.skillCategory}", "type": "action", "description": "one sentence, ≤${MAX_SKILL_DESC_CHARS} chars", "content": "markdown body" }
}

- "log" (ALWAYS): the progress entry to append. What happened and why it matters. For a created task, note the new workstream; for a completed one, note the outcome. Don't restate what the log tail already says.
- "skill" (MOST EVENTS: omit it): only when this event materially changes the project's direction, status, or decisions (milestone done, workstream started/dropped). It must be the WHOLE body — everything after the frontmatter, reorganized and kept current — because it REPLACES the file. Never a fragment, never a summary of it, and never drop history that still matters. Omit the key entirely when nothing needs to change.
- "new_skill" (RARE): only when the task reveals a recurring CLASS of work no existing skill covers. Never a task-specific artifact. The user is notified automatically; don't ask.
- Never delete anything. Nothing outside this project's skill and log can be written.`;
}

export interface MaintainerRunOptions {
  system: string;
  source: UsageSource;
  maxTokens: number;
}

export type MaintainerRunner = (
  userMessage: string,
  options: MaintainerRunOptions,
) => Promise<{ response: string }>;

/** One model call, no tools. The seam stays injectable so tests never call out. */
async function defaultRunner(userMessage: string, options: MaintainerRunOptions): Promise<{ response: string }> {
  const { sendMessage } = await import('../model/model.js');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAINTAINER_TIMEOUT_MS);
  let result;
  try {
    result = await sendMessage({
      system: options.system,
      messages: [{ role: 'user', content: userMessage }],
      config: { maxTokens: options.maxTokens },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (result.usage) {
    try {
      usageTracker.record({
        source: options.source,
        model: result.usage.model ?? 'unknown',
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
        cache_read_input_tokens: result.usage.cache_read_input_tokens,
        agentId: SUBSCRIBER,
      });
    } catch { /* accounting must never fail the hook */ }
  }
  const response = (result.content ?? [])
    .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
    .join('');
  return { response };
}

export interface MaintainerAnswer {
  log: string;
  skill?: string;
  newSkill?: {
    name: string;
    category: string;
    type: 'action' | 'knowledge';
    description: string;
    content: string;
  };
}

/**
 * Parse + validate one maintainer answer. Returns null (with a reason logged by
 * the caller) whenever ANY part of it is unusable: a partly-applied answer is
 * worse than a skipped run, because the skipped run leaves the file intact.
 */
export function parseMaintainerAnswer(
  raw: string,
  location: ProjectSkillLocation,
  currentBodyLength: number,
): { answer: MaintainerAnswer } | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { error: 'empty answer' };
  // Models fence JSON even when told not to; a leading/trailing fence is the
  // only tolerated decoration.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse((fence?.[1] ?? text).trim());
  } catch {
    return { error: 'answer is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'answer is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;

  const logEntry = typeof obj.log === 'string' ? obj.log.trim() : '';
  if (!logEntry) return { error: 'answer has no "log" entry' };
  if (logEntry.length > MAX_LOG_CHARS) return { error: `"log" is ${logEntry.length} chars (max ${MAX_LOG_CHARS})` };
  const logScreen = screenSkillWrite(logEntry, `overview-maintainer log '${location.name}'`);
  if (logScreen) return { error: logScreen };

  const answer: MaintainerAnswer = { log: logEntry };

  if (obj.skill !== undefined && obj.skill !== null) {
    if (typeof obj.skill !== 'string') return { error: '"skill" must be a string' };
    const body = obj.skill.trim();
    if (body) {
      if (body.length > MAX_SKILL_CHARS) return { error: `"skill" is ${body.length} chars (max ${MAX_SKILL_CHARS})` };
      if (currentBodyLength > 0 && body.length < currentBodyLength * MIN_SKILL_KEEP_RATIO) {
        return { error: `"skill" is ${body.length} chars against a ${currentBodyLength}-char body — refusing a rewrite that drops most of the doc` };
      }
      const screen = screenSkillWrite(body, `overview-maintainer skill '${location.name}'`);
      if (screen) return { error: screen };
      answer.skill = body;
    }
  }

  if (obj.new_skill !== undefined && obj.new_skill !== null) {
    if (typeof obj.new_skill !== 'object' || Array.isArray(obj.new_skill)) {
      return { error: '"new_skill" must be an object' };
    }
    const ns = obj.new_skill as Record<string, unknown>;
    const name = typeof ns.name === 'string' ? ns.name.trim() : '';
    const description = typeof ns.description === 'string' ? ns.description.trim() : '';
    const content = typeof ns.content === 'string' ? ns.content.trim() : '';
    const category = (typeof ns.category === 'string' && ns.category.trim()) || location.skillCategory;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { error: `"new_skill.name" is not a plain skill name: "${name}"` };
    if (!/^[a-zA-Z0-9_-]+$/.test(category)) return { error: `"new_skill.category" is not a plain category: "${category}"` };
    if (!description) return { error: '"new_skill.description" is required' };
    if (description.length > MAX_SKILL_DESC_CHARS) {
      return { error: `"new_skill.description" is ${description.length} chars (max ${MAX_SKILL_DESC_CHARS})` };
    }
    if (!content) return { error: '"new_skill.content" is required' };
    if (content.length > MAX_SKILL_CHARS) return { error: `"new_skill.content" is ${content.length} chars (max ${MAX_SKILL_CHARS})` };
    const screen = screenSkillWrite([description, content].join('\n\n'), `overview-maintainer create '${name}'`);
    if (screen) return { error: screen };
    answer.newSkill = {
      name, category, description, content,
      type: ns.type === 'knowledge' ? 'knowledge' : 'action',
    };
  }

  return { answer };
}

export interface MaintainerWrites {
  logAppended: boolean;
  skillUpdated: boolean;
  skillCreated?: string;
}

/**
 * Apply a validated answer. Order matters: the log entry (the always-write) goes
 * first, so a failure in the rarer writes still leaves the progress trail.
 */
async function applyMaintainerAnswer(
  answer: MaintainerAnswer,
  location: ProjectSkillLocation,
): Promise<MaintainerWrites> {
  const writes: MaintainerWrites = { logAppended: false, skillUpdated: false };

  const appended = appendSkillHistoryLog(location.skillCategory, location.name, answer.log, 'task-hook');
  writes.logAppended = true;
  if (appended.rotated) {
    log.agent.info('overview-maintainer: history log rotated', {
      project: location.name, archivedVolume: appended.archivedVolume,
    });
  }

  if (answer.skill) {
    const key = skillManageName(location);
    const skill = await getSkill(key);
    if (!skill) {
      log.agent.warn('overview-maintainer: project skill vanished, body update skipped', { skill: key });
    } else {
      const md = buildSkillMd({
        name: skill.name,
        description: skill.description,
        type: skill.type === 'knowledge' ? 'knowledge' : 'action',
        content: answer.skill,
        base: parseRawFrontmatter(skill.content),
      });
      await updateSkill(key, md);
      await recordSkillPatched(key);
      writes.skillUpdated = true;
    }
  }

  if (answer.newSkill) {
    const { name, category, description, type, content } = answer.newSkill;
    try {
      const md = buildSkillMd({ name, description, type, content });
      const created = await createSkill(name, md, 'walnut', category);
      await recordSkillCreated(name);
      writes.skillCreated = name;
      notifySkillCreated(name, created.category);
    } catch (err) {
      // A name clash or an invalid segment is the model's mistake, not a hook
      // failure: the log entry above already landed.
      log.agent.warn('overview-maintainer: skill create refused', {
        skill: name, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  refreshSkillIndex();
  return writes;
}

/**
 * All gating + serialized execution for one task lifecycle event.
 * Resolves when THIS task's maintainer run finishes (tests await it);
 * the bus handler calls it fire-and-forget. `false` = nothing was written,
 * whether because gating skipped the event or the answer was unusable.
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

  // Serialize: one maintainer run at a time; each run waits for the prior tail.
  const prior = queueTail;
  let done!: () => void;
  queueTail = new Promise<void>((resolve) => { done = resolve; });
  await prior;

  try {
    log.agent.info('overview-maintainer: running for task event', {
      taskId: task.id, event: eventName, project: location.name,
    });
    const prompt = buildMaintainerPrompt(task, eventName, location);
    // Measured BEFORE the call: the shrink guard compares the answer against the
    // body the model was actually shown.
    const currentBody = skillBody(readFileSafe(path.join(skillDir(location.skillCategory, location.name), 'SKILL.md')));
    const result = await runner(prompt, {
      system: MAINTAINER_SYSTEM,
      source: 'task-hook',
      maxTokens: MAINTAINER_MAX_TOKENS,
    });
    const parsed = parseMaintainerAnswer(result.response, location, currentBody.length);
    if ('error' in parsed) {
      log.agent.warn('overview-maintainer: unusable answer, nothing written', {
        taskId: task.id, project: location.name, reason: parsed.error,
        head: (result.response ?? '').slice(0, 200),
      });
      return false;
    }
    const writes = await applyMaintainerAnswer(parsed.answer, location);
    log.agent.info('overview-maintainer: run complete', {
      taskId: task.id, project: location.name,
      logAppended: writes.logAppended, skillUpdated: writes.skillUpdated,
      ...(writes.skillCreated ? { skillCreated: writes.skillCreated } : {}),
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
