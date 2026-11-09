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
  it('its first tab is its own page, and the agent\'s page opens beside it', async () => {
    const { api, calls, session } = fakeApi()
    ;(api as unknown as { runtime: unknown }).runtime = { getURL: (p: string) => `chrome-extension://walnut/${p}` }
    await openInAgentWindow(api, 'https://shop.example.test/')
    expect(calls.slice(0, 2)).toEqual([
      { fn: 'windows.create', arg: { url: 'chrome-extension://walnut/agent-window.html', focused: false, width: 1280, height: 900, type: 'normal' } },
      { fn: 'tabs.create', arg: { url: 'about:blank', windowId: 7, active: true } },
    ])
    expect(session.agentPage).toBe(70)
  })

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

  // The one exception: the person's own Take over in the Browser view (agent-takeover.ts takeOver),
  // which the server sends only for a person's request (browser-view-v1.ts personTab).
  it('no agent code minimizes a window or brings one forward, except the person\'s Take over', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => /^(agent|capture|page-agent|cdp)/.test(x) && x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (f === 'agent-takeover.ts' && line.trim() === 'await ext.windows.update?.(tab.windowId, { focused: true })') return
        if (/state:\s*['"]minimized['"]|focused:\s*true|drawAttention/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        // A window is updated in one place only, with a size (agent-window.ts resizeAgentWindow).
        if (/windows\.update\??\.?\(/.test(line) && !(f === 'agent-window.ts' && /\{ \.\.\.plain, width, height \}/.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  // 2026-11-08, the user: "why the browser keep stealing my focus?". Every call in the extension that
  // can bring a window forward, focus one, or open one (a new window takes focus by default) is
  // listed here with why it may: each runs for the person's own click or key, or opens the agent's
  // window unfocused. A new one fails until it is placed here, with its reason.
  it('every call that can raise, focus or open a window is the person\'s own, or keeps the agent window unfocused', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const allowed = new Map<string, string>([
      // The agent's window: made unfocused (AGENT_WINDOW), sized, its tabs opened inside it.
      ['agent-window.ts: const w = await api.windows.create({ url: own ?? \'about:blank\', ...AGENT_WINDOW })', 'agent window, unfocused'],
      ['agent-window.ts: await api.windows.update?.(agentWindow, { ...plain, width, height })', 'agent window size only'],
      ['agent-window.ts: if (w) tab = await api.tabs.create({ url: \'about:blank\', windowId: id, active: true })', 'inside the unfocused agent window'],
      ['agent-window.ts: ? await api.tabs.create({ url: \'about:blank\', windowId: w.id, active: true })', 'inside the unfocused agent window'],
      ['agent-groups.ts: const t = await api.tabs.create({ url: api.runtime.getURL(AGENT_PAGE), windowId, active: false, index: 0 }).catch(() => null)', 'agent window page, not active'],
      ['agent-page.ts: const t = await more.tabs.create({ url: href, windowId: tab.windowId, active: !personsTab(rec), openerTabId: tabId }).finally(() => linking.delete(tabId))', 'a link the page opened, in its own window; never active in the person\'s'],
      // The person's Take over in the Browser view (browser-view-v1.ts sends it only for a person).
      ['agent-takeover.ts: await ext.windows.update?.(tab.windowId, { focused: true })', 'Take over'],
      // The person's own clicks and keys: the toolbar popup, the side panel, the fill shortcut, Connect.
      ['background.ts: const tab = await ext.tabs.create({ url: `${origin}/connect-extension`, active: true })', 'Connect button'],
      ['background.ts: if (t.windowId !== undefined) await ext.windows.update?.(t.windowId, { focused: true }).catch(() => undefined)', 'Open vault'],
      ['background.ts: await ext.tabs.create({ url })', 'Open Walnut'],
      ['background.ts: if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)', 'side panel shortcut'],
      ['bg-fill.ts: try { await ext.action.openPopup() } finally { await ext.action.setPopup?.({ popup: \'popup-ask.html\' })?.catch(() => undefined) }', 'unlock, from a fill the person asked for'],
      ['bg-fill.ts: await ext.windows.create({ url: ext.runtime.getURL(\'popup.html?window=1\'), type: \'popup\', width: 380, height: 560, focused: true })', 'unlock, from a fill the person asked for'],
      ['panel-ask.ts: if (!inTab && ext.sidePanel && win.id !== undefined) opened = ext.sidePanel.open({ windowId: win.id })', 'Ask, the person\'s click'],
      ['panel-ask.ts: if (o.status === \'rejected\' && win.id !== undefined) await ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${win.id}`), type: \'popup\', width: 420, height: 760 })', 'Ask, the person\'s click'],
      ['popup.ts: if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)', 'popup button'],
      ['popup.ts: else if (windowId !== undefined) void ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${windowId}`), type: \'popup\', width: 420, height: 760 })', 'popup button'],
    ])
    const RAISES = /windows\.(create|update)\??\.?\(|tabs\.create\(|sidePanel\.open\(|openPopup\(|focused:\s*true|drawAttention|state:\s*['"]minimized['"]/
    const found: string[] = []
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])
    for (const file of walk(dir)) {
      const rel = path.relative(dir, file)
      fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !RAISES.test(line)) return
        found.push(`${rel}: ${line.trim()}`)
      })
    }
    expect(found.filter((k) => !allowed.has(k))).toEqual([])
    // A listed call that went away comes off the list.
    expect([...allowed.keys()].filter((k) => !found.includes(k))).toEqual([])
  })

  // Review 2026-11-08: a tab switch is as visible as a raised window when the person looks at that
  // window. Every switch is listed with the check that keeps it out of the person's view.
  it('every tab switch is listed, with what keeps it from the person\'s view', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const allowed = new Map<string, string>([
      ['background.ts: await ext.tabs.update(t.id, { active: true, ...(want.search && t.url !== url ? { url } : {}) })', 'Open vault, the person\'s click'],
      ['agent-takeover.ts: await ext.tabs.update(tabId, { active: true })', 'Take over, the person\'s click'],
      ['agent-shot.ts: await ext.tabs.update(tabId, { active: true })', 'agent window only, never over a taken-over tab or in a focused window'],
      ['agent-groups.ts: await api.tabs.update(page, { active: true })', 'the fold: agent window only, never focused or under a taken-over tab'],
      ['agent-view.ts: await ext.tabs.update(tabId, { active: true }).catch(() => undefined)', 'bringUpForCommand: agent window only, never focused or under a taken-over tab'],
      ['agent-view.ts: await ext.tabs.update(tabId, { active: true })', 'a picture: agent window only, never focused or under a taken-over tab'],
      ['agent-view.ts: await ext.tabs.update(back, { active: true }).catch(() => undefined)', 'put back after a picture: only while nobody came in'],
    ])
    const found: string[] = []
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])
    for (const file of walk(dir)) {
      const rel = path.relative(dir, file)
      fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !/tabs\.update\??\.?\(.*active:/.test(line)) return
        found.push(`${rel}: ${line.trim()}`)
      })
    }
    expect(found.filter((k) => !allowed.has(k))).toEqual([])
    expect([...allowed.keys()].filter((k) => !found.includes(k))).toEqual([])
  })
})
