/**
 * The choices a person picks from with one click, as every writer hands them in: a report's
 * ask_options (sessions/report-set.ts) and a thread's options (org/threads-model.ts). One reader, so
 * a choice reads the same wherever it is shown (2026-11-20, the user, on a thread whose summary
 * listed A (recommended) and B with only Acknowledge under it: "why not give me some options ...
 * then I can just click").
 *
 * Each entry is a label, or { id?, label, detail?, recommended? }: a label of 1 to 80 characters, an
 * id of letters, digits, `_` or `-` (else `o1`, `o2`...), unique; a line of detail, cut to 200 (one
 * that is no string is dropped: a report's ask_options took none before and never failed on it). How
 * many a place takes is its own rule (2 to ASK_OPTIONS_MAX for a choice). Pure.
 */
import { ASK_OPTIONS_MAX, type AskOption } from './user-status.js';

export const ASK_OPTION_LABEL_MAX = 80;
export const ASK_OPTION_DETAIL_MAX = 200;

export class AskOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskOptionsError';
  }
}

/** The options of `raw` (absent or null: none), checked; `field` names them in an error. Throws AskOptionsError. */
export function readAskOptions(raw: unknown, field: string): AskOption[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AskOptionsError(`${field} is a list of options`);
  const options = raw.map((o: unknown, i: number): AskOption => {
    const obj = typeof o === 'string' ? { label: o } : (o ?? {}) as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.replace(/\s+/g, ' ').trim() : '';
    if (!label || label.length > ASK_OPTION_LABEL_MAX) throw new AskOptionsError(`each ${field} entry has a label of 1 to ${ASK_OPTION_LABEL_MAX} characters`);
    const id = typeof obj.id === 'string' && /^[\w-]{1,40}$/.test(obj.id) ? obj.id : `o${i + 1}`;
    const detail = typeof obj.detail === 'string' ? obj.detail.replace(/\s+/g, ' ').trim().slice(0, ASK_OPTION_DETAIL_MAX) : '';
    return { id, label, ...(detail ? { detail } : {}), ...(obj.recommended === true ? { recommended: true } : {}) };
  });
  if (new Set(options.map((o) => o.id)).size !== options.length) throw new AskOptionsError(`${field} ids are unique`);
  return options;
}

/** A choice offers 2 to ASK_OPTIONS_MAX options. Throws AskOptionsError. */
export function checkChoiceCount(options: readonly AskOption[], field: string): void {
  if (options.length < 2 || options.length > ASK_OPTIONS_MAX) throw new AskOptionsError(`${field} takes 2 to ${ASK_OPTIONS_MAX} options`);
}

/** The recommended ones first, each group in the writer's order. Pure. */
export function recommendedFirst<T extends { recommended?: boolean }>(options: readonly T[]): T[] {
  return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
}

/** Stored options read back leniently (a hand edit, an older build): the valid shape, else none. Pure. */
export function storedOptions(raw: unknown): AskOption[] | undefined {
  try {
    const list = readAskOptions(raw, 'options');
    return list.length >= 2 && list.length <= ASK_OPTIONS_MAX ? list : undefined;
  } catch {
    return undefined;
  }
}
