/**
 * The title brake for tasks a session files (src/core/sessions/task-title-brake.ts).
 *
 * Pure half: needsShortening / heuristicShortTitle over the shapes agents write
 * (a head before a colon, a run-on sentence, one long token, CJK, the limit
 * itself). Background half: refineShortTitle against a REAL task store in an
 * isolated home, with only the fast model faked (session-title-backend.js), so
 * the write, the "still wears the cut" guard, the plugin rule and an over-long
 * answer are all judged on the stored row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-title-brake'))

const backend = {
  available: true,
  answer: null as string | null,
  calls: [] as Array<{ brief: string; placeholder: string; requirement: string | null }>,
}
vi.mock('../../../src/core/session-title-backend.js', () => ({
  backendTitleAvailable: () => backend.available,
  titleViaBackendModel: vi.fn(async (brief: string, placeholder: string, requirement: string | null) => {
    backend.calls.push({ brief, placeholder, requirement })
    return backend.answer
  }),
}))

import {
  SESSION_TITLE_MAX, needsShortening, heuristicShortTitle, refineShortTitle,
} from '../../../src/core/sessions/task-title-brake.js'
import { addTask, getTask, updateTask } from '../../../src/core/task-manager.js'

const LONG = 'Bakery website launch: build the home page and the menu page, wire the order form to the bakery mailbox, and add the opening hours'

describe('needsShortening', () => {
  it('is the 60-character line, judged after whitespace is collapsed', () => {
    expect(SESSION_TITLE_MAX).toBe(60)
    expect(needsShortening('x'.repeat(60))).toBe(false)
    expect(needsShortening('x'.repeat(61))).toBe(true)
    expect(needsShortening(`  ${'x'.repeat(58)}   `)).toBe(false)
    expect(needsShortening('Fix the flaky auth test')).toBe(false)
    expect(needsShortening(LONG)).toBe(true)
  })
})

describe('heuristicShortTitle', () => {
  it('leaves a short title alone, whitespace tidied', () => {
    expect(heuristicShortTitle('  Fix   the flaky\tauth test ')).toBe('Fix the flaky auth test')
  })

  it('takes the head before a break when the head is a title of its own', () => {
    expect(heuristicShortTitle(LONG)).toBe('Bakery website launch')
    expect(heuristicShortTitle('Stream parser rewrite - split the reader from the frame decoder and add backpressure on writes'))
      .toBe('Stream parser rewrite')
    expect(heuristicShortTitle('Retry backoff for the uploader. The current loop retries every 100ms and never backs off'))
      .toBe('Retry backoff for the uploader')
    // CJK punctuation is a break too.
    expect(heuristicShortTitle('订单表单接入邮箱：把面包店首页的订单表单接到邮箱，并且加上营业时间和地图，顺便修一下移动端的排版问题和图片加载慢的问题，最后把菜单页的价格改成新的'))
      .toBe('订单表单接入邮箱')
  })

  it('ignores a head too short to be a title and cuts at a word instead', () => {
    const cut = heuristicShortTitle('Fix: the order form on the bakery home page drops the customer note when the browser is offline')
    expect(cut).toBe('Fix: the order form on the bakery home page drops')
    expect(cut.length).toBeLessThanOrEqual(SESSION_TITLE_MAX)
  })

  it('never ends on a stopword or punctuation', () => {
    expect(heuristicShortTitle('Move the nightly export of the bakery orders to the archive and the new bucket with a retention of'))
      .toBe('Move the nightly export of the bakery orders to the archive')
    expect(heuristicShortTitle('Rewrite the menu page, the order page, the about page, and, the contact page, plus the footer'))
      .toBe('Rewrite the menu page, the order page, the about page')
  })

  it('hard-cuts one token longer than the limit, and CJK without breaks', () => {
    const token = 'a'.repeat(80)
    expect(heuristicShortTitle(token)).toBe('a'.repeat(60))
    expect(heuristicShortTitle('面'.repeat(70))).toBe('面'.repeat(60))
  })

  it('stays within the limit for random run-on titles', () => {
    const words = ['order', 'form', 'bakery', 'home', 'page', 'menu', 'hours', 'map', 'and', 'the', 'to', 'of']
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 200; i++) {
      const n = 12 + Math.floor(rnd() * 20)
      const title = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ')
      const cut = heuristicShortTitle(title)
      expect(cut.length).toBeGreaterThan(0)
      expect(cut.length).toBeLessThanOrEqual(SESSION_TITLE_MAX)
      // A title within the limit is returned as written; only a cut is trimmed.
      if (title.length > SESSION_TITLE_MAX) expect(cut).not.toMatch(/\s(?:and|the|to|of)$/)
    }
  })
})

describe('refineShortTitle (background, real store)', () => {
  beforeEach(() => {
    backend.available = true
    backend.answer = null
    backend.calls = []
  })

  async function seed(): Promise<{ id: string; cut: string }> {
    const cut = heuristicShortTitle(LONG)
    const { task } = await addTask({ title: cut, project: 'marina', description: LONG })
    return { id: task.id, cut }
  }

  it('renames the task to the model\'s answer while it still wears the cut', async () => {
    const { id, cut } = await seed()
    backend.answer = 'Bakery site launch'
    await refineShortTitle(id, cut, LONG)
    expect((await getTask(id)).title).toBe('Bakery site launch')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].placeholder).toBe(cut)
    expect(backend.calls[0].brief).toBe(LONG)
    expect(backend.calls[0].requirement).toContain('at most 60 characters')
  })

  it('puts the description after the long title when it says more', async () => {
    const { id, cut } = await seed()
    backend.answer = 'Bakery site launch'
    await refineShortTitle(id, cut, LONG, 'Ship before the weekend market.')
    expect(backend.calls[0].brief).toBe(`${LONG}\n\nShip before the weekend market.`)
    // A description that only repeats the title is not sent twice.
    backend.calls = []
    const second = await seed()
    await refineShortTitle(second.id, second.cut, LONG, LONG)
    expect(backend.calls[0].brief).toBe(LONG)
  })

  it('keeps the cut when the gate is closed, the model has no answer, or answers the cut', async () => {
    const { id, cut } = await seed()
    backend.available = false
    await refineShortTitle(id, cut, LONG)
    expect(backend.calls).toHaveLength(0)
    backend.available = true
    backend.answer = null
    await refineShortTitle(id, cut, LONG)
    backend.answer = cut
    await refineShortTitle(id, cut, LONG)
    expect((await getTask(id)).title).toBe(cut)
  })

  it('never overwrites a rename that landed in between', async () => {
    const { id, cut } = await seed()
    await updateTask(id, { title: 'Chosen by hand' })
    backend.answer = 'Bakery site launch'
    await refineShortTitle(id, cut, LONG)
    expect(backend.calls).toHaveLength(0)
    expect((await getTask(id)).title).toBe('Chosen by hand')
  })

  it('never overwrites a rename that lands while the model is thinking', async () => {
    const { id, cut } = await seed()
    const { titleViaBackendModel } = await import('../../../src/core/session-title-backend.js')
    vi.mocked(titleViaBackendModel).mockImplementationOnce(async () => {
      await updateTask(id, { title: 'Renamed mid-flight' })
      return 'Bakery site launch'
    })
    await refineShortTitle(id, cut, LONG)
    expect((await getTask(id)).title).toBe('Renamed mid-flight')
  })

  it('uses the head of an answer that overran the limit, never the long form', async () => {
    const { id, cut } = await seed()
    backend.answer = 'Bakery site launch: home page, menu page, order form wired to the mailbox, opening hours'
    await refineShortTitle(id, cut, LONG)
    expect((await getTask(id)).title).toBe('Bakery site launch')
  })

  it('a deleted task is a no-op, and a throwing model never throws out', async () => {
    const { cut } = await seed()
    await expect(refineShortTitle('t_gone', cut, LONG)).resolves.toBeUndefined()
    const { id } = await seed()
    const { titleViaBackendModel } = await import('../../../src/core/session-title-backend.js')
    vi.mocked(titleViaBackendModel).mockImplementationOnce(async () => { throw new Error('boom') })
    await expect(refineShortTitle(id, cut, LONG)).resolves.toBeUndefined()
    expect((await getTask(id)).title).toBe(cut)
  })
})
