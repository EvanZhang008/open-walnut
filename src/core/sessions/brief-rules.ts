/**
 * The Brief's rules, checked by Walnut rather than left to each writer's memory (2026-10-27, the
 * user, after a VP's Brief had three "needs you" lines with no task, one of them four things long:
 * "always have a task? also should have enough detail? ... in the CEO, u need to put 2 link
 * 1) the actual task 2) the vp", "this should be a generic rule for walnut").
 *
 *   1. Every line starts with the <task-ref/> of the task it is about; one thing per line.
 *   2. Main's lines name two tasks: the task doing the work, then the VP (project lead) over it.
 *   3. Enough detail to act on without the chat, and only what needs the user now (the rest goes
 *      into the writer's own MEMORY.md): said in the prompt; Walnut cannot judge detail.
 *
 * A Brief whose lines name no task (or, Main's, no VP) is stored with those issues (the page says
 * so) and the writer is asked once, right then, to rewrite it; a line holding a list of asks is
 * noted too. Every next turn-end ask lists what is still wrong. The checks are kept narrow on
 * purpose: a false hit costs a re-ask at every turn end of Main and every lead.
 */
import { pickLead } from '../org/org-tree.js';
import type { BriefTask, TaskBrief } from '../user-status.js';

/** One line that breaks a rule: no task, no VP (Main), several things. */
export type BriefIssue = NonNullable<TaskBrief['issues']>[number];

const REF_RE = /<task-ref\b[^>]*\bid="([^"]+)"[^>]*\/?>/g;

/** A line that introduces items or separates them: a heading, a rule, a bold or colon label. */
function isLabel(line: string): boolean {
  if (/^#+\s/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line) || /^[*_\s]+$/.test(line)) return true;
  if (line.includes('<task-ref')) return false;
  const bare = line.replace(/[*_`]/g, '').trim();
  if (bare.length > 40) return false;
  return /[:\uff1a]$/.test(bare) || /^(\*\*|__)[^*_]+(\*\*|__)[:\uff1a]?$/.test(line);
}

/** "Nothing needs you right now": says no task needs naming. */
function saysNothing(line: string): boolean {
  if (line.includes('<task-ref')) return false;
  const bare = line.replace(/[*_`]/g, '').replace(/^[-*+]\s+/, '').trim();
  return bare.length <= 80 && /\b(?:nothing|none|n\/a)\b|\u6ca1\u6709|\u6682\u65e0|\u65e0\u9700|^\u65e0/i.test(bare);
}

/** The lines that say something: not blank, a label, a rule, or a "nothing" line. */
export function briefItemLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !isLabel(l) && !saysNothing(l));
}

function refsOf(line: string): string[] {
  return [...line.matchAll(REF_RE)].map((m) => m[1]!);
}

/** A list of asks in one line: four or more items (three enumeration commas or semicolons). */
function severalThings(line: string): boolean {
  return (line.replace(REF_RE, '').match(/[\u3001;\uff1b]/g) ?? []).length >= 3;
}

/** The VP over a task for Main's Brief: its project's open lead, never the task itself. */
export function briefVpOf(task: BriefTask, tasks: readonly BriefTask[]): BriefTask | undefined {
  if (!task.project || task.org_role === 'lead' || task.org_role === 'main') return undefined;
  const vp = pickLead(tasks as never[], task.project) as BriefTask | undefined;
  return vp && vp.id !== task.id && vp.phase !== 'COMPLETE' ? vp : undefined;
}

/** What breaks the rules in this Brief, line by line. `tasks` resolves Main's VPs. */
export function briefIssues(text: string, owner: BriefTask, tasks: readonly BriefTask[]): BriefIssue[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const issues: BriefIssue[] = [];
  for (const line of briefItemLines(text)) {
    const refs = refsOf(line);
    if (!refs.length) { issues.push({ kind: 'no_task', line }); continue; }
    if (severalThings(line)) issues.push({ kind: 'several_things', line });
    if (owner.org_role !== 'main') continue;
    // Main's line about a worker names that worker's VP too.
    const work = byId.get(refs[0]!);
    const vp = work && work.id !== owner.id ? briefVpOf(work, tasks) : undefined;
    if (vp && !refs.includes(vp.id)) issues.push({ kind: 'no_vp', line, vp: { id: vp.id, title: vp.title } });
  }
  return issues;
}

/** The issues worth an immediate re-ask: a line with no task or no VP, not seen last time. */
export function briefNeedsRewrite(issues: readonly BriefIssue[], before: readonly BriefIssue[] | undefined): boolean {
  const key = (i: BriefIssue) => `${i.kind}\u0000${i.line}`;
  const seen = new Set((before ?? []).map(key));
  return issues.some((i) => i.kind !== 'several_things' && !seen.has(key(i)));
}

const quote = (s: string) => s.replace(/"/g, '&quot;');

/** One line per issue, in the words the writer is asked to fix them with. */
export function formatBriefIssues(issues: readonly BriefIssue[]): string[] {
  return issues.map((i) => {
    const line = i.line.length > 200 ? `${i.line.slice(0, 197)}...` : i.line;
    if (i.kind === 'no_task') return `- names no task (start it with the <task-ref/> of the task it is about): ${line}`;
    if (i.kind === 'several_things') return `- holds several things (one line each, each with its task): ${line}`;
    return `- names no VP (add <task-ref id="${i.vp!.id}" label="${quote(i.vp!.title)}"/> after the task): ${line}`;
  });
}

/** Main's VPs, for its Brief ask: who leads which project, as the refs to copy. */
export function briefVpLines(owner: BriefTask, tasks: readonly BriefTask[]): string[] {
  if (owner.org_role !== 'main') return [];
  return tasks
    .filter((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE')
    .map((t) => `- <task-ref id="${t.id}" label="${quote(t.title)}"/> leads ${[t.project, ...(t.org_leads ?? [])].filter(Boolean).join(', ')}`);
}

/**
 * The second ask, right after a Brief that broke the rules. A side question does not see the
 * one before it, so this carries the Brief itself and what the first ask gave to write it.
 */
export function briefFixPrompt(opts: {
  text: string; issues: readonly BriefIssue[]; main: boolean; vps?: readonly string[];
  moves?: readonly string[]; language?: string; ownId?: string;
}): string {
  const own = opts.ownId ? `<task-ref id="${opts.ownId}" label="..."/>` : 'your own task';
  return `Walnut checked the Brief you just wrote for the user (below) and these lines break its rules:
${formatBriefIssues(opts.issues).join('\n')}
<brief>
${opts.text}
</brief>
Rewrite the whole Brief now, keeping every line that is right as it is${opts.language ? `, in ${opts.language}` : ''}: every line starts with the <task-ref/> of the task it is about${opts.main ? ', then the <task-ref/> of the VP who leads it' : ''} (${own} for your own work), holds one thing, and says enough to act on without the chat (which document, repo or release, what the user must decide or do).${opts.vps?.length ? `\nYour VPs:\n${opts.vps.join('\n')}` : ''}${opts.moves?.length ? `\nWhat moved in your team since your last Brief:\n${opts.moves.join('\n')}` : ''}
Answer with nothing but:
FOR_USER_BRIEF:
<the letter>`;
}
