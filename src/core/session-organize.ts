/**
 * Quick-start session auto-organize — cheap-model project placement.
 *
 * Historically the web client woke the Personal AI after every quick
 * start ("[Quick Start] Session created… move the task to the correct
 * category") — a full agent turn (main model + whole context) to make a
 * one-field decision. This module replaces that with the same fast-model
 * strict-JSON recipe as quick-task-parse.ts: buildProjectDigest() for
 * context, canonicalMatch whitelist so a hallucinated name can never land,
 * never-throw. No match → the task stays where the launch put it: the Inbox,
 * or the project it took from its folder (folderDefaultKind).
 *
 * NOTE: unlike the quick-task parser, this background pass may only pick an
 * EXISTING project — it never proposes a new name. A human confirms new
 * projects in the quick-add UI; nobody is watching this one.
 *
 * Deliberately NOT a session hook: placement needs no live CLI and shouldn't
 * wait for the spawn — it runs fire-and-forget right from quick-start.ts.
 */

import { sendMessage } from '../model/model.js';
import { log } from '../logging/index.js';
import { fastModelFor } from './cheap-model.js';
import { getJevClient, readChoice, type JevClient } from './decision/jev-client.js';
import type { Config } from './types.js';

const SYSTEM_PROMPT = `You place a new coding-session task into ONE of the user's existing projects. Reply with ONLY a JSON object — no markdown fence, no commentary.
Field:
- project: the ONE best-matching project NAME from the list, judged by similarity between the session (its working directory and the user's request) and that project's summary and example task titles. Copy the name EXACTLY as written. NEVER invent a name not in the list — you may not create projects. If nothing plausibly fits, OMIT the field: the task stays in Inbox, and a wrong move is worse than no move.
Bias: coding sessions usually belong with the project whose example titles mention the same repository/directory name.`;

export interface OrganizeSuggestion {
  project?: string;
}

interface PlacementInput {
  cwd: string;
  message?: string;
  /** The project the task already sits in only because its folder is inside
   *  that project's declared folder (folderDefaultKind 'inherited'). */
  currentProject?: string;
}

/** Tells the model the current project is a default it may overturn — and that
 *  keeping it is the safe answer, since a wrong move is worse than no move. */
function inheritedNote(project: string): string {
  return `The task is currently filed under "${project}" only because its working directory is inside that project's folder. Keep "${project}" unless another project clearly fits the request better.`;
}

const trimSlashes = (dir: unknown): string => (typeof dir === 'string' ? dir.replace(/\/+$/, '') : '');

/**
 * How much a folder-derived project is worth, judged by the NEAREST folder at or
 * above `cwd` that any project declares as its `default_cwd`:
 *  · 'final': that folder is `cwd` itself and `project` alone declares it. The
 *    folder's own answer; never refiled.
 *  · 'inherited': `project` alone declares a PARENT folder, or nothing up the
 *    path is declared (the project is named after the folder). A default the
 *    model may overturn, told that keeping it is the safe answer.
 *  · 'shared': the nearest declared folder belongs to several projects, or to a
 *    different one. The launch's pick was not evidence (an older client takes
 *    the first by name), so the model gets no hint toward it.
 * Server twin of the draft column's folderClaim
 * (web/src/components/sessions/draft-column.ts): the same nearest-first walk,
 * paths compared verbatim minus trailing slashes, names case-insensitively.
 */
export function folderDefaultKind(
  projects: Record<string, { metadata?: Record<string, unknown> }>,
  project: string,
  cwd: string,
): 'final' | 'shared' | 'inherited' {
  const byDir = new Map<string, string[]>();
  for (const [name, record] of Object.entries(projects)) {
    const dir = trimSlashes(record.metadata?.default_cwd);
    if (dir) byDir.set(dir, [...(byDir.get(dir) ?? []), name.toLowerCase()]);
  }
  const clean = trimSlashes(cwd);
  const wanted = project.trim().toLowerCase();
  for (let p = clean; p && p !== '/'; p = p.slice(0, p.lastIndexOf('/')) || '/') {
    const declarers = byDir.get(p);
    if (!declarers) continue;
    if (declarers.length > 1 || declarers[0] !== wanted) return 'shared';
    return p === clean ? 'final' : 'inherited';
  }
  return 'inherited';
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

/** Floor for acting on a Jev placement — "a wrong move is worse than no move",
 *  and unlike the prompt's OMIT-the-field begging this one is enforceable. */
const JEV_MIN_CONFIDENCE = 0.6;
/** Sentinel option key for "stays in Inbox" — cannot collide with a real
 *  project name because criteria keys are ours, not the registry's. */
const JEV_INBOX = '__inbox__';

/**
 * One Choice question over the existing projects (plus the Inbox sentinel).
 * Returns a suggestion when Jev ANSWERED — including the empty suggestion for
 * "nothing fits" / low confidence, which is authoritative, not a failure.
 * Returns undefined on transport/HTTP errors AND on a malformed answer (a 200
 * whose answer is missing, mis-shaped, or confidence-less is schema drift,
 * not "nothing fits") so the caller still reaches the fast-model fallback.
 */
async function placeViaJev(
  jev: JevClient,
  digest: { digest: string; projects: string[]; summaries?: Record<string, string> },
  input: PlacementInput,
  opts: { timeoutMs?: number; taskId?: string } = {},
): Promise<OrganizeSuggestion | undefined> {
  try {
    const criteria: Record<string, string> = {
      [JEV_INBOX]: input.currentProject
        ? `No listed project fits this session better than "${input.currentProject}"; leave it where it is.`
        : 'No listed project plausibly fits this session; leave it unfiled.',
    };
    for (const name of digest.projects) {
      // A real project can't be allowed to shadow the sentinel key.
      if (name === JEV_INBOX) continue;
      // The summary gives options outside the digest's top-20 window real
      // evidence; guarded because tests (and old callers) pass digests
      // without a summaries map.
      const summary = digest.summaries?.[name];
      criteria[name] = `File it under the project named "${name}".${summary ? ` ${summary}` : ''}`;
    }

    const state = [
      'A new coding session just started and its task needs a project.',
      `Session working directory: ${input.cwd}`,
      ...(input.currentProject ? [inheritedNote(input.currentProject)] : []),
      input.message?.trim()
        ? `User's request (opening message): ${input.message.trim().slice(0, 800)}`
        : '(No opening message — the session was started on the directory alone.)',
      '',
      "The user's projects (name, open task count, summary, recent task titles):",
      digest.digest,
    ].join('\n');

    const answers = await jev.decide(state, {
      project: {
        type: 'choice',
        instructions: 'Which existing project should this coding session be filed under? Coding sessions usually belong with the project whose summary or example titles mention the same repository/directory name.',
        criteria,
      },
    }, {
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });

    const answer = readChoice(answers.project);
    if (!answer) {
      // Loud, and a fallback — the silent version of this branch once turned
      // auto-organize off forever on a renamed answer key, with zero log lines.
      log.web.warn('jev placement answer malformed — falling back to fast model', {
        answerKeys: Object.keys(answers),
      });
      return undefined;
    }
    if (answer.choice === JEV_INBOX || answer.confidence < JEV_MIN_CONFIDENCE) return {};
    const project = canonicalMatch(answer.choice, digest.projects);
    if (!project) {
      log.web.warn('jev placement chose a key outside the offered list — falling back', {});
      return undefined;
    }
    return { project };
  } catch (err) {
    log.web.debug('jev placement failed — falling back to fast model', {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return undefined;
  }
}

/**
 * Ask the fast model where a quick-start session belongs. Never throws;
 * empty suggestion means "leave it where it is".
 */
export async function suggestSessionPlacement(
  input: PlacementInput,
  opts: { timeoutMs?: number; modelOverride?: string; taskId?: string } = {},
): Promise<OrganizeSuggestion> {
  try {
    const { buildProjectDigest } = await import('./quick-task-digest.js');
    const digest = await buildProjectDigest();
    if (!digest.projects.length) return {};

    const { getConfig } = await import('./config-manager.js');
    const config: Config = await getConfig();

    // Jev first when configured: one Choice call (~300ms) instead of a
    // fast-model JSON one-shot (which on a CLI provider spawns `claude -p`).
    // A Jev ANSWER — even "nothing fits" — is final; a transport error or a
    // malformed answer falls through to the fast-model path below. An explicit
    // modelOverride means the caller wants THAT model's judgment (evals, A/B),
    // so Jev steps aside entirely, mirroring parseQuickTask. The Settings
    // opt-out (decisions.session_organize === false) disables this ONE
    // decision; unset means on.
    const organizeEnabled = config.jev?.decisions?.session_organize !== false;
    const jev = opts.modelOverride || !organizeEnabled ? undefined : getJevClient(config);
    if (jev) {
      const viaJev = await placeViaJev(jev, digest, input, {
        timeoutMs: opts.timeoutMs, taskId: opts.taskId,
      });
      if (viaJev) return viaJev;
    }

    const model = opts.modelOverride ?? fastModelFor(config);

    const content = [
      'Your projects (name, open task count, summary, recent task titles):',
      digest.digest,
      '',
      `Session working directory: ${input.cwd}`,
      ...(input.currentProject ? [inheritedNote(input.currentProject)] : []),
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
 *
 * `folderProject`: the project the launch took from its FOLDER (the draft's
 * "a folder is a project" default). When the folder is not that project's own
 * declared folder (folderDefaultKind), the project is a default and this pass
 * may move the task off it: a team subfolder of a shared checkout used to land
 * in whichever project declared the checkout, whatever the message said
 * (2026-09-28).
 */
export async function organizeQuickStartTask(
  taskId: string, cwd: string, message?: string,
  opts: { folderProject?: string } = {},
): Promise<void> {
  // The whole-feature switch (Settings › Tasks › Smart task creation). Checked
  // before the digest build: that walks every task, and a pass the user turned
  // off must cost nothing. Unset = on.
  const { getConfig } = await import('./config-manager.js');
  if ((await getConfig()).agent?.session_organize === false) return;

  const { getTask, updateTask, getStoreProjects } = await import('./task-manager.js');
  const folderProject = opts.folderProject?.trim() ?? '';
  const kind = folderProject ? folderDefaultKind(await getStoreProjects(), folderProject, cwd) : undefined;
  if (kind === 'final') return;

  const suggestion = await suggestSessionPlacement(
    { cwd, message, ...(kind === 'inherited' ? { currentProject: folderProject } : {}) },
    { taskId },
  );
  // A kept folder default is the answer to "why is my task in X?", so it is
  // said out loud; a no-fit Inbox launch stays as quiet as before.
  if (folderProject && (!suggestion.project || suggestion.project.toLowerCase() === folderProject.toLowerCase())) {
    log.web.info('session-auto-organize: kept the folder default project', {
      taskId, project: folderProject, kind, suggestion: suggestion.project ?? null,
    });
  }
  if (!suggestion.project) return;

  const current = await getTask(taskId);
  if (!current) return;
  const from = current.project ?? '';
  // Only move while the task is where the launch put it: unfiled, or still in
  // its folder's default project and in none of its folders (a launch files into
  // no folder, so a group_id means someone placed it there while the model was
  // thinking, and a project move would drop it). Anything else means a human or
  // the Personal AI already placed it.
  if (from !== '' && (!folderProject || from.toLowerCase() !== folderProject.toLowerCase())) return;
  if (from !== '' && current.group_id) return;
  if (from.toLowerCase() === suggestion.project.toLowerCase()) return;

  // No claim guard needed anymore: updateTask keeps a LOCAL task local on a
  // move into a provider-claimed project (the project is just a folder; nothing
  // is pushed). The guard that used to sit here protected against the old
  // behavior where this move flipped the source and PUSHED the task — which is
  // how "Session: walnut" noise tasks multiplied in the user's real MS To-Do
  // (19 copies by 2026-08-20). Now the placement is safe by construction, so
  // the unattended pass may file the task anywhere the model suggests.
  await updateTask(taskId, {
    project: suggestion.project,
  }, { source: 'session-auto-organize' });

  const placed = await getTask(taskId);
  log.web.info('session-auto-organize: placed quick-start task', {
    taskId, project: suggestion.project, from: from || 'Inbox', source: placed?.source,
  });
}
