/**
 * useBriefFileOpener (web/src/components/org/useBriefFileOpener.tsx), mounted: a path in the Brief
 * opens on the machine of whoever wrote it, read on the click only, and a lookup that answers late
 * opens nothing once the chooser was cancelled, the view unmounted, a newer click came, or the
 * letter or its sources changed (changed and back included). A newer task list only renames the
 * writers in the chooser. A render React never committed (a suspended transition) names no writer
 * and no label. An unrecorded writer opens no file and reads no session, keeping the position.
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
vi.mock('@/hooks/useHostDisplayLabel', () => ({ useHostDisplayLabels: () => (host: string) => `machine ${host}` }))
vi.mock('@/components/common/ConfirmDialog', async () => {
  const react = await import('../../web/node_modules/react/index.js')
  return {
    ConfirmDialog: ({ message, onCancel }: { message: unknown; onCancel: () => void }) => react.createElement('div', { 'data-testid': 'chooser' },
      message as never, react.createElement('button', { type: 'button', 'data-testid': 'chooser-cancel', onClick: onCancel }, 'Cancel')),
  }
})
vi.mock('../../web/src/components/org/org-brief-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/components/org/org-brief-sources')>()),
  briefPathBlocks: () => null,
  briefPathWritersOf: (text: string, _sources: unknown, _blocks: unknown, path: string) => h.writers.get(`${text}|${path}`) ?? null,
}))

const { useBriefFileOpener } = await import('../../web/src/components/org/useBriefFileOpener')
const { OrgBrief } = await import('../../web/src/components/org/OrgBrief')
const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

type Open = (path: string, line?: number, term?: undefined, endLine?: number) => void
interface P { text: string; sources?: unknown; tasks: readonly Task[]; suspend?: boolean }
const never = new Promise<never>(() => {})
let open: Open | null = null
function Probe(p: P) {
  const opener = useBriefFileOpener('owner-task-0001', p.text, p.sources ?? null, p.tasks)
  open = opener.open
  if (p.suspend) throw never
  return opener.dialog
}

const task = (id: string, title: string) => ({ id, title }) as Task
const TASKS = [task('t1', 'Old one'), task('t2', 'Second')]
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
    await mount({ text: 'A', tasks: TASKS })
    expect(h.fetchSession).not.toHaveBeenCalled()
    open!(ONE, 3)
    expect(h.fetchSession).toHaveBeenCalledExactlyOnceWith('s1')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: ONE, line: 3, host: 'devbox', sourceOnly: true })
  })

  it('Cancel on the pending chooser outdates its reads: their late answers open nothing', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(TWO)
    await flush()
    expect(q('chooser')).toHaveLength(1)
    expect(q('org-brief-file-source')).toHaveLength(0)
    await click(q('chooser-cancel')[0]!)
    expect(q('chooser')).toHaveLength(0)
    await answer(0, 'devbox')
    await answer(1, 'gpubox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
    expect(q('chooser')).toHaveLength(0)
  })

  it('an answer after unmount opens nothing', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(ONE)
    await act(async () => { root!.unmount() })
    root = null
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an answer after the letter changed opens nothing', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(ONE)
    await rerender({ text: 'B', tasks: TASKS })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('an answer after the letter\'s sources changed opens nothing', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(ONE)
    await rerender({ text: 'A', sources: [{ start: 0, end: 1, by: 'human' }], tasks: TASKS })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('a letter that changed and came back (A, B, A) still outdates the click made on the first A', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(ONE)
    await rerender({ text: 'B', tasks: TASKS })
    await rerender({ text: 'A', tasks: TASKS })
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
    open!(ONE)
    await answer(1, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: ONE, host: 'devbox', sourceOnly: true })
  })

  it('a replaced letter never restores its old chooser when the same letter returns', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(TWO)
    await answer(0, 'devbox')
    await answer(1, 'gpubox')
    expect(q('org-brief-file-source')).toHaveLength(2)
    await rerender({ text: 'B', tasks: TASKS })
    expect(q('chooser')).toHaveLength(0)
    await rerender({ text: 'A', tasks: TASKS })
    expect(q('chooser')).toHaveLength(0)
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('of two clicks only the newer opens, whichever answers first', async () => {
    await mount({ text: 'A', tasks: TASKS })
    h.writers.set(`A|/srv/b.ts`, [{ by: 'task:t2', sessionId: 's2' }])
    open!(ONE)
    open!('/srv/b.ts')
    await answer(1, 'gpubox')
    await answer(0, 'devbox')
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/srv/b.ts', host: 'gpubox', sourceOnly: true })
  })

  it('a newer task list of the same letter only renames the writers; the pick opens on its machine', async () => {
    await mount({ text: 'A', tasks: TASKS })
    open!(TWO, 7)
    await rerender({ text: 'A', tasks: [task('t1', 'New one'), task('t2', 'Second')] })
    await answer(0, 'devbox')
    await answer(1, 'gpubox')
    const picks = q('org-brief-file-source')
    expect(picks.map((b) => b.textContent)).toEqual(['machine devbox: Words of New one', 'machine gpubox: Words of Second'])
    await click(picks[0]!)
    expect(q('chooser')).toHaveLength(0)
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: TWO, line: 7, host: 'devbox', sourceOnly: true })
  })

  it('the mounted Brief sends raw relative links to its writer opener before any path lookup', async () => {
    await mount({ text: 'A', tasks: TASKS })
    const text = '<a class="file-link" data-rel-path="src/notes.ts" data-cwd="/forged" data-file-line="4" data-file-end-line="9">Notes</a>'
    const owner = { id: 'owner-task-0001', brief: { text, at: new Date().toISOString() } } as Task
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(OrgBrief, {
        owner, tasks: [], name: 'Notes', now: Date.now(), onOpenTask: () => {},
      })))
    })
    const link = doc.querySelector('[data-testid="org-brief-body"] a.file-link')!
    expect(link).not.toBeNull()
    await click(link)
    expect(h.locatePath).not.toHaveBeenCalled()
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.peekSessionRecord).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({
      path: 'src/notes.ts', line: 4, endLine: 9, sourceFailure: expect.stringContaining('No file was read'), sourceReason: 'unrecorded',
    })
  })

  it('an unrecorded writer opens no file and reads no session, keeping the line and the range', async () => {
    h.writers.set(`A|/srv/unknown.ts`, [{ by: 'task:t1' }, { by: 'task:t2', sessionId: 's2' }])
    await mount({ text: 'A', tasks: TASKS })
    open!('/srv/unknown.ts', 4, undefined, 9)
    open!('/srv/nowhere.ts', 2)
    expect(h.fetchSession).not.toHaveBeenCalled()
    expect(h.peekSessionRecord).not.toHaveBeenCalled()
    expect(h.openFileAnywhere.mock.calls).toEqual([
      [{ path: '/srv/unknown.ts', line: 4, endLine: 9, sourceFailure: expect.stringContaining('No file was read'), sourceReason: 'unrecorded' }],
      [{ path: '/srv/nowhere.ts', line: 2, sourceFailure: expect.stringContaining('No file was read'), sourceReason: 'unrecorded' }],
    ])
    expect(q('chooser')).toHaveLength(0)
  })

  it('a render React never committed names no writer and no label', async () => {
    h.writers.set(`C|${TWO}`, [{ by: 'task:t3', sessionId: 's3' }, { by: 'task:t4', sessionId: 's4' }])
    await mount({ text: 'A', tasks: TASKS })
    await act(async () => {
      startTransition(() => root!.render(tree({ text: 'C', tasks: [task('t1', 'New one'), task('t2', 'Second')], suspend: true })))
    })
    open!(TWO)
    expect(h.fetchSession.mock.calls.map(([sid]) => sid)).toEqual(['s1', 's2'])
    await answer(0, 'devbox')
    await answer(1, 'gpubox')
    expect(q('org-brief-file-source').map((b) => b.textContent)).toEqual(['machine devbox: Words of Old one', 'machine gpubox: Words of Second'])
  })
})
