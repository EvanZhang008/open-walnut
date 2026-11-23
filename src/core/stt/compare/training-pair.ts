/**
 * Which takes are training pairs (exported by pairs.ts, kept longest by the store): paired exactly
 * by recording id, edited, from one dictation's own composer text, with both texts, and the sent text
 * is that dictation edited, nothing more. A send that named several takes holds all of their words
 * (`sentShared`); one that came without the composer's own text holds Walnut's additions
 * (`sentFrom: 'message'`); one with words typed before or after the dictation (`sentExtra`, or no
 * `sentSimilarity` judged) holds words never said. None of them is a transcript of one recording.
 */
import type { CompareTake } from './types.js'

/** At least this share of the tokens in common: below it the send is a rewrite, not an edit. */
export const TRAINING_MIN_SIMILARITY = 0.6

export function isTrainingPair(take: CompareTake): boolean {
  return take.edited === true && take.sentMatch === 'recording-id' && take.sentShared !== true && take.sentFrom === undefined
    && take.sentExtra !== true && typeof take.sentSimilarity === 'number' && take.sentSimilarity >= TRAINING_MIN_SIMILARITY
    && typeof take.sentText === 'string' && typeof take.inUseText === 'string'
}
