/**
 * The user's correction list (config `stt_corrections`): forms the speech engine is
 * known to mishear, mapped to the term the user said, applied to every transcription
 * after it comes back (transcribeAudio, so dictation, phone takes, live pieces and the
 * companion's own engine alike, then once more on a take's joined live pieces; the
 * companion holds the Mac's list through the config copy). 2026-10-28: on 33 of the user's own mixed zh/en takes no local model heard
 * "typo" or "clouddev" right (泰普, Cloud Deep, Claude Dev), and biasing the prompt
 * with more words broke other phrases, so the fix is a plain lookup after the fact.
 *
 *   stt_corrections:
 *     clouddev: [Cloud Deep, Cloud Dev, Claude Dev]
 *     typo: [泰普]
 *
 * A heard form matches case-insensitively, with any spacing between its words
 * ("Cloud Deep" also finds "CloudDeep"), and a Latin edge only at a word edge, so
 * "Dimon" never fires inside "Dimonds". Longer forms go first. A form that would
 * turn one of the terms into something else is left out (one that only changes a
 * term's case, "CloudDev", is kept), so a corrected term is never corrected again.
 */

import { log } from '../../logging/index.js'
import type { Config } from '../types.js'

const MAX_RULES = 500
const MAX_LEN = 100

export interface Correction { term: string; heard: string; re: RegExp }

const LATIN = /[A-Za-z0-9]/
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function pattern(heard: string): RegExp {
  const body = heard.split(/\s+/).map(escape).join('\\s*')
  const head = LATIN.test(heard[0]!) ? '(?<![A-Za-z0-9])' : ''
  const tail = LATIN.test(heard[heard.length - 1]!) ? '(?![A-Za-z0-9])' : ''
  return new RegExp(`${head}${body}${tail}`, 'giu')
}

// Config is read fresh for every call, so the list is cached by its content.
let cached: { key: string; rules: Correction[] } | null = null

/** The list from config, invalid entries left out. */
export function parseCorrections(raw: unknown): Correction[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const key = JSON.stringify(raw)
  if (cached?.key === key) return cached.rules
  const rules: Correction[] = []
  for (const [term, forms] of Object.entries(raw as Record<string, unknown>)) {
    const t = term.trim()
    if (!t || t.length > MAX_LEN) continue
    for (const form of Array.isArray(forms) ? forms : [forms]) {
      if (typeof form !== 'string') continue
      const heard = form.trim()
      if (!heard || heard.length > MAX_LEN) continue
      rules.push({ term: t, heard, re: pattern(heard) })
    }
  }
  rules.sort((a, b) => b.heard.length - a.heard.length)
  const terms = [...new Set(rules.map((r) => r.term))]
  const kept = rules.filter((r) => {
    const rewrites = terms.some((t) => t.replace(r.re, r.term) !== t)
    if (rewrites) log.stt.warn(`stt_corrections: "${r.heard}" left out, it would rewrite a term of the list`)
    return !rewrites
  }).slice(0, MAX_RULES)
  cached = { key, rules: kept }
  return kept
}

/** `text` with every known mishearing replaced by its term. */
export function applyCorrections(text: string, rules: Correction[]): { text: string; applied: number } {
  let applied = 0
  for (const rule of rules) {
    text = text.replace(rule.re, (m) => { if (m !== rule.term) applied++; return rule.term })
  }
  return { text, applied }
}

/** The user's list from `config` applied to one transcription. */
export function correctTranscript(config: Pick<Config, 'stt_corrections'>, text: string): string {
  const fixed = applyCorrections(text, parseCorrections(config.stt_corrections))
  if (fixed.applied) log.stt.info(`Applied ${fixed.applied} correction(s) from stt_corrections`)
  return fixed.text
}
