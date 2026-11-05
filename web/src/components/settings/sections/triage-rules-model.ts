/**
 * Settings > Inbox Triage > Routing rules, as plain functions: each rule's lines and the task
 * picker's matches. No React and no network (tests/web/triage-rules-model.test.ts).
 */
import type { TriageRoutingRuleView } from '@/api/triage-rules';

export const ROUTING_COPY = {
  heading: 'Routing rules',
  help: 'Mail or Slack that matches a rule goes straight to its task on every batch. The first matching rule wins.',
  empty: 'No routing rules yet. Add one to send a kind of mail to the task that owns it.',
  add: 'Add rule',
  from: 'Sender contains',
  subject: 'Subject contains',
  task: 'Goes to task',
  note: 'Why (Triage reads this)',
  matchRequired: 'Give a sender or a subject to match.',
  taskRequired: 'Pick the task these items go to.',
  off: 'Inbox triage is off, so these rules route nothing until it is turned on.',
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function day(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

type Author = TriageRoutingRuleView['author'];

function whoOf(a: Author): string {
  return a.by === 'human' ? 'you' : a.name?.trim() || 'a Walnut task';
}

/** `Added by you · Nov 5`, `Added by Walnut VP · Nov 5 · changed by you Nov 6`. */
export function provenanceLine(rule: Pick<TriageRoutingRuleView, 'author' | 'createdBy' | 'createdAt' | 'updatedAt'>): string {
  const added = rule.createdBy ?? rule.author;
  const head = `Added by ${whoOf(added)}${rule.createdAt > 0 ? ` · ${day(rule.createdAt)}` : ''}`;
  if (rule.updatedAt <= rule.createdAt + 1000) return head;
  // "Added by you · Nov 5 · changed by you Nov 5" says nothing new: name a change only by
  // another writer or on another day.
  const sameWriter = whoOf(rule.author) === whoOf(added) && rule.author.taskId === added.taskId;
  if (sameWriter && day(rule.updatedAt) === day(rule.createdAt)) return head;
  return `${head} · changed by ${whoOf(rule.author)} ${day(rule.updatedAt)}`;
}

/** `Routed 3 items, last "Offer letter" · Nov 5`, or `Nothing routed yet`. */
export function routedLine(rule: Pick<TriageRoutingRuleView, 'recent' | 'routedCount'>): string {
  const count = rule.routedCount ?? 0;
  const last = rule.recent?.[0];
  if (!count || !last) return 'Nothing routed yet';
  return `Routed ${count} ${count === 1 ? 'item' : 'items'}, last "${last.item}" · ${day(last.at)}`;
}

/** What the rule's task line says: its live title, or that it is gone or finished. */
export function taskLine(rule: Pick<TriageRoutingRuleView, 'task' | 'taskTitle' | 'taskId'>): { text: string; warn?: string } {
  if (!rule.task) return { text: rule.taskTitle || rule.taskId, warn: 'This task is gone: items stay in the summary.' };
  if (rule.task.phase === 'COMPLETE') return { text: rule.task.title, warn: 'This task is complete: items stay in the summary.' };
  return { text: rule.task.title };
}

export interface PickableTask { id: string; title: string; project?: string; phase: string }

/** Open tasks whose title or project contains every word typed, best (title starts with it) first. */
export function pickTasks(tasks: readonly PickableTask[], query: string, limit = 8): PickableTask[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  // An empty query lists the first open tasks, so the picker offers something on focus.
  const hits = tasks.filter((t) => {
    if (t.phase === 'COMPLETE') return false;
    const hay = `${t.title} ${t.project ?? ''} ${t.id}`.toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const q = query.trim().toLocaleLowerCase();
  hits.sort((a, b) => Number(b.title.toLocaleLowerCase().startsWith(q)) - Number(a.title.toLocaleLowerCase().startsWith(q)));
  return hits.slice(0, limit);
}

type MatchOf = Pick<TriageRoutingRuleView, 'id' | 'match' | 'enabled' | 'matchText'> & {
  taskTitle?: string;
  task?: TriageRoutingRuleView['task'];
};

/** A rule Triage applies now: on, and its task still open (a rule to finished work sits out). */
function applies(r: MatchOf): boolean {
  return r.enabled && (r.task === undefined || (r.task !== null && r.task.phase !== 'COMPLETE'));
}

function covers(outer: string | undefined, inner: string | undefined): boolean {
  if (!outer) return true;
  return !!inner && inner.toLocaleLowerCase().includes(outer.toLocaleLowerCase());
}

/**
 * The earlier enabled rule that matches every item this one would (the first matching rule wins,
 * so this one never fires), or null. A rule `sender contains "acme"` above `sender contains
 * "hr@acme.example"` shadows it; the same match twice does too.
 */
export function shadowingRule<R extends MatchOf>(rules: readonly R[], index: number): R | null {
  const me = rules[index];
  if (!me || !applies(me)) return null;
  for (const earlier of rules.slice(0, index)) {
    if (!applies(earlier)) continue;
    if (covers(earlier.match.from, me.match.from) && covers(earlier.match.subject, me.match.subject)) return earlier;
  }
  return null;
}

/**
 * `Contractor Bob <bob@kitchenpros.example>` as `bob@kitchenpros.example`; other text as typed.
 * Twin of `senderNeedle` in src/core/triage/routing-rules.ts, which stores the same.
 */
export function senderNeedle(raw: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (angle ? angle[1]! : raw).trim();
}
