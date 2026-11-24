/**
 * A refusal Walnut writes itself, before any request goes out (the op executor, an op's own
 * handler, the hub's gateway), under the code it is known by. Its message opens as the API's own
 * refusals do ("Walnut API error (<code>): "), so every client names it by that code: the CLI's
 * error (src/providers/tool-call-output.ts opFailureCode), the MCP text, and the failed calls real
 * use counts from what sessions read (core/usage-watch/normalize.ts toolErrorCode).
 *
 * 2026-11-24: 68 failed calls in a day were counted as `bad_request`, the hub's catch-all for an
 * op's own refusal, most of them reply-language refusals whose code only the hub's own record kept;
 * and 33 origin refusals with no code at all were counted as thrown errors.
 * Ratchet: tests/unit/ops/own-refusal-codes.test.ts.
 */

/** How an API refusal's message opens, its code after it. */
export const API_ERROR_OPENING = 'Walnut API error ('

/**
 * Where a caller acts from does not let it run this op or reach this route (origin-policy.ts: health,
 * places and the ops that run only for callers on this Mac): 403 local_only, as human-action-policy.ts
 * answers it, never an error.
 */
export const LOCAL_ONLY_CODE = 'local_only'

/** A text a read shortened, sent back to be stored (answer.ts cutTextRefusal): the rest would be deleted. */
export const SHORTENED_TEXT_CODE = 'shortened_text'

const opened = (code: string, message: string): string => `${API_ERROR_OPENING}${code}): ${message}`

export function ownRefusal<T extends Record<string, unknown>>(code: string, message: string, extra: T): { ok: false; message: string; code: string } & T {
  return { ok: false, message: opened(code, message), code, ...extra }
}

/**
 * What an op's handler throws to refuse under a code: its message already opens with the code, and
 * the executor answers it with that code and `extra` (a 409, a bad argument), never as a thrown error.
 */
export class OwnRefusalError extends Error {
  constructor(readonly code: string, message: string, readonly extra: { invalidArgs?: true; status?: number } = {}) { super(opened(code, message)) }
}
