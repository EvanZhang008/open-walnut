/**
 * What the user sent after a dictation, kept beside its take: the training pair of
 * the recording, the engine's text and the text sent (pairs.ts exports them). Two
 * ways to pair, and the take keeps which (`sentMatch`):
 *
 *  - `recording-id`: the send names the recordings dictated into its composer, with
 *    the composer's own text (web/src/utils/dictation-takes.ts; `dictationIds`,
 *    `dictationText`). Exact: two alike dictations never swap, and a send edited a lot
 *    or sent late pairs too. Each take is judged on its own: `edited` when its engine
 *    text is no longer in the composer's text.
 *  - `text-similarity`: a send that names none (an older client, the phone) is
 *    matched by learn-from-sends to a recent dictation whose words it mostly
 *    carries, within 15 minutes; a guess, so it never replaces an exact pairing.
 *
 * The text is stored as sent, never trimmed. Only while the experiment is on; the
 * entry is made when there is none yet.
 */
import { sentAgainstDictation, sentDictation, type DictationSource } from '../learn-from-sends.js'
import { compareFlag } from './settings.js'
import { compareStore, takeIdOf } from './store.js'
import { ensureTake, skeletonOf } from './takes-source.js'

const iso = (at: number) => new Date(at).toISOString()
const round = (x: number) => Math.round(x * 1000) / 1000

export async function recordSentText(source: DictationSource, text: string, at = Date.now(), similarity = 1): Promise<boolean> {
  if (!text.trim() || !(await compareFlag.on())) return false
  const take = await ensureTake(source)
  // A guess never replaces the exact pairing, judged again where it is written (an exact one may land in between).
  const exact = (t: { sentMatch?: string }) => t.sentMatch === 'recording-id'
  if (!take || exact(take)) return false
  const written = await compareStore.upsert(take.id, {
    sentText: text, sentAt: iso(at),
    sentMatch: 'text-similarity', sentSimilarity: round(similarity), sentExtra: undefined,
  }, exact)
  return written.sentMatch === 'text-similarity'
}

/** A person's send that named no recording: the take of the dictation it most likely carries, if any, gets the sent text. */
export async function recordSentTextOf(text: string, at: number, dictations: Parameters<typeof sentDictation>[2]): Promise<boolean> {
  if (!text.trim() || !(await compareFlag.on())) return false
  const match = sentDictation(text, at, dictations)
  return match?.source ? recordSentText(match.source, text, at, match.similarity) : false
}

const bare = (s: string) => s.replace(/\s+/g, '')

/** Is the engine's text still in the box text word for word (whitespace ignored)? Then the take was not edited. */
export function engineTextKept(boxText: string, engineText: string): boolean {
  return bare(boxText).includes(bare(engineText))
}

/**
 * A person's send that named the recordings dictated into it (`recordingIds`, web dictation): each
 * take that still resolves is paired exactly with the composer's own text (`boxText`) and judged on
 * its own: not edited while its engine text is in that text word for word. One take: the text is
 * that take's. Several: the text is the whole box (`sentShared`). No composer text (an older
 * client): the message without hints (`sentFrom: 'message'`). Shared and message pairs are never
 * exported. An id that no longer resolves is skipped and changes nothing for the others. Returns
 * the take ids written.
 */
export function recordSentByIds(recordingIds: readonly string[], sent: { boxText?: string; message: string }, at = Date.now()): Promise<string[]> {
  return inTurn(() => pairByIds(recordingIds, sent, at))
}

/**
 * Pairings by recording id and their discards, one after another in the order they were asked: a
 * discard right after its send (its reads still running) never lands before that send's pairing.
 */
let turns: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = turns.then(fn, fn)
  turns = run.catch(() => {})
  return run
}

async function pairByIds(recordingIds: readonly string[], sent: { boxText?: string; message: string }, at: number): Promise<string[]> {
  const text = sent.boxText ?? sent.message
  if (!recordingIds.length || !text.trim() || !(await compareFlag.on())) return []
  const takes: Array<{ id: string; engineText?: string }> = []
  for (const id of recordingIds) {
    const source: DictationSource = { kind: 'recording', id }
    const take = await ensureTake(source).catch(() => null)
    if (!take) continue
    // The engine's final text: the recording's own, read now (a Retry after the entry was made rewrote it).
    const engineText = (await skeletonOf(source).catch(() => null))?.inUseText ?? take.inUseText
    takes.push({ id: take.id, ...(engineText !== undefined ? { engineText } : {}) })
  }
  const shared = takes.length > 1
  for (const t of takes) {
    const edited = t.engineText !== undefined && !engineTextKept(text, t.engineText)
    // One take's own box text: is it that dictation edited, or with words typed around it?
    const judged = !shared && sent.boxText !== undefined && t.engineText !== undefined ? sentAgainstDictation(t.engineText, text) : null
    await compareStore.upsert(t.id, {
      sentText: text, sentAt: iso(at), sentMatch: 'recording-id',
      sentSimilarity: judged ? round(judged.similarity) : undefined, sentExtra: judged?.extra || undefined,
      ...(t.engineText !== undefined ? { inUseText: t.engineText } : {}),
      edited: edited || undefined,
      sentShared: shared || undefined,
      sentFrom: sent.boxText === undefined ? 'message' : undefined,
    })
  }
  return takes.map((t) => t.id)
}

/**
 * The send that named these recordings was discarded before it went (its queue row deleted): what
 * it paired with them goes too, so a message never sent is never "What you sent". Only a pairing
 * made by recording id, and only while it still holds that send's text.
 */
export function forgetSentByIds(recordingIds: readonly string[], sentText: string): Promise<void> {
  return inTurn(() => forgetByIds(recordingIds, sentText))
}

async function forgetByIds(recordingIds: readonly string[], sentText: string): Promise<void> {
  for (const id of recordingIds) {
    const takeId = takeIdOf({ kind: 'recording', id })
    if (!(await compareStore.has(takeId).catch(() => false))) continue
    await compareStore.upsert(takeId, {
      sentText: undefined, sentAt: undefined, sentMatch: undefined, sentSimilarity: undefined, sentExtra: undefined,
      edited: undefined, sentShared: undefined, sentFrom: undefined,
    }, (t) => t.sentMatch !== 'recording-id' || t.sentText !== sentText).catch(() => {})
  }
}
