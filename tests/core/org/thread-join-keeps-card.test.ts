/**
 * A message of his that joined a thread only for coming right after his last one moves nothing on
 * that thread's card (2026-11-23, the user, of a card he had just read that turned Working and left
 * his Threads view when he sent the next chat message on another subject: "本来是 need you，然后我随便
 * 一聊，它就直接就消失，直接就消失了").
 *
 * The class: every way fileMessage files his message into an open thread. Only his own word on that
 * thread (a Follow up on it, a reopen of one he just closed) makes it the node's turn; a join by
 * timing alone keeps the card as it was (state, decision, options, what he has read) until the node's
 * status answer says whether it is that subject. A bare reaction is filed as his read of the answer.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { emptyThreads, fileMessage, SAME_CONVERSATION_MS, setAnswers, splitThreadMessage, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { clearJoin, clearStaleJoins, JOIN_ASK_MAX_AGE_MS } from '../../../src/core/sessions/status-thread-split.js'
import { cardView, readsAsReaction, REPLY_DUE_MS, shownToHim, threadOverdue } from '../../../src/core/org/thread-view.js'
import { ackKnown } from '../../../src/core/org/thread-ack.js'
import { ackHoldsResult } from '../../../src/core/org/thread-known.js'

const T0 = Date.now() - 60 * 60_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const NODE = 'task:lead-1' as const

/** His question, answered in the chat and on its card, read at once: a card in his sight. */
function readCard(state: 'answered' | 'needs'): { f: ThreadsFile; id: string } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'can the error chart tell us when it is not normal?', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS }).file
  const id = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Yes: the weekly report compares it with its last 3 weeks.', at: at(1) }]])).file
  f = updateThread(f, id, state === 'needs'
    ? { state: 'needs', reply: 'Build an anomaly model for the chart? I recommend not to.', user_kind: 'user_own', user_kind_why: 'it spends money each month', options: [{ label: 'No model', recommended: true }, { label: 'Build one' }] }
    : { state: 'answered', reply: 'The weekly report already compares the chart with its last 3 weeks.' }, NODE, at(1)).file
  return { f, id }
}

describe('a join by timing alone keeps the card he sees', () => {
  for (const state of ['answered'] as const) {
    it(`an ${state} card stays ${state} and in his sight, nothing read into it; the message is marked for the node`, () => {
      const { f, id } = readCard(state)
      const before = f.threads[0]
      const r = fileMessage(f, { text: 'and what is a subscription required exception?', via: 'chat', at: at(2), joinRecent: SAME_CONVERSATION_MS })
      expect(r.thread.id).toBe(id)
      expect(r.joined).toBe('recent')
      expect(r.message.joined).toBe('recent')
      const t = r.file.threads[0]
      expect(t.state).toBe(state)
      expect(t.options).toEqual(before.options)
      expect(t.known).toEqual(before.known)
      expect(t.reactedAt).toEqual(before.reactedAt)
      expect(shownToHim(before, undefined, Date.parse(at(2)))).toBe(true)
      expect(shownToHim(t, undefined, Date.parse(at(3)))).toBe(true)
      // Checked as its subject (the mark off): his words read the answer, and it leaves his view.
      expect(shownToHim(clearJoin(r.file, r.message.id).threads[0], undefined, Date.parse(at(3)))).toBe(false)
      // Another subject: split out, the card stays as it was.
      const split = splitThreadMessage(r.file, id, r.message.id, NODE, at(3), undefined, 'en', { keepOpen: true }).file
      expect(shownToHim(split.threads.find((x) => x.id === id)!, undefined, Date.parse(at(3)))).toBe(true)
    })
  }

  it('a decision waiting on him: his words right after his own there answer it, the node\'s turn (11-20)', () => {
    const { f, id } = readCard('needs')
    const r = fileMessage(f, { text: 'no model, the weekly compare is enough', via: 'chat', at: at(2), joinRecent: SAME_CONVERSATION_MS })
    expect(r.thread.id).toBe(id)
    expect(r.joined).toBe('recent')
    expect(r.message.joined).toBe('recent')
    expect(r.file.threads[0].state).toBe('working')
  })

  it('his Follow up on the card itself is his word on it: the node\'s turn, as before', () => {
    for (const state of ['answered', 'needs'] as const) {
      const { f, id } = readCard(state)
      const r = fileMessage(f, { text: 'ok, and the grill chart too?', via: 'follow-up', threadId: id, at: at(2) })
      expect(r.file.threads[0].state).toBe('working')
      expect(r.file.threads[0].options).toBeUndefined()
    }
  })

  it('the card does not show it before the node checked it, and the node is still woken for it (review M1, M2)', () => {
    const { f } = readCard('answered')
    const r = fileMessage(f, { text: 'unrelated: what is a subscription exception?', via: 'chat', at: at(2), joinRecent: SAME_CONVERSATION_MS })
    const t = r.file.threads[0]
    expect(cardView(t).waiting).toEqual([])
    // The node's chat answer to it, filed before the check: not an unread answer on this card either.
    const answered = setAnswers(r.file, new Map([[r.message.id, { text: 'A subscription exception means the account has no plan.', at: at(3) }]])).file.threads[0]
    expect(cardView(answered).unread.some((x) => x.messages.some((m) => m.id === r.message.id))).toBe(false)
    // No answer and no check (the turn failed): the reply clock wakes the node as for a working thread.
    expect(threadOverdue(t, Date.parse(at(2)) + REPLY_DUE_MS + 60_000)?.why).toBe('reply')
    expect(threadOverdue(answered, Date.parse(at(2)) + REPLY_DUE_MS + 60_000)).toBeNull()
  })

  it('it does not count as a word of his since his Acknowledge (review L1)', () => {
    const { f, id } = readCard('answered')
    const acked = ackKnown(f, id, at(2)).file
    const r = fileMessage(acked, { text: 'unrelated: what is a subscription exception?', via: 'chat', at: at(3), joinRecent: SAME_CONVERSATION_MS })
    expect(r.thread.id).toBe(id)
    expect(ackHoldsResult(r.file.threads[0])).toBe(true)
  })

  it('a mark too old to be asked comes off in the node\'s next status answer (review L2)', () => {
    const { f } = readCard('answered')
    const r = fileMessage(f, { text: 'unrelated: what is a subscription exception?', via: 'chat', at: at(2), joinRecent: SAME_CONVERSATION_MS })
    expect(clearStaleJoins(r.file, at(60)).threads[0].messages.at(-1)!.joined).toBe('recent')
    const later = new Date(Date.parse(at(2)) + JOIN_ASK_MAX_AGE_MS + 60_000).toISOString()
    const swept = clearStaleJoins(r.file, later).threads[0]
    expect(swept.messages.at(-1)!.joined).toBeUndefined()
    expect(readsAsReaction(swept.messages.at(-1)!)).toBe(true)
  })

  it('every way fileMessage files into an open thread is classified here', () => {
    // The kinds it reports (FileMessageResult.joined) and the named Follow up: a new one fails this.
    const src = readFileSync(path.resolve(__dirname, '../../../src/core/org/threads-model.ts'), 'utf8')
    const kinds = (/joined\?: ([^;]+);/.exec(src.slice(src.indexOf('export interface FileMessageResult')))![1]).split('|').map((k) => k.trim().replace(/'/g, '')).sort()
    const MOVES: Record<string, string> = {
      recent: 'nothing on an answered or pending card until the node checked it (this file); a decision in needs: his answer, the node\'s turn',
      reaction: 'his read of the newest answer (a bare ok), never a turn for the node',
      reopened: 'his Follow up on a thread he closed minutes ago: open again, the node\'s turn',
    }
    expect(kinds).toEqual(Object.keys(MOVES).sort())
  })
})
