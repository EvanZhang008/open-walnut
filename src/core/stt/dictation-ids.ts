/**
 * What a person's send carries of its dictations (web/src/utils/dictation-takes.ts):
 *   `dictationIds`   the recording ids (web dictation, tmp/stt-recordings) whose text the composer
 *                    still held when it sent;
 *   `dictationText`  the composer's own text as the person typed it, before Walnut added anything
 *                    (attachment headers, thread lines, quotes, reference tags, hints).
 * Both optional: an older client sends neither (or ids alone), and an older server ignores them.
 * Kept on the queue row (QueuedMessage.dictation) and told on its queued event; Voice Accuracy
 * pairs each named take with the text exactly (compare/sent-text.ts recordSentByIds).
 */

const RECORDING_ID = /^[0-9A-Za-z-]{1,80}$/
const MAX_IDS = 8
/** A box text past this is not kept: the pairing falls back to the message. */
const MAX_TEXT = 20_000

export interface SentDictation { ids: string[]; text?: string }

/** The valid, distinct recording ids of a send's `dictationIds`, at most MAX_IDS; [] for anything else. */
export function dictationIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && RECORDING_ID.test(v)))].slice(0, MAX_IDS)
}

/** A send's dictation fields (an RPC payload, a queued event), or undefined when it names no recording. */
export function dictationOf(data: { dictationIds?: unknown; dictationText?: unknown } | null | undefined): SentDictation | undefined {
  const ids = dictationIdsOf(data?.dictationIds)
  if (!ids.length) return undefined
  const text = typeof data?.dictationText === 'string' && data.dictationText.trim() && data.dictationText.length <= MAX_TEXT ? data.dictationText : undefined
  return { ids, ...(text !== undefined ? { text } : {}) }
}

/** The queued event's fields for a row's dictation (none for a row without one). */
export function dictationEventFields(d: SentDictation | undefined): { dictationIds?: string[]; dictationText?: string } {
  if (!d?.ids.length) return {}
  return { dictationIds: d.ids, ...(d.text !== undefined ? { dictationText: d.text } : {}) }
}
