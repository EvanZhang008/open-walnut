/**
 * Word-level diff between two transcriptions of the SAME audio (engine A/B).
 *
 * Tokenization uses Intl.Segmenter with word granularity, which correctly
 * segments mixed Chinese/English speech (CJK words of 1-3 chars, latin words
 * whole) — plain diffChars would shred English words and diffWords would treat
 * whole CJK runs as single tokens.
 *
 * Changed segments that differ only in punctuation/whitespace are downgraded to
 * `trivial`: engines disagree constantly on ，vs , and 。placement, and painting
 * those as real differences buries the ones that matter (missing words, wrong
 * terms). No AI needed — "important" here is simply "not punctuation".
 */
import { diffArrays } from 'diff';

export interface SttDiffSeg {
  text: string;
  /** same = both engines; a = only engine A (primary); b = only engine B (secondary) */
  kind: 'same' | 'a' | 'b';
  /** Punctuation/whitespace-only change — render dimmed, not highlighted. */
  trivial?: boolean;
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;

export function tokenizeSpeech(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    return Array.from(seg.segment(text), s => s.segment);
  }
  // Environments without Intl.Segmenter: split latin words on whitespace and
  // CJK into single chars.
  return text.match(/[⺀-鿿豈-﫿]|[^\s⺀-鿿豈-﫿]+|\s+/gu) ?? [];
}

export function diffSpeech(a: string, b: string): SttDiffSeg[] {
  const parts = diffArrays(tokenizeSpeech(a), tokenizeSpeech(b));
  return parts.map(p => {
    const text = p.value.join('');
    const kind: SttDiffSeg['kind'] = p.added ? 'b' : p.removed ? 'a' : 'same';
    return kind === 'same'
      ? { text, kind }
      : { text, kind, trivial: PUNCT_ONLY.test(text) || undefined };
  });
}

/** Quick stats for the header: how much actually differs (trivial excluded). */
export function diffStats(segs: SttDiffSeg[]): { aOnly: number; bOnly: number } {
  let aOnly = 0, bOnly = 0;
  for (const s of segs) {
    if (s.trivial) continue;
    if (s.kind === 'a') aOnly += s.text.length;
    if (s.kind === 'b') bOnly += s.text.length;
  }
  return { aOnly, bOnly };
}
