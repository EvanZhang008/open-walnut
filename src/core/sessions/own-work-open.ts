/**
 * A task does not close itself while its own work has not ended (2026-11-24 and 11-25, the Walnut
 * VP: three tasks completed with a land still running, a check of production still to come, or a
 * request still unanswered, and the VP reopened each with a forced send).
 *
 * The close gate (owed-to-user.ts admitSessionClose) asks this for a session closing its OWN task.
 * Three sources, each read from what Walnut itself knows, never from the task's say-so alone:
 *   background  its session's own work that goes on after the turn (outliving-work.ts: a
 *               run_in_background command such as a land or a test run, a background subagent, an
 *               agent team, an armed wakeup), as the session's host reports it now (host-work.ts);
 *               not a /loop, whose cron a folder's other sessions share;
 *   subtask     a subtask of its own still open (2026-11-26, the Walnut VP: 713c0d39 closed with its
 *               review task still running and its commit not landed). A lead's team is no step of
 *               its work: Main and the leads are never asked this (admitSessionClose returns first);
 *   trigger     an armed trigger the task armed on its own work (`watches: "own"`, ownWork: the
 *               deploy watch a land leaves). A trigger someone else aimed at it is paused by the
 *               completion and resumed by a reopen (routines/trigger-completion-pause.ts);
 *   said        the close's own words (its result, and its not_done items that are not the user's)
 *               say that its work is still running or that it checks production after it goes live.
 * `force` with a reason (REASON_MIN+ characters) closes past them: the reason is logged with the
 * close. A source Walnut cannot read (a host that does not answer) holds nothing.
 * Guard tests: tests/core/sessions/own-work-open.test.ts.
 */
import { log } from '../../logging/index.js';
import type { StructuredReply } from '../peers/structured-reply.js';

export const OWN_WORK_REASON_MIN = 10;

export type OwnWorkSource = 'background' | 'subtask' | 'trigger' | 'said';
export interface OwnWorkItem { source: OwnWorkSource; text: string }
export interface OwnWorkRefusal { ok: false; code: 'own_work_open'; message: string; items: OwnWorkItem[] }

// Work of its own still under way, or a check it promises for after it ends: a run named as still
// going, or a first-person future check of production. Never a sentence that describes how code
// behaves ("a session whose CLI is still running keeps its slot", "deploys only after main is
// green"), and never the past ("after it went live I checked"). Review of 2026-11-26.
const EN_PENDING: readonly RegExp[] = [
  /\b(?:the |my |its |our )?(?:land|landing|deploy|deployment|test run|tests|suite|CI run|pipeline run)\s+(?:is|are)\s+still\s+(?:running|in progress|pending|queued|going)\b/i,
  /\b(?:is|are)\s+still\s+running\s+in\s+the\s+background\b/i,
  /\b(?:I|we)\s*(?:will|'ll|am going to|are going to|still (?:need|have) to)\s+(?:check|verify|confirm|look at|re-?check|take (?:a|the) (?:short )?look)\b[^.;\n]{0,60}\b(?:live|production|prod)\b/i,
  /\b(?:once|after|when)\s+(?:it|this|that|the (?:land|deploy|change|fix))\s+(?:is|goes)\s+live\b[^.;\n]{0,40}\b(?:I|we)\s*(?:will|'ll)\b/i,
  /\bnot\s+(?:live|deployed|landed)\s+yet\b/i,
  // A step it still takes once something comes back: "I land once its findings come back".
  /\b(?:I|we)\s*(?:will\s+|'ll\s+|am going to\s+|are going to\s+)?(?:land|ship|deploy|merge|push|commit|complete|finish)\b[^.;\n]{0,30}\b(?:once|when|after|as soon as)\b/i,
  /\b(?:once|when|after|as soon as)\s+(?:its|the|their|my)\s+(?:findings|review|reviews|results?|verdict|answer|reply)\s+(?:come|comes|are|is)\s+(?:back|in)\b/i,
  // A run of its own named as going on: "the review task mwx3sskd-d3d4 is running".
  /\b(?:the|its|my|our)\s+(?:review|reviewer|subtask|worker|build|test run|tests|CI run)\b(?:\s+\S+){0,2}\s+(?:is|are)\s+(?:still\s+)?(?:running|in progress|under way)\b/i,
];
// The same in Chinese, as escapes (no Chinese in code): "after it goes live / deploys / lands /
// finishes, (I) then / will / must", "wait (for it) to go live", "still running", "not live yet".
const ZH_EVENT = '(?:\\u4e0a\\u7ebf|\\u90e8\\u7f72|\\u843d\\u5730|land|\\u8dd1\\u5b8c|\\u6d4b\\u5b8c)';
const ZH_PENDING: readonly RegExp[] = [
  new RegExp(`${ZH_EVENT}(?:\\u4e86)?\\u540e(?:\\u6211)?(?:\\u518d|\\u4f1a|\\u8981|\\u5c06)`, 'u'),
  new RegExp(`\\u7b49(?:\\u5b83|\\u6539\\u52a8)?${ZH_EVENT}`, 'u'),
  /\u8fd8\u5728(?:\u8dd1|land|\u90e8\u7f72|\u843d\u5730|\u6d4b)/u,
  // "wait for the review (findings) to come back", "review is still running / in progress".
  /\u7b49(?:\u8bc4\u5ba1|\u5ba1\u67e5|review|\u5b50\u4efb\u52a1)/u,
  /(?:\u8bc4\u5ba1|\u5ba1\u67e5|\u5b50\u4efb\u52a1)(?:\u8fd8|\u6b63)\u5728/u,
  new RegExp(`\\u8fd8\\u6ca1(?:\\u6709)?${ZH_EVENT}`, 'u'),
];

/** The lines of `texts` that say work is still running or a check comes after it ends. Pure. */
export function pendingLines(texts: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of (text ?? '').split(/\n|(?<=[.;。；])\s*/u)) {
      const line = raw.trim();
      if (!line) continue;
      if ([...EN_PENDING, ...ZH_PENDING].some((re) => re.test(line))) out.push(line.length > 200 ? `${line.slice(0, 197)}...` : line);
    }
  }
  return [...new Set(out)];
}

/**
 * What this close says: its result, and its not_done items that are not the user's (owed-waits.ts
 * waitsOnUser: the user's items are the owed gate's, which holds them for him). A close with no
 * words of its own reads nothing: an earlier mid-work report is no word on this close.
 */
async function closeWords(fields: StructuredReply | null | undefined): Promise<string[]> {
  if (!fields) return [];
  const { waitsOnUser } = await import('./owed-waits.js');
  return [fields.result, ...(fields.not_done ?? []).filter((t) => !waitsOnUser(t))].filter((t): t is string => typeof t === 'string');
}

export interface OwnWorkDeps {
  /** The closing session's own work that outlives its turn, named; null when its host cannot say. */
  outliving: (sessionId: string) => Promise<string[] | null>;
  /** Its own subtasks still open, as `"<title>" (<id>)`. */
  openSubtasks: (taskId: string) => Promise<string[]>;
  /** The armed triggers the task armed on its own work (watches: own). */
  armedTriggers: (taskId: string) => Promise<Array<{ id: string; name: string }>>;
}

async function liveDeps(): Promise<OwnWorkDeps> {
  return {
    outliving: async (sessionId) => {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const record = await getSessionByClaudeId(sessionId).catch(() => null);
      if (!record) return null;
      const { hostWorkOf } = await import('./host-work.js');
      const work = await hostWorkOf(record);
      if (!work?.alive) return null;
      const { OUTLIVING_SOURCES } = await import('./outliving-work.js');
      return (work.outliving ?? []).filter((s) => s !== 'loop').map((s) => OUTLIVING_SOURCES[s]);
    },
    openSubtasks: async (taskId) => {
      const { getChildTasks } = await import('../task-manager.js');
      return (await getChildTasks(taskId)).filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done').map((t) => `"${t.title}" (${t.id})`);
    },
    armedTriggers: async (taskId) => {
      const { triggersWatching } = await import('../task-wait-until.js');
      return (await triggersWatching(taskId)).filter((t) => t.state === 'armed' && t.ownWork === true).map((t) => ({ id: t.id, name: t.name ?? 'unnamed' }));
    },
  };
}

/**
 * Null when the task's own session may close it; else the refusal naming what still runs.
 * `task` is the task being closed by its own session `sessionId`.
 */
export async function admitOwnWorkEnded(
  task: { id: string },
  sessionId: string,
  opts: { force?: boolean; reason?: string; fields?: StructuredReply | null } = {},
  deps?: OwnWorkDeps,
): Promise<OwnWorkRefusal | null> {
  const reason = (opts.reason ?? '').replace(/\s+/g, ' ').trim();
  const d = deps ?? await liveDeps();
  const items: OwnWorkItem[] = [];
  const outliving = await d.outliving(sessionId).catch(() => null);
  for (const what of outliving ?? []) items.push({ source: 'background', text: what });
  for (const sub of await d.openSubtasks(task.id).catch(() => [])) items.push({ source: 'subtask', text: sub });
  const triggers = await d.armedTriggers(task.id).catch(() => []);
  for (const t of triggers) items.push({ source: 'trigger', text: `trigger ${t.id} (${t.name})` });
  for (const line of pendingLines(await closeWords(opts.fields))) items.push({ source: 'said', text: line });
  if (!items.length) return null;
  if (opts.force === true && reason.length >= OWN_WORK_REASON_MIN) {
    log.task.info('task closed by its own session past its own open work', { taskId: task.id, sessionId, reason, items: items.map((i) => `${i.source}: ${i.text}`) });
    return null;
  }
  const by = (s: OwnWorkSource) => items.filter((i) => i.source === s).map((i) => i.text);
  const parts: string[] = [];
  if (by('background').length) parts.push(`your own work still runs: ${by('background').join(', ')}. Wait for it to end (its notice wakes you), read its result and act on it; one that is not part of this task's result (a server left running), stop it (TaskStop)`);
  if (by('subtask').length) parts.push(`its own subtasks are still open: ${by('subtask').join(', ')}. Wait for each one's result (a review: read its findings and act on them), then complete; one you no longer need, stop it (task_stop) or complete it`)
  if (by('trigger').length) parts.push(`it still watches something: ${by('trigger').join('; ')}. Let it fire and do what it brings (a deploy watch: look at your change on production), or delete it with trigger_delete if it is no longer needed`);
  if (by('said').length) parts.push(`your result says the work is not over: ${by('said').map((t) => `"${t}"`).join('; ')}. Do that first, then complete with a result that says what happened`);
  const message = `Not closed: ${parts.join('. Also, ')}. `
    + 'A task is complete when its work has ended and you saw the outcome, not when it is handed to a clock. '
    + (opts.force === true
      ? `force needs a reason of ${OWN_WORK_REASON_MIN}+ characters saying why it may close now.`
      : `If it really may close now (the work was dropped, or what runs is not this task's), complete again with force:true and a reason (${OWN_WORK_REASON_MIN}+ characters) saying why; the reason is kept with the close.`);
  return { ok: false, code: 'own_work_open', message, items };
}
