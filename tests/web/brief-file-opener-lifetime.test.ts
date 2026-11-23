/**
 * useBriefFileOpener (web/src/components/org/useBriefFileOpener.tsx), mounted: a path in the Brief
 * opens on the machine of whoever wrote it, read on the click only, and a lookup that answers late
 * opens nothing once the view unmounted, a newer click came, or the letter or its sources changed
 * (changed and back included). A writer Walnut did not record, or writers on several machines, are
 * never a question to the person: the path is looked up on every machine, the writing task's first
 * (else the Brief owner's), keeping the position. A render React never committed names no writer.
 *
 * Real React over a linkedom document, as tests/web/agent-file-opener-lifetime.test.ts does. The
 * path-to-writers map (org-brief-sources.ts, tested on its own) is stubbed per letter and path.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import type { Task } from '@open-walnut/core'
import { createElement, act, Suspense, startTransition } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

type Writer = { by: string; sessionId?: string }
const h = vi.hoisted(() => ({
  pending: [] as Array<{ sid: string; resolve: (r: { host: string } | null) => void; reject: (e: unknown) => void }>,
  writers: new Map<string, Writer[]>(),
  fetchSession: vi.fn(),
  peekSessionRecord: vi.fn(),
  locatePath: vi.fn(),
  openFileAnywhere: vi.fn(),
}))
vi.mock('@/api/sessions', () => ({ fetchSession: h.fetchSession, peekSessionRecord: h.peekSessionRecord }))
vi.mock('@/api/files', () => ({ locatePath: h.locatePath }))
vi.mock('@/utils/open-anywhere', () => ({ openFileAnywhere: h.openFileAnywhere, claimAgentLinkClick: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/utils/markdown', () => ({ renderMarkdownWithRefs: (text: string) => text }))
vi.mock('@/hooks/useEntityLabels', () => ({ useEntityLabelsVersion: () => 0 }))
vi.mock('../../web/src/components/org/org-brief-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/components/org/org-brief-sources')>()),
  briefPathBlocks: () => null,
  briefPathWritersOf: (text: string, _sources: unknown, _blocks: unknown, path: string) => h.writers.get(`${text}|${path}`) ?? null,
}))

const { useBriefFileOpener } = await import('../../web/src/components/org/useBriefFileOpener')
const { OrgBrief } = await import('../../web/src/components/org/OrgBrief')
const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

type Open = (path: string, line?: number, term?: undefined, endLine?: number) => void
interface P { text: string; sources?: unknown; suspend?: boolean }
const never = new Promise<never>(() => {})
let open: Open | null = null
function Probe(p: P) {
  const opener = useBriefFileOpener('owner-task-0001', p.text, p.sources ?? null)
  open = opener.open
  if (p.suspend) throw never
  return null
}

const ONE = '/srv/one.ts'
const TWO = '/srv/two.ts'
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const answer = async (i: number, host: string) => { h.pending[i]!.resolve({ host }); await flush() }

describe('a Brief path lookup lives only as long as its click, its letter and its view', () => {
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
    h.writers.clear()
    h.writers.set(`A|${ONE}`, [{ by: 'task:t1', sessionId: 's1' }])
    h.writers.set(`A|${TWO}`, [{ by: 'task:t1', sessionId: 's1' }, { by: 'task:t2', sessionId: 's2' }])
    h.fetchSession.mockReset().mockImplementation((sid: string) => new Promise((resolve, reject) => { h.pending.push({ sid, resolve, reject }) }))
    h.peekSessionRecord.mockReset().mockReturnValue(null)
    h.openFileAnywhere.mockReset()
    h.locatePath.mockReset()
    open = null
    root = null
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
  })

  const tree = (p: P) => createElement(Suspense, { fallback: null }, createElement(Probe, p))
  async function mount(p: P) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    root = createRoot(el as unknown as Element) as unknown as typeof root
    await act(async () => { root!.render(tree(p)) })
  }
  const rerender = (p: P) => act(async () => { root!.render(tree(p)) })
  const q = (id: string) => [...doc.querySelectorAll(`[data-testid="${id}"]`)] as Element[]
  const click = (el: Element) => act(async () => {
    el.dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event('click', { bubbles: true }))
  })

  it('mounting reads nothing; the click reads the writer\'s session once and opens on its machine', async () => {
    await mount({ text: 'A' })
    expect(h.fetchSession).not.toHaveBeenCalled()
    open!(ONE, 3)
    expect(h.fetchSession).toHaveBeenCalledExactlyOnceWith('s1')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: ONE, line: 3, host: 'devbox' })
  })

  it('writers on several machines are never a question: every machine is asked at once, the first writing task first', async () => {
    await mount({ text: 'A' })
    open!(TWO, 5)
    await flush()
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.peekSessionRecord).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: TWO, line: 5, anywhere: true, taskId: 't1', hintSessions: ['s1', 's2'] })
    expect(doc.body.textContent).toBe('')
  })

  it('an answer after unmount opens nothing', async () => {
    await mount({ text: 'A' })
    open!(ONE)
    await act(async () => { root!.unmount() })
    root = null
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an answer after the letter changed opens nothing', async () => {
    await mount({ text: 'A' })
    open!(ONE)
    await rerender({ text: 'B' })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an answer after the letter\'s sources changed opens nothing', async () => {
    await mount({ text: 'A' })
    open!(ONE)
    await rerender({ text: 'A', sources: [{ start: 0, end: 1, by: 'human' }] })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('a letter that changed and came back (A, B, A) still outdates the click made on the first A', async () => {
    await mount({ text: 'A' })
    open!(ONE)
    await rerender({ text: 'B' })
    await rerender({ text: 'A' })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
    open!(ONE)
    await answer(1, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: ONE, host: 'devbox' })
  })

  it('a click on a path with several writers outdates a single-writer lookup still in flight', async () => {
    await mount({ text: 'A' })
    open!(ONE)
    open!(TWO)
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: TWO, anywhere: true, taskId: 't1', hintSessions: ['s1', 's2'] })
  })

  it('of two clicks only the newer opens, whichever answers first', async () => {
    await mount({ text: 'A' })
    h.writers.set(`A|/srv/b.ts`, [{ by: 'task:t2', sessionId: 's2' }])
    open!(ONE)
    open!('/srv/b.ts')
    await answer(1, 'gpubox')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/srv/b.ts', host: 'gpubox' })
  })

  it('the mounted Brief sends raw relative links to its writer opener before any path lookup', async () => {
    await mount({ text: 'A' })
    const text = '<a class="file-link" data-rel-path="src/notes.ts" data-cwd="/forged" data-file-line="4" data-file-end-line="9">Notes</a>'
    const owner = { id: 'owner-task-0001', brief: { text, at: new Date().toISOString() } } as Task
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(OrgBrief, {
        owner, tasks: [], name: 'Notes', now: Date.now(),
      })))
    })
    const link = doc.querySelector('[data-testid="org-brief-body"] a.file-link')!
    expect(link).not.toBeNull()
    await click(link)
    expect(h.locatePath).not.toHaveBeenCalled()
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.peekSessionRecord).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({
      path: 'src/notes.ts', line: 4, endLine: 9, anywhere: true, taskId: 'owner-task-0001',
    })
  })

  it('an unrecorded writer reads no session and asks every machine, keeping the line and the range', async () => {
    h.writers.set(`A|/srv/unknown.ts`, [{ by: 'task:t1' }, { by: 'task:t2', sessionId: 's2' }])
    h.writers.set(`A|/srv/lone.ts`, [{ by: 'task:t3' }])
    await mount({ text: 'A' })
    open!('/srv/unknown.ts', 4, undefined, 9)
    open!('/srv/lone.ts')
    open!('/srv/nowhere.ts', 2)
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.peekSessionRecord).not.toHaveBeenCalled()
    expect(h.openFileAnywhere.mock.calls).toEqual([
      // The writer whose session was recorded is still a hint, asked first.
      [{ path: '/srv/unknown.ts', line: 4, endLine: 9, anywhere: true, taskId: 't1', hintSessions: ['s2'] }],
      [{ path: '/srv/lone.ts', anywhere: true, taskId: 't3' }],
      // No writer found at all: the Brief owner's task is the hint.
      [{ path: '/srv/nowhere.ts', line: 2, anywhere: true, taskId: 'owner-task-0001' }],
    ])
  })

  it('a render React never committed names no writer', async () => {
    h.writers.set(`C|${TWO}`, [{ by: 'task:t3', sessionId: 's3' }, { by: 'task:t4', sessionId: 's4' }])
    await mount({ text: 'A' })
    await act(async () => {
      startTransition(() => root!.render(tree({ text: 'C', suspend: true })))
    })
    open!(TWO)
    // The letter shown is still A: its writers (t1, t2), never the uncommitted C's.
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: TWO, anywhere: true, taskId: 't1', hintSessions: ['s1', 's2'] })
  })
})
