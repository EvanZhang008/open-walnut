/**
 * The Mac's copy of one conversation (companion-conversations.ts copiedConversation, the
 * phone's v1 rows) as chat entries, for the cloud companion's readers that speak the chat
 * history's shape (stage 4d of docs/plan/walnut-companion-unified-replica.md). Neither
 * reads the chat history git sync wrote on the box.
 *
 *   the lane     the companion's chat lane seeds and catches up from it (cloud-chat-lane.ts):
 *                the user's words and the answers only, the Mac's compaction summary ahead
 *                and the rows it covers left out (chat-history.ts collectSeedTurns does the
 *                same with the store's `compacted` entries)
 *   the console  GET /api/chat/history pages it (web/routes/chat-history.ts), this box's
 *                own turns on the tail until the copy names them
 *
 * Cloud companion only: anywhere else there is no copy (null).
 */

import type { ChatEntry } from './types.js'
import type { CloudChatOutboxEntry } from './cloud-chat-outbox.js'
import type { PaginatedEntries, SeedSource, SeedStore } from './chat-history.js'
import { copiedConversation, type CopiedConversation } from './companion-conversations.js'
import { followerKind } from './server-role.js'

type CopyRow = CopiedConversation['messages'][number]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The seed's entries from the copy: the user's words and the answers (never a tool, a
 * thinking line or a card). An answer this box gave (`answeredBy: 'cloud'`) is stamped
 * as `ownLabel`'s, so the catch-up never hands the lane its own turns back.
 */
export function seedStoreFromCopy(copied: CopiedConversation, ownLabel: string): SeedStore {
  const entries: ChatEntry[] = []
  for (const m of copied.messages) {
    if (m.kind !== undefined || (m.role !== 'user' && m.role !== 'assistant')) continue
    const text = str(m.text)
    const at = str(m.createdAt)
    if (!text || (copied.summaryAt && at && at <= copied.summaryAt)) continue
    entries.push({
      tag: 'ai', role: m.role, content: text, timestamp: at,
      ...(m.role === 'assistant' && m.answeredBy === 'cloud' ? { engine: ownLabel } : {}),
    } as ChatEntry)
  }
  return { entries, compactionSummary: copied.summary ?? null }
}

/**
 * Where the companion's chat lane reads the conversation: the copy once the Mac sends
 * `conversation-bodies` (one it does not hold is an empty one: nothing to seed), or null
 * before that (the lane reads this box's chat history, as before).
 */
export async function companionSeedSource(agentId: string, conversationId: string, ownLabel: string): Promise<SeedSource | null> {
  if (followerKind() !== 'companion') return null
  const { copyKindHeld } = await import('./replication/kinds/gate.js')
  if (!(await copyKindHeld('conversation-bodies'))) return null
  return async () => {
    const copied = await copiedConversation(agentId, conversationId)
    return copied ? seedStoreFromCopy(copied, ownLabel) : { entries: [], compactionSummary: null }
  }
}

/** One copy row as the console's chat entries (a tool call carries its result). */
function rowEntries(m: CopyRow): ChatEntry[] {
  const timestamp = str(m.createdAt)
  const text = str(m.text)
  const role = m.role === 'user' ? 'user' : 'assistant'
  if (m.kind === 'notification') return [{ tag: 'ui', role, content: text, timestamp, notification: true, source: str(m.source) || undefined } as ChatEntry]
  if (m.kind === 'thinking') return [{ tag: 'ai', role: 'assistant', content: [{ type: 'thinking', thinking: str(m.thinkingText) || text }], timestamp }]
  if (m.kind === 'tool') {
    const id = `copy-${m.id}`
    return [
      { tag: 'ai', role: 'assistant', content: [{ type: 'tool_use', id, name: text, input: m.detail ? { summary: str(m.detail) } : {} }], timestamp },
      { tag: 'ai', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: str(m.resultPreview), ...(m.isError === true ? { is_error: true } : {}) }], timestamp },
    ]
  }
  if (!text) return []
  return role === 'user'
    ? [{ tag: 'ai', role: 'user', content: text, displayText: text, timestamp }]
    : [{ tag: 'ai', role: 'assistant', content: [{ type: 'text', text }], timestamp }]
}

/** A turn this box answered itself, as the console's entries. */
function bankedEntries(e: CloudChatOutboxEntry): ChatEntry[] {
  const out: ChatEntry[] = [{ tag: 'ai', role: 'user', content: e.userText, displayText: e.userText, timestamp: e.userAt, turnId: e.turnId }]
  if (e.state === 'answered' && e.answerText) {
    out.push({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text: e.answerText }], timestamp: e.answeredAt ?? e.updatedAt, turnId: e.turnId })
  }
  return out
}

/**
 * One page of GET /api/chat/history on the companion: the copy's rows and this box's own
 * turns the copy does not name yet, or, for a chat with no copy, its own turns when it
 * has no message on the Mac (one made here). Null: the Mac holds turns this box cannot
 * show (the route answers needs-the-Mac).
 */
export async function companionChatHistoryPage(
  agentId: string, conversationId: string, page: number, pageSize: number, messageCount: number,
): Promise<PaginatedEntries | null> {
  if (followerKind() !== 'companion') return null
  const [{ companionBankedTurns }, { pageDisplayEntries }] = await Promise.all([import('./companion-chat-turns.js'), import('./chat-history.js')])
  const banked = await companionBankedTurns({ agentId, conversationId })
  const copied = await copiedConversation(agentId, conversationId)
  if (!copied && messageCount > 0) return null
  const entries = copied ? copied.messages.flatMap(rowEntries) : []
  for (const e of banked) if (!copied?.adoptedTurnIds.has(e.turnId)) entries.push(...bankedEntries(e))
  return pageDisplayEntries(entries, page, pageSize)
}
