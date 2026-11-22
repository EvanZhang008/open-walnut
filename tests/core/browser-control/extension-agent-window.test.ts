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
      { fn: 'tabs.create', arg: { url: 'about:blank', windowId: 7, active: false } },
    ])
    // Then in front of the agent window alone, which is not focused.
    expect(calls[2]).toEqual({ fn: 'tabs.update', arg: { id: 71, o: { active: true } } })
    expect(calls.some((c) => c.fn === 'windows.update')).toBe(false)
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
    expect(seen).toEqual(['before 71 after 3 calls'])
    expect(calls.at(-1)).toEqual({ fn: 'tabs.update', arg: { id: 71, o: { url: 'https://portal.example.test/' } } })
  })

  it('a second tab opens in the same window and raises nothing', async () => {
    const { api, calls } = fakeApi(7)
    await openInAgentWindow(api, 'https://shop.example.test/two')
    expect(calls).toEqual([
      { fn: 'tabs.create', arg: { url: 'about:blank', windowId: 7, active: false } },
      { fn: 'tabs.update', arg: { id: 71, o: { active: true } } },
      { fn: 'tabs.update', arg: { id: 71, o: { muted: true } } },
      { fn: 'tabs.update', arg: { id: 71, o: { url: 'https://shop.example.test/two' } } },
    ])
    expect(calls.some((c) => c.fn === 'windows.update')).toBe(false)
  })

  it('a new tab stays behind while the person is in the agent window', async () => {
    const { api, calls } = fakeApi(7)
    await (api as unknown as { windows: { update: (id: number, o: Record<string, unknown>) => Promise<unknown> } }).windows.update(7, { focused: true })
    calls.length = 0
    await openInAgentWindow(api, 'https://shop.example.test/three')
    expect(calls[0]).toEqual({ fn: 'tabs.create', arg: { url: 'about:blank', windowId: 7, active: false } })
    expect(calls.some((c) => c.fn === 'tabs.update' && (c.arg as { o: Record<string, unknown> }).o.active === true)).toBe(false)
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

  // The one exception: the person's own click (agent-window.ts revealForPerson: Take over, Show it
  // live, Open vault), which the server sends only for a person's request (browser-view-v1.ts personTab).
  it('no agent code minimizes a window or brings one forward, except the person\'s own click', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => /^(agent|capture|page-agent|cdp)/.test(x) && x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (f === 'agent-window.ts' && line.trim() === 'if (windowId !== undefined) await api.windows.update?.(windowId, { focused: true }).catch(() => undefined)') return
        // While this machine's screen is shared the agent window goes to the Dock, and one made then is made there (noteScreenShare, makeAgentWindow).
        if (f === 'agent-window.ts' && line.trim() === "return !!(await api.windows.update?.(id, { state: 'minimized' }).catch(() => null))") return
        if (f === 'agent-window-own.ts' && line.trim() === "? await api.windows.create({ url: own ?? 'about:blank', type: 'normal', focused: false, state: 'minimized' })") return
        if (f === 'agent-window-own.ts' && line.trim() === "if (sharing && w.id !== undefined && w.state !== 'minimized') await api.windows.update?.(w.id, { state: 'minimized' }).catch(() => undefined)") return
        // A "Leave site?" Chrome showed brought the agent window out of the Dock: it goes back (agent-leave.ts).
        if (f === 'agent-leave.ts' && line.trim() === "if (docked !== undefined) await ext.windows.update?.(docked, { state: 'minimized' }).catch(() => undefined)") return
        // A popup window an agent's own page opened (agent-popups.ts): to the Dock at once, never shown.
        if (f === 'agent-popups.ts' && line.trim() === "return !!(await ext.windows.update?.(t.windowId, { state: 'minimized' }).catch(() => null))") return
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
      ['agent-window-own.ts: : await api.windows.create({ url: own ?? \'about:blank\', ...AGENT_WINDOW })', 'agent window, unfocused (makeAgentWindow)'],
      ['agent-window-own.ts: ? await api.windows.create({ url: own ?? \'about:blank\', type: \'normal\', focused: false, state: \'minimized\' })', 'agent window during a screen share: unfocused and minimized (makeAgentWindow)'],
      ['agent-window-own.ts: if (sharing && w.id !== undefined && w.state !== \'minimized\') await api.windows.update?.(w.id, { state: \'minimized\' }).catch(() => undefined)', 'a window made as a share began: to the Dock too (makeAgentWindow)'],
      ['agent-window.ts: return !!(await api.windows.update?.(id, { state: \'minimized\' }).catch(() => null))', 'the agent window to the Dock when a screen share starts (noteScreenShare); never shown again'],
      ['agent-window.ts: await api.windows.update?.(agentWindow, { ...plain, width, height })', 'agent window size only'],
      ['agent-leave.ts: if (docked !== undefined) await ext.windows.update?.(docked, { state: \'minimized\' }).catch(() => undefined)', 'the agent window back to the Dock a "Leave site?" of Chrome\'s took it out of'],
      ['agent-popups.ts: return !!(await ext.windows.update?.(t.windowId, { state: \'minimized\' }).catch(() => null))', 'a popup window an agent\'s own page opened: to the Dock at once (minimizeAgentPopup)'],
      ['profile-keeper.ts: const w = await api.windows.create({ url: api.runtime.getURL(KEEPER_PAGE), type: \'normal\', focused: false, state: \'minimized\' })', 'the keeper window: in the Dock, unfocused, so closing the last window keeps the extension (profile-keeper.ts)'],
      ['profile-keeper.ts: if (w.id !== undefined && w.state !== \'minimized\') await api.windows.update?.(w.id, { state: \'minimized\' }).catch(() => undefined)', 'the keeper window to the Dock: Chrome on a Mac makes it normal all the same'],
      ['agent-window.ts: const tab = await api.tabs.create({ url: \'about:blank\', windowId, active: false })', 'agent window, in the background (newAgentTab)'],
      ['agent-groups.ts: const t = await api.tabs.create({ url: api.runtime.getURL(AGENT_PAGE), windowId, active: false, index: 0 }).catch(() => null)', 'agent window page, not active'],
      ['agent-opened.ts: const t = await more.tabs.create({ url: href, windowId: tab.windowId, active: false, openerTabId: tabId }).finally(() => linking.delete(tabId))', 'a link the page opened, in its own window, in the background'],
      // The person's own click, the one call that focuses a window (revealForPerson; its callers are listed below).
      ['agent-window.ts: if (windowId !== undefined) await api.windows.update?.(windowId, { focused: true }).catch(() => undefined)', 'revealForPerson: the person\'s click'],
      // The person's own clicks and keys: the toolbar popup, the side panel, the fill shortcut, Connect.
      ['background.ts: const tab = await ext.tabs.create({ url: `${origin}/connect-extension`, active: true })', 'Connect button'],
      ['background.ts: await ext.tabs.create({ url })', 'Open Walnut'],
      ['background.ts: if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)', 'side panel shortcut'],
      ['bg-fill.ts: try { await ext.action.openPopup() } finally { await ext.action.setPopup?.({ popup: \'popup-ask.html\' })?.catch(() => undefined) }', 'unlock, from a fill the person asked for'],
      ['bg-fill.ts: await ext.windows.create({ url: ext.runtime.getURL(\'popup.html?window=1\'), type: \'popup\', width: 380, height: 560, focused: true })', 'unlock, from a fill the person asked for'],
      ['panel-ask.ts: if (!inTab && ext.sidePanel && win.id !== undefined) opened = ext.sidePanel.open({ windowId: win.id })', 'Ask, the person\'s click'],
      ['panel-ask.ts: if (o.status === \'rejected\' && win.id !== undefined) await ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${win.id}`), type: \'popup\', width: 420, height: 760 })', 'Ask, the person\'s click'],
      ['popup.ts: if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)', 'popup button'],
      ['popup.ts: else if (windowId !== undefined) void ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${windowId}`), type: \'popup\', width: 420, height: 760 })', 'popup button'],
      // A site's passkey request (bg-passkey.ts): only a page in the person's focused tab may ask,
      // so its window is in front for them, and a leave gives the focus back to that tab.
      ['bg-passkey.ts: const WINDOW = { type: \'popup\', width: 420, height: 480, focused: true } as const', 'passkey window: the request of the person\'s own focused tab'],
      ['bg-passkey.ts: void ext.windows.create({ url: ext.runtime.getURL(`passkey.html?k=${encodeURIComponent(key)}`), ...WINDOW }).then(', 'passkey window: the request of the person\'s own focused tab'],
      ['bg-passkey.ts: p.tabWindowId !== undefined ? w.update?.(p.tabWindowId, { focused: true })?.catch(() => undefined) : undefined,', 'passkey leave: the focus back to the person\'s tab that asked'],
      // "Show it live" in a task's Browser view (grant-open.ts): the person's own click brings the
      // grant page up in their window; anyone else's opens it there in the background.
      ['grant-open.ts: const tab = await ext.tabs.create({ url, windowId, active: person })', 'Show it live: in front only for the person\'s click, never in the agent window'],
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

  // 2026-11-09: tabs.create with active: true focused the agent window in Chrome (a spec caught it:
  // extension-agent-net.spec.ts, resize). A tab the extension opens for an agent is made in the
  // background; only tabs.update brings it to the front of its window (frontInWindow).
  it('every tab the agent code opens is made in the background', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    // grant-open.ts opens its page in front for the person's click only (active: person), never for an agent.
    const PERSONS = new Set(['background.ts', 'bg-fill.ts', 'panel-ask.ts', 'popup.ts', 'grant-open.ts'])
    const bad: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !PERSONS.has(x))) {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !/tabs\.create\(/.test(line)) return
        if (!/active:\s*false\b/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })

  // Review 2026-11-08: a tab switch is as visible as a raised window when the person looks at that
  // window. 2026-11-17: nine switches each guarded themselves with "the window is not focused" and
  // "it is the agent window"; the agent window had become the user's own main window, and every
  // agent step put an agent's tab or the agent page in front of his window while he was in another
  // app. Now a tab is switched in exactly two places: frontInWindow (an agent's step: Walnut's own
  // agent window only, never one the person uses, never while they are in it) and revealForPerson
  // (the person's own click). A third fails here.
  it('a tab is put in front in two places only: frontInWindow for agents, revealForPerson for the person', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const allowed = new Map<string, string>([
      ['agent-window.ts: return api.tabs.update(tabId, { active: true }).then(() => true, () => false)', 'frontInWindow'],
      ['agent-window.ts: const t = await api.tabs.update(tabId, { active: true }).catch(() => null)', 'revealForPerson'],
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

  // Every caller of revealForPerson, the one call that focuses a window, with the person's click it serves.
  it('revealForPerson runs only for the person\'s own click, each caller listed', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const allowed = new Set([
      'agent-takeover.ts: takeover', // Take over in the Browser view (browser-view-v1.ts sends it only for a person)
      'grant-open.ts: grant-open', // Show it live, bringUp runs only for args.person
      'background.ts: walnut-tab', // Open vault in the toolbar popup
      'agent-reveal.ts: reveal', // Open in Chrome in the Browser view (browser-view-v1.ts sends it only for a person)
    ])
    const found: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'agent-window.ts')) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/revealForPerson\([^)]*'([a-z-]+)'\)/g)) found.push(`${f}: ${m[1]}`)
    }
    expect(found.filter((k) => !allowed.has(k))).toEqual([])
    expect([...allowed].filter((k) => !found.includes(k))).toEqual([])
  })

  // Which window is the agent's is asked in one place (agent-window-own.ts ownAgentWindow), so no
  // reader can act on a window the person took for their own (2026-11-17).
  it('the agent window id is read only through ownAgentWindow', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    // agent.ts forgets a closed window; agent-keep.ts mirrors every kept key for a reload.
    const OK = new Set(['agent-window-own.ts', 'agent.ts'])
    const bad: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !OK.has(x))) {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/session\.get\(\s*'agentWindow'/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })

  // 2026-11-08: CDP Page.bringToFront restored a minimized window and brought Chrome to the front of
  // the person's screen (measured on macOS; window.focus(), Input and Runtime calls did not). The
  // extension sends a fixed set of CDP methods; a new one is placed here once it is known not to raise.
  it('sends only CDP methods that never raise a window', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    // Input.setInterceptDrags and Input.dispatchDragEvent (a drag, agent-drag.ts) act inside the page's renderer like the mouse events.
    const QUIET = new Set(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent',
      'Input.setInterceptDrags', 'Input.dispatchDragEvent',
      // Page.captureScreenshot (agent-live.ts): live pictures of a covered agent window. It makes the
      // page draw off screen (Chromium's IncrementCapturerCount with stay_hidden); it does not show,
      // raise or focus the window, nor switch a tab.
      'Page.captureScreenshot',
      // Emulation.setFocusEmulationEnabled (agent-awake.ts): a covered agent window's page counts as on
      // screen and in focus inside the renderer, so an upload's video loads; measured in Chromium, it
      // shows, raises and focuses no window and switches no tab.
      'Emulation.setFocusEmulationEnabled',
      // A trusted upload (cdp.ts cdpSetFiles): the frame's id, an isolated world in the page, a node
      // resolved into it and a function run on it; all inside the renderer, nothing shown or focused.
      'Page.getFrameTree', 'Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn',
      // A close with discard, or Walnut's tidy (tab-close.ts): the tab goes as tabs.remove would take
      // it, without its beforeunload; its window gets its next tab in front, nothing raised or focused.
      'Target.closeTarget',
      'Page.enable', 'Page.handleJavaScriptDialog', 'Runtime.enable', 'Runtime.evaluate', 'Network.enable', 'Network.disable', 'Network.getResponseBody', 'Network.getRequestPostData', 'Log.enable'])
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])
    const sent: string[] = []
    for (const file of walk(dir)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:send|sendCommand|cdp)\w*\(\s*(?:[\w.]+,\s*)?'((?:Page|Target|Browser|Emulation|Input|Runtime|DOM|Network|Fetch|Log)\.[A-Za-z]+)'/g)) sent.push(`${path.relative(dir, file)}: ${m[1]}`)
    }
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.filter((x) => !QUIET.has(x.split(': ')[1]!))).toEqual([])
    expect(sent.some((x) => /bringToFront|activateTarget|setWindowBounds/.test(x))).toBe(false)
  })
})
