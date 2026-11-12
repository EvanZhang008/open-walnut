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
 * so), and its writer is answered with them (brief_write) and reads them again in brief_read; a
 * line holding a list of asks is noted too. The checks are kept narrow on purpose: a false hit
 * nags Main and every lead at each write.
 */
import type { BriefTask, TaskBrief } from '../user-status.js';
import { ADDED_MORE_RE, briefVpOf } from './brief-structure.js';
import { matchIdRef } from '../../lib/id-ref.js';
export { briefVpOf };

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

/** A list of independent actions in one line: four or more clauses separated by semicolons.
 *  \u3001 enumerates nouns within one thing; content inside parentheses is detail, not a separate item. */
function severalThings(line: string): string | null {
  const stripped = line.replace(REF_RE, '').replace(/[\uff08(][^\uff09)]*[\uff09)]/g, '');
  const parts = stripped.split(/[;\uff1b]/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  return parts[1] || null;
}

/** The VP over a task for Main's Brief: its project's open lead, never the task itself. */
/**
 * Each <task-ref/> whose id is only the head of a task's id, written out in full (2026-10-27:
 * Main wrote `id="65c5766d"`, and the page drew that pill with no live status: pills, clicks and
 * the VP check all match whole ids). A head two tasks share, or none, is left as written.
 */
export function completeBriefRefs<T extends { text: string }>(brief: T, tasks: readonly { id: string }[]): T {
  const ids = new Set(tasks.map((t) => t.id));
  let changed = false;
  const text = brief.text.replace(REF_RE, (whole, id: string) => {
    if (ids.has(id) || id.length < 6) return whole;
    const hits = matchIdRef(tasks, id);
    if (hits.length !== 1) return whole;
    changed = true;
    return whole.replace(`id="${id}"`, () => `id="${hits[0]!.id}"`);
  });
  return changed ? { ...brief, text } : brief;
}

/** What breaks the rules in this Brief, line by line. `tasks` resolves Main's VPs. */
export function briefIssues(text: string, owner: BriefTask, tasks: readonly BriefTask[]): BriefIssue[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const issues: BriefIssue[] = [];
  for (const line of briefItemLines(text)) {
    if (ADDED_MORE_RE.test(line)) continue;
    const refs = refsOf(line);
    if (!refs.length) { issues.push({ kind: 'no_task', line }); continue; }
    const detail = severalThings(line);
    if (detail) issues.push({ kind: 'several_things', line, detail });
    if (owner.org_role !== 'main') continue;
    // Main's line about a worker names that worker's VP too.
    const work = byId.get(refs[0]!);
    const vp = work && work.id !== owner.id ? briefVpOf(work, tasks) : undefined;
    if (vp && !refs.includes(vp.id)) issues.push({ kind: 'no_vp', line, vp: { id: vp.id, title: vp.title } });
  }
  return issues;
}

const quote = (s: string) => s.replace(/"/g, '&quot;');

/** One line per issue, in the words the writer is asked to fix them with. */
export function formatBriefIssues(issues: readonly BriefIssue[]): string[] {
  return issues.map((i) => {
    const line = i.line.length > 200 ? `${i.line.slice(0, 197)}...` : i.line;
    if (i.kind === 'no_task') return `- names no task (start it with the <task-ref/> of the task it is about): ${line}`;
    if (i.kind === 'several_things') return `- holds several things — "${i.detail}" looks like a separate item (one line each, each with its task): ${line}`;
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
