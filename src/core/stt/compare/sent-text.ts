/**
 * What the user probably sent after a dictation, kept beside its take. The pairing
 * is learn-from-sends' guess by text: a person's send within 15 minutes whose words
 * match a recent dictation's (the same text, or most of its words), never the
 * recording's id travelling with the send. So the take keeps how it was paired
 * (`sentMatch`) and how close the texts were (`sentSimilarity`), and the pane says
 * "Probably what you sent", never states it as fact. The text is stored as sent,
 * never trimmed. Only while the experiment is on; the entry is made when there is
 * none yet.
 */
import { sentDictation, type DictationSource } from '../learn-from-sends.js'
import { compareFlag } from './settings.js'
import { compareStore } from './store.js'
import { ensureTake } from './takes-source.js'

export async function recordSentText(source: DictationSource, text: string, at = Date.now(), similarity = 1): Promise<boolean> {
  if (!text.trim() || !(await compareFlag.on())) return false
  const take = await ensureTake(source)
  if (!take) return false
  await compareStore.upsert(take.id, {
    sentText: text, sentAt: new Date(at).toISOString(),
    sentMatch: 'text-similarity', sentSimilarity: Math.round(similarity * 1000) / 1000,
  })
  return true
}

/** A person's send: the take of the dictation it most likely carries, if any, gets the sent text. */
export async function recordSentTextOf(text: string, at: number, dictations: Parameters<typeof sentDictation>[2]): Promise<boolean> {
  if (!text.trim() || !(await compareFlag.on())) return false
  const match = sentDictation(text, at, dictations)
  return match?.source ? recordSentText(match.source, text, at, match.similarity) : false
}
