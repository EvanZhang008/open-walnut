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
import { BRIEF_MAX_CHARS, USER_STATE_LABELS, briefMoves, fallbackUserState, type TaskBrief } from '../user-status.js';
import type { Task } from '../types.js';

export function keepsBrief(task: Pick<Task, 'org_role'>): boolean {
  return task.org_role === 'main' || task.org_role === 'lead';
}

/** One line per team task that moved since the Brief, for the self-report prompt. */
export function briefMoveLines(owner: Task, tasks: readonly Task[]): string[] {
  const at = owner.brief?.at ? Date.parse(owner.brief.at) : NaN;
  return briefMoves(owner, tasks, at, 12).map(({ task }) => {
    const s = task.user_status;
    const state = USER_STATE_LABELS[task.phase === 'COMPLETE' ? 'done' : s?.state ?? fallbackUserState(task.phase, task.status)];
    const why = s?.ask ?? s?.waitingOn ?? s?.now;
    return `- <task-ref id="${task.id}" label="${task.title.replace(/"/g, '&quot;')}"/>: now ${state}${why ? ` (${why})` : ''}`;
  });
}

/** The self-report's Brief section (after the FOR_USER lines), for Main and leads only. */
export function briefPrompt(opts: { hadBrief: boolean; moves: readonly string[]; language?: string }): string {
  const moved = opts.moves.length
    ? `\nSince your last Brief, these moved in your team (Walnut's list; each must be right in the new one):\n${opts.moves.join('\n')}`
    : '';
  return `
Then your BRIEF, the short letter the user reads at the top of your chat instead of scrolling it. ${opts.hadBrief ? 'Rewrite it whole' : 'Write it'} every time (never "unchanged"): Markdown, at most 12 short lines, plain words${opts.language ? `, in ${opts.language}` : ''}. First what needs the user (the decision or action, one line each), then one line per piece of work: its <task-ref id="..." label="..."/>, what is done, what it waits on now and on whom. Walnut shows each named task's live status beside it, so name tasks with <task-ref/>, never a bare id. No codenames, hashes or file names.${moved}
FOR_USER_BRIEF:
<the letter>`;
}

/** The Brief out of a self-report, or null when it wrote none. */
export function readBrief(field: string, nowIso: string = new Date().toISOString()): TaskBrief | null {
  const text = field.replace(/^<the letter>\s*/i, '').trim();
  if (!text || /^(unchanged|none|n\/a)\.?$/i.test(text)) return null;
  return { text: text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS - 1).trimEnd()}…` : text, at: nowIso };
}
