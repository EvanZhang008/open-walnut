/**
 * A structured reply to a request (2026-10-28, from the multi-agent tracking research, point 2):
 * besides its text, `task_send` with `in_reply_to` may carry
 *
 *   result     one sentence: what came of the work;
 *   evidence   paths or links that show it;
 *   not_done   what is not done or not checked;
 *   score      a review's verdict out of 10: { function, ux, ui } (any of them), kept on the
 *              reviewer's task as `review_score` and read by Usage & Costs' engine comparison.
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
  score?: ReviewScore;
}

/** A review's scores out of 10 (2026-11-06: the user's bar is function 10, UX 9, UI 9). */
export interface ReviewScore {
  function?: number;
  ux?: number;
  ui?: number;
}

export const SCORE_DIMENSIONS = ['function', 'ux', 'ui'] as const;

/** A reviewer task's latest score (Task.review_score): from a reply or the call that completed it. */
export interface TaskReviewScore extends ReviewScore {
  at: string;
  via: 'reply' | 'complete';
  request_id?: string;
  /** When each part was given, when they differ from `at` (a later score that named only some). */
  parts_at?: Partial<Record<(typeof SCORE_DIMENSIONS)[number], string>>;
}

/**
 * A new score merged into the one a task holds, part by part: a part is replaced only by a newer
 * one, and a part the new score does not name is kept (2026-11-06: a full 9/8/9 followed by
 * {ui: 6} kept only the UI). null when nothing changes (a replay, an older score).
 */
export function mergeReviewScore(
  was: TaskReviewScore | undefined,
  next: ReviewScore,
  meta: { at: string; via: 'reply' | 'complete'; request_id?: string },
): TaskReviewScore | null {
  const out: TaskReviewScore = { at: was?.at ?? meta.at, via: was?.via ?? meta.via, ...(was?.request_id ? { request_id: was.request_id } : {}) };
  const partsAt: Partial<Record<(typeof SCORE_DIMENSIONS)[number], string>> = {};
  let changed = false;
  for (const d of SCORE_DIMENSIONS) {
    const old = was?.[d];
    const oldAt = was?.parts_at?.[d] ?? was?.at;
    const v = next[d];
    if (typeof v === 'number' && (old === undefined || !oldAt || Date.parse(meta.at) > Date.parse(oldAt))) {
      if (v !== old || oldAt !== meta.at) changed = true;
      out[d] = v;
      partsAt[d] = meta.at;
    } else if (typeof old === 'number') {
      out[d] = old;
      if (oldAt) partsAt[d] = oldAt;
    }
  }
  if (!changed) return null;
  // The newest write names the score's time, way and request; parts given earlier keep their own time.
  out.at = meta.at;
  out.via = meta.via;
  if (meta.request_id) out.request_id = meta.request_id; else delete out.request_id;
  const differ = SCORE_DIMENSIONS.filter((d) => partsAt[d] && partsAt[d] !== meta.at);
  if (differ.length) out.parts_at = partsAt;
  return out;
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
  /** Giving session, from the resolved caller only; absent = a person or unknown. */
  sessionId?: string;
  /** `local`: a person on the primary gave it (resultWriterOf with no caller header). A `by: human`
   *  without it is an older record, which may be an unresolved session caller: its source is unknown. */
  host?: 'local';
  /** `unknown`: not_done merges an earlier close's held items, so by/sessionId do not cover it. */
  not_done_by?: 'unknown';
  /** The not-done items were taken up or dropped (task_update not_done_settled): no longer Partial. */
  settled?: { at: string; by?: string; how: 'taken' | 'dropped'; note?: string };
  /**
   * What a session's close left for the user (sessions/owed-to-user.ts): the items, also listed in
   * `not_done` while open, and the Needs you ask they make. Open (no `settled`) = the task is held
   * in Needs you whatever its later turns report; a forced close or the not-done settle ends it.
   */
  owed?: TaskOwed;
}

export interface TaskOwed {
  items: string[];
  ask: string;
  at: string;
  by: string;
  /** The tasks whose close was refused with these items named: only they may force it closed. */
  told?: string[];
  settled?: { at: string; by?: string; how: 'taken' | 'dropped'; note?: string };
}

/** A result's writer from what a route resolved: a task only when its caller resolved, never the person when a header came. Pure. */
export function resultWriterOf(actorSid: string | undefined, callerTaskId: string | undefined, callerSessionId?: string): Pick<TaskResultReport, 'by' | 'sessionId' | 'host'> {
  if (callerTaskId) return { by: `task:${callerTaskId}`, ...(callerSessionId ? { sessionId: callerSessionId } : {}) };
  return actorSid ? { by: 'unknown' } : { by: 'human', host: 'local' };
}

/** The open hold a session's close left for the user, if any. */
export function openOwed(r: { owed?: TaskOwed } | null | undefined): TaskOwed | undefined {
  return r?.owed?.items?.length && !r.owed.settled ? r.owed : undefined;
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

/** One score out of 10: a number, or "8" / "8/10" / "7.5"; anything else (or outside 0..10) is none. */
function scoreValue(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim().replace(/\s*\/\s*10$/, '')) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 10) / 10 : undefined;
}

/**
 * A score from an object ({ function: 8, ux: 7.5, ui: 9 }, "UX" in any case) or the text
 * "8/7.5/9" (function/UX/UI in that order); undefined when it names none.
 */
export function readScore(v: unknown): ReviewScore | undefined {
  let raw: Record<string, unknown> = {};
  if (typeof v === 'string') {
    const parts = v.trim().split(/\s*[/,|]\s*/);
    // All three valid, or none: "10/9/11" is no score, never function 10 and UX 9.
    if (parts.length !== 3 || parts.some((p) => scoreValue(p) === undefined)) return undefined;
    raw = { function: parts[0], ux: parts[1], ui: parts[2] };
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) raw[k.toLowerCase()] = x;
  }
  const out: ReviewScore = {};
  for (const d of SCORE_DIMENSIONS) {
    const n = scoreValue(raw[d]);
    if (n !== undefined) out[d] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Why a given `score` is unusable, or null when it is fine (or absent): the HTTP routes refuse it
 * with 400 the way the op's schema does, instead of dropping a dimension without a word.
 */
export function scoreProblem(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const why = 'score must be {"function": n, "ux": n, "ui": n} (any of them, each 0..10) or "n/n/n"';
  if (typeof v === 'string') {
    // All three, each valid: "10/9/11" is refused, never read as function 10 and UX 9.
    const parts = v.trim().split(/\s*[/,|]\s*/);
    const bad = parts.length === 3 ? SCORE_DIMENSIONS.filter((_, i) => scoreValue(parts[i]) === undefined) : [];
    if (parts.length !== 3) return why;
    return bad.length ? `${why}; not 0..10: ${bad.join(', ')}` : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return why;
  const raw = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), x]));
  const unknown = Object.keys(raw).filter((k) => !(SCORE_DIMENSIONS as readonly string[]).includes(k));
  if (unknown.length) return `${why}; unknown: ${unknown.join(', ')}`;
  const bad = SCORE_DIMENSIONS.filter((d) => raw[d] !== undefined && scoreValue(raw[d]) === undefined);
  if (bad.length) return `${why}; not 0..10: ${bad.join(', ')}`;
  return readScore(v) ? null : why;
}

/** "function 8/10, UX 7.5/10, UI 9/10" */
export function scoreLine(s: ReviewScore): string {
  const name = { function: 'function', ux: 'UX', ui: 'UI' } as const;
  return SCORE_DIMENSIONS.filter((d) => s[d] !== undefined).map((d) => `${name[d]} ${s[d]}/10`).join(', ');
}

/** The structured fields of a send's arguments, cleaned; null when it carries none. */
export function readStructuredReply(args: { result?: unknown; evidence?: unknown; not_done?: unknown; score?: unknown }): StructuredReply | null {
  const result = typeof args.result === 'string' && args.result.trim() ? clean(args.result, REPLY_RESULT_MAX) : undefined;
  const evidence = items(args.evidence);
  const notDone = items(args.not_done);
  const score = readScore(args.score);
  if (!result && !evidence && !notDone && !score) return null;
  return { ...(result ? { result } : {}), ...(evidence ? { evidence } : {}), ...(notDone ? { not_done: notDone } : {}), ...(score ? { score } : {}) };
}

/** Whether the arguments name any structured field at all (even an empty one). */
export function hasStructuredFields(args: Record<string, unknown>): boolean {
  return args.result !== undefined || args.evidence !== undefined || args.not_done !== undefined || args.score !== undefined;
}

export function isPartial(r: (StructuredReply & { settled?: unknown; owed?: TaskOwed }) | null | undefined): boolean {
  return (!!r?.not_done?.length && !r.settled) || !!openOwed(r);
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
  if (r.score) parts.push(`Score: ${scoreLine(r.score)}`);
  return parts.join('\n\n');
}

/** The "Partial" line a surface shows: "Partial: iOS not tested; the docs". */
export function partialLine(r: (StructuredReply & { settled?: unknown }) | null | undefined): string | undefined {
  return isPartial(r) ? `Partial: ${(r!.not_done?.length ? r!.not_done : openOwed(r as { owed?: TaskOwed })?.items ?? []).join('; ')}` : undefined;
}
