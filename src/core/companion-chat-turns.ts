/**
 * Chat turns the cloud companion answered itself while the Mac did not answer
 * (stage 3e of docs/plan/walnut-companion-unified-replica.md).
 *
 *   write    a turn starts in the outbox (cloud-chat-outbox.ts `running`: the user's
 *            words survive a crash, a read during the turn shows them); when it ends and
 *            the Mac drains `chat-turn`, it becomes a `chat-turn` record in the
 *            companion's journal (companion-journal.ts journalChatTurn, texts as blobs)
 *            and its outbox file goes. A Mac that does not drain the kind (older, or none
 *            drained yet) keeps the outbox and its `server.chat.adopt` hand-over, as do
 *            the outbox files already there.
 *   read     every read of the conversation shows the turn: the outbox's, the records
 *            the Mac has not acked, and the ones it acked, until the Mac's copy (or git's
 *            chat history) names the turn, at most CHAT_TURN_AWAIT_MS after the ack.
 *   the list a turn moves its conversation's `lastMessageAt` while it is shown (the v1
 *            list only).
 *
 * Cloud companion only.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import type { CloudChatOutboxEntry } from './cloud-chat-outbox.js'
import type { ConversationMeta } from './types.js'
import { companionJournalBlobBody, companionJournalRecords, journalChatTurn } from './companion-journal.js'

/** A turn the Mac acked is shown at most this long without its copy naming it. */
export const CHAT_TURN_AWAIT_MS = 10 * 60_000

/** Turns the Mac acked, by turn id: shown until the copy names them. */
const awaited = new Map<string, { entry: CloudChatOutboxEntry; at: number }>()

/** A record as the outbox's entry shape (the readers' one), or null when its words are gone. */
function entryOf(r: JournalRecord): CloudChatOutboxEntry | null {
  if (r.kind !== 'chat-turn' || typeof r.turnId !== 'string' || typeof r.agentId !== 'string' || typeof r.conversationId !== 'string') return null
  const user = companionJournalBlobBody(r.userBlob)
  if (!user) return null
  const answer = typeof r.answerBlob === 'string' ? companionJournalBlobBody(r.answerBlob) : null
  const userAt = typeof r.userAt === 'string' ? r.userAt : new Date(r.at).toISOString()
  const answeredAt = typeof r.answeredAt === 'string' ? r.answeredAt : undefined
  return {
    v: 1, turnId: r.turnId, agentId: r.agentId, conversationId: r.conversationId, userText: user.toString('utf8'), userAt,
    state: answer ? 'answered' : 'failed', ...(answer ? { answerText: answer.toString('utf8'), ...(answeredAt ? { answeredAt } : {}) } : {}),
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}), ...(typeof r.engine === 'string' ? { engine: r.engine } : {}),
    bootId: 'journal', updatedAt: answeredAt ?? userAt,
  }
}

/**
 * The turn ended on this box: a `chat-turn` record when the Mac drains the kind (its
 * outbox file then goes), else its outcome in the outbox as before. Never throws;
 * false when neither took it.
 */
export async function finishCompanionTurn(
  entry: CloudChatOutboxEntry,
  outcome: { answerText: string; engine?: string } | { error: string; engine?: string },
): Promise<boolean> {
  const outbox = await import('./cloud-chat-outbox.js')
  try {
    const now = new Date().toISOString()
    const r = journalChatTurn({
      turnId: entry.turnId, agentId: entry.agentId, conversationId: entry.conversationId, userText: entry.userText, userAt: entry.userAt,
      engine: outcome.engine ?? entry.engine ?? 'cloud:unknown',
      ...('answerText' in outcome ? { answerText: outcome.answerText, answeredAt: now } : { error: outcome.error }),
    })
    if (r?.ok) {
      // The record holds the turn now; a file left by a failed remove is adopted once more by
      // the outbox, which the Mac answers as a duplicate (adoption is by turn id).
      await fsp.rm(path.join(outbox.CLOUD_CHAT_OUTBOX_DIR, `${entry.turnId}.json`), { force: true }).catch(() => {})
      return true
    }
  } catch (err) {
    log.agent.warn('companion chat: the journal did not take a turn, it stays in the outbox', { turnId: entry.turnId, error: err instanceof Error ? err.message : String(err) })
  }
  return outbox.finishCloudTurn(entry, outcome)
}

/** The turns the Mac has not acked, as entries, oldest first. */
function journaledTurns(): CloudChatOutboxEntry[] {
  const out: CloudChatOutboxEntry[] = []
  for (const r of companionJournalRecords()) {
    if (r.kind !== 'chat-turn') continue
    const e = entryOf(r)
    if (e) out.push(e)
  }
  return out
}

function awaitedTurns(): CloudChatOutboxEntry[] {
  const now = Date.now()
  const out: CloudChatOutboxEntry[] = []
  for (const [id, a] of [...awaited]) {
    if (now - a.at > CHAT_TURN_AWAIT_MS) { awaited.delete(id); continue }
    out.push(a.entry)
  }
  return out
}

/**
 * Every turn this box answered that a read must show, oldest first, once each: the
 * outbox's, the journal's, the acked ones awaiting the copy. The readers drop the ones
 * the Mac's answer, its copy or git's chat history names (api-v1.ts).
 */
export async function companionBankedTurns(filter: { agentId?: string; conversationId?: string } = {}): Promise<CloudChatOutboxEntry[]> {
  const { listCloudTurns } = await import('./cloud-chat-outbox.js')
  const byTurn = new Map<string, CloudChatOutboxEntry>()
  for (const e of [...awaitedTurns(), ...journaledTurns()]) byTurn.set(e.turnId, e)
  for (const e of await listCloudTurns(filter)) if (!byTurn.has(e.turnId)) byTurn.set(e.turnId, e)
  return [...byTurn.values()]
    .filter((e) => (!filter.agentId || e.agentId === filter.agentId) && (!filter.conversationId || e.conversationId === filter.conversationId))
    .sort((a, b) => (a.userAt < b.userAt ? -1 : a.userAt > b.userAt ? 1 : 0))
}

/**
 * The list with each conversation's `lastMessageAt` moved up to the newest turn this box
 * answered in it that a read still shows, so a chat used while the Mac was away moves to
 * the top. The box's list only (the v1 list route); never written anywhere.
 */
export async function withCompanionTurnTimes(agentId: string, list: ConversationMeta[]): Promise<ConversationMeta[]> {
  const turns = await companionBankedTurns({ agentId })
  if (turns.length === 0) return list
  const at = new Map<string, string>()
  for (const e of turns) {
    const t = e.updatedAt || e.userAt
    if ((at.get(e.conversationId) ?? '') < t) at.set(e.conversationId, t)
  }
  return list.map((c) => {
    const t = at.get(c.id)
    return t && t > c.lastMessageAt ? { ...c, lastMessageAt: t } : c
  })
}

/**
 * The Mac acked these chat turns (it adopted them), before the journal frees their texts:
 * each stays in the box's reads until the Mac's copy names it (the copy carries the turn
 * ids the Mac adopted), at most CHAT_TURN_AWAIT_MS.
 */
export function companionChatTurnsAcked(records: JournalRecord[]): void {
  let n = 0
  for (const r of records) {
    const entry = entryOf(r)
    if (!entry) continue
    awaited.set(entry.turnId, { entry, at: Date.now() })
    n++
  }
  if (n) log.agent.info('companion chat: the Mac took the chat turns; they show until its copy does', { turns: n })
}

/** Tests only. */
export function _resetCompanionChatTurnsForTesting(): void {
  awaited.clear()
}
