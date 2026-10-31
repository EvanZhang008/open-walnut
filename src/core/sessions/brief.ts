/**
 * The Brief: the short letter Main and every lead keep for the user at the top of their chat
 * (OrgBrief.tsx on the Org page), so the user reads where things stand instead of scrolling the
 * conversation. 2026-10-26, the user: "a persistent letter ... managed by AI ... I can just reply,
 * direct to the chat, this is constantly managed by agent, must be up to date"; "All the leader or
 * main agent, or VP need to utilize this."
 *
 * Only the letter, in three sections (2026-10-30, the user: "brief 就是 AI 写的一个 brief. That's
 * it", with Needs you, Working and Waiting / snoozed: BRIEF_SECTIONS). Kept current by the
 * program, not by the session remembering to: every turn end's self-report asks for it
 * (FOR_USER_BRIEF) and hands it the team's live status as those three lists, and the stored letter
 * is put in that shape (brief-structure.ts). The page shows each task it names with its live
 * status dot; nothing else is added to it.
 */
import {
  BRIEF_MAX_CHARS, BRIEF_SECTIONS, COMPLETE_IS_VERIFIED, agoWords, briefTeam, resultIsPartial, type TaskBrief,
} from '../user-status.js';
import type { Task } from '../types.js';
import { briefVpOf } from './brief-rules.js';
import { BRIEF_STRUCTURE_RULE, briefSectionOf, briefSectionsBlock, type BriefSectionKey } from './brief-structure.js';

export function keepsBrief(task: Pick<Task, 'org_role'>): boolean {
  return task.org_role === 'main' || task.org_role === 'lead';
}

/** Lines per section in the ask; the rest are counted. */
const SECTION_LIST_MAX = 15;

/**
 * The team's open work by the section it belongs in now, as lines for the Brief ask: what each
 * asks of the user (with when it was last checked, 2026-10-28: asks he had done were read to him
 * as fact), what it is doing, what it waits on. Main's Needs you covers the whole org, each with
 * its VP; its Working and Waiting are its VPs and the work below Main.
 */
export function briefSectionLines(owner: Task, tasks: readonly Task[], now = Date.now()): Record<BriefSectionKey, string[]> {
  const flat = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = (t: { id: string; title: string }) => `<task-ref id="${t.id}" label="${flat(t.title).replace(/"/g, '&quot;')}"/>`;
  const main = owner.org_role === 'main';
  const team = briefTeam(owner, tasks);
  const org = main ? tasks.filter((t) => !t.plugin_only && t.id !== owner.id) : team;
  const out: Record<BriefSectionKey, Array<{ line: string; at: number }>> = { needs: [], working: [], waiting: [] };
  const inTeam = new Set(team.map((t) => t.id));
  for (const t of org) {
    const section = briefSectionOf(t);
    if (!section || (section !== 'needs' && !inTeam.has(t.id))) continue;
    const s = t.user_status;
    let words = '';
    if (section === 'needs') {
      const checked = s?.checkedAt ? Date.parse(s.checkedAt) : NaN;
      const when = s?.source !== 'session' ? 'Walnut\'s live record'
        : !Number.isFinite(checked) ? 'never checked'
          : s.unverified ? `NOT VERIFIED: last checked ${agoWords(now - checked)}, the user may have done it already`
            : `checked ${agoWords(now - checked)} by its session`;
      words = `${s?.ask ? `"${flat(s.ask).slice(0, 200)}"` : 'needs the user'} (${when})`;
    } else if (section === 'waiting') {
      // Snoozed (src/core/snooze.ts, on the status itself): its date, and the ask it holds back.
      const snoozed = (s as { snoozed?: { until?: string; ask?: string } } | undefined)?.snoozed;
      const on = s?.waitingOn ?? s?.now;
      if (snoozed?.until) words = `snoozed until ${snoozed.until}${snoozed.ask ? ` (then asks: "${flat(snoozed.ask).slice(0, 160)}")` : ''}`;
      else {
        words = on ? `waits on ${flat(on).slice(0, 160)}` : 'waiting';
        if (s?.until) words += ` (wakes ${s.until})`;
      }
    } else {
      words = s?.now ? flat(s.now).slice(0, 160) : 'working';
    }
    if (resultIsPartial(t.result_report)) words += `; Partial, not done: ${flat(t.result_report!.not_done!.join('; ')).slice(0, 200)}`;
    const vp = main ? briefVpOf(t, tasks) : undefined;
    const at = t.phase_changed_at ? Date.parse(t.phase_changed_at) : 0;
    out[section].push({ line: `- ${ref(t)}${vp ? ` (VP ${ref(vp)})` : ''}: ${words}`, at: Number.isFinite(at) ? at : 0 });
  }
  const lines = {} as Record<BriefSectionKey, string[]>;
  for (const { state } of BRIEF_SECTIONS) {
    const rows = out[state].sort((a, b) => b.at - a.at);
    lines[state] = rows.slice(0, SECTION_LIST_MAX).map((r) => r.line);
    if (rows.length > SECTION_LIST_MAX) lines[state].push(`- and ${rows.length - SECTION_LIST_MAX} more`);
  }
  return lines;
}

/** The self-report's Brief section (after the FOR_USER lines), for Main and leads only. `vps`
 *  (Main's) are the refs it names beside each worker; `issues` what broke the rules last time. */
export function briefPrompt(opts: {
  hadBrief: boolean; language?: string; ownId?: string;
  main?: boolean; vps?: readonly string[]; issues?: readonly string[];
  /** briefSectionLines: the team's open work by section, from the live statuses. */
  sections?: Record<BriefSectionKey, readonly string[]>;
}): string {
  const own = opts.ownId ? `<task-ref id="${opts.ownId}" label="..."/>` : 'your own task';
  const refs = opts.main
    ? `EVERY line names two tasks: first the <task-ref id="..." label="..."/> of the task doing the work, then the <task-ref/> of the VP who leads it (${own} alone for your own work, the VP alone for the VP's own work).${opts.vps?.length ? `\nYour VPs:\n${opts.vps.join('\n')}` : ''}\n`
    : `EVERY line starts with the <task-ref id="..." label="..."/> of the task it is about (the worker that owns it; ${own} for your own work). `;
  const broke = opts.issues?.length
    ? `\nWalnut found these lines of your last Brief breaking the rules; the new one must not:\n${opts.issues.join('\n')}`
    : '';
  return `
Then your BRIEF, the short letter the user reads at the top of your chat instead of scrolling it. ${opts.hadBrief ? 'Rewrite it whole' : 'Write it'} every time (never "unchanged"): Markdown, plain words${opts.language ? `, in ${opts.language}` : ''}, the headings as given. ${BRIEF_STRUCTURE_RULE} Under each heading one line per piece of work: under Needs you exactly what the user must decide or do; under Working what it is doing now; under Waiting / snoozed what it waits on and on whom. One thing per line: several asks are several lines, each with its task. ${refs}Each line says enough to act on without the chat: which document, repo or release, and exactly what the user must decide or do. Only the asks in Walnut's Needs you list need the user; one NOT VERIFIED may be done already: write it as "may be done, being checked", never as a step the user still owes. Name tasks with <task-ref/>, never a bare id. ${COMPLETE_IS_VERIFIED} Keep it to what matters now, at most 15 lines of work: a deadline days away, a reminder or a thing for later goes into your own MEMORY.md (asked below), not here. No bold labels, no codenames, hashes or file names.
Walnut's lists, from each task's live status now (not from your memory):
${briefSectionsBlock(opts.sections)}${broke}
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
