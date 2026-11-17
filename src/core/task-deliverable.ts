/**
 * What a sender reads to decide, by meaning, whether new work is a task's own deliverable:
 *
 *   deliverable    what it was made to produce: its note's "## User Request" (the session keeps
 *                  it current), else its description, else its title
 *   first_request  the words it was created with (its description's first paragraph), when the
 *                  deliverable line came from somewhere else: a goal that drifted shows here
 *   latest         its newest report, with when: what it is doing or what came of it
 *
 * Why (2026-11-16, a VP's own review): a lead handed a new incident's fix to an open task whose
 * deliverable was a different code review, because both edited the same file; the target's
 * deliverable was never in front of it. A check that matched ticket and review numbers in the
 * message was tried and removed (2026-11-17, the user: too specific to one way of numbering work,
 * and it refused normal follow-ups): the judgment stays the sender's, and these lines make it
 * cheap. task_get, search, task_list's by_meaning rows, task_create's related tasks and
 * task_send's answer all show them.
 */
import { parseNoteSections } from './note-sections.js';

/** Longest line shown: a sentence or two, enough to tell two deliverables apart. */
export const DELIVERABLE_MAX = 280;

type DeliverableSource = { title?: unknown; description?: unknown; note?: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Markdown and bullets out, one line, clipped at a word where it can be. */
function oneLine(text: string): string {
  const flat = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim())
    .filter((l) => l && !/^\(former\)/i.test(l))
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= DELIVERABLE_MAX) return flat;
  const cut = flat.slice(0, DELIVERABLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > DELIVERABLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type RoutingSource = DeliverableSource & { status_report?: unknown; result_report?: unknown; phase?: unknown };

/** One line of at most `max` characters. */
function clip(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The task's deliverable as one line ('' when it has no words at all). */
export function deliverableLine(task: DeliverableSource): string {
  const request = parseNoteSections(str(task.note)).sections['User Request'] ?? '';
  const fromRequest = oneLine(request);
  if (fromRequest) return fromRequest;
  const fromDescription = oneLine(str(task.description).split(/\n\s*\n/)[0] ?? '');
  if (fromDescription) return fromDescription;
  return oneLine(str(task.title));
}

/** Longest `latest` line. */
export const LATEST_MAX = 200;

/** The words the task was created with, when its deliverable line came from its note ('' otherwise). */
export function firstRequestLine(task: DeliverableSource): string {
  const first = oneLine(str(task.description).split(/\n\s*\n/)[0] ?? '');
  if (!first) return '';
  const request = oneLine(parseNoteSections(str(task.note)).sections['User Request'] ?? '');
  return request && request !== first ? first : '';
}

const at = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v : '');

/** Its newest report in one line, led by when ('' when it has none). */
export function latestLine(task: RoutingSource): string {
  const status = (task.status_report ?? {}) as { at?: unknown; now?: unknown; ask?: unknown; state?: unknown };
  const result = (task.result_report ?? {}) as { at?: unknown; result?: unknown };
  const rows = [
    { when: at(result.at), text: str(result.result), kind: 'result' },
    { when: at(status.at), text: str(status.now) || str(status.ask), kind: str(status.state) || 'status' },
  ].filter((r) => r.when && r.text.trim()).sort((a, b) => b.when.localeCompare(a.when));
  const top = rows[0];
  return top ? `${top.when.slice(0, 16).replace('T', ' ')} UTC ${top.kind}: ${clip(top.text, LATEST_MAX)}` : '';
}

export interface RoutingView { deliverable?: string; first_request?: string; latest?: string }

/** The three lines a sender reads before handing a task work, each only when it has words. */
export function routingView(task: RoutingSource): RoutingView {
  const deliverable = deliverableLine(task);
  const first = firstRequestLine(task);
  const latest = latestLine(task);
  return { ...(deliverable ? { deliverable } : {}), ...(first ? { first_request: first } : {}), ...(latest ? { latest } : {}) };
}
