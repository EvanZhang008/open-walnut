/**
 * Quick-start session auto-organize — cheap-model category/project placement.
 *
 * Historically the web client woke the MAIN butler agent after every quick
 * start ("[Quick Start] Session created… move the task to the correct
 * category") — a full agent turn (main model + whole context) to make a
 * one-field decision. This module replaces that with the same fast-model
 * strict-JSON recipe as quick-task-parse.ts: buildCategoryDigest() for
 * context, canonicalMatch whitelist so a hallucinated name can never land,
 * never-throw. No match → the task simply stays in Local/Quick Start.
 *
 * Deliberately NOT a session hook: placement needs no live CLI and shouldn't
 * wait for the spawn — it runs fire-and-forget right from quick-start.ts.
 */

import { sendMessage } from '../agent/model.js';
import { log } from '../logging/index.js';
import { fastModelFor } from './cheap-model.js';

const SYSTEM_PROMPT = `You place a new coding-session task into the user's existing category/project tree. Reply with ONLY a JSON object — no markdown fence, no commentary.
Fields:
- category: the ONE best-matching category NAME from the list, judged by similarity between the session (its working directory and the user's request) and that category's example task titles. Copy the name EXACTLY as written. NEVER invent a name not in the list. If nothing plausibly fits, OMIT the field — a wrong move is worse than no move.
- project: only if you set category — the best-matching project name listed UNDER that category. Copy EXACTLY. If none clearly matches, OMIT (the task stays at the category default). NEVER invent a name.
Bias: coding sessions usually belong with the project whose example titles mention the same repository/directory name.`;

export interface OrganizeSuggestion {
  category?: string;
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
    const { buildCategoryDigest } = await import('./quick-task-digest.js');
    const digest = await buildCategoryDigest();
    if (!digest.categories.length) return {};

    let model = opts.modelOverride;
    if (!model) {
      const { getConfig } = await import('./config-manager.js');
      model = fastModelFor(await getConfig());
    }

    const content = [
      'Your categories and projects (name, open task count, recent task titles):',
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

    const category = canonicalMatch(parsed.category, digest.categories);
    if (!category) return {};
    const project = canonicalMatch(parsed.project, digest.projectsByCategory[category]);
    return { category, ...(project ? { project } : {}) };
  } catch (err) {
    log.web.debug('suggestSessionPlacement failed — task stays in Quick Start', {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return {};
  }
}

/**
 * Fire-and-forget placement for a quick-start task. Re-reads the task before
 * writing so a user/butler move that happened while the model was thinking
 * always wins (same guard shape as session-auto-title).
 */
export async function organizeQuickStartTask(
  taskId: string, cwd: string, message?: string,
): Promise<void> {
  const suggestion = await suggestSessionPlacement({ cwd, message });
  if (!suggestion.category) return;
  // 'Local' is the transit stop the task is already in — the digest lists it
  // (with quick-start tasks as its examples!), so the model can echo it back.
  // Moving Local/Quick Start → Local/Local is a pointless rewrite; skip.
  if (suggestion.category.toLowerCase() === 'local') return;

  const { getTask, updateTask } = await import('./task-manager.js');
  const current = await getTask(taskId);
  if (!current) return;
  // Only move while the task is still in the quick-start default spot —
  // anything else means a human or the butler already placed it.
  if (current.category !== 'Local' || current.project !== 'Quick Start') return;

  await updateTask(taskId, {
    category: suggestion.category,
    // No project match → the category name is the category's default list.
    project: suggestion.project ?? suggestion.category,
  }, { source: 'session-auto-organize', extraTargets: ['main-agent'] });

  log.web.info('session-auto-organize: placed quick-start task', {
    taskId, category: suggestion.category, project: suggestion.project ?? suggestion.category,
  });
}
