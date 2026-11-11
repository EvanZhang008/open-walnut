/**
 * A path in agent text opens on the machine whose words it is (web/src/utils/agent-text-source.ts).
 *
 * An absolute path with no host opens on this machine first, so a remote session's `/home/me/a.ts`
 * opened a same-named file here. The source's host decides now: a known host wins, else the
 * session record is read on the click only, and a session that cannot be read opens nothing.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { locatePath } from '../../web/src/api/files'
import type { Task } from '@open-walnut/core'
import { openFromSource, renderContextOf, renderCwdOf, sourceFailureText, sourceHostOf, sourceSessionId, type SessionHostLookup } from '../../web/src/utils/agent-text-source'

const task = (over: Partial<Task>): Task => ({ id: 't1', title: 'T', session_ids: [], ...over } as unknown as Task)
const REQ = { path: '/home/me/src/a.ts', line: 3 }

afterEach(() => vi.unstubAllGlobals())

describe('source-bound locate requests', () => {
  it('carries the source boundary in the real request, including the primary', async () => {
    for (const host of [undefined, 'devbox']) {
      const fetch = vi.fn(async (_input: string) => new Response(JSON.stringify({ path: REQ.path, host, found: true })))
      vi.stubGlobal('fetch', fetch)
      expect(await locatePath(REQ.path, { host, sourceOnly: true })).toMatchObject({ path: REQ.path, found: true })
      const url = new URL(fetch.mock.calls[0]![0] as string, 'http://localhost')
      expect(url.searchParams.get('sourceOnly')).toBe('1')
      expect(url.searchParams.get('host')).toBe(host ?? null)
    }
  })

  it('rejects another host from an older server that ignores the source boundary', async () => {
    for (const [host, elsewhereHost] of [[undefined, 'devbox'], ['devbox', undefined]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ path: REQ.path, host: elsewhereHost, found: true, elsewhere: true }))))
      expect(await locatePath(REQ.path, { host, sourceOnly: true })).toEqual({
        path: REQ.path, ...(host ? { host } : {}), found: false, missing: true, checked: [host ?? 'Local'],
      })
    }
  })

  it('ordinary file search still accepts a file on another machine', async () => {
    const found = { path: REQ.path, host: 'devbox', found: true, elsewhere: true }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(found))))
    expect(await locatePath(REQ.path)).toEqual(found)
  })
})

function deps(lookup: Partial<SessionHostLookup> = {}) {
  const peek = vi.fn(lookup.peek ?? (() => null))
  const fetch = vi.fn(lookup.fetch ?? (async () => null))
  return { lookup: { peek, fetch }, open: vi.fn(), fail: vi.fn() }
}

describe('where a path in agent text opens', () => {
  it('no source: opens exactly as before, with no host and no lookup', async () => {
    for (const src of [undefined, {}]) {
      const d = deps()
      await openFromSource(src, REQ, d)
      expect(d.open).toHaveBeenCalledExactlyOnceWith(REQ)
      expect(d.lookup.peek).not.toHaveBeenCalled()
      expect(d.lookup.fetch).not.toHaveBeenCalled()
    }
  })

  it('an external writer with no host opens nowhere; an explicitly recorded primary still opens there', async () => {
    const src = { sessionId: 'external' }
    const d = deps()
    expect(sourceHostOf(src)).toEqual({ kind: 'unknown' })
    expect(renderContextOf(src, d.lookup.peek)).toEqual({ images: false })
    await openFromSource(src, REQ, d)
    expect(d.open).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
    expect(d.lookup.fetch).not.toHaveBeenCalled()
    const local = deps()
    await openFromSource({ ...src, host: 'local' }, REQ, local)
    expect(local.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: undefined, sourceOnly: true })
  })

  it('a task without a writing session opens no guessed machine and draws no image', async () => {
    const src = { task: task({}) }
    const d = deps()
    expect(sourceHostOf(src)).toEqual({ kind: 'unknown' })
    expect(renderContextOf(src, d.lookup.peek)).toEqual({ images: false })
    await openFromSource(src, REQ, d)
    expect(d.open).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
    expect(d.lookup.fetch).not.toHaveBeenCalled()
  })

  it('a host the surface knows wins over any session, with no lookup', async () => {
    const d = deps()
    await openFromSource({ host: 'devbox', sessionId: 's1', task: task({ session_id: 's2' }) }, REQ, d)
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: 'devbox', sourceOnly: true })
    expect(d.lookup.fetch).not.toHaveBeenCalled()
  })

  it('a known local host stays on the primary even when another host has the same path', async () => {
    for (const host of ['', 'local', '__local__']) {
      const d = deps()
      await openFromSource({ host, sessionId: 's1' }, REQ, d)
      expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: undefined, sourceOnly: true })
      expect(d.lookup.fetch).not.toHaveBeenCalled()
    }
  })

  it("a remote session's absolute path asks for that session's host, read on the click", async () => {
    const d = deps({ fetch: async () => ({ host: 'devbox' }) })
    await openFromSource({ task: task({ session_id: 's9' }) }, REQ, d)
    expect(d.lookup.peek).toHaveBeenCalledExactlyOnceWith('s9')
    expect(d.lookup.fetch).toHaveBeenCalledExactlyOnceWith('s9')
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: 'devbox', sourceOnly: true })
  })

  it('a record the page already holds answers without a request; the explicit session wins over the task', async () => {
    const d = deps({ peek: (sid) => (sid === 's1' ? { host: 'devbox' } : null) })
    await openFromSource({ sessionId: 's1', task: task({ session_id: 's2' }) }, REQ, d)
    expect(d.lookup.fetch).not.toHaveBeenCalled()
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: 'devbox', sourceOnly: true })
  })

  it('a local session opens here', async () => {
    const d = deps({ fetch: async () => ({ host: '__local__' }) })
    await openFromSource({ sessionId: 's1' }, REQ, d)
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...REQ, host: undefined, sourceOnly: true })
  })

  it('a session that cannot be read opens nothing on this machine and says so', async () => {
    const failed = deps({ fetch: async () => { throw new Error('timeout') } })
    await openFromSource({ sessionId: 's1' }, REQ, failed)
    expect(failed.open).not.toHaveBeenCalled()
    expect(failed.fail).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1', path: REQ.path, error: 'timeout', reason: 'lookup' })

    const gone = deps({ fetch: async () => null })
    await openFromSource({ task: task({ session_id: 's1' }) }, REQ, gone)
    expect(gone.open).not.toHaveBeenCalled()
    expect(gone.fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 's1', reason: 'gone' }))
  })

  it('reading the source for render asks nothing; relative paths render only with a known host', () => {
    expect(sourceHostOf({ task: task({ session_id: 's1', cwd: '/w' }) })).toEqual({ kind: 'session', sessionId: 's1' })
    expect(renderCwdOf({ task: task({ session_id: 's1', cwd: '/w' }) })).toBeUndefined()
    expect(renderCwdOf({ cwd: '/w' })).toBeUndefined()
    expect(renderCwdOf({ host: 'devbox', task: task({ cwd: '/w' }) })).toBe('/w')
    expect(renderCwdOf({ host: 'devbox', cwd: '/x', task: task({ cwd: '/w' }) })).toBe('/x')
  })

  it('render: a known host draws images from it with no cwd; an unread session draws no pictures', () => {
    const none = vi.fn(() => null)
    expect(renderContextOf(undefined, none)).toEqual({ images: true })
    expect(renderContextOf({ host: 'devbox' }, none)).toEqual({ host: 'devbox', images: true })
    expect(renderContextOf({ host: '' }, none)).toEqual({ images: true })
    expect(renderContextOf({ sessionId: 's1' }, none)).toEqual({ images: false })
    expect(renderContextOf({ sessionId: 's1' }, () => ({ host: 'devbox' }))).toEqual({ host: 'devbox', images: true })
    expect(renderContextOf({ sessionId: 's1' }, () => ({ host: '__local__' }))).toEqual({ images: true })
    expect(none).toHaveBeenCalledOnce()
  })
})

describe('a source whose writer Walnut did not record', () => {
  const UNREC = { unknownSource: true }

  it('is unknown, never the task\'s current session; a recorded host or session still wins', () => {
    expect(sourceHostOf(UNREC)).toEqual({ kind: 'unknown' })
    // A task with a live session must not fill in for the unrecorded writer.
    expect(sourceHostOf({ ...UNREC, task: task({ session_id: 's-new' }) })).toEqual({ kind: 'unknown' })
    expect(sourceSessionId({ ...UNREC, task: task({ session_id: 's-new' }) })).toBeUndefined()
    expect(sourceHostOf({ ...UNREC, sessionId: 's-old' })).toEqual({ kind: 'session', sessionId: 's-old' })
    expect(sourceHostOf({ ...UNREC, host: '__local__' })).toEqual({ kind: 'host' })
    expect(sourceHostOf({ ...UNREC, host: 'devbox' })).toEqual({ kind: 'host', host: 'devbox' })
  })

  it('draws no picture and no relative link, and asks nothing to render', () => {
    const peek = vi.fn(() => ({ host: 'devbox' }))
    expect(renderContextOf({ ...UNREC, cwd: '/w' }, peek)).toEqual({ images: false })
    expect(renderCwdOf({ ...UNREC, cwd: '/w' })).toBeUndefined()
    expect(peek).not.toHaveBeenCalled()
  })

  it('opens neither an absolute nor a relative path, with no lookup and no source-less open', async () => {
    for (const path of ['/home/me/src/a.ts', 'src/a.ts']) {
      const d = deps({ fetch: async () => ({ host: 'devbox' }) })
      await openFromSource({ ...UNREC, task: task({ session_id: 's-new' }) }, { path }, d)
      expect(d.open).not.toHaveBeenCalled()
      expect(d.lookup.peek).not.toHaveBeenCalled()
      expect(d.lookup.fetch).not.toHaveBeenCalled()
      expect(d.fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path, reason: 'unrecorded' }))
    }
  })

  it('says the source was not recorded and nothing was read, never that a session is briefly away', () => {
    const unrec = sourceFailureText('unrecorded')
    expect(unrec).toMatch(/did not record which session wrote/)
    expect(unrec).toContain('No file was read')
    expect(unrec).not.toMatch(/unavailable|retry|again/i)
    // Only a lookup that failed this time offers a retry.
    expect(sourceFailureText('lookup')).toMatch(/try again/)
    expect(sourceFailureText('lookup')).toContain('No file was read')
    for (const r of ['no-session', 'gone'] as const) {
      expect(sourceFailureText(r)).toContain('No file was read')
      expect(sourceFailureText(r)).not.toMatch(/try again|retry/)
    }
  })
})
