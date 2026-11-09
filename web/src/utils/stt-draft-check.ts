/**
 * How far the text a dictation ended with is from the whole recording's text,
 * for the log line that makes a new loss in the live audio show at once
 * (2026-11-08: the live draft had been losing words in the Mac app for days
 * before anyone noticed).
 *
 * Words are compared, punctuation and spacing ignored. The text heard the
 * recording to its last byte, so words the recording has after its end count
 * as missing too: a lost last sentence is the loss this check is for.
 */
import { diffArrays } from 'diff';
import { tokenizeSpeech } from './stt-diff';

const WORD = /[\p{L}\p{N}]/u;
/** Above this share of wrong or missing words, the draft and the recording disagree. */
const MISMATCH_PCT = 20;

export interface DraftMismatch {
  /** Share of the draft's words the recording does not have. */
  wrongPct: number;
  /** Share of the recording's words the draft lacks. */
  missingPct: number;
  mismatch: boolean;
}

export function draftMismatch(draft: string, final: string): DraftMismatch {
  const words = (t: string) => tokenizeSpeech(t.toLowerCase()).filter((w) => WORD.test(w));
  const parts = diffArrays(words(draft), words(final));
  let same = 0, wrong = 0, missing = 0;
  for (const p of parts) {
    if (p.added) missing += p.count ?? p.value.length;
    else if (p.removed) wrong += p.count ?? p.value.length;
    else same += p.count ?? p.value.length;
  }
  const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);
  const wrongPct = pct(wrong, same + wrong);
  const missingPct = pct(missing, same + missing);
  return { wrongPct, missingPct, mismatch: wrongPct > MISMATCH_PCT || missingPct > MISMATCH_PCT };
}
