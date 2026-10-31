/**
 * What a task mention in text looks like. One rule for every surface that turns
 * a written id into the task's title: the markdown renderer (bare-task-ids.ts),
 * the label store's resolution (entity-label-store.ts) and the Board frame's
 * message renderer (board-markdown.frame.js mirrors TASK_TOKEN_SRC). The phone
 * twin is ios-native/Walnut/Markdown/TaskMentions.swift.
 *
 * Zero imports on purpose: the markdown test tier runs in a bare node env.
 *
 * A task id is `<base36 time>-<4 hex>` (`mvu0ubnq-a02d`) or, for a task synced
 * from another service, a UUID. Sessions also cite a task by the id's first
 * segment (`mvkghc5v`, `2ac88910`): a PREFIX, which names a task only when
 * exactly one id starts with that segment.
 */

/** A standalone token: not glued to a word, a longer dashed token, a path
 *  segment, a file name or an address. Tried in this order: a UUID, a short id,
 *  then a run that may be an id's first segment. */
export const TASK_TOKEN_SRC =
  '(?<![\\w\\-./@#])'
  + '(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{7,10}-[a-f0-9]{4}|[a-z0-9]{7,})'
  + '(?![\\w\\-/@]|\\.\\w)';

const FULL_ID_RE = /^(?:[a-z0-9]{7,10}-[a-f0-9]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The shortest run that may stand for an id. */
export const MIN_PREFIX_LEN = 7;

/** A whole task id in either shape. */
export function isFullTaskId(token: string): boolean {
  return FULL_ID_RE.test(token);
}

/**
 * May this token be the leading segment(s) of a task id? Seven characters or
 * more, lowercase letters and digits (dashes between), not only digits (a
 * number is never one). A base36 time segment is all letters about one time in
 * fourteen (`mpwidref`), so letters alone count; whether it names a task is the
 * store's call: exactly one id must start with `token + '-'`.
 */
export function isTaskPrefixToken(token: string): boolean {
  return token.length >= MIN_PREFIX_LEN && PREFIX_RE.test(token) && /[a-z]/.test(token);
}

/** Worth resolving against the task list: a full id, or a run that may be a prefix. */
export function isTaskTokenCandidate(token: string): boolean {
  return isFullTaskId(token) || isTaskPrefixToken(token);
}

/**
 * Worth asking the server about when the list cannot settle it: a full id, or a
 * prefix with a digit in it. A word of letters alone is only ever matched
 * against the list, or every long word in a reply would be a lookup.
 */
export function isTaskLookupToken(token: string): boolean {
  return isFullTaskId(token) || (isTaskPrefixToken(token) && /\d/.test(token));
}

/** Every candidate token in plain text, in order (duplicates kept). */
export function taskTokensIn(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(TASK_TOKEN_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (isTaskTokenCandidate(m[0])) out.push(m[0]);
  return out;
}
