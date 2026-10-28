/**
 * The user's own terms as speech context, found without anyone typing them in.
 *
 * Qwen3-ASR takes a context (the system prompt) that biases it toward the words
 * in it. 2026-10-28, on 33 of the user's mixed zh/en takes: the hand-kept vocab
 * file (7 words, none the user mishears) left 18 of 43 known terms wrong; this
 * context (the vocab file, the 10 terms of the correction list, 30 title words)
 * left 11 wrong with no list applied, 9 with it, at the same speed; 150 words
 * made two takes come back empty. So the context is short and built from what
 * the user already wrote: the vocab file, the terms of the correction list
 * (stt_corrections), up to LEARNED_TERMS learned from the user's own edits, then
 * the English words of their mixed zh/en task titles, most used first, MAX_TERMS
 * in all.
 *
 * The title scan runs off the transcription path: the newest list is cached and
 * refreshed in the background at most once per REFRESH_MS, so a take never waits
 * on it. `stt.auto_context: false` turns the title words off.
 */

import { log } from '../../logging/index.js'
import type { Config } from '../types.js'
import { learnedTerms } from './learn-from-sends.js'

export const MAX_TERMS = 40
export const TITLE_TERMS = 30
const LEARNED_TERMS = 10
const REFRESH_MS = 60 * 60_000
const MIN_USES = 3

const CJK = /[一-鿿]/
const WORD = /[A-Za-z][A-Za-z0-9.+-]*[A-Za-z0-9]/g
// Words that carry no term of their own; a technical word is kept even when it is common.
export const STOP: ReadonlySet<string> = new Set(('the a an and or of to in on for with is are was were be been by at as it its this that these those ' +
  'from not no via vs into out up all one two can how why what when which who will would should could may might must do does ' +
  'did done have has had i you he she we they me my your our their them us if then than so but also only just more most less ' +
  'very any some each every other such same new old here there now get got make made use used using see let like need want ' +
  'know think go going come back over under about after before again still even yes ok okay please thanks http https www com').split(' '))

/** English words of the mixed zh/en titles, most used first (each title counts a word once). */
export function termsFromTitles(titles: Iterable<string>, max = TITLE_TERMS): string[] {
  const uses = new Map<string, number>()
  const spellings = new Map<string, Map<string, number>>()
  for (const title of titles) {
    if (!CJK.test(title)) continue
    const seen = new Set<string>()
    for (const word of title.match(WORD) ?? []) {
      const key = word.toLowerCase()
      if (STOP.has(key) || seen.has(key)) continue
      seen.add(key)
      uses.set(key, (uses.get(key) ?? 0) + 1)
      const forms = spellings.get(key) ?? new Map<string, number>()
      forms.set(word, (forms.get(word) ?? 0) + 1)
      spellings.set(key, forms)
    }
  }
  return [...uses.entries()]
    .filter(([, n]) => n >= MIN_USES)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => [...spellings.get(key)!.entries()].sort((a, b) => b[1] - a[1])[0]![0])
}

/** One list from the sources in order: duplicates (any case) dropped, at most `max`. */
export function mergeTerms(lists: Iterable<string>[], max = MAX_TERMS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const raw of list) {
      const term = raw.trim()
      const key = term.toLowerCase()
      if (!term || term.length > 100 || seen.has(key)) continue
      seen.add(key)
      out.push(term)
      if (out.length >= max) return out
    }
  }
  return out
}

let titleTerms: string[] = []
let refreshedAt = 0
let refreshing: Promise<void> | null = null

async function refreshTitleTerms(): Promise<void> {
  try {
    const { listTaskTitles } = await import('../task-manager.js')
    titleTerms = termsFromTitles(await listTaskTitles())
  } catch (err) {
    log.stt.warn(`speech context: task titles not read (${err instanceof Error ? err.message : String(err)})`)
  } finally {
    refreshedAt = Date.now()
  }
}

/** The title words held now; a stale list starts its refresh and is used meanwhile. */
export function cachedTitleTerms(now = Date.now()): string[] {
  if (now - refreshedAt > REFRESH_MS && !refreshing) {
    refreshing = refreshTitleTerms().finally(() => { refreshing = null })
  }
  return titleTerms
}

/** The context for one transcription: vocab words, correction terms, then title words. */
export function speechContext(config: Pick<Config, 'stt' | 'stt_corrections'>, vocabWords: string[]): string {
  const corrections = config.stt_corrections && typeof config.stt_corrections === 'object' && !Array.isArray(config.stt_corrections)
    ? Object.keys(config.stt_corrections) : []
  const titles = config.stt?.auto_context === false ? [] : cachedTitleTerms()
  // Learned terms are capped so a run of edits never pushes the title words out.
  return mergeTerms([vocabWords, corrections, learnedTerms().slice(0, LEARNED_TERMS), titles]).join(', ')
}

/** Test hook. */
export function _setTitleTermsForTest(terms: string[], at = Date.now()): void {
  titleTerms = terms
  refreshedAt = at
  refreshing = null
}
