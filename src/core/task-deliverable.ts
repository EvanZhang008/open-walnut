/**
 * A task's deliverable in one line: what it was made to produce, read from its note's
 * "## User Request" (the session keeps it current), else its description, else its title.
 *
 * Why (2026-11-16, a VP's own review): a lead handed a new incident's fix to an open task
 * whose deliverable was a different code review, because both edited the same file; the
 * target's deliverable was never in front of it. task_get shows this line at the top, and
 * task_send's scope check (sessions/send-scope.ts) quotes it when it refuses.
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

/** The task's deliverable as one line ('' when it has no words at all). */
export function deliverableLine(task: DeliverableSource): string {
  const request = parseNoteSections(str(task.note)).sections['User Request'] ?? '';
  const fromRequest = oneLine(request);
  if (fromRequest) return fromRequest;
  const fromDescription = oneLine(str(task.description).split(/\n\s*\n/)[0] ?? '');
  if (fromDescription) return fromDescription;
  return oneLine(str(task.title));
}
