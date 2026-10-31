/**
 * How one ask of the Org rail (OrgTaskRail.tsx) reads and answers, pure (2026-10-31, the user: "show
 * the summay of the issue veyr clear, with potentially a more secino", and an answer "so user can
 * just click ... yes and noe, or single or multiple choice, or text right, ideally prefer non
 * text"). The ask's shape comes from the task that asks: `user_status.askForm` (its turn-end report,
 * or its lead's), else the structure of where the ask lives (a live prompt, a letter's actions, a
 * Board choice), else its plain words, which take a line of text.
 */
import type { Task } from '@open-walnut/core';
import { askAnswerText, type AskForm, type AskKind, type AskOption, type StatusLine } from '@open-walnut/user-status';
import { answerShape, type AnswerShape } from './org-answer-shape';
import type { OrgAlertView } from './org-channels-model';

export type { AskForm, AskKind, AskOption, StatusLine };

const KINDS: readonly AskKind[] = ['yes_no', 'single', 'multi', 'text'];
/** A summary longer than this is cut, and the whole text goes under More. */
export const SUMMARY_MAX = 120;

/** The stored ask form (user_status.askForm), when it is one this page can draw (a writer older or
 *  newer than this page may store another shape: that ask falls back to its words). */
export function readAskForm(status: unknown): AskForm | undefined {
  const f = (status as { askForm?: unknown } | null | undefined)?.askForm as Partial<AskForm> | undefined;
  if (!f || typeof f.summary !== 'string' || !f.summary.trim() || !KINDS.includes(f.kind as AskKind)) return undefined;
  // Each id once: an id is the option's key and what a pick sends.
  const seen = new Set<string>();
  const options = Array.isArray(f.options)
    ? f.options.filter((o): o is AskOption => !!o && typeof o.id === 'string' && typeof o.label === 'string' && !!o.label.trim() && !seen.has(o.id) && !!seen.add(o.id))
    : [];
  const summary = f.summary.trim();
  const more = typeof f.more === 'string' && f.more.trim() ? { more: f.more.trim() } : {};
  if ((f.kind === 'single' || f.kind === 'multi') && options.length < 2) return { summary, ...more, kind: 'text' };
  return { summary, ...more, kind: f.kind as AskKind, ...(options.length ? { options } : {}) };
}

export function readStatusLine(status: unknown): StatusLine | undefined {
  const l = (status as { line?: unknown } | null | undefined)?.line as Partial<StatusLine> | undefined;
  if (!l || typeof l.text !== 'string' || !l.text.trim()) return undefined;
  const by = typeof l.by === 'string' && (l.by === 'self' || l.by === 'human' || l.by.startsWith('task:')) ? l.by : 'self';
  return { text: l.text.trim(), by: by as StatusLine['by'], ...(l.byName ? { byName: l.byName } : {}), at: typeof l.at === 'string' ? l.at : '' };
}

/** Who set a row's line, when it was not the task itself: "set by Walnut VP", "set by you". */
export function lineSetBy(line: StatusLine | undefined): string | null {
  if (!line || line.by === 'self') return null;
  return line.by === 'human' ? 'set by you' : `set by ${line.byName || 'its lead'}`;
}

/** The words of an ask with none of its own: what kind of ask it is. */
export function askWords(a: OrgAlertView): string {
  return a.ask?.trim() || (a.kind === 'question' ? 'Asks you a question'
    : a.kind === 'permission' ? `Wants approval${a.tool ? ` (${a.tool})` : ''}` : a.kind === 'error' ? 'Its session failed' : 'Needs you');
}

/** The row's one clear line, and the detail under More. Never empty: a Needs you row always says
 *  what it asks (2026-10-31, the user: "u need to show what are actually waiting"). */
export function askSummary(a: OrgAlertView): { summary: string; more?: string } {
  if (a.form) return { summary: a.form.summary, ...(a.form.more ? { more: a.form.more } : {}) };
  const text = askWords(a).replace(/\r\n/g, '\n');
  const first = text.split('\n')[0]!.trim();
  if (first.length <= SUMMARY_MAX && first === text.trim()) return { summary: first };
  // The first sentence when it is short enough, else the head of the line.
  // A full-width mark ends a sentence with no space after it.
  const sentence = first.match(/^.{8,}?(?:[.?!](?=\s|$)|[。？！])/)?.[0];
  const head = sentence && sentence.length <= SUMMARY_MAX ? sentence : first.length <= SUMMARY_MAX ? first : `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  return { summary: head, more: text.trim() };
}

/** How the row answers: where the ask lives decides first (its prompt, letter, Board choice), then
 *  the form its task gave it, then a line of words. */
export type InlineShape = Exclude<AnswerShape, 'words'> | AskKind;
export function inlineShape(a: OrgAlertView): InlineShape {
  const where = answerShape(a);
  if (where !== 'words') return where;
  if (a.kind === 'error') return 'text';
  return a.form?.kind ?? 'text';
}

/** The choices of a form: Yes / No for a yes_no (ids `yes`, `no`), else its own. */
export function formOptions(form: AskForm | undefined): AskOption[] {
  if (!form) return [];
  if (form.kind === 'yes_no') return [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
  return form.kind === 'text' ? [] : form.options ?? [];
}

/** The one message an answer sends into the task's session: the status foundation's own wording
 *  (askAnswerText), so the task reads every answer the same way. An ask with no form takes its
 *  summary as one. */
export function answerMessage(form: AskForm | undefined, summary: string, answer: { picked?: string[]; words?: string }): string {
  return askAnswerText(form ?? { summary, kind: 'text' }, answer);
}

/** The ask's form for its alert view, read from the task's stored status. */
export function alertForm(task: Pick<Task, 'user_status'> | undefined): AskForm | undefined {
  return readAskForm(task?.user_status);
}
