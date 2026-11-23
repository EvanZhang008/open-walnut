/**
 * useAgentFileOpener (web/src/hooks/useAgentFileOpener.ts), mounted: a session's host is read on
 * the click and never on mount, and a lookup that answers late opens nothing once the surface
 * unmounted, its source changed, or a newer click came. A late answer used to reach the app's
 * one viewer from a card the user had already closed.
 *
 * Real React mounts over a linkedom document, as tests/web/use-integrations-cache.test.ts does.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import fs from 'node:fs'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const h = vi.hoisted(() => ({
  pending: [] as Array<{ sid: string; resolve: (r: { host?: string } | null) => void; reject: (e: unknown) => void }>,
  fetchSession: vi.fn(),
  peekSessionRecord: vi.fn(() => null),
  openFileAnywhere: vi.fn(),
}))
vi.mock('@/api/sessions', () => ({ fetchSession: h.fetchSession, peekSessionRecord: h.peekSessionRecord }))
vi.mock('@/utils/open-anywhere', () => ({ openFileAnywhere: h.openFileAnywhere }))
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { useAgentFileOpener, type AgentFileOpener } from '../../web/src/hooks/useAgentFileOpener'
import type { AgentTextSource } from '../../web/src/utils/agent-text-source'

let latest: AgentFileOpener | null = null
function Probe({ src }: { src: AgentTextSource | undefined }) {
  latest = useAgentFileOpener(src)
  return null
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const answer = async (i: number, host: string) => { h.pending[i]!.resolve({ host }); await flush() }

describe('a file lookup lives only as long as its click and its surface', () => {
  let doc: Document
  let root: { render: (el: unknown) => void; unmount: () => void } | null

  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })

  beforeEach(() => {
    h.pending.length = 0
    h.fetchSession.mockReset().mockImplementation((sid: string) => new Promise((resolve, reject) => { h.pending.push({ sid, resolve, reject }) }))
    h.peekSessionRecord.mockReset().mockReturnValue(null)
    h.openFileAnywhere.mockReset()
    latest = null
    root = null
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
  })

  async function mount(src: AgentTextSource | undefined) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    root = createRoot(el as unknown as Element) as unknown as typeof root
    await act(async () => { root!.render(createElement(Probe, { src })) })
  }
  const rerender = (src: AgentTextSource | undefined) => act(async () => { root!.render(createElement(Probe, { src })) })

  it('mounting asks nothing; the click reads the session once and opens on its host', async () => {
    await mount({ sessionId: 's1' })
    expect(latest!.refusesAll).toBeUndefined()
    expect(h.fetchSession).not.toHaveBeenCalled()
    latest!.onFileOpen!('/home/me/a.ts', 4)
    expect(h.fetchSession).toHaveBeenCalledExactlyOnceWith('s1')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', line: 4, host: 'devbox' })
  })

  it('no source: no opener of its own, so the shared handler keeps its default', async () => {
    await mount(undefined)
    expect(latest!.onFileOpen).toBeUndefined()
    expect(h.fetchSession).not.toHaveBeenCalled()
  })

  it('an answer after unmount opens nothing', async () => {
    await mount({ sessionId: 's1' })
    latest!.onFileOpen!('/home/me/a.ts')
    await act(async () => { root!.unmount() })
    root = null
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an answer after the source changed opens nothing', async () => {
    await mount({ sessionId: 's1' })
    const click = latest!.onFileOpen!
    click('/home/me/a.ts')
    await rerender({ sessionId: 's2' })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('of two clicks only the newer opens, whichever answers first', async () => {
    await mount({ sessionId: 's1' })
    latest!.onFileOpen!('/a.ts')
    latest!.onFileOpen!('/b.ts')
    await answer(1, 'devbox')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/b.ts', host: 'devbox' })

    h.openFileAnywhere.mockReset()
    latest!.onFileOpen!('/c.ts')
    latest!.onFileOpen!('/d.ts')
    await answer(2, 'devbox')
    await answer(3, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/d.ts', host: 'devbox' })
  })

  it('a failed lookup looks the path up on every machine, never this one first, and the next press asks the session again', async () => {
    await mount({ sessionId: 's1' })
    latest!.onFileOpen!('/home/me/a.ts')
    h.pending[0]!.reject(new Error('timeout'))
    await flush()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', anywhere: true })
    h.openFileAnywhere.mockReset()
    latest!.onFileOpen!('/home/me/a.ts', 2)
    await answer(1, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', line: 2, host: 'devbox' })
  })

  it('an unrecorded writer asks nothing and looks an absolute or a relative path up on every machine', async () => {
    await mount({ unknownSource: true })
    expect(latest!.render).toEqual({ images: false })
    // The shared click handler hands it relative paths too (useEntityClickHandler relativeToOpener).
    expect(latest!.refusesAll).toBe(true)
    expect(latest!.fileSessionId).toBeUndefined()
    expect(latest!.fileHost).toBeUndefined()
    for (const path of ['/home/me/a.ts', 'src/a.ts']) {
      h.openFileAnywhere.mockReset()
      latest!.onFileOpen!(path, 3)
      await flush()
      expect(h.fetchSession).not.toHaveBeenCalled()
      expect(h.peekSessionRecord).not.toHaveBeenCalled()
      // No host, no failure text, no question: the position rides with the every-machine request.
      expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path, line: 3, anywhere: true })
    }
  })

  it('an unknown source keeps the line range and names its task first, without reading anything', async () => {
    await mount({ unknownSource: true, taskId: 't7' })
    latest!.onFileOpen!('/home/me/a.ts', 3, undefined, 8)
    await flush()
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', line: 3, endLine: 8, anywhere: true, taskId: 't7' })
  })

  it('an unknown source keeps one opener across renders (no stale object), and a recorded writer replaces it', async () => {
    await mount({ unknownSource: true })
    const first = latest!.onFileOpen
    await rerender({ unknownSource: true })
    expect(latest!.onFileOpen).toBe(first)
    // The writer becomes known (a fresh status with its session): the next click reads that session.
    await rerender({ unknownSource: true, sessionId: 's-old' })
    expect(latest!.onFileOpen).not.toBe(first)
    latest!.onFileOpen!('/home/me/a.ts')
    expect(h.fetchSession).toHaveBeenCalledExactlyOnceWith('s-old')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', host: 'devbox' })
  })

  it('a lookup in flight opens nothing once the source turns unknown', async () => {
    await mount({ sessionId: 's-old' })
    latest!.onFileOpen!('/home/me/a.ts')
    await rerender({ unknownSource: true })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an unknown source is never filled in from the task\'s current session, only its task is named', async () => {
    await mount({ unknownSource: true, task: { id: 't1', title: 'T', session_id: 's-new', session_ids: ['s-new'] } as never })
    latest!.onFileOpen!('/home/me/a.ts')
    await flush()
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', anywhere: true, taskId: 't1' })
  })

  it('a session that is gone or unreadable asks every machine, its source\'s task first', async () => {
    await mount({ sessionId: 's1', task: { id: 't1', title: 'T', session_ids: [] } as never })
    latest!.onFileOpen!('/home/me/a.ts')
    h.pending[0]!.reject(new Error('timeout'))
    await flush()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', anywhere: true, taskId: 't1' })
    h.openFileAnywhere.mockReset()
    latest!.onFileOpen!('/home/me/a.ts')
    h.pending[1]!.resolve(null)
    await flush()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/a.ts', anywhere: true, taskId: 't1' })
  })

  it('a failed lookup after unmount opens nothing', async () => {
    await mount({ sessionId: 's1' })
    latest!.onFileOpen!('/home/me/a.ts')
    await act(async () => { root!.unmount() })
    root = null
    h.pending[0]!.reject(new Error('timeout'))
    await flush()
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('a new source cancels a lookup at commit, not in a later passive effect', () => {
    // A passive cleanup runs after the commit, so an answer landing in that gap opened the old
    // source's file; the cancel lives in a layout effect and each open checks the shown source.
    const src = fs.readFileSync('web/src/hooks/useAgentFileOpener.ts', 'utf8')
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*shown\.current = sourceKey;\s*return \(\) => \{ seq\.current\+\+; \};\s*\}, \[sourceKey\]\)/)
    expect(src).not.toMatch(/\buseEffect\(/)
    expect(src).toContain('mine === seq.current && shown.current === sourceKey')
  })
})
