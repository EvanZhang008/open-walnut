/**
 * A structured reply to a request (2026-10-28, from the multi-agent tracking research, point 2):
 * besides its text, `task_send` with `in_reply_to` may carry
 *
 *   result     one sentence: what came of the work;
 *   evidence   paths or links that show it;
 *   not_done   what is not done or not checked.
 *
 * A reply whose `not_done` is not empty is PARTIAL: the Board and the Brief say so and list
 * what is missing, so "one test still not run" never drowns in a long answer. The asker reads
 * the same words in the delivered text (composeReplyText), so a reader that knows nothing of
 * the fields (an older daemon, the phone) still sees all of it.
 *
 * Pure: the server, the CLI and the web app import it.
 */

export interface StructuredReply {
  result?: string;
  evidence?: string[];
  not_done?: string[];
}

/**
 * A task's latest result, kept on the task (Task.result_report): from its session's reply to a
 * request (`via: 'reply'`) or from the call that completed it (`via: 'complete'`). The newest one
 * wins, so a full answer after a partial one clears the Partial mark.
 */
export interface TaskResultReport extends StructuredReply {
  via: 'reply' | 'complete';
  /** When it was given (ISO). */
  at: string;
  /** via reply: the request it answered, and the asker's task when known. */
  request_id?: string;
  to_task_id?: string;
  /** Who gave it: 'human', or 'task:<id>' for a session. */
  by?: string;
  /** The not-done items were taken up or dropped (task_update not_done_settled): no longer Partial. */
  settled?: { at: string; by?: string; how: 'taken' | 'dropped'; note?: string };
}

export const REPLY_RESULT_MAX = 600;
export const REPLY_ITEM_MAX = 400;
export const REPLY_ITEMS_MAX = 20;

function clean(s: string, max: number): string {
  const one = s.replace(/\r\n?/g, '\n').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one;
}

/** A list field from a string (one item per line, "- " bullets dropped) or an array of strings. */
function items(v: unknown): string[] | undefined {
  const raw = typeof v === 'string' ? v.split('\n') : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const out = raw.map((s) => clean(s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), REPLY_ITEM_MAX)).filter(Boolean).slice(0, REPLY_ITEMS_MAX);
  return out.length ? out : undefined;
}

/** The structured fields of a send's arguments, cleaned; null when it carries none. */
export function readStructuredReply(args: { result?: unknown; evidence?: unknown; not_done?: unknown }): StructuredReply | null {
  const result = typeof args.result === 'string' && args.result.trim() ? clean(args.result, REPLY_RESULT_MAX) : undefined;
  const evidence = items(args.evidence);
  const notDone = items(args.not_done);
  if (!result && !evidence && !notDone) return null;
  return { ...(result ? { result } : {}), ...(evidence ? { evidence } : {}), ...(notDone ? { not_done: notDone } : {}) };
}

/** Whether the arguments name any structured field at all (even an empty one). */
export function hasStructuredFields(args: Record<string, unknown>): boolean {
  return args.result !== undefined || args.evidence !== undefined || args.not_done !== undefined;
}

export function isPartial(r: (StructuredReply & { settled?: unknown }) | null | undefined): boolean {
  return !!r?.not_done?.length && !r.settled;
}

/**
 * The text the asker reads: the reply's own text (or its result when it has none), then the
 * fields as plain sections. A field the text already ends with is not repeated.
 */
export function composeReplyText(text: string | undefined, r: StructuredReply | null): string {
  const body = (text ?? '').trim();
  if (!r) return body;
  const parts: string[] = [];
  if (body) parts.push(body);
  if (r.result && r.result !== body) parts.push(`Result: ${r.result}`);
  if (r.evidence?.length) parts.push(`Evidence:\n${r.evidence.map((e) => `- ${e}`).join('\n')}`);
  if (r.not_done?.length) parts.push(`Not done (partial reply):\n${r.not_done.map((e) => `- ${e}`).join('\n')}`);
  return parts.join('\n\n');
}

/** The "Partial" line a surface shows: "Partial: iOS not tested; the docs". */
export function partialLine(r: (StructuredReply & { settled?: unknown }) | null | undefined): string | undefined {
  return isPartial(r) ? `Partial: ${r!.not_done!.join('; ')}` : undefined;
}
