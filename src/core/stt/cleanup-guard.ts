/**
 * Guardrails for the dictation cleanup (polish) pass.
 *
 * The cleanup model's contract is "remove fillers and stutters, change
 * nothing else". A small local model occasionally violates it by dropping a
 * real clause (observed with Qwen3-4B: an entire "pick up computer user"
 * fragment deleted). For a feature whose whole point is fidelity, a wrong
 * cleanup is worse than none — so every model output passes these checks and
 * the ORIGINAL text wins any dispute. Worst case equals not having the
 * feature; best case is free readability.
 */

export interface CleanupVerdict {
  ok: boolean;
  reason?: string;
}

/** English fillers the model is SUPPOSED to delete — exempt from the
 *  must-survive rule. Deliberately tiny: a word that ever carries meaning
 *  ("like", "well", "so") stays protected even though it is often filler. */
const ENGLISH_FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'er', 'erm', 'hmm', 'mm', 'mhm']);

/** ASCII-ish tokens (identifiers, English words, numbers) that must survive. */
function latinTokens(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9_.-]*/g) ?? [])
    .map(w => w.toLowerCase())
    .filter(w => !ENGLISH_FILLERS.has(w));
}

export function validateCleanup(original: string, cleaned: string): CleanupVerdict {
  const out = cleaned.trim();
  if (!out) return { ok: false, reason: 'empty output' };
  // Cleanup only ever REMOVES — meaningful growth means the model added words
  // (or answered the text instead of editing it).
  if (out.length > original.length * 1.15 + 20) {
    return { ok: false, reason: 'output grew — model added content' };
  }
  // Fillers and stutters are a modest share of real speech. Losing more than
  // ~35% of the characters means sentences went missing, not just 呃/嗯.
  if (out.length < original.length * 0.65) {
    return { ok: false, reason: 'output shrank too much — content likely dropped' };
  }
  // Chinese must stay Chinese. Fillers (呃/嗯) and stutters only account for a
  // modest share of the CJK characters, so losing half of them means the model
  // translated or paraphrased instead of editing.
  const cjkCount = (s: string) => (s.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const originalCjk = cjkCount(original);
  if (originalCjk >= 4 && cjkCount(out) < originalCjk * 0.5) {
    return { ok: false, reason: 'chinese content lost — model translated or rewrote' };
  }
  // Every distinct latin token (code names, product names, English words) must
  // survive. Dedup first: collapsing a stutter ("computer computer") is fine
  // as long as the word still appears.
  const outTokens = new Set(latinTokens(out));
  for (const tok of new Set(latinTokens(original))) {
    if (!outTokens.has(tok)) {
      return { ok: false, reason: `latin token lost: ${tok}` };
    }
  }
  return { ok: true };
}
