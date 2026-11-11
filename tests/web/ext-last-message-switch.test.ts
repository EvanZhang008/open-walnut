import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

type History = { messages: Array<{ role: string; text: string }> }
const pending = new Map<string, Array<(history: History) => void>>()
vi.mock('@/api/sessions', () => ({
  fetchSessionHistory: (sid: string) => new Promise<History>((resolve) => {
    pending.set(sid, [...(pending.get(sid) ?? []), resolve])
  }),
}))

let useLastMessage: typeof import('../../web/src/popout/PopoutExtTasks').useLastMessage
let root: Root | null = null
let box: Element
const frames: Array<{ sid: string | null; known: boolean; text: string; writer: string }> = []

function Probe({ sid, known = false }: { sid: string | null; known?: boolean }) {
  const said = useLastMessage(sid, known)
  frames.push({ sid, known, text: said.text, writer: said.sessionId })
  return null
}

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  box = dom.document.createElement('div')
  dom.document.body.appendChild(box)
  ;({ useLastMessage } = await import('../../web/src/popout/PopoutExtTasks'))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  pending.clear()
  frames.length = 0
})

async function render(sid: string | null, known = false) {
  root ??= createRoot(box)
  await act(async () => { root!.render(createElement(Probe, { sid, known })) })
}

async function answer(sid: string, text: string) {
  const queue = pending.get(sid) ?? []
  expect(queue.length).toBeGreaterThan(0)
  await act(async () => { queue.shift()!({ messages: [{ role: 'assistant', text }] }) })
}

describe('an extension reply stays with the session it was read from', () => {
  it('never shows a previous session reply in the next session first frame', async () => {
    await render('A')
    await answer('A', 'Read /srv/a.log')
    expect(frames.at(-1)).toMatchObject({ text: 'Read /srv/a.log', writer: 'A' })
    const start = frames.length
    await render('B')
    expect(frames.slice(start).every((f) => f.text === '' && f.writer === '')).toBe(true)
    await answer('B', 'Read /srv/b.log')
    expect(frames.at(-1)).toMatchObject({ text: 'Read /srv/b.log', writer: 'B' })
    await render(null)
    expect(frames.at(-1)).toMatchObject({ text: '', writer: '' })
  })

  it('ignores an old request even when it answers after the new request', async () => {
    await render('A')
    await render('B')
    await answer('B', 'Read /srv/b.log')
    await answer('A', 'Late /srv/a.log')
    expect(frames.at(-1)).toMatchObject({ sid: 'B', text: 'Read /srv/b.log', writer: 'B' })
  })

  it('hides the fetched reply when a stored reply becomes available', async () => {
    await render('A')
    await answer('A', 'Read /srv/a.log')
    await render('A', true)
    expect(frames.at(-1)).toMatchObject({ known: true, text: '', writer: '' })
  })
})
