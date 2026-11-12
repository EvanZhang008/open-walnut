/**
 * No credential in a letter: a letter is written to the data folder, which syncs to
 * the user's other machines, and the sync's own scan (integrations/git-sync-secrets.ts)
 * holds back any file that looks like it carries one. So a letter with a credential
 * never reached the other machines, and the user got a second letter, from the sync,
 * about the first (2026-11-12: a backup task wrote a Google OAuth client secret into
 * its letter, and the sync held lt-...md back). The same scan now runs when the letter
 * is written, and the sender gets the refusal while it can still take the value out.
 *
 * `redactLetterLines` is the way out for a letter written before this check: the lines
 * the scan flags are replaced, so the file syncs again.
 */
import { findSecretsInText, findSecretsInTextAsync, type SecretFinding } from '../../integrations/git-sync-secrets.js'

export interface LetterCredential {
  /** Where it is: `markdown`, `subject`, `actions[0].label`, ... */
  field: string
  /** The scan's rule id (`google-oauth-secret`), never the value. */
  kind: string
  /** 1-based line within that field. */
  line: number
}

/** Fields never written by the sender: stamped by Walnut, or a reference to staged bytes. */
const NOT_TEXT = new Set(['sender', 'htmlRef', 'html_ref', 'taskRefs', 'task_refs'])

/** Every string the sender wrote, with its path (`items[2].summary`). */
export function letterTextFields(input: unknown): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = []
  const walk = (v: unknown, at: string, depth: number): void => {
    // Every field: a letter's own caps (items, actions, bytes) already bound how many there are.
    if (depth > 8) return
    if (typeof v === 'string') { if (v) out.push({ field: at, text: v }); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (depth === 0 && NOT_TEXT.has(k)) continue
        walk(x, at ? `${at}.${k}` : k, depth + 1)
      }
    }
  }
  walk(input, '', 0)
  return out
}

/** The credentials in a letter's text (and, for a staged body, its bytes). */
export async function credentialsInLetter(input: unknown, stagedBody?: { field: string; text: string }): Promise<LetterCredential[]> {
  const found: LetterCredential[] = []
  const add = (field: string, list: SecretFinding[]) => { for (const f of list) found.push({ field, kind: f.kind, line: f.line }) }
  for (const { field, text } of letterTextFields(input)) add(field, await findSecretsInTextAsync(text))
  if (stagedBody) add(stagedBody.field, await findSecretsInTextAsync(stagedBody.text))
  return found
}

/** The sender's error: where each one is, and what to write instead. */
export function credentialRefusal(found: LetterCredential[], what: 'letter' | 'reply' = 'letter'): string {
  const where = found.slice(0, 5).map((f) => `${f.kind} in ${f.field}, line ${f.line}`).join('; ')
  return `This ${what} holds a credential (${where}). Letters sync to the user's other machines, and the sync holds back a file with a credential, so it would not reach them. `
    + 'Leave the value out: say where it is kept instead (a file path on this machine, Settings, the secrets store). Nothing was sent.'
}

/** What replaces a flagged line. */
export const REDACTED_LINE = '[A credential was removed from this line. It is kept where the letter says, not in the letter.]'

/** `text` with every line the scan flags replaced; `count` 0 means it was clean. */
export function redactLetterLines(text: string): { text: string; count: number } {
  const lines = text.split('\n')
  let count = 0
  // One scan reports at most 20 findings: scan again until clean (a bounded number of passes).
  for (let pass = 0; pass < 20; pass++) {
    const hits = [...new Set(findSecretsInText(lines.join('\n')).map((f) => f.line - 1))].filter((i) => lines[i] !== REDACTED_LINE)
    if (hits.length === 0) break
    for (const i of hits) {
      // A private key flags its BEGIN line only: its body lines go too, up to its END line.
      const end = /PRIVATE KEY/.test(lines[i]) ? lines.findIndex((l, j) => j > i && /-----END [A-Z0-9 ]*PRIVATE KEY/.test(l)) : -1
      for (let j = i; j <= (end === -1 ? i : end); j++) lines[j] = REDACTED_LINE
      count++
    }
  }
  return { text: lines.join('\n'), count }
}
