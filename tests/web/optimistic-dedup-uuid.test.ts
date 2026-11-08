/**
 * A send whose acknowledgement was lost is delivered once history shows its line.
 *
 * U22 (2026-11-10): the server took the message and the CLI answered it, but the
 * client never heard the send's acknowledgement, so the bubble read "Send failed"
 * with Retry while its own words and the answer sat right above it. The bubble's
 * pre-assigned uuid is the transcript uuid of its line (msgId, or sourceUuid for a
 * line taken mid-turn): exact proof, whatever the send RPC said.
 *
 * Guard: every surface that draws a "Send failed" bubble runs it through
 * dedupeOptimisticMessages, so a new one cannot keep a delivered line as failed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dedupeOptimisticMessages, historyUuidsOf, settleShownByUuid } from '@/components/sessions/optimistic-dedup'

const U1 = '11111111-aaaa-4bbb-8ccc-000000000001'
const U2 = '11111111-aaaa-4bbb-8ccc-000000000002'
const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'user', text, ...extra })
const asst = (text: string) => ({ role: 'assistant', text })
const bubble = (text: string, status: string, extra: Record<string, unknown> = {}) => ({ text, status, queueId: `temp-${text}-${status}`, ...extra })

describe('dedupeOptimisticMessages: uuid evidence', () => {
  it('a failed bubble whose line history holds is absorbed (the lost-ack case)', () => {
    const history = [user('Lost ack test', { msgId: U1 }), asst('Hello! I processed your message: Lost ack test')]
    const failed = bubble('Lost ack test', 'failed', { userUuid: U1, failedError: 'acknowledgement was lost' })
    // Index 2: the rows are below the watermark, so only the uuid can prove it.
    expect(dedupeOptimisticMessages([failed], history, 2)).toEqual([])
  })

  it('a line taken mid-turn proves its bubble through sourceUuid', () => {
    const history = [user('queued words', { msgId: 'queue-row-1', sourceUuid: U1 })]
    expect(dedupeOptimisticMessages([bubble('queued words', 'failed', { userUuid: U1 })], history, 1)).toEqual([])
  })

  it('a failed bubble history does not hold stays failed', () => {
    const history = [user('other words', { msgId: U2 })]
    const failed = bubble('Lost ack test', 'failed', { userUuid: U1 })
    expect(dedupeOptimisticMessages([failed], history, 0)).toEqual([failed])
  })

  it('a failed bubble with no uuid is never absorbed by text', () => {
    const history = [user('same words')]
    const failed = bubble('same words', 'failed')
    expect(dedupeOptimisticMessages([failed], history, 0)).toEqual([failed])
  })

  it('the row a uuid claimed accounts for that bubble only, never a second one with the same words', () => {
    const history = [user('ok', { msgId: U1 })]
    const first = bubble('ok', 'failed', { userUuid: U1 })
    const second = bubble('ok', 'delivered', { queueId: 'qm-2', userUuid: U2 })
    expect(dedupeOptimisticMessages([first, second], history, 0)).toEqual([second])
  })
})

describe('settleShownByUuid', () => {
  it('a lost-ack failed or a queued bubble history shows becomes delivered, its error gone', () => {
    const history = [user('a', { msgId: U1 }), user('b', { msgId: 'x', sourceUuid: U2 })]
    const out = settleShownByUuid([
      bubble('a', 'failed', { userUuid: U1, failedError: 'acknowledgement was lost' }),
      bubble('b', 'pending', { userUuid: U2 }),
    ], history)
    expect(out.map((m) => m.status)).toEqual(['delivered', 'delivered'])
    expect(out[0]).not.toHaveProperty('failedError')
  })

  it('a bubble the server parked keeps its Retry although history holds its line', () => {
    // "Not answered: Claude Code read this message and stopped before answering it,
    // twice": the line is in the transcript, the server parked it for a Retry.
    const history = [user('a', { msgId: U1 })]
    const parked = bubble('a', 'failed', { userUuid: U1, failedError: 'Not answered', parked: true, serverUndelivered: true })
    const list = [parked]
    expect(settleShownByUuid(list, history)).toBe(list)
    expect(dedupeOptimisticMessages(list, history, 1)).toEqual([parked])
  })

  it('a batch-failed bubble, and one retried after a park, are never proven by uuid', () => {
    const history = [user('a', { msgId: U1 }), user('b', { msgId: U2 })]
    const batchFailed = bubble('a', 'failed', { userUuid: U1, failedError: 'Send failed', serverUndelivered: true })
    // Retry clears `parked` and goes pending; the server's report stays on the bubble.
    const retried = bubble('b', 'pending', { userUuid: U2, serverUndelivered: true })
    const list = [batchFailed, retried]
    expect(settleShownByUuid(list, history)).toBe(list)
    expect(dedupeOptimisticMessages([batchFailed], history, 2)).toEqual([batchFailed])
    expect(dedupeOptimisticMessages([retried], history, 2)).toEqual([retried])
  })

  it('once the server reports the retried row delivered, its line in history absorbs it', () => {
    const history = [user('a', { msgId: U1 })]
    const delivered = bubble('a', 'delivered', { userUuid: U1, serverUndelivered: true })
    expect(dedupeOptimisticMessages([delivered], history, 1)).toEqual([])
  })

  it('returns the same array when history shows none of them', () => {
    const list = [bubble('a', 'failed', { userUuid: U1 }), bubble('b', 'failed')]
    expect(settleShownByUuid(list, [user('a', { msgId: U2 })])).toBe(list)
  })

  it('leaves a launch bubble alone', () => {
    const list = [bubble('start', 'pending', { userUuid: U1, launch: true })]
    expect(settleShownByUuid(list, [user('start', { msgId: U1 })])).toBe(list)
  })

  it('historyUuidsOf reads user rows only', () => {
    expect([...historyUuidsOf([user('a', { msgId: U1 }), { role: 'assistant', text: 'b', msgId: U2 }]).keys()]).toEqual([U1])
  })
})

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx$/.test(e.name) ? [p] : []
  })
}

describe('every server report of an undelivered row is marked, so its uuid proves nothing', () => {
  it('each failed bubble useSessionSend makes is a client-side send error or carries serverUndelivered', () => {
    // A send RPC's own .catch is the lost-ack case uuid evidence exists for; any
    // other place that marks a bubble failed is the server speaking (a park, a
    // failed batch) and must say so, or settleShownByUuid hides its Retry.
    const src = fs.readFileSync(path.join(WEB_SRC, 'hooks/useSessionSend.ts'), 'utf8').split('\n')
    const sites = src.flatMap((l, i) => (/status: '(?:failed)'|\? 'failed'|parked: true/.test(l) ? [i] : []))
    expect(sites.length, 'the failed-bubble sites are found').toBeGreaterThanOrEqual(4)
    const unmarked = sites.filter((i) => {
      if (/serverUndelivered: true/.test(src.slice(i, i + 2).join('\n'))) return false
      const above = src.slice(Math.max(0, i - 8), i).join('\n')
      return !/\.catch\(|\}\s*catch\s*\(/.test(above)
    }).map((i) => `useSessionSend.ts:${i + 1}: ${src[i].trim()}`)
    expect(unmarked).toEqual([])
  })
})

describe('every surface that draws a failed send checks history first', () => {
  it('each component rendering "Send failed" runs its bubbles through dedupeOptimisticMessages', () => {
    // Code only: a comment that names the words draws nothing.
    const code = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')
    const drawers = files(WEB_SRC).filter((f) => /[`'"]Send failed/.test(code(f)))
    expect(drawers.length, 'the chat history draws it').toBeGreaterThanOrEqual(1)
    const missing = drawers.filter((f) => !/\bdedupeOptimisticMessages\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(WEB_SRC, f))
    expect(missing, 'a bubble history shows delivered must not read "Send failed" (optimistic-dedup.ts uuid evidence)').toEqual([])
  })
})
