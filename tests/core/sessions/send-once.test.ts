/**
 * One send, however often a client asks for it (src/core/sessions/send-once.ts).
 *
 * 2026-11-22: a quick bar message that never reached Walnut (it was restarting) is sent again by
 * the bar itself once Walnut answers, as a chat bubble already is. The client cannot tell whether
 * the first try reached the server, so every try carries the same user line uuid, and the server
 * must keep one copy: the same send twice at once runs one after the other; an answer this process
 * gave is given again (a start, too, runs once); after a restart the queue row or the line the CLI
 * ran under that uuid is that send. A send without a uuid runs as always.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-send-once') }
})

// What the session's daemon says became of a line (line.fate): unknown unless a test sets it.
const { lineFate } = vi.hoisted(() => ({ lineFate: { value: null as unknown, asked: [] as unknown[][] } }))
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/daemon-connection.js')>()
  return {
    ...actual,
    getConnectedDaemonConnection: vi.fn(() => ({ connected: true })),
    readDaemonLineFate: vi.fn(async (...args: unknown[]) => { lineFate.asked.push(args); return lineFate.value }),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { enqueueMessage, getQueue, markProcessing, parkMessages, resetCache } from '../../../src/core/session-message-queue.js'
import { SEND_ANSWER_KEPT_MS, oneSendAtATime, resetSendOnce, sameSendSettled, sendOnce } from '../../../src/core/sessions/send-once.js'

const SID = 'ffffffff-1111-4222-8333-444444444444'
const UUID = '2d0e9f8a-3b4c-4d5e-9f0a-1b2c3d4e5f60'
const TEXT = 'so for this one, why it just keep showing'

let sends: BusEvent[] = []

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  resetSendOnce()
  bus.clear()
  sends = []
  bus.subscribe('session-runner', (event: BusEvent) => { if (event.name === EventNames.SESSION_SEND) sends.push(event) })
  lineFate.value = null
  lineFate.asked = []
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('oneSendAtATime', () => {
  it('the same send twice at once runs one after the other; other sends never wait on it', async () => {
    const order: string[] = []
    const first = deferred<string>()
    const a = oneSendAtATime('k1', async () => { order.push('a start'); const v = await first.promise; order.push('a end'); return v })
    const b = oneSendAtATime('k1', async () => { order.push('b start'); return 'b' })
    const other = oneSendAtATime('k2', async () => { order.push('other'); return 'o' })
    await other
    expect(order).toEqual(['a start', 'other'])
    first.resolve('a')
    expect(await a).toBe('a')
    expect(await b).toBe('b')
    expect(order).toEqual(['a start', 'other', 'a end', 'b start'])
  })

  it('an earlier send that failed never blocks the next; no key runs at once', async () => {
    const failed = oneSendAtATime('k1', async () => { throw new Error('boom') })
    const next = oneSendAtATime('k1', async () => 'next')
    await expect(failed).rejects.toThrow('boom')
    expect(await next).toBe('next')
    let ran = 0
    await Promise.all([oneSendAtATime(undefined, async () => { ran++ }), oneSendAtATime(undefined, async () => { ran++ })])
    expect(ran).toBe(2)
  })
})

describe('sendOnce: an answer given is given again for the same uuid', () => {
  it('the same send twice at once runs once, and both get its answer (a start never runs twice)', async () => {
    let starts = 0
    const start = async () => { starts++; await new Promise((r) => setTimeout(r, 10)); return { taskId: 't1', sessionId: 's1', started: true } }
    const [one, two] = await Promise.all([sendOnce('quick\nu1', start), sendOnce('quick\nu1', start)])
    expect(starts).toBe(1)
    expect(two).toEqual(one)
    // Asked again later (the bar resends after a lost answer): the same answer, nothing run.
    expect(await sendOnce('quick\nu1', start)).toEqual(one)
    expect(starts).toBe(1)
    // What became of it since may change the answer (its row went in: delivered); the kept one stays as it was.
    expect(await sendOnce('quick\nu1', start, { again: async (a) => ({ ...a, alreadyDelivered: true }) })).toEqual({ ...one, alreadyDelivered: true })
    expect(await sendOnce('quick\nu1', start)).toEqual(one)
  })

  it('a send that threw runs again; an answer is kept only so long; no uuid runs every time', async () => {
    let tries = 0
    const flaky = async () => { tries++; if (tries === 1) throw new Error('not yet'); return { n: tries } }
    await expect(sendOnce('quick\nu2', flaky)).rejects.toThrow('not yet')
    expect(await sendOnce('quick\nu2', flaky)).toEqual({ n: 2 })
    expect(tries).toBe(2)

    let clock = 1_000
    let runs = 0
    const run = async () => ({ run: ++runs })
    await sendOnce('quick\nu3', run, { now: () => clock })
    clock += SEND_ANSWER_KEPT_MS - 1
    expect(await sendOnce('quick\nu3', run, { now: () => clock })).toEqual({ run: 1 })
    clock += 2
    expect(await sendOnce('quick\nu3', run, { now: () => clock })).toEqual({ run: 2 })

    let plain = 0
    await sendOnce(undefined, async () => { plain++ })
    await sendOnce(undefined, async () => { plain++ })
    expect(plain).toBe(2)
  })

  it('an answer that sent nothing (held behind a permission prompt) is not kept: the same send runs again', async () => {
    let runs = 0
    const run = async () => ({ held: ++runs === 1 })
    const keep = (a: { held: boolean }) => !a.held
    expect(await sendOnce('s\nheld-line', run, { keep })).toEqual({ held: true })
    expect(await sendOnce('s\nheld-line', run, { keep })).toEqual({ held: false })
    // Once it went in, that answer is kept like any other.
    expect(await sendOnce('s\nheld-line', run, { keep })).toEqual({ held: false })
    expect(runs).toBe(2)
  })

  it('the kept answers stay a little past the clients\' 10 minute limit on sending by themselves', () => {
    expect(SEND_ANSWER_KEPT_MS).toBeGreaterThan(10 * 60_000)
    expect(SEND_ANSWER_KEPT_MS).toBeLessThanOrEqual(15 * 60_000)
  })
})

describe('sameSendSettled: the durable record answers after a restart', () => {
  const base = { sessionId: SID, message: TEXT, source: 'test', autoResend: true }

  it('a row queued under the user line is that send: drained again, never copied', async () => {
    const row = await enqueueMessage(SID, TEXT, { userUuid: UUID })
    const same = await sameSendSettled({ ...base, userUuid: UUID })
    expect(same).toMatchObject({ state: 'queued', messageId: row.id })
    expect(await getQueue(SID)).toHaveLength(1)
    expect(sends).toHaveLength(1)
    expect(lineFate.asked).toHaveLength(0)
  })

  it('a resend by itself leaves a parked row parked; a person\'s resend un-parks it', async () => {
    await enqueueMessage(SID, TEXT, { userUuid: UUID })
    await parkMessages(await markProcessing(SID), 'Working directory no longer exists: /gone')
    expect((await sameSendSettled({ ...base, userUuid: UUID })).state).toBe('queued')
    expect((await getQueue(SID)).map((m) => m.status)).toEqual(['parked'])
    await sameSendSettled({ ...base, userUuid: UUID, autoResend: false })
    expect((await getQueue(SID)).map((m) => m.status)).not.toContain('parked')
  })

  it('a line the CLI already ran under that uuid is delivered; otherwise nothing is known', async () => {
    lineFate.value = { fate: 'ran', state: 'idle' }
    expect(await sameSendSettled({ ...base, userUuid: UUID })).toEqual({ state: 'ran' })
    expect(lineFate.asked[0]?.[2]).toBe(UUID)
    // The server's own settled line uuid wins over the client's when it knows one.
    lineFate.asked = []
    await sameSendSettled({ ...base, userUuid: UUID, lineUuid: 'line-uuid-1' })
    expect(lineFate.asked[0]?.[2]).toBe('line-uuid-1')
    lineFate.value = { fate: 'unanswered' }
    expect(await sameSendSettled({ ...base, userUuid: UUID })).toEqual({ state: 'none' })
  })

  it('without a uuid nothing is looked up', async () => {
    await enqueueMessage(SID, TEXT)
    expect(await sameSendSettled({ ...base })).toEqual({ state: 'none' })
    expect(lineFate.asked).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })
})
