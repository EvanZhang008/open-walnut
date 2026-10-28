/**
 * The correction list learns from the user's own edits: when a message the user
 * sends is a dictation they fixed by hand ("我说泰文，我说泰普" sent as
 * "我说泰文，我说typo"), the changed span is a mishearing of the term they typed.
 *
 * Each dictation's text is held here for WINDOW_MS (noteDictation, called where a
 * transcript lands: the voice archive and web dictation). A person's send that
 * mostly matches one of them (MIN_SHARE of its tokens in place) and changes at
 * most MAX_PAIRS short spans into English words yields those pairs; the dictation
 * is then used up. A grammar edit ("is" to "was", "PR" to "PRs") is not a
 * mishearing and is skipped. The term joins the speech context at once
 * (user-terms.ts, a soft bias); the pair is written into config stt_corrections,
 * a hard replacement, only once it was seen on SIGHTING_DAYS different days, and
 * only on the leader, whose config the followers copy.
 * 2026-10-28: of 35 phone takes the user sent on in a month, 2 were fixed by hand,
 * one of them exactly 泰普 -> typo; a spoken correction is not learned.
 */

import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { STOP } from './user-terms.js'

const WINDOW_MS = 15 * 60_000
const MAX_HELD = 20
const MAX_TOKENS = 800
const MIN_SHARE = 0.6
const MAX_PAIRS = 3
const SIGHTING_DAYS = 2
const MAX_LEARNED = 500
const SEEN_IDS = 200

export interface EditPair { heard: string; term: string }
interface Learned { term: string; heard: string; count: number; at: string; days?: string[] }

const held: { text: string; at: number }[] = []
const seenIds: string[] = []

/** A transcript the user may now send on, made at `at`. */
export function noteDictation(text: string, at = Date.now()): void {
  if (!text || !Number.isFinite(at) || Date.now() - at > WINDOW_MS) return
  const i = held.findIndex((d) => d.text === text)
  if (i >= 0) held.splice(i, 1) // the same take noted twice (live finish, then the archive)
  held.push({ text, at })
  held.sort((a, b) => a.at - b.at)
  while (held.length > MAX_HELD) held.shift()
}

interface Token { text: string; from: number; to: number }

/** English words and digits as one token each, every other letter on its own; spaces and punctuation are not tokens. */
function tokens(s: string): Token[] {
  const out: Token[] = []
  for (const m of s.matchAll(/[A-Za-z0-9][A-Za-z0-9'.+-]*[A-Za-z0-9]|[A-Za-z0-9]|[^\s\p{P}\p{S}]/gu)) {
    out.push({ text: m[0].toLowerCase(), from: m.index!, to: m.index! + m[0].length })
  }
  return out
}

const CJK = /[㐀-鿿]/u

/** "is" -> "was", "PR" -> "PRs", "run" -> "running": an English edit, not a mishearing. */
function isWordEdit(heard: string, term: string): boolean {
  if (CJK.test(heard)) return false
  const h = heard.toLowerCase()
  const t = term.toLowerCase()
  return STOP.has(h) || STOP.has(t) || t.startsWith(h) || h.startsWith(t)
}

/** The spans a send changed in a dictation, when the send is that dictation edited by hand. */
export function editPairs(dictated: string, sent: string): EditPair[] | null {
  const a = tokens(dictated)
  const b = tokens(sent)
  if (!a.length || !b.length || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null
  // The common part can be no longer than the shorter text: skip the table when that already fails.
  if (Math.min(a.length, b.length) < MIN_SHARE * Math.max(a.length, b.length)) return null
  // Longest common subsequence, then the runs between its matches.
  const dp: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i]!.text === b[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  if (dp[0]![0]! < MIN_SHARE * Math.max(a.length, b.length)) return null
  const runs: { a: Token[]; b: Token[] }[] = []
  let run: { a: Token[]; b: Token[] } = { a: [], b: [] }
  let i = 0
  let j = 0
  const close = () => { if (run.a.length || run.b.length) runs.push(run); run = { a: [], b: [] } }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) { close(); i++; j++ }
    else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) run.b.push(b[j++]!)
    else run.a.push(a[i++]!)
  }
  close()
  const pairs: EditPair[] = []
  for (const r of runs) {
    if (!r.a.length || !r.b.length) continue // an added or a dropped word is not a mishearing
    const heard = dictated.slice(r.a[0]!.from, r.a[r.a.length - 1]!.to).trim()
    const term = sent.slice(r.b[0]!.from, r.b[r.b.length - 1]!.to).trim()
    if (!/[A-Za-z]{2,}/.test(term) || term.length > 40 || heard.length < 2 || heard.length > 12) continue
    if (heard.replace(/\s+/g, '').toLowerCase() === term.replace(/\s+/g, '').toLowerCase()) continue
    if (isWordEdit(heard, term)) continue
    pairs.push({ heard, term })
  }
  return pairs.length <= MAX_PAIRS ? pairs : null
}

// The store is machine-local (local/ is never synced): each server learns from its own sends.
let learned: Learned[] | null = null
let loading: Promise<Learned[]> | null = null
let unreadable = false
let writing: Promise<void> = Promise.resolve()

async function storePath(): Promise<string> {
  const { WALNUT_HOME } = await import('../../constants.js')
  return join(WALNUT_HOME, 'local', 'stt-learned-corrections.json')
}

function load(): Promise<Learned[]> {
  if (learned) return Promise.resolve(learned)
  loading ??= (async () => {
    let raw: string | null = null
    try { raw = await readFile(await storePath(), 'utf8') } catch { /* none yet */ }
    let pairs: Learned[] = []
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { pairs?: Learned[] }
        pairs = Array.isArray(parsed.pairs) ? parsed.pairs.filter((p) => typeof p?.term === 'string' && typeof p?.heard === 'string') : []
      } catch {
        unreadable = true // kept as it is: never overwritten with an empty list
        log.stt.warn('learned corrections: the store does not parse, learning is off until it is fixed or removed')
      }
    }
    learned = pairs
    return pairs
  })().finally(() => { loading = null })
  return loading
}

/** Writes one after another, so two learns never race on the file. */
function save(pairs: Learned[]): Promise<void> {
  if (unreadable) return Promise.resolve()
  const snapshot = JSON.stringify({ version: 1, pairs }, null, 2)
  writing = writing.then(async () => {
    const path = await storePath()
    await mkdir(join(path, '..'), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, snapshot)
    await rename(tmp, path)
  }).catch((err) => log.stt.warn(`learned corrections not saved: ${err instanceof Error ? err.message : String(err)}`))
  return writing
}

/** Terms learned from the user's edits, newest first, for the speech context (empty until the store is read). */
export function learnedTerms(): string[] {
  if (!learned) void load().catch(() => {})
  return [...new Set((learned ?? []).map((p) => p.term))]
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A person's send: learn from it when it is a recent dictation edited by hand. */
export async function learnFromSend(sent: string, now = Date.now(), messageId?: string): Promise<EditPair[]> {
  if (messageId) {
    if (seenIds.includes(messageId)) return [] // a retry of the same send
    seenIds.push(messageId)
    if (seenIds.length > SEEN_IDS) seenIds.shift()
  }
  const recent = held.filter((d) => now - d.at <= WINDOW_MS)
  if (!recent.length || recent.some((d) => d.text === sent)) return [] // sent as it was heard
  let best: { pairs: EditPair[]; from: (typeof held)[number] } | null = null
  for (const d of recent) {
    const pairs = editPairs(d.text, sent)
    if (pairs?.length && (!best || pairs.length < best.pairs.length)) best = { pairs, from: d }
  }
  if (!best) return []
  held.splice(held.indexOf(best.from), 1) // one dictation teaches once
  const pairs = await load()
  if (unreadable) return []
  const today = day(now)
  const promote: EditPair[] = []
  for (const p of best.pairs) {
    let row = pairs.find((x) => x.term === p.term && x.heard === p.heard)
    if (!row) { row = { ...p, count: 0, at: '', days: [] }; pairs.push(row) }
    row.count++
    row.at = new Date(now).toISOString()
    const days = row.days ?? []
    if (!days.includes(today)) {
      row.days = [...days, today].slice(-SIGHTING_DAYS)
      if (row.days.length === SIGHTING_DAYS && days.length === SIGHTING_DAYS - 1) promote.push(p)
    }
  }
  pairs.sort((x, y) => y.at.localeCompare(x.at))
  pairs.length = Math.min(pairs.length, MAX_LEARNED)
  await save(pairs)
  log.stt.info(`learned ${best.pairs.length} correction(s) from an edited dictation`)
  if (promote.length) await promoteToConfig(promote)
  return best.pairs
}

/** Seen on enough days: into config stt_corrections, where the user sees and edits it. */
async function promoteToConfig(pairs: EditPair[]): Promise<void> {
  const { isFollower } = await import('../server-role.js')
  if (isFollower()) return // a follower's config is the leader's copy
  const { migrateStoredConfig } = await import('../config-manager.js')
  let added = 0
  // Read and written under the config lock, so an edit the user saves meanwhile is kept.
  await migrateStoredConfig((doc) => {
    const raw = doc.stt_corrections
    const current: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    added = 0
    for (const p of pairs) {
      const prior = current[p.term]
      const forms = Array.isArray(prior) ? prior.filter((f): f is string => typeof f === 'string') : typeof prior === 'string' ? [prior] : []
      if (forms.some((f) => f.toLowerCase() === p.heard.toLowerCase())) continue
      current[p.term] = [...forms, p.heard]
      added++
    }
    if (!added) return false
    doc.stt_corrections = current
    return true
  })
  if (added) log.stt.info(`stt_corrections gained ${added} form(s) learned from edits`)
}

const HINT_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g

let started = false

/** Listen to every message a person sends into a session (the leader only). */
export async function startLearningFromSends(): Promise<void> {
  if (started) return
  const [{ bus, EventNames }, { queueSentBy }, { isFollower }] = await Promise.all([
    import('../event-bus.js'), import('../sessions/send-sent-by.js'), import('../server-role.js'),
  ])
  if (isFollower()) return
  started = true
  bus.subscribe('stt-learn-from-sends', (event) => {
    const data = event.data as { message?: unknown; source?: unknown; sentBy?: unknown; messageId?: unknown } | undefined
    if (typeof data?.message !== 'string' || !held.length) return
    const by = data.sentBy ?? queueSentBy(typeof data.source === 'string' ? data.source : undefined)
    if (by !== 'person') return
    const text = data.message.replace(HINT_BLOCK, '').trim()
    const id = typeof data.messageId === 'string' ? data.messageId : undefined
    void learnFromSend(text, Date.now(), id).catch((err) => log.stt.warn(`learning from an edit failed: ${err instanceof Error ? err.message : String(err)}`))
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}

/** Test hook. */
export function _resetLearningForTest(): void {
  held.length = 0
  seenIds.length = 0
  learned = null
  loading = null
  unreadable = false
  writing = Promise.resolve()
  started = false
}
