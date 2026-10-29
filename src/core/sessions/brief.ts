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
import {
  BRIEF_MAX_CHARS, COMPLETE_IS_VERIFIED, USER_STATE_LABELS, briefMentions, briefMoves, agoWords, briefStillOpen, briefTeam, checkedLine, fallbackUserState,
  type StillOpenAsk, type TaskBrief,
} from '../user-status.js';
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

/** Every overdue request still open (session-requests.ts), by the tasks of its two sides. */
export async function overdueAsks(now = Date.now()): Promise<StillOpenAsk[]> {
  const { overdueOpenRequests } = await import('../session-requests.js');
  const rows = await overdueOpenRequests(now).catch(() => []);
  if (rows.length === 0) return [];
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const taskOf = new Map<string, string | undefined>();
  for (const r of rows) {
    if (!taskOf.has(r.fromSessionId)) taskOf.set(r.fromSessionId, (await getSessionByClaudeId(r.fromSessionId).catch(() => undefined))?.taskId);
  }
  // A request whose asker or target task has since closed waits for nothing any more.
  const { getTask } = await import('../task-manager.js');
  const closed = new Map<string, boolean>();
  const isClosed = async (id: string | undefined): Promise<boolean> => {
    if (!id) return false;
    if (!closed.has(id)) {
      const t = await getTask(id).catch(() => null);
      closed.set(id, !!t && (t.phase === 'COMPLETE' || t.status === 'done'));
    }
    return closed.get(id)!;
  };
  const out: StillOpenAsk[] = [];
  for (const r of rows) {
    const fromTaskId = taskOf.get(r.fromSessionId);
    if (await isClosed(fromTaskId) || await isClosed(r.toTaskId)) continue;
    out.push({ id: r.id, ...(fromTaskId ? { fromTaskId } : {}), ...(r.toTaskId ? { toTaskId: r.toTaskId } : {}), preview: r.preview, createdAt: r.createdAt });
  }
  return out;
}

/** What the team asks of the user right now, from the live statuses, each with when it was last
 *  checked (2026-10-28, the user: asks he had already done read to him as fact). */
export function briefNeedsLines(owner: Task, tasks: readonly Task[], now = Date.now()): string[] {
  const flat = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [];
  // Main answers for the whole org: what any task asks the user, with its VP beside it.
  const team = owner.org_role === 'main' ? tasks.filter((t) => !t.plugin_only) : briefTeam(owner, tasks);
  for (const t of team) {
    const s = t.user_status;
    if (t.id === owner.id || t.phase === 'COMPLETE' || t.status === 'done' || s?.state !== 'needs' || !s.ask) continue;
    const checked = s.checkedAt ? Date.parse(s.checkedAt) : NaN;
    const when = s.source !== 'session' ? 'Walnut\'s live record'
      : !Number.isFinite(checked) ? 'never checked'
        : s.unverified ? `NOT VERIFIED: last checked ${agoWords(now - checked)}, the user may have done it already`
          : `checked ${agoWords(now - checked)} by its session`;
    const vp = owner.org_role === 'main' ? briefVpOf(t, tasks) : undefined;
    const vpRef = vp ? ` (VP <task-ref id="${vp.id}" label="${flat(vp.title).replace(/"/g, '&quot;')}"/>)` : '';
    lines.push(`- <task-ref id="${t.id}" label="${flat(t.title).replace(/"/g, '&quot;')}"/>${vpRef}: "${flat(s.ask).slice(0, 200)}" (${when})`);
  }
  return lines.slice(0, 12);
}

/** What is still open in the team (briefStillOpen), as lines for the self-report prompt. */
export function briefStillOpenLines(owner: Task, tasks: readonly Task[], overdue: readonly StillOpenAsk[], now = Date.now()): string[] {
  // Titles and agent words are data inside the prompt: one line each, no markup of their own.
  const flat = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = (t: Task) => `<task-ref id="${t.id}" label="${flat(t.title).replace(/"/g, '&quot;')}"/>`;
  const open = briefStillOpen(owner, tasks, { mentioned: briefMentions(owner.brief?.text ?? ''), overdue, now });
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const span = (ms: number) => {
    const h = Math.max(1, Math.round(ms / 3_600_000));
    return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
  };
  const lines: string[] = [];
  for (const t of open.unmentioned) {
    const state = USER_STATE_LABELS[t.user_status?.state ?? fallbackUserState(t.phase, t.status)];
    lines.push(`- ${ref(t)}: ${state}, not in your last Brief`);
  }
  if (open.moreUnmentioned > 0) lines.push(`- and ${open.moreUnmentioned} more open tasks not in your last Brief`);
  for (const p of open.partial) lines.push(`- ${ref(p.task)}: Partial, not done: ${flat(p.notDone.join('; ')).slice(0, 300)}`);
  for (const r of open.overdue) {
    const from = r.fromTaskId ? byId.get(r.fromTaskId) : undefined;
    const to = r.toTaskId ? byId.get(r.toTaskId) : undefined;
    lines.push(`- a request${from ? ` from ${ref(from)}` : ''}${to ? ` to ${ref(to)}` : ''} is overdue with no reply: "${flat(r.preview).slice(0, 120)}"`);
  }
  for (const d of open.due) lines.push(`- ${ref(d.task)}: ${d.state === 'overdue' ? 'past its due date' : 'due within a day'} (${d.at})`);
  for (const pr of open.promises) lines.push(`- ${ref(pr.task)}: said it waits on or will follow up on "${flat(pr.words).slice(0, 120)}"; Walnut's follow-up is ${pr.at}`);
  for (const w of open.waitingLong) {
    // On the user: when it was last confirmed, so an old ask is never passed on as fact.
    const c = w.on === 'you' ? checkedLine(w.task.user_status, now) : null;
    lines.push(`- ${ref(w.task)}: waiting on ${w.on === 'you' ? 'the user' : 'its lead'} for ${span(now - w.since)}${c ? ` (${c.unverified ? c.text.replace(/^Not verified/, 'NOT VERIFIED') : c.text.charAt(0).toLowerCase() + c.text.slice(1)})` : ''}`);
  }
  return lines;
}

/** The self-report's Brief section (after the FOR_USER lines), for Main and leads only. `vps`
 *  (Main's) are the refs it names beside each worker; `issues` what broke the rules last time. */
export function briefPrompt(opts: {
  hadBrief: boolean; moves: readonly string[]; language?: string; ownId?: string;
  main?: boolean; vps?: readonly string[]; issues?: readonly string[]; stillOpen?: readonly string[];
  /** briefNeedsLines: what the team asks of the user now, with when each was checked. */
  needs?: readonly string[];
}): string {
  const moved = opts.moves.length
    ? `\nSince your last Brief, these moved in your team (Walnut's list; each must be right in the new one):\n${opts.moves.join('\n')}`
    : '';
  const own = opts.ownId ? `<task-ref id="${opts.ownId}" label="..."/>` : 'your own task';
  const refs = opts.main
    ? `EVERY line, the ones that need the user too, names two tasks: first the <task-ref id="..." label="..."/> of the task doing the work, then the <task-ref/> of the VP who leads it (${own} alone for your own work, the VP alone for the VP's own work).${opts.vps?.length ? `\nYour VPs:\n${opts.vps.join('\n')}` : ''}\n`
    : `EVERY line, the ones that need the user too, starts with the <task-ref id="..." label="..."/> of the task it is about (the worker that owns it; ${own} for your own work). `;
  const still = opts.stillOpen?.length
    ? `\nStill open in your team (Walnut's list, from the tasks and requests, not from your memory); cover what needs the user or is at risk, and Walnut shows the rest under your Brief:\n${opts.stillOpen.join('\n')}`
    : '';
  const needs = opts.needs?.length
    ? `\nWhat your team asks of the user now (Walnut's live list, with when each was last checked). Only these need the user; one NOT VERIFIED may be done already: write it as "may be done, being checked", never as a step the user still owes:\n${opts.needs.join('\n')}`
    : '';
  const broke = opts.issues?.length
    ? `\nWalnut found these lines of your last Brief breaking the rules; the new one must not:\n${opts.issues.join('\n')}`
    : '';
  return `
Then your BRIEF, the short letter the user reads at the top of your chat instead of scrolling it. ${opts.hadBrief ? 'Rewrite it whole' : 'Write it'} every time (never "unchanged"): Markdown, at most 12 lines, plain words${opts.language ? `, in ${opts.language}` : ''}. First what needs the user (the decision or action), then one line per piece of work: what is done, what it waits on now and on whom. One thing per line: several asks are several lines, each with its task. ${refs}Each line says enough to act on without the chat: which document, repo or release, and exactly what the user must decide or do. Walnut shows each named task's live status beside it, so name tasks with <task-ref/>, never a bare id, and Walnut checks these rules. ${COMPLETE_IS_VERIFIED} Only what needs the user now or changes their picture of the work: a deadline days away, a reminder or a thing for later goes into your own MEMORY.md (asked below), not here. Plain Markdown with no bold labels around the field name. No codenames, hashes or file names.${needs}${moved}${still}${broke}
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
