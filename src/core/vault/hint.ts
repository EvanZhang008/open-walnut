/**
 * The master password hint (docs/reference/passwords.md, "Master password hint"): a line the
 * person writes at setup or in Settings, kept in plain text in vault.json and shown under the
 * unlock screen's password field. It is not a secret, so it must not give the password away.
 *
 * WebCrypto only (crypto.ts), so the web app, the extension and the server share the rule.
 */
import { derivePasswordKey, toB64, type KdfParams } from './crypto.js'

export const HINT_MAX = 100
/** A hint this long or longer may not be part of the password (a shorter one says too little to matter). */
const HINT_PART_MIN = 4

const fold = (s: string) => s.normalize('NFKC').toLowerCase()
const squash = (s: string) => fold(s).replace(/\s+/g, '')

/**
 * A hint as sent: undefined when the field is absent (an older client), '' to have none,
 * else the trimmed text with its whitespace runs made single spaces.
 */
export function readHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.replace(/\s+/g, ' ').trim()
}

/** Why `hint` cannot go with `password`, in words for the person; null when it can (or is empty). */
export function hintProblem(hint: string, password?: string): string | null {
  const h = hint.trim()
  if (!h) return null
  if (h.length > HINT_MAX) return `A hint is at most ${HINT_MAX} characters.`
  if (!password) return null
  const ph = squash(h)
  const pp = squash(password)
  if (!pp) return null
  if (fold(h).includes(fold(password)) || ph.includes(pp)) {
    return 'The hint contains your master password. Anyone who opens the unlock screen reads the hint, so write something that only reminds you of it.'
  }
  if (ph.length >= HINT_PART_MIN && pp.includes(ph)) {
    return 'The hint is part of your master password. Anyone who opens the unlock screen reads the hint, so write something that only reminds you of it.'
  }
  return null
}

/**
 * The server's check when it gets only the password key (the client derived it): a hint whose
 * text, as typed, without spaces, or in lower case, IS the master password derives the same key.
 * The full rule (contains, is part of) runs where the password is typed.
 */
export async function hintIsPasswordKey(hint: string, passwordKey: string, kdf: KdfParams): Promise<boolean> {
  const h = hint.trim()
  if (!h) return false
  const guesses = [...new Set([h, h.replace(/\s+/g, ''), h.toLowerCase(), h.toLowerCase().replace(/\s+/g, '')])]
  const keys = await Promise.all(guesses.map(async (g) => toB64(await derivePasswordKey(g, kdf))))
  return keys.includes(passwordKey)
}
