/**
 * Walnut's agent window stays visible to the person and never takes focus
 * (packages/browser-extension/src/agent-window.ts; 2026-11-07: an old relay's agent window was
 * always minimized, and a session signed in to the person's bank there without him seeing it).
 * The window is made unfocused and in no minimized state, a second tab opens in it without
 * raising it, and which window a tab is in goes into the answers. A scan of the extension's agent
 * code keeps any minimize or focus of a window out of it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_WINDOW, openInAgentWindow, windowOf } from '../../../packages/browser-extension/src/agent-window'

function fakeApi(existing?: number) {
  const calls: Array<{ fn: string; arg: unknown }> = []
  const session: Record<string, unknown> = existing !== undefined ? { agentWindow: existing } : {}
  const windows = new Map<number, { id: number; state: string; focused: boolean }>()
  if (existing !== undefined) windows.set(existing, { id: existing, state: 'normal', focused: false })
  const api = {
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o) }, remove: async () => undefined } },
    windows: {
      create: async (o: Record<string, unknown>) => { calls.push({ fn: 'windows.create', arg: o }); windows.set(7, { id: 7, state: 'normal', focused: false }); return { id: 7, tabs: [{ id: 70, windowId: 7, url: String(o.url) }] } },
      get: async (id: number) => { const w = windows.get(id); if (!w) throw new Error('No window'); return w },
      getCurrent: async () => ({}),
      update: async (id: number, o: unknown) => { calls.push({ fn: 'windows.update', arg: { id, o } }); return {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabs: {
      create: async (o: Record<string, unknown>) => { calls.push({ fn: 'tabs.create', arg: o }); return { id: 71, windowId: o.windowId as number, url: String(o.url) } },
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
    expect(tab).toMatchObject({ id: 70, windowId: 7 })
    expect(calls).toEqual([{ fn: 'windows.create', arg: { url: 'https://shop.example.test/', focused: false, width: 1280, height: 900, type: 'normal' } }])
    expect(session.agentWindow).toBe(7)
  })

  it('a second tab opens in the same window and raises nothing', async () => {
    const { api, calls } = fakeApi(7)
    await openInAgentWindow(api, 'https://shop.example.test/two')
    expect(calls).toEqual([{ fn: 'tabs.create', arg: { url: 'https://shop.example.test/two', windowId: 7, active: true } }])
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

  it('no agent code minimizes a window or brings one forward', () => {
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => /^(agent|capture|page-agent|cdp)/.test(x) && x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (/state:\s*['"]minimized['"]|focused:\s*true|windows\.update\(/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
