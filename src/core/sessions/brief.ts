/**
 * The Brief: the short letter Main and every lead keep for the user at the top of their chat
 * (OrgBrief.tsx on the Org page), so the user reads where things stand instead of scrolling the
 * conversation. 2026-10-26, the user: "a persistent letter ... managed by AI ... I can just reply,
 * direct to the chat, this is constantly managed by agent, must be up to date"; "All the leader or
 * main agent, or VP need to utilize this."
 *
 * Kept current by the program, not by the session remembering to:
 *   - every turn end's self-report asks for it (FOR_USER_BRIEF) and lists what moved in the team
 *     since the last one, so the rewrite cannot miss a move;
 *   - the page shows every task it names with its live status, and lists what moved after it was
 *     written (briefMoves in src/core/user-status.ts), so an idle owner's Brief never reads stale.
 */
import { BRIEF_MAX_CHARS, COMPLETE_IS_VERIFIED, USER_STATE_LABELS, briefMoves, fallbackUserState, type TaskBrief } from '../user-status.js';
import type { Task } from '../types.js';
import { briefVpOf } from './brief-rules.js';

export function keepsBrief(task: Pick<Task, 'org_role'>): boolean {
  return task.org_role === 'main' || task.org_role === 'lead';
}

/** One line per team task that moved since the Brief, for the self-report prompt. */
export function briefMoveLines(owner: Task, tasks: readonly Task[]): string[] {
  const at = owner.brief?.at ? Date.parse(owner.brief.at) : NaN;
  return briefMoves(owner, tasks, at, 12).map(({ task }) => {
    // Main names the VP over each worker (brief-rules.ts): the ref to copy, beside the move.
    const vp = owner.org_role === 'main' ? briefVpOf(task, tasks) : undefined;
    const vpRef = vp ? ` (VP <task-ref id="${vp.id}" label="${vp.title.replace(/"/g, '&quot;')}"/>)` : '';
    const s = task.user_status;
    // A completed task is verified (the user mostly closes it after checking): its last open
    // words ("waits on the user to install the build") are history, never a pending step.
    const done = task.phase === 'COMPLETE' || task.status === 'done';
    const state = USER_STATE_LABELS[done ? 'done' : s?.state ?? fallbackUserState(task.phase, task.status)];
    const why = done ? undefined : s?.ask ?? s?.waitingOn ?? s?.now;
    return `- <task-ref id="${task.id}" label="${task.title.replace(/"/g, '&quot;')}"/>${vpRef}: now ${state}${why ? ` (${why})` : ''}`;
  });
}

/** The self-report's Brief section (after the FOR_USER lines), for Main and leads only. `vps`
 *  (Main's) are the refs it names beside each worker; `issues` what broke the rules last time. */
export function briefPrompt(opts: {
  hadBrief: boolean; moves: readonly string[]; language?: string; ownId?: string;
  main?: boolean; vps?: readonly string[]; issues?: readonly string[];
}): string {
  const moved = opts.moves.length
    ? `\nSince your last Brief, these moved in your team (Walnut's list; each must be right in the new one):\n${opts.moves.join('\n')}`
    : '';
  const own = opts.ownId ? `<task-ref id="${opts.ownId}" label="..."/>` : 'your own task';
  const refs = opts.main
    ? `EVERY line, the ones that need the user too, names two tasks: first the <task-ref id="..." label="..."/> of the task doing the work, then the <task-ref/> of the VP who leads it (${own} alone for your own work, the VP alone for the VP's own work).${opts.vps?.length ? `\nYour VPs:\n${opts.vps.join('\n')}` : ''}\n`
    : `EVERY line, the ones that need the user too, starts with the <task-ref id="..." label="..."/> of the task it is about (the worker that owns it; ${own} for your own work). `;
  const broke = opts.issues?.length
    ? `\nWalnut found these lines of your last Brief breaking the rules; the new one must not:\n${opts.issues.join('\n')}`
    : '';
  return `
Then your BRIEF, the short letter the user reads at the top of your chat instead of scrolling it. ${opts.hadBrief ? 'Rewrite it whole' : 'Write it'} every time (never "unchanged"): Markdown, at most 12 lines, plain words${opts.language ? `, in ${opts.language}` : ''}. First what needs the user (the decision or action), then one line per piece of work: what is done, what it waits on now and on whom. One thing per line: several asks are several lines, each with its task. ${refs}Each line says enough to act on without the chat: which document, repo or release, and exactly what the user must decide or do. Walnut shows each named task's live status beside it, so name tasks with <task-ref/>, never a bare id, and Walnut checks these rules. ${COMPLETE_IS_VERIFIED} Only what needs the user now or changes their picture of the work: a deadline days away, a reminder or a thing for later goes into your own MEMORY.md (asked below), not here. Plain Markdown with no bold labels around the field name. No codenames, hashes or file names.${moved}${broke}
FOR_USER_BRIEF:
<the letter>`;
}

/** The Brief out of a self-report, or null when it wrote none. A line of bare emphasis marks
 *  at its top (a label bold left open) is dropped. */
export function readBrief(field: string, nowIso: string = new Date().toISOString()): TaskBrief | null {
  const text = field.replace(/^<the letter>\s*/i, '').replace(/^(?:[ \t]*[*_]+[ \t]*\r?\n)+/, '').trim();
  if (!text || /^(unchanged|none|n\/a)\.?$/i.test(text)) return null;
  return { text: text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS - 1).trimEnd()}…` : text, at: nowIso };
}
