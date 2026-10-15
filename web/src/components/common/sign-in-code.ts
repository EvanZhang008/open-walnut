/**
 * How the sign-in code field shows what was typed (spec 3.3). Display only:
 * the server normalizes again (src/web/routes/browser-pair.ts).
 *
 * The alphabet mirrors CODE_ALPHABET in src/core/browser-pairing.ts (a vitest
 * pins the two together). It has no 0, 1, I, L or O. A typed one is kept, so
 * the person sees what they typed, and flagged as `badChars`, so the field can
 * say so before a wrong code spends a rate-limit try.
 */

export const SIGN_IN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SIGN_IN_CODE_LENGTH = 8;

export interface FormattedSignInCode {
  /** What the field shows: `ABCD-EFGH`, `ABCD`, `ABCD-E`. */
  display: string;
  /** The code without the dash, at most 8 characters. */
  normalized: string;
  /** True when the code holds a character no code ever uses. */
  badChars: boolean;
}

const PAIR_MARK = '#pair=';

export function formatSignInCode(raw: string): FormattedSignInCode {
  let text = typeof raw === 'string' ? raw : '';
  // A pasted sign-in link: only the part after `#pair=` is the code.
  const mark = text.indexOf(PAIR_MARK);
  if (mark >= 0) text = text.slice(mark + PAIR_MARK.length);
  const normalized = text.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, SIGN_IN_CODE_LENGTH);
  const display = normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
  let badChars = false;
  for (const ch of normalized) {
    if (!SIGN_IN_CODE_ALPHABET.includes(ch)) { badChars = true; break; }
  }
  return { display, normalized, badChars };
}

/** A full code with no character outside the alphabet: the button may submit. */
export function isSubmittableSignInCode(code: FormattedSignInCode): boolean {
  return code.normalized.length === SIGN_IN_CODE_LENGTH && !code.badChars;
}
