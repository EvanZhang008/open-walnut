/**
 * Walnut's agent window stays visible to the person and never takes focus
 * (packages/browser-extension/src/agent-window.ts; 2026-11-07: an old relay's agent window was
 * always minimized, and a session signed in to the person's bank there without him seeing it).
 * The window is made unfocused and in no minimized state, a second tab opens in it without
 * raising it, and which window a tab is in goes into the answers. Every tab opens blank and is
 * muted before its page loads (2026-10-29: an agent's page played video with sound in the person's
 * meeting). A resize sizes the agent window alone, never the person's, and only its size. A scan
 * of the extension's agent code keeps any minimize or focus of a window out of it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_WINDOW, RESIZE_LIMITS, openInAgentWindow, resizeAgentWindow, windowOf } from '../../../packages/browser-extension/src/agent-window'

function fakeApi(existing?: number) {
  const calls: Array<{ fn: string; arg: unknown }> = []
  const session: Record<string, unknown> = existing !== undefined ? { agentWindow: existing } : {}
  const windows = new Map<number, { id: number; state: string; focused: boolean; width: number; height: number }>()
  if (existing !== undefined) windows.set(existing, { id: existing, state: 'normal', focused: false, width: 1280, height: 900 })
  // Each tab's page area: the window less its frame and toolbars (16 x 120 here).
  const tabs = new Map<number, { id: number; windowId: number; url?: string }>([[5, { id: 5, windowId: 3 }], [71, { id: 71, windowId: 7 }]])
  const api = {
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o) }, remove: async () => undefined } },
    windows: {
      create: async (o: Record<string, unknown>) => { calls.push({ fn: 'windows.create', arg: o }); windows.set(7, { id: 7, state: 'normal', focused: false, width: 1280, height: 900 }); tabs.set(70, { id: 70, windowId: 7 }); return { id: 7, tabs: [{ id: 70, windowId: 7, url: String(o.url) }] } },
      get: async (id: number) => { const w = windows.get(id); if (!w) throw new Error('No window'); return { ...w } },
      getCurrent: async () => ({}),
      update: async (id: number, o: Record<string, unknown>) => {
        calls.push({ fn: 'windows.update', arg: { id, o } })
        const w = windows.get(id)!
        Object.assign(w, o)
        return { ...w }
      },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabs: {
      create: async (o: Record<string, unknown>) => { calls.push({ fn: 'tabs.create', arg: o }); return { id: 71, windowId: o.windowId as number, url: String(o.url) } },
      update: async (id: number, o: Record<string, unknown>) => { calls.push({ fn: 'tabs.update', arg: { id, o } }); return { id, windowId: 7, ...(typeof o.url === 'string' ? { url: o.url } : {}) } },
      get: async (id: number) => {
        const t = tabs.get(id)
        if (!t) throw new Error('No tab')
        const w = windows.get(t.windowId)
        return { ...t, ...(w ? { width: w.width - 16, height: w.height - 120 } : { width: 800, height: 600 }) }
      },
      query: async () => [],
    },
  }
  return { api: api as never, calls, session }
}

describe('the agent window', () => {
  it('is made unfocused, normal-sized and not minimized', async () => {
    expect(AGENT_WINDOW).toEqual({ focused: false, width: 1280, height: 900, type: 'normal' })
    expect(AGENT_WINDOW).not.toHaveProperty('state')
    const { api, calls, session } = fakeApi()
    const tab = await openInAgentWindow(api, 'https://shop.example.test/')
    expect(tab).toMatchObject({ id: 70, windowId: 7, url: 'https://shop.example.test/' })
    expect(calls).toEqual([
      { fn: 'windows.create', arg: { url: 'about:blank', focused: false, width: 1280, height: 900, type: 'normal' } },
      // Muted while still blank, so its page never makes a sound; then the page.
      { fn: 'tabs.update', arg: { id: 70, o: { muted: true } } },
      { fn: 'tabs.update', arg: { id: 70, o: { url: 'https://shop.example.test/' } } },
    ])
    expect(session.agentWindow).toBe(7)
  })

  it('what must happen before the page loads (a recording) runs on the blank, muted tab', async () => {
    const { api, calls } = fakeApi(7)
    const seen: string[] = []
    await openInAgentWindow(api, 'https://portal.example.test/', async (id) => { seen.push(`before ${id} after ${calls.length} calls`) })
    expect(seen).toEqual(['before 71 after 2 calls'])
    expect(calls.at(-1)).toEqual({ fn: 'tabs.update', arg: { id: 71, o: { url: 'https://portal.example.test/' } } })
  })

  it('a second tab opens in the same window and raises nothing', async () => {
    const { api, calls } = fakeApi(7)
    await openInAgentWindow(api, 'https://shop.example.test/two')
    expect(calls).toEqual([
      { fn: 'tabs.create', arg: { url: 'about:blank', windowId: 7, active: true } },
      { fn: 'tabs.update', arg: { id: 71, o: { muted: true } } },
      { fn: 'tabs.update', arg: { id: 71, o: { url: 'https://shop.example.test/two' } } },
    ])
    expect(calls.some((c) => c.fn === 'windows.update')).toBe(false)
  })

  it('a window the person closed is made again, still unfocused', async () => {
    const { api, calls } = fakeApi()
    const s = api as unknown as { storage: { session: { set: (o: Record<string, unknown>) => Promise<void> } } }
    await s.storage.session.set({ agentWindow: 99 })
    await openInAgentWindow(api, 'https://shop.example.test/')
    expect(calls[0]).toMatchObject({ fn: 'windows.create', arg: { focused: false } })
  })

  it('names which window a tab is in, and its state', async () => {
    const { api } = fakeApi(7)
    expect(await windowOf(api, 7)).toEqual({ window: 'agent', windowState: 'normal' })
    expect(await windowOf(api, 3)).toEqual({ window: 'person' })
    expect(await windowOf(api, undefined)).toEqual({})
  })

  it('a resize sizes the agent window alone, only its size; viewport gives the page that size', async () => {
    const { api, calls } = fakeApi(7)
    expect(await resizeAgentWindow(api, 71, { width: 1000, height: 700 })).toEqual({ width: 1000, height: 700, viewport: { width: 984, height: 580 } })
    expect(calls.at(-1)).toEqual({ fn: 'windows.update', arg: { id: 7, o: { width: 1000, height: 700 } } })
    expect(await resizeAgentWindow(api, 71, { width: 900, height: 600, viewport: true })).toMatchObject({ viewport: { width: 900, height: 600 } })
    // Out of range is held to the limits.
    expect((await resizeAgentWindow(api, 71, { width: 10, height: 99_999 })).width).toBe(RESIZE_LIMITS.minW)
    for (const c of calls.filter((x) => x.fn === 'windows.update')) {
      expect(Object.keys((c.arg as { o: object }).o).sort()).toEqual(['height', 'width'])
    }
  })

  it('a maximized agent window becomes a normal one to take a size, never minimized or focused', async () => {
    const { api, calls } = fakeApi(7)
    await (api as unknown as { windows: { update: (id: number, o: object) => Promise<unknown> } }).windows.update(7, { state: 'maximized' })
    await resizeAgentWindow(api, 71, { width: 1100, height: 800 })
    expect(calls.at(-1)).toEqual({ fn: 'windows.update', arg: { id: 7, o: { state: 'normal', width: 1100, height: 800 } } })
  })

  it('a tab in the person\'s window is never resized', async () => {
    const { api, calls } = fakeApi(7)
    await expect(resizeAgentWindow(api, 5, { width: 800, height: 600 })).rejects.toMatchObject({ code: 'person_window' })
    expect(calls.some((c) => c.fn === 'windows.update')).toBe(false)
  })

  it('no agent code minimizes a window or brings one forward', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => /^(agent|capture|page-agent|cdp)/.test(x) && x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (/state:\s*['"]minimized['"]|focused:\s*true|drawAttention/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        // A window is updated in one place only, with a size (agent-window.ts resizeAgentWindow).
        if (/windows\.update\??\.?\(/.test(line) && !(f === 'agent-window.ts' && /\{ \.\.\.plain, width, height \}/.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
