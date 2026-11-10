/**
 * Real input by default leaves a control whose own click opens a picker Chrome draws outside the
 * page (a select's list, the file chooser, a date, time or colour picker) to the page's events
 * (agent-trusted.ts, review 2026-11-09: the file chooser is a window of the system's and takes the
 * person's focus). The page says so in `locate` when asked with `blank` (page-ops.ts opensPicker),
 * run for real against the small DOM (page-dom-fake.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { installFakePage } from './page-dom-fake'

;(globalThis as any).chrome = {
  runtime: {
    id: 'test',
    getFrameId: () => -1,
    sendMessage: async () => ({ ok: true, placed: true }),
    onMessage: { addListener() {}, removeListener() {} },
  },
}
const page = installFakePage()
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const cur = await import('../../../packages/browser-extension/src/page-cursor')

const PICKERS = ['file', 'date', 'time', 'datetime-local', 'month', 'week', 'color']

beforeEach(() => {
  cur._resetCursorForTesting()
  page.load(`<select id="size"><option>S</option><option>M</option></select>
    ${PICKERS.map((t) => `<input id="in-${t}" type="${t}" aria-label="${t}">`).join('')}
    <label id="wrap">Attachment <input type="file" id="inner"></label>
    <label id="for-label" for="when">When</label><input type="date" id="when">
    <input id="name" aria-label="Name"><button id="go">Next</button><label id="plain">Name <input id="inside"></label>`)
  page.place('#size', { x: 10, y: 10, w: 100, h: 30 })
  PICKERS.forEach((t, i) => page.place(`#in-${t}`, { x: 10, y: 50 + i * 40, w: 100, h: 30 }))
  page.place('#wrap', { x: 300, y: 10, w: 200, h: 30 })
  page.place('#for-label', { x: 300, y: 60, w: 80, h: 30 })
  page.place('#when', { x: 400, y: 60, w: 100, h: 30 })
  page.place('#name', { x: 300, y: 110, w: 100, h: 30 })
  page.place('#go', { x: 300, y: 160, w: 100, h: 30 })
  page.place('#plain', { x: 300, y: 210, w: 200, h: 30 })
})

const at = async (x: number, y: number, blank = true) => await runPageOp('locate', { x, y, cursor: 'click', outward: 'click', ...(blank ? { blank: true } : {}) }) as Record<string, unknown>

describe('locate with blank names a control that opens a picker of the browser\'s', () => {
  it('a select', async () => {
    expect((await at(50, 25)).native).toBe(true)
  })

  it.each(PICKERS.map((t, i) => [t, i] as const))('an input of type %s', async (_t, i) => {
    expect((await at(50, 65 + i * 40)).native).toBe(true)
  })

  it('a label around a file field, and a label naming a date field by its for', async () => {
    expect((await at(320, 25)).native).toBe(true)
    expect((await at(320, 75)).native).toBe(true)
  })

  it('a text field, a button and a label of a text field: no picker', async () => {
    expect((await at(350, 125)).native).toBeUndefined()
    expect((await at(350, 175)).native).toBeUndefined()
    expect((await at(320, 225)).native).toBeUndefined()
  })

  it('without blank (a step asked for by name), nothing is said', async () => {
    expect((await at(50, 25, false)).native).toBeUndefined()
  })
})
