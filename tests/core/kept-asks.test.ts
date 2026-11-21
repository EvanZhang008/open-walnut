/**
 * Asks kept across a Walnut restart (src/core/kept-asks.ts; 2026-11-20: a deploy restarted the
 * server during a sign-in wait, the ask lived in memory only, and the person was asked again).
 * A "restart" here is forgetKeptForRestart(): every kept map loses its memory, the files stay.
 *
 *  - a map's entries, a value changed in place, a delete and a clear are all on disk after it;
 *  - a file that does not parse reads as empty, and a value unpack refuses is dropped;
 *  - each browser ask that waits on a person answers by the same id after a restart: the sign-in
 *    ask, a trusted upload's ask, a step that buys or sends, a new sign-in on a site in use;
 *  - safety holds after it: another owner's id is still refused, an expired ask still ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-kept-asks'))

import { flushKept, forgetKeptForRestart, keptDir, keptMap } from '../../src/core/kept-asks.js'
import { _resetBrowserHubForTesting, ownTab } from '../../src/core/browser-control/hub.js'
import { ASK_MS, _resetSignInAsksForTesting, askSignIn, endSignIn, getAsk, openAsk } from '../../src/core/browser-control/sign-in-ask.js'
import { _resetUploadGrantsForTesting, answerUpload, askUpload } from '../../src/core/browser-control/upload-grants.js'
import { _resetOutwardAsksForTesting, answerOutward, askOutward } from '../../src/core/browser-control/outward-asks.js'
import { _resetFreshSignInForTesting, answerFreshSignIn, askFreshSignIn, isFreshAsk } from '../../src/core/browser-control/fresh-sign-in.js'

async function restart(): Promise<void> {
  await flushKept()
  forgetKeptForRestart()
}

const requester = { host: 'devbox', taskId: 't1', taskTitle: 'Buy the paper', sessionId: 's1' }

beforeEach(() => {
  _resetBrowserHubForTesting()
  _resetSignInAsksForTesting()
  _resetUploadGrantsForTesting()
  _resetOutwardAsksForTesting()
  _resetFreshSignInForTesting()
})

describe('a kept map', () => {
  it('keeps its entries, values changed in place, deletes and clears across a restart', async () => {
    const m = keptMap<{ n: number; note?: string }>('test-basic')
    m.set('a', { n: 1 })
    m.set('b', { n: 2 })
    m.get('a')!.note = 'changed in place'
    m.changed()
    m.delete('b')
    await restart()
    expect([...m.entries()]).toEqual([['a', { n: 1, note: 'changed in place' }]])
    const raw = JSON.parse(fs.readFileSync(path.join(keptDir(), 'test-basic.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect((fs.statSync(path.join(keptDir(), 'test-basic.json')).mode & 0o777).toString(8)).toBe('600')
    m.clear()
    await restart()
    expect(m.size).toBe(0)
  })

  it('reads a file that does not parse as empty, and drops what unpack refuses', async () => {
    fs.mkdirSync(keptDir(), { recursive: true })
    fs.writeFileSync(path.join(keptDir(), 'test-broken.json'), '{not json')
    const broken = keptMap<number>('test-broken')
    expect(broken.size).toBe(0)
    fs.writeFileSync(path.join(keptDir(), 'test-picky.json'), JSON.stringify({ version: 1, entries: [['x', 'text'], ['y', 5], [7, 1]] }))
    const picky = keptMap<number>('test-picky', { unpack: (v) => (typeof v === 'number' ? v : undefined) })
    expect([...picky.entries()]).toEqual([['y', 5]])
    expect(() => keptMap('Bad Name')).toThrow(/lowercase/)
  })
})

describe('test isolation', () => {
  it('each test file keeps its own folder: what another one kept (a shared test home) is never read here', () => {
    expect(path.basename(keptDir())).toMatch(/^test-/)
    for (const other of [path.dirname(keptDir()), path.join(path.dirname(keptDir()), 'test-another-file')]) {
      fs.mkdirSync(other, { recursive: true })
      fs.writeFileSync(path.join(other, 'test-leak.json'), JSON.stringify({ version: 1, entries: [['denied-site', 5]] }))
    }
    expect(keptMap<number>('test-leak').size).toBe(0)
  })
})

describe('the asks that wait on a person, after a restart', () => {
  it('a sign-in ask: the same id, the same words, and the Done after it ends it; another owner is still refused', async () => {
    ownTab('dev', 5, 'task:a')
    const a = askSignIn({ owner: 'task:a', device: 'dev', tab: 5, site: 'shop.example.test', note: 'press Touch ID' })
    await restart()
    expect(getAsk(a.id)).toMatchObject({ id: a.id, owner: 'task:a', tab: 5, site: 'shop.example.test', note: 'press Touch ID' })
    // The agent asks again on the same tab: the same ask, not a second one.
    expect(askSignIn({ owner: 'task:a', device: 'dev', tab: 5 }).id).toBe(a.id)
    expect(endSignIn('dev', 5, 'done', 'task:b')).toBeUndefined()
    expect(endSignIn('dev', 5, 'done', 'task:a')?.end?.why).toBe('done')
    await restart()
    expect(getAsk(a.id)?.end?.why).toBe('done')
    expect(openAsk('dev', 5)).toBeUndefined()
  })

  it('a sign-in ask still runs out at ASK_MS', async () => {
    ownTab('dev', 6, 'task:a')
    const a = askSignIn({ owner: 'task:a', device: 'dev', tab: 6 })
    await restart()
    const now = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => now() + ASK_MS + 1000)
    try {
      expect(getAsk(a.id)).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('a trusted upload\'s ask: the same id is still pending, not unknown', async () => {
    const { id } = await askUpload({ taskId: 't1', paths: ['/Users/me/a.mov'], site: 'example.test', requester })
    await restart()
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: ['/Users/me/a.mov'], holdMs: 0 })).toBe('pending')
    // Another task's call with that id is not answered.
    expect(await answerUpload({ id, taskId: 't2', site: 'example.test', paths: ['/Users/me/a.mov'], holdMs: 0 })).toBe('unknown')
    expect((await askUpload({ taskId: 't1', paths: ['/Users/me/a.mov'], site: 'example.test', requester })).reused).toBe(true)
  })

  it('a step that buys: the same id still waits (202), and only on its own tab and step', async () => {
    const hold = { kind: 'buy' as const, why: 'it pays', what: 'click button "Pay"', url: 'https://shop.example.test/pay', sig: 'sig-1' }
    const asked = await askOutward({ owner: 'task:a', tab: 4, action: 'click', args: { ref: 'e3' }, hold, requester })
    const id = String(asked.request)
    await restart()
    const again = await answerOutward({ id, owner: 'task:a', tab: 4, action: 'click', args: { ref: 'e3' }, holdMs: 0 })
    expect(again).toMatchObject({ ok: false, status: 202, body: { request: id } })
    await expect(answerOutward({ id, owner: 'task:b', tab: 4, action: 'click', args: { ref: 'e3' }, holdMs: 0 })).rejects.toMatchObject({ code: 'no_such_request' })
  })

  it('a new sign-in on a site in use: the same id is still its ask', async () => {
    const scope = { owner: 'task:a', device: 'dev', tab: 8, site: 'shop.example.test' }
    const asked = await askFreshSignIn({ ...scope, theirs: [{ id: 2, title: 'Shop' }], requester })
    const id = String(asked.request)
    await restart()
    expect(isFreshAsk(id)).toBe(true)
    expect(await answerFreshSignIn({ ...scope, id, holdMs: 0 })).toMatchObject({ ok: false, status: 202 })
  })
})
