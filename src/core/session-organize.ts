/**
 * Quick-start session auto-organize — cheap-model project placement.
 *
 * Historically the web client woke the Personal AI after every quick
 * start ("[Quick Start] Session created… move the task to the correct
 * category") — a full agent turn (main model + whole context) to make a
 * one-field decision. This module replaces that with the same fast-model
 * strict-JSON recipe as quick-task-parse.ts: buildProjectDigest() for
 * context, canonicalMatch whitelist so a hallucinated name can never land,
 * never-throw. No match → the task stays in Inbox.
 *
 * NOTE: unlike the quick-task parser, this background pass may only pick an
 * EXISTING project — it never proposes a new name. A human confirms new
 * projects in the quick-add UI; nobody is watching this one.
 *
 * Deliberately NOT a session hook: placement needs no live CLI and shouldn't
 * wait for the spawn — it runs fire-and-forget right from quick-start.ts.
 */

import { sendMessage } from '../agent/model.js';
import { log } from '../logging/index.js';
import { fastModelFor } from './cheap-model.js';

const SYSTEM_PROMPT = `You place a new coding-session task into ONE of the user's existing projects. Reply with ONLY a JSON object — no markdown fence, no commentary.
Field:
- project: the ONE best-matching project NAME from the list, judged by similarity between the session (its working directory and the user's request) and that project's summary and example task titles. Copy the name EXACTLY as written. NEVER invent a name not in the list — you may not create projects. If nothing plausibly fits, OMIT the field: the task stays in Inbox, and a wrong move is worse than no move.
Bias: coding sessions usually belong with the project whose example titles mention the same repository/directory name.`;

export interface OrganizeSuggestion {
  project?: string;
}

function stripJsonFence(value: string): string {
  const match = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? value).trim();
}

function canonicalMatch(value: unknown, choices: string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !choices?.length) return undefined;
  const normalized = value.trim().toLowerCase();
  return choices.find((choice) => choice.trim().toLowerCase() === normalized);
}

/**
 * Ask the fast model where a quick-start session belongs. Never throws;
 * empty suggestion means "leave it where it is".
 */
export async function suggestSessionPlacement(
  input: { cwd: string; message?: string },
  opts: { timeoutMs?: number; modelOverride?: string } = {},
): Promise<OrganizeSuggestion> {
  try {
    const { buildProjectDigest } = await import('./quick-task-digest.js');
    const digest = await buildProjectDigest();
    if (!digest.projects.length) return {};

    let model = opts.modelOverride;
    if (!model) {
      const { getConfig } = await import('./config-manager.js');
      model = fastModelFor(await getConfig());
    }

    const content = [
      'Your projects (name, open task count, summary, recent task titles):',
      digest.digest,
      '',
      `Session working directory: ${input.cwd}`,
      ...(input.message?.trim()
        ? [`User's request (opening message):\n${input.message.trim().slice(0, 800)}`]
        : ['(No opening message — the session was started on the directory alone.)']),
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    let result;
    try {
      // maxTokens stays small: Haiku catalog default (64K) trips the SDK's
      // "streaming required" guard on the non-streaming path.
      result = await sendMessage({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        config: { maxTokens: 128, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const responseText = (result.content ?? [])
      .map((block) => (block.type === 'text' && 'text' in block ? (block as { text: string }).text : ''))
      .join('')
      .trim();
    const parsedValue: unknown = JSON.parse(stripJsonFence(responseText));
    const parsed = parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};

    const project = canonicalMatch(parsed.project, digest.projects);
    return project ? { project } : {};
  } catch (err) {
    log.web.debug('suggestSessionPlacement failed — task stays in Inbox', {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return {};
  }
}

/**
 * Fire-and-forget placement for a quick-start task. Re-reads the task before
 * writing so a user/Personal AI move that happened while the model was thinking
 * always wins (same guard shape as session-auto-title).
 */
export async function organizeQuickStartTask(
  taskId: string, cwd: string, message?: string,
): Promise<void> {
  const suggestion = await suggestSessionPlacement({ cwd, message });
  if (!suggestion.project) return;

  const { getTask, updateTask } = await import('./task-manager.js');
  const current = await getTask(taskId);
  if (!current) return;
  // Only move while the task is still unfiled — anything else means a human or
  // the Personal AI already placed it.
  if ((current.project ?? '') !== '') return;

  // No claim guard needed anymore: updateTask keeps a LOCAL task local on a
  // move into a provider-claimed project (the project is just a folder; nothing
  // is pushed). The guard that used to sit here protected against the old
  // behavior where this move flipped the source and PUSHED the task — which is
  // how "Session: walnut" noise tasks multiplied in the user's real MS To-Do
  // (19 copies by 2026-08-20). Now the placement is safe by construction, so
  // the unattended pass may file the task anywhere the model suggests.
  await updateTask(taskId, {
    project: suggestion.project,
  }, { source: 'session-auto-organize', extraTargets: ['main-agent'] });

  const placed = await getTask(taskId);
  log.web.info('session-auto-organize: placed quick-start task', {
    taskId, project: suggestion.project, source: placed?.source,
  });
}
