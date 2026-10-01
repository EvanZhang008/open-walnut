/**
 * The unsubscribe checklist and the batch (spec 6.3, C21 C22 C23 C56).
 *
 * Plan: the best rung per account (one-click, then a link when the account cannot send, then mailto),
 * the ledger's own list key, list-level `done`, and the late header check: only on accounts whose
 * provider can fetch headers, at most 60 senders, one 4 s budget (`partial` past it), every answer
 * recorded (`null` included) and those rows re-sorted. Nothing in the plan ever calls the ladder.
 * Batch: one item at a time through `MailUnsubscribe.run` with three arguments, Stop after the
 * running item, one event per item.
 */
import { describe, expect, it } from 'vitest'
import type { UnsubCandidateRow } from '../../src/integrations/mail/sort-store.js'
import { BATCH_MAX_ITEMS, MailUnsubBatches, parseBatchItems } from '../../src/integrations/mail/sort-unsub-batch.js'
import {
  PLAN_SENDERS, bestMethod, buildPlan, checkHeaders, headersUnknown, heldOf, toCheck,
} from '../../src/integrations/mail/sort-unsub-plan.js'

const MARINA = 'marina:robin@marina.example.invalid'
const FERRY = 'ferry:robin.harbour@ferry.example.invalid'
const oneClick = { https: ['https://leave.example.invalid/u/1'], oneClick: true }
const mailto = { mailto: ['mailto:leave@tidings.example.invalid'], oneClick: false, listId: 'bulletin.tidings.example.invalid' }

function candidate(accountId: string, n: number, payload: Record<string, unknown>, extra: Partial<UnsubCandidateRow> = {}): UnsubCandidateRow {
  return {
    rowid: n, account_id: accountId, mailbox_id: 'INBOX', message_id: `INBOX:1:${n}`, rfc_message_id: `<m${n}@example.invalid>`,
    from_addr: (payload.from as { address?: string } | undefined)?.address ?? '', subject: `Mail ${n}`, payload: JSON.stringify(payload),
    sort_group: 'u:shopping', sort_reason: 'ai', sender_key: `k${n}`, seen: 0, sent_at: 1_000 + n, received_at: null,
    gmail_category: null, list_headers_json: null, mails: 3, headers_checked_at: null, ...extra,
  }
}

const abilities = (sendable: Set<string>, fetching: Set<string>) => ({
  canSend: (id: string) => sendable.has(id), canFetch: (id: string) => fetching.has(id), ledger: [],
})

describe('the best rung per account', () => {
  it('one-click first; a link over mailto when the account cannot send; mailto otherwise', () => {
    expect(bestMethod(oneClick, false)).toBe('one-click')
    expect(bestMethod({ ...mailto, https: ['https://leave.example.invalid/u/2'] }, false)).toBe('link')
    expect(bestMethod({ ...mailto, https: ['https://leave.example.invalid/u/2'] }, true)).toBe('mailto')
    expect(bestMethod(mailto, false)).toBe('mailto')
    expect(bestMethod({ bodyLink: 'https://leave.example.invalid/footer' }, true)).toBe('link')
    expect(bestMethod(undefined, true)).toBeUndefined()
  })

  it('reads late-fetched headers from the hints when the payload has none', () => {
    const row = candidate(MARINA, 1, { from: { address: 'news@lists.example.invalid' } }, {
      list_headers_json: JSON.stringify({ listUnsubscribe: oneClick, listId: 'weekly.lists.example.invalid' }), headers_checked_at: 5,
    })
    expect(heldOf(row)).toEqual({ ...oneClick, listId: 'weekly.lists.example.invalid' })
    expect(headersUnknown(row)).toBe(false)
  })
})

describe('buildPlan', () => {
  const rows = [
    candidate(MARINA, 1, { from: { address: 'hello@em.shop.example.invalid', name: 'Shop Deals' }, listUnsubscribe: oneClick }),
    candidate(MARINA, 2, { from: { address: 'bulletin@tidings.example.invalid', name: 'Tidings Bulletin' }, listUnsubscribe: mailto }),
    candidate(MARINA, 3, { from: { address: 'news@lists.example.invalid' } }),
    candidate(FERRY, 4, { from: { address: '', name: 'Brand Tide to Shore' } }),
    candidate(FERRY, 5, { from: { address: '', name: 'Ferry Line Updates' }, bodyFormat: 'text' }),
  ]

  it('lists every way out with the ledger key, and counts what has none (C56)', () => {
    const plan = buildPlan(rows, abilities(new Set([MARINA]), new Set([MARINA])))
    expect(plan.items.map((one) => [one.label, one.method, one.listKey, one.keyedBy, one.canSend])).toEqual([
      ['Shop Deals', 'one-click', 'hello@em.shop.example.invalid', 'sender', true],
      ['Tidings Bulletin', 'mailto', 'bulletin.tidings.example.invalid', 'list-id', true],
    ])
    // Three without an option; the body-read ferry row's headers are known (none), the other two are not.
    expect(plan).toMatchObject({ withoutOption: 3, headerUnknown: 2, unchecked: 1 })
  })

  it('the account that cannot send keeps its mailto item, marked canSend: false, with the address', () => {
    const plan = buildPlan([rows[1]!], abilities(new Set(), new Set()))
    expect(plan.items[0]).toMatchObject({ method: 'mailto', canSend: false, mailto: mailto.mailto[0] })
    // An account that can send is offered the send itself; the address stays on the server.
    expect(buildPlan([rows[1]!], abilities(new Set([MARINA]), new Set())).items[0]!.mailto).toBeUndefined()
  })

  it('a list left through another mail shows list-level done; an attempt shows on its own row (C22)', () => {
    const ledger = [
      { account_id: MARINA, message_id: 'INBOX:1:77', list_key: 'bulletin.tidings.example.invalid', method: 'mailto', status: 'done', at: 9 },
      { account_id: MARINA, message_id: 'INBOX:1:1', list_key: 'hello@em.shop.example.invalid', method: 'one-click', status: 'needs-human', at: 8 },
    ]
    const plan = buildPlan(rows.slice(0, 2), { ...abilities(new Set([MARINA]), new Set()), ledger })
    expect(plan.items[1]!.done).toEqual({ at: 9, method: 'mailto' })
    expect(plan.items[0]!.attempt).toEqual({ status: 'needs-human', at: 8 })
  })

  it('items found by this check go after the ones already known', () => {
    const late = candidate(MARINA, 0, { from: { address: 'news@lists.example.invalid' } }, { list_headers_json: JSON.stringify({ listUnsubscribe: oneClick }), headers_checked_at: 1 })
    const plan = buildPlan([late, rows[0]!], { ...abilities(new Set([MARINA]), new Set([MARINA])), fresh: new Set([late.message_id]) })
    expect(plan.items.map((one) => one.messageId)).toEqual(['INBOX:1:1', 'INBOX:1:0'])
  })
})

describe('the late header check (C56)', () => {
  it('checks at most 60 senders, and only on accounts that can fetch', () => {
    const many = Array.from({ length: 90 }, (_, i) => candidate(i % 3 === 0 ? FERRY : MARINA, i + 1, { from: { address: `s${i}@shop.example.invalid` } }))
    const picked = toCheck(many, (id) => id === MARINA)
    expect(picked).toHaveLength(PLAN_SENDERS)
    expect(picked.every((one) => one.account_id === MARINA)).toBe(true)
  })

  it('records every asked id (null for no answer) and re-sorts them; a slow folder makes it partial', async () => {
    const applied: Array<{ accountId: string; mailboxId: string; entries: unknown[] }> = []
    const asked: string[][] = []
    const deps = {
      service: { provider: () => ({
        fetchListHeaders: async (_a: string, mailboxId: string, ids: string[]) => {
          asked.push(ids)
          if (mailboxId === 'Slow') return new Promise<never>(() => {})
          return [{ messageId: ids[0]!, headers: { listUnsubscribe: oneClick } }]
        },
      }) },
      sort: { applyListHeaders: async (accountId: string, mailboxId: string, entries: unknown[]) => { applied.push({ accountId, mailboxId, entries }); return 0 } },
      store: {},
    }
    const rows = [
      candidate(MARINA, 1, { from: { address: 'a@shop.example.invalid' } }),
      candidate(MARINA, 2, { from: { address: 'b@shop.example.invalid' } }),
      candidate(MARINA, 3, { from: { address: 'c@shop.example.invalid' } }, { mailbox_id: 'Slow' }),
    ]
    const started = Date.now()
    const outcome = await checkHeaders(deps as never, rows, 80)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(outcome.partial).toBe(true)
    expect([...outcome.fetched]).toEqual(['INBOX:1:1'])
    expect(applied).toEqual([{ accountId: MARINA, mailboxId: 'INBOX', entries: [
      { messageId: 'INBOX:1:1', headers: { listUnsubscribe: oneClick } }, { messageId: 'INBOX:1:2', headers: null },
    ] }])
    expect(asked).toEqual([['INBOX:1:1', 'INBOX:1:2'], ['INBOX:1:3']])
  })
})

describe('the batch', () => {
  it('parses at most 50 items with a requestable method', () => {
    expect(parseBatchItems([{ accountId: MARINA, messageId: 'INBOX:1:1', method: 'one-click' }])).toHaveLength(1)
    expect(parseBatchItems([])).toMatchObject({ error: expect.any(String) })
    expect(parseBatchItems(Array.from({ length: BATCH_MAX_ITEMS + 1 }, () => ({ accountId: MARINA, messageId: 'x', method: 'link' })))).toMatchObject({ error: expect.stringContaining('50') })
    expect(parseBatchItems([{ accountId: MARINA, messageId: 'x', method: 'manual' }])).toMatchObject({ error: expect.stringContaining('method') })
  })

  it('runs one item at a time with exactly three arguments, and reports each (C22)', async () => {
    const calls: unknown[][] = []
    const events: Array<{ index: number; status: string }> = []
    let inFlight = 0
    let most = 0
    const batches = new MailUnsubBatches({
      run: async (...args) => {
        calls.push(args)
        inFlight += 1; most = Math.max(most, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return args[1] === 'INBOX:1:2'
          ? { status: 'conflict', conflict: 'already', method: 'mailto', at: 1, message: 'You already left this list.' }
          : { status: 'done', method: 'one-click', at: 1, message: 'Done.' }
      },
      events: { unsubBatch: (event) => events.push(event) },
    })
    const batch = batches.start([
      { accountId: MARINA, messageId: 'INBOX:1:1', method: 'one-click' },
      { accountId: MARINA, messageId: 'INBOX:1:2', method: 'mailto' },
    ])
    await batches.idle()
    expect(most).toBe(1)
    expect(calls).toEqual([[MARINA, 'INBOX:1:1', { method: 'one-click' }], [MARINA, 'INBOX:1:2', { method: 'mailto' }]])
    expect(events.map((one) => [one.index, one.status])).toEqual([[0, 'done'], [1, 'done']])
    expect(batches.get(batch.batchId)!.state).toBe('done')
  })

  it('Stop lets the running item finish and leaves the rest waiting, untouched (C23)', async () => {
    const calls: string[] = []
    const batches = new MailUnsubBatches({
      run: async (_a, messageId) => { calls.push(messageId); await new Promise((resolve) => setTimeout(resolve, 30)); return { status: 'done', method: 'one-click', at: 1, message: 'Done.' } },
    })
    const batch = batches.start(Array.from({ length: 4 }, (_, i) => ({ accountId: MARINA, messageId: `INBOX:1:${i}`, method: 'one-click' as const })))
    await new Promise((resolve) => setTimeout(resolve, 10))
    batches.stop(batch.batchId)
    await batches.idle()
    expect(calls).toEqual(['INBOX:1:0'])
    expect(batch.items.map((one) => one.status)).toEqual(['done', 'waiting', 'waiting', 'waiting'])
    expect(batch.stopped).toBe(true)
  })
})
