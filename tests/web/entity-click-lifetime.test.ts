/**
 * useEntityClickHandler (web/src/hooks/useEntityClickHandler.ts), mounted: a relative path is
 * looked up before it opens, and that lookup belongs to its click and its surface. A newer click
 * of any kind, a new source (host or session), or an unmount makes its answer open nothing, and a
 * handler kept past its surface or source opens no file. A new opener identity is not a new source:
 * a lookup in flight goes on and opens with the latest opener. A late answer used to call the old
 * opener after the surface had closed or changed source, and its viewer popped up elsewhere.
 *
 * Real React over a linkedom document, inside a real MemoryRouter. Stubbed: only the boundaries,
 * the path lookup (`locatePath`) and the app's opener (`openFileAnywhere`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, StrictMode, Suspense, startTransition } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

type Answer = { path: string; found: boolean; missing?: boolean; line?: number; endLine?: number }
const h = vi.hoisted(() => ({
  pending: [] as Array<{ ref: string; ctx: Record<string, unknown>; resolve: (r: Answer) => void; reject: (e: unknown) => void }>,
  locatePath: vi.fn(),
  openFileAnywhere: vi.fn(),
  claimed: [] as unknown[],
  warn: vi.fn(),
}))
vi.mock('@/api/files', () => ({ locatePath: h.locatePath }))
vi.mock('@/utils/open-anywhere', () => ({ openFileAnywhere: h.openFileAnywhere, claimAgentLinkClick: (e: unknown) => { h.claimed.push(e) } }))
vi.mock('@/utils/open-session', () => ({ openTaskOnHome: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }))

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')
const { useEntityClickHandler } = await import('../../web/src/hooks/useEntityClickHandler')

type FileOpen = (path: string, line?: number, term?: undefined, endLine?: number) => void
interface Props { onSessionClick?: (id: string) => void; onFileOpen?: FileOpen; fileHost?: string; fileSessionId?: string; relativeToOpener?: boolean; suspend?: boolean }
type Handler = (e: unknown) => void
const pendingRender = new Promise<never>(() => {})

let latest: Handler | null = null
function Probe(p: Props) {
  latest = useEntityClickHandler(p.onSessionClick, p.onFileOpen, p.fileHost, p.fileSessionId, p.relativeToOpener) as unknown as Handler
  if (p.suspend) throw pendingRender
  return null
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const answer = async (i: number, r: Partial<Answer> = {}) => { h.pending[i]!.resolve({ path: `/srv/${h.pending[i]!.ref}`, found: true, ...r }); await flush() }

describe('a file link opens only from its click and its surface as they are now', () => {
  let doc: Document
  let root: { render: (el: unknown) => void; unmount: () => void } | null
  let mounted = false

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
    h.claimed.length = 0
    h.locatePath.mockReset().mockImplementation((ref: string, ctx: Record<string, unknown>) =>
      new Promise((resolve, reject) => { h.pending.push({ ref, ctx, resolve, reject }) }))
    h.openFileAnywhere.mockReset()
    h.warn.mockReset()
    latest = null
    root = null
    mounted = false
  })

  afterEach(async () => {
    if (root && mounted) await act(async () => { root!.unmount() })
  })

  const tree = (p: Props, strict: boolean) => {
    const routed = createElement(MemoryRouter, null, createElement(Suspense, { fallback: null }, createElement(Probe, p)))
    return strict ? createElement(StrictMode, null, routed) : routed
  }
  async function mount(p: Props, strict = false) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    root = createRoot(el as unknown as Element) as unknown as typeof root
    mounted = true
    await act(async () => { root!.render(tree(p, strict)) })
  }
  const rerender = (p: Props) => act(async () => { root!.render(tree(p, false)) })
  const unmount = async () => { await act(async () => { root!.unmount() }); mounted = false }

  function anchor(cls: string, data: Record<string, string>): HTMLElement {
    const a = doc.createElement('a')
    a.className = cls
    for (const [k, v] of Object.entries(data)) a.setAttribute(`data-${k}`, v)
    doc.body.appendChild(a)
    return a as unknown as HTMLElement
  }
  const press = (handler: Handler, target: HTMLElement) => {
    const e = { target, preventDefault: vi.fn(), nativeEvent: { target } }
    handler(e)
    return e
  }
  const rel = (name: string, line?: number) => anchor('file-link', { 'rel-path': name, cwd: '/srv/repo', ...(line ? { 'file-line': String(line) } : {}) })
  const abs = (p: string) => anchor('file-link', { 'file-path': p })

  it('mounting asks nothing; a relative click looks up once and opens with the anchor\'s own positions', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open, fileHost: 'devbox', fileSessionId: 'sid-full-0001' })
    expect(h.locatePath).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
    const e = press(latest!, anchor('file-link', { 'rel-path': 'src/a.ts', cwd: '/srv/repo', 'file-line': '7', 'file-end-line': '9' }))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(h.claimed).toEqual([e.nativeEvent])
    expect(h.locatePath).toHaveBeenCalledExactlyOnceWith('src/a.ts', { host: 'devbox', cwd: '/srv/repo', sessionId: 'sid-full-0001', sourceOnly: true })
    await answer(0, { path: '/srv/repo/src/a.ts', line: 99, endLine: 100 })
    expect(open).toHaveBeenCalledExactlyOnceWith('/srv/repo/src/a.ts', 7, undefined, 9)
  })

  it('no line on the anchor: the lookup\'s position; a miss opens the path joined to cwd', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open })
    press(latest!, rel('./b.ts'))
    await answer(0, { found: false, path: '/nowhere/b.ts', line: 4, endLine: 6 })
    expect(open).toHaveBeenCalledExactlyOnceWith('/srv/repo/b.ts', 4, undefined, 6)
  })

  it('an unknown writer: a relative path goes to the opener as written, never to a lookup on every host', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open, relativeToOpener: true })
    const e = press(latest!, anchor('file-link', { 'rel-path': 'src/a.ts', cwd: '/srv/repo', 'file-line': '7', 'file-end-line': '9' }))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(h.claimed).toEqual([e.nativeEvent])
    expect(h.locatePath).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledExactlyOnceWith('src/a.ts', 7, undefined, 9)
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('no opener of its own: the app\'s viewer, on this surface\'s host', async () => {
    await mount({ fileHost: 'devbox' })
    press(latest!, rel('c.ts', 3))
    await answer(0, { path: '/srv/repo/c.ts' })
    expect(h.openFileAnywhere).toHaveBeenCalledExactlyOnceWith({ path: '/srv/repo/c.ts', line: 3, host: 'devbox' })
  })

  it('unmounted before the answer: nothing opens', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open })
    press(latest!, rel('a.ts'))
    await unmount()
    await answer(0)
    expect(open).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it.each([
    ['its host', { fileHost: 'otherbox' }],
    ['its session', { fileSessionId: 'sid-full-0002' }],
  ])('%s changed before the answer: nothing opens, even after it changes back', async (_what, change) => {
    const open = vi.fn<FileOpen>()
    const first: Props = { onFileOpen: open, fileHost: 'devbox', fileSessionId: 'sid-full-0001' }
    await mount(first)
    press(latest!, rel('a.ts'))
    await rerender({ ...first, ...change })
    // Back to the first source: the lookup from before stays dead, never brought back.
    await rerender(first)
    await answer(0)
    expect(open).not.toHaveBeenCalled()
  })

  it('a new opener each render (same source) cancels nothing: the answer opens with the latest one', async () => {
    const first = vi.fn<FileOpen>()
    const second = vi.fn<FileOpen>()
    const third = vi.fn<FileOpen>()
    const source = { fileHost: 'devbox', fileSessionId: 'sid-full-0001' }
    await mount({ ...source, onFileOpen: first })
    press(latest!, rel('a.ts', 5))
    await rerender({ ...source, onFileOpen: second })
    await rerender({ ...source, onFileOpen: third })
    await answer(0, { path: '/srv/repo/a.ts' })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(third).toHaveBeenCalledExactlyOnceWith('/srv/repo/a.ts', 5, undefined, undefined)
  })

  it('a new session callback each render cancels nothing', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open, onSessionClick: () => {} })
    press(latest!, rel('a.ts'))
    await rerender({ onFileOpen: open, onSessionClick: () => {} })
    await answer(0, { path: '/srv/repo/a.ts' })
    expect(open).toHaveBeenCalledExactlyOnceWith('/srv/repo/a.ts', undefined, undefined, undefined)
  })

  it.each([
    ['an absolute path', () => abs('/home/me/x.ts')],
    ['a task', () => anchor('task-link', { 'task-id': 't-1' })],
    ['a session', () => anchor('session-link', { 'session-id': 's-1' })],
    ['a project', () => anchor('project-link', { project: 'P' })],
    ['a letter', () => anchor('letter-link', { 'letter-id': 'lt-a-b' })],
    ['a URL', () => { const a = anchor('', {}); a.setAttribute('href', 'https://example.com/x'); return a }],
  ])('a newer click on %s: the earlier relative answer opens nothing', async (_what, make) => {
    const open = vi.fn<FileOpen>()
    const onSessionClick = vi.fn()
    await mount({ onFileOpen: open, onSessionClick })
    press(latest!, rel('a.ts'))
    // A session or project press navigates the real router: inside act.
    await act(async () => { press(latest!, make()) })
    const now = open.mock.calls.slice()
    await answer(0)
    expect(open.mock.calls).toEqual(now)
    expect(open.mock.calls.every((c) => c[0] !== '/srv/a.ts')).toBe(true)
  })

  it('two relative clicks answered out of order: only the latest opens, whichever answers first', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open })
    press(latest!, rel('one.ts'))
    press(latest!, rel('two.ts'))
    await answer(1, { path: '/srv/repo/two.ts' })
    await answer(0, { path: '/srv/repo/one.ts' })
    expect(open.mock.calls).toEqual([['/srv/repo/two.ts', undefined, undefined, undefined]])

    open.mockReset()
    press(latest!, rel('three.ts'))
    press(latest!, rel('four.ts'))
    await answer(2, { path: '/srv/repo/three.ts' })
    expect(open).not.toHaveBeenCalled()
    await answer(3, { path: '/srv/repo/four.ts' })
    expect(open.mock.calls).toEqual([['/srv/repo/four.ts', undefined, undefined, undefined]])
  })

  it('a handler kept past its surface opens no file, absolute or relative', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open })
    const kept = latest!
    await unmount()
    const e = press(kept, abs('/home/me/x.ts'))
    press(kept, rel('a.ts'))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(h.claimed).toContain(e.nativeEvent)
    expect(h.locatePath).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(h.openFileAnywhere).not.toHaveBeenCalled()
  })

  it('a handler kept from before a new opener (same source) opens with the latest opener, never the old one', async () => {
    const before = vi.fn<FileOpen>()
    const after = vi.fn<FileOpen>()
    await mount({ onFileOpen: before })
    const old = latest!
    await rerender({ onFileOpen: after })
    press(old, abs('/home/me/x.ts'))
    expect(before).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledExactlyOnceWith('/home/me/x.ts', undefined, undefined, undefined)
  })

  it('an uncommitted suspended render cannot replace the visible surface opener', async () => {
    const before = vi.fn<FileOpen>()
    const pending = vi.fn<FileOpen>()
    await mount({ onFileOpen: before })
    const committed = latest!
    await act(async () => {
      startTransition(() => root!.render(tree({ onFileOpen: pending, suspend: true }, false)))
    })
    press(committed, abs('/home/me/x.ts'))
    expect(before).toHaveBeenCalledExactlyOnceWith('/home/me/x.ts', undefined, undefined, undefined)
    expect(pending).not.toHaveBeenCalled()
  })

  it('a handler kept from before its source changed opens no file; the current one opens there', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open, fileHost: 'devbox', fileSessionId: 'sid-full-0001' })
    const old = latest!
    await rerender({ onFileOpen: open, fileHost: 'otherbox', fileSessionId: 'sid-full-0002' })
    press(old, abs('/home/me/x.ts'))
    press(old, rel('a.ts'))
    expect(open).not.toHaveBeenCalled()
    expect(h.locatePath).not.toHaveBeenCalled()
    press(latest!, rel('a.ts'))
    expect(h.locatePath).toHaveBeenCalledExactlyOnceWith('a.ts', { host: 'otherbox', cwd: '/srv/repo', sessionId: 'sid-full-0002', sourceOnly: true })
    await answer(0, { path: '/srv/repo/a.ts' })
    expect(open).toHaveBeenCalledExactlyOnceWith('/srv/repo/a.ts', undefined, undefined, undefined)
  })

  it('StrictMode\'s mount, cleanup and mount again leaves the surface working', async () => {
    const open = vi.fn<FileOpen>()
    await mount({ onFileOpen: open }, true)
    press(latest!, rel('a.ts'))
    await answer(0, { path: '/srv/repo/a.ts' })
    expect(open).toHaveBeenCalledExactlyOnceWith('/srv/repo/a.ts', undefined, undefined, undefined)
  })

  it('a lookup that fails, or an opener that throws, is logged with the whole path and session, never unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (r: unknown) => { unhandled.push(r) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const open = vi.fn<FileOpen>(() => { throw new Error('viewer refused') })
      const sid = 'sid-full-0001-aaaa-bbbb-cccc'
      await mount({ onFileOpen: open, fileHost: 'devbox', fileSessionId: sid })
      press(latest!, rel('deep/dir/a.ts'))
      h.pending[0]!.reject(new Error('lookup offline'))
      await flush()
      press(latest!, rel('deep/dir/b.ts'))
      await answer(1, { path: '/srv/repo/deep/dir/b.ts' })
      await flush()
      expect(h.warn.mock.calls.map((c) => c[2])).toEqual([
        { path: 'deep/dir/a.ts', cwd: '/srv/repo', sessionId: sid, host: 'devbox', error: 'lookup offline' },
        { path: 'deep/dir/b.ts', cwd: '/srv/repo', sessionId: sid, host: 'devbox', error: 'viewer refused' },
      ])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
