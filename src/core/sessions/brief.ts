/**
 * The Brief: the short letter Main and every lead keep for the user at the top of their chat
 * (OrgBrief.tsx on the Org page), so the user reads where things stand instead of scrolling the
 * conversation. 2026-10-26, the user: "a persistent letter ... managed by AI ... I can just reply,
 * direct to the chat, this is constantly managed by agent, must be up to date"; "All the leader or
 * main agent, or VP need to utilize this."
 *
 * Only the letter, in three sections (2026-10-30, the user: "brief 就是 AI 写的一个 brief. That's
 * it", with Needs you, Working and Waiting / snoozed: BRIEF_SECTIONS). Kept current by the
 * node itself, a document it edits any time (brief-write.ts, 2026-10-31); Walnut reminds it (the
 * `brief` message hint), hands it the team's live status as those three lists and these rules
 * (brief_read), and every write is put in that shape (brief-structure.ts). The page shows each
 * task it names with its live status dot.
 */
import {
  BRIEF_SECTIONS, storedUserState, COMPLETE_IS_VERIFIED, agoWords, briefTeam, resultIsPartial,
} from '../user-status.js';
import type { Task } from '../types.js';
import { statusDecision } from '../ask-decision.js';
import { briefVpOf } from './brief-rules.js';
import { BRIEF_STRUCTURE_RULE, briefSectionOf, briefSectionsBlock, type BriefSectionKey } from './brief-structure.js';
import { sameAreaTasks } from '../router/same-area.js';

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
/** Every task in the node's Needs you section now, with its ask (the same scope as the list below). */
export function briefNeedsAsks(owner: Task, tasks: readonly Task[]): Record<string, string> {
  const main = owner.org_role === 'main';
  // Only the owner's own area (router/same-area.ts): an unscoped Main never reads an area task's ask.
  const org = sameAreaTasks(owner, main ? tasks.filter((t) => !t.plugin_only && t.id !== owner.id) : briefTeam(owner, tasks));
  const out: Record<string, string> = {};
  for (const t of org) {
    const us = t.user_status;
    const words = us && storedUserState(us) === 'read' ? us.waitingOn : us?.ask;
    if (briefSectionOf(t) === 'needs') out[t.id] = (words ?? 'needs the user').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return out;
}

/** The decision of each ask briefNeedsAsks lists, when it has one (ask-decision.ts): task id -> key. */
export function briefNeedsDecisions(owner: Task, tasks: readonly Task[]): Record<string, string> {
  const main = owner.org_role === 'main';
  const org = main ? tasks.filter((t) => !t.plugin_only && t.id !== owner.id) : briefTeam(owner, tasks);
  const out: Record<string, string> = {};
  for (const t of org) {
    const decision = briefSectionOf(t) === 'needs' ? statusDecision(t.user_status) : null;
    if (decision) out[t.id] = decision.key;
  }
  return out;
}

export function briefSectionLines(owner: Task, tasks: readonly Task[], now = Date.now()): Record<BriefSectionKey, string[]> {
  const flat = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = (t: { id: string; title: string }) => `<task-ref id="${t.id}" label="${flat(t.title).replace(/"/g, '&quot;')}"/>`;
  const main = owner.org_role === 'main';
  // The team is read on every task (a chain may pass through any), then kept to the owner's area.
  const team = sameAreaTasks(owner, briefTeam(owner, tasks));
  const org = main ? sameAreaTasks(owner, tasks.filter((t) => !t.plugin_only && t.id !== owner.id)) : team;
  const out: Record<BriefSectionKey, Array<{ line: string; at: number }>> = { needs: [], working: [], waiting: [] };
  const inTeam = new Set(team.map((t) => t.id));
  for (const t of org) {
    const section = briefSectionOf(t);
    if (!section || (section !== 'needs' && !inTeam.has(t.id))) continue;
    const s = t.user_status;
    let words = '';
    if (section === 'needs' && s && storedUserState(s) === 'read') {
      words = s.waitingOn ? `to read: ${flat(s.waitingOn).slice(0, 160)}` : 'to read';
    } else if (section === 'needs') {
      const checked = s?.checkedAt ? Date.parse(s.checkedAt) : NaN;
      // A Board choice is checked like a session's own ask (its write on the Board is its check).
      const by = s?.source === 'choice' ? 'on its Board' : 'by its session';
      const when = s?.source !== 'session' && s?.source !== 'choice' ? 'Walnut\'s live record'
        : !Number.isFinite(checked) ? (s.unverified ? 'NOT VERIFIED: never checked, the user may have done it already' : 'never checked')
          : s.unverified ? `NOT VERIFIED: last checked ${agoWords(now - checked)}, the user may have done it already`
            : `checked ${agoWords(now - checked)} ${by}`;
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
    const vp = main ? briefVpOf(t, sameAreaTasks(owner, tasks)) : undefined;
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

/** How to write the Brief, returned with it by brief_read (GET /api/v1/tasks/:id/brief) for Main
 *  and the leads. `vps` (Main's) are the refs it names beside each worker; `issues` what broke the
 *  rules in the stored letter; `sections` the team's open work from the live statuses. */
export function briefRules(opts: {
  hadBrief: boolean; language?: string; ownId?: string;
  main?: boolean; vps?: readonly string[]; issues?: readonly string[];
  /** briefSectionLines: the team's open work by section, from the live statuses. */
  sections?: Record<BriefSectionKey, readonly string[]>;
}): string {
  const own = opts.ownId ? `<task-ref id="${opts.ownId}" label="..."/>` : 'your own task';
  const refs = opts.main
    ? `EVERY line names two tasks: first the <task-ref id="..." label="..."/> of the task doing the work, then the <task-ref/> of the VP who leads it (${own} alone for your own work, the VP alone for the VP's own work).${opts.vps?.length ? `\nYour VPs:\n${opts.vps.join('\n')}` : ''}\n`
    : `EVERY line starts with the <task-ref id="..." label="..."/> of the task it is about (the worker that owns it; ${own} for your own work). `;
  // Main's brief_read carries `health` (core/health-monitor healthBriefLine): its alarms are lines like any work.
  const health = opts.main
    ? 'Walnut\'s own health comes as `health` beside these lists: each alarm in ALARM is one line, under Working with its fix task\'s <task-ref/> (Walnut fixes it), or under Needs you only when it says it told the user; no alarm, no line. '
    : ''
  const broke = opts.issues?.length
    ? `\nWalnut found these lines of your Brief breaking the rules; fix them:\n${opts.issues.join('\n')}`
    : '';
  return `Your BRIEF is the short letter the user reads at the top of your chat instead of scrolling it. ${opts.hadBrief ? 'Edit the lines that changed' : 'Write it'} with brief_write: Markdown, plain words${opts.language ? `, in ${opts.language}` : ''}, the headings as given. ${BRIEF_STRUCTURE_RULE} Under each heading one line per piece of work: under Needs you exactly what the user must decide or do; under Working what it is doing now; under Waiting / snoozed what it waits on and on whom. One thing per line: several asks are several lines, each with its task. ${refs}Each line says enough to act on without the chat: which document, repo or release, and exactly what the user must decide or do. Only the asks in Walnut's Needs you list need the user; one NOT VERIFIED may be done already: write it as "may be done, being checked", never as a step the user still owes. Name tasks with <task-ref/>, never a bare id. ${COMPLETE_IS_VERIFIED} Keep it to what matters now, at most 15 lines of work: a deadline days away, a reminder or a thing for later goes into your own memory, not here. No bold labels, no codenames, hashes or file names. ${health}Walnut removes a finished task's line and adds any ask you left out, in that task's own words.
Walnut's lists, from each task's live status now (not from your memory):
${briefSectionsBlock(opts.sections)}${broke}`;
}
