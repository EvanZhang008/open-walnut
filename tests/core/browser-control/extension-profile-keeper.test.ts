/**
 * The keeper window (packages/browser-extension/src/profile-keeper.ts): Chrome on a Mac stops a
 * profile's extensions when its last window closes (2026-11-21, agents lost the user's browser
 * for 1 h 46 min), so while agents are on and the profile is down to one window, the extension
 * keeps one more, minimized and unfocused.
 */
import { describe, expect, it } from 'vitest'
import { initProfileKeeper, isKeeper, keepProfile, KEEPER_PAGE, type KeeperApi } from '../../../packages/browser-extension/src/profile-keeper'

const PAGE = `chrome-extension://walnut/${KEEPER_PAGE}`

function fake(os = 'mac', initial: Array<string[]> = [['https://example.com/']], pages: 'loaded' | 'loading' | 'broken' = 'loaded') {
  let next = 100
  let tabId = 1000
  const wins = new Map<number, string[]>()
  const tabIds = new Map<number, number[]>()
  const states = new Map<number, string>()
  const setWin = (id: number, urls: string[]) => { wins.set(id, urls); tabIds.set(id, urls.map(() => tabId++)) }
  for (const urls of initial) setWin(next++, urls)
  const created: unknown[] = []
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = { agentControl: true }
  const listeners = { created: [] as Array<(w: unknown) => void>, removed: [] as Array<(id: number) => void>, changed: [] as Array<(c: Record<string, unknown>, a: string) => void> }
  const api: KeeperApi = {
    windows: {
      // Chrome hides a tab's address without the tabs permission: no url here, only ids.
      getAll: async () => [...wins].map(([id]) => ({ id, tabs: tabIds.get(id)!.map((t) => ({ id: t })) })),
      // Chrome on a Mac makes a window asked minimized a normal one (2026-11-21).
      create: async (o) => { created.push(o); const id = next++; setWin(id, [o.url]); states.set(id, 'normal'); for (const f of listeners.created) f({ id }); return { id, state: 'normal' } },
      update: async (id, o) => { states.set(id, o.state); return { id, state: o.state } },
      remove: async (id) => { wins.delete(id); for (const f of listeners.removed) f(id) },
      onCreated: { addListener: (f) => { listeners.created.push(f as (w: unknown) => void) } },
      onRemoved: { addListener: (f) => { listeners.removed.push(f) } },
    },
    runtime: {
      getURL: (p) => `chrome-extension://walnut/${p}`,
      getPlatformInfo: async () => ({ os }),
      getContexts: async (o) => {
        if (pages === 'broken') throw new Error('no contexts')
        if (pages === 'loading') return []
        return [...wins].flatMap(([id, urls]) => urls.map((u, i) => ({ u, tabId: tabIds.get(id)![i], windowId: id }))).filter((c) => o.documentUrls.includes(c.u))
      },
    },
    storage: {
      session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => { Object.assign(session, o) } },
      onChanged: { addListener: (f) => { listeners.changed.push(f) } },
    },
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return {
    api, wins, created, local, settle, states,
    keepers: () => [...wins.values()].filter((u) => u.length === 1 && u[0] === PAGE).length,
    /** The person (or a page) closes a window. */
    close: async (id: number) => { wins.delete(id); for (const f of listeners.removed) f(id); await settle() },
    open: async (urls: string[]) => { const id = next++; setWin(id, urls); for (const f of listeners.created) f({ id }); await settle(); return id },
    /** The background stops and starts again: its listeners and memory go, storage.session stays. */
    restart: () => { listeners.created.length = 0; listeners.removed.length = 0; listeners.changed.length = 0 },
    switchAgents: async (on: boolean) => { local.agentControl = on; for (const f of listeners.changed) f({ agentControl: { newValue: on } }, 'local'); await settle() },
  }
}

describe('profile keeper', () => {
  it('tells its own window by its page\'s tab alone', () => {
    const ids = new Set([7])
    expect(isKeeper({ tabs: [{ id: 7 }] }, ids)).toBe(true)
    expect(isKeeper({ tabs: [{ id: 7 }, { id: 8 }] }, ids)).toBe(false)
    expect(isKeeper({ tabs: [{ id: 8 }] }, ids)).toBe(false)
  })

  it('with one window left, makes a minimized, unfocused keeper; with two, makes none and drops one', async () => {
    const f = fake()
    expect(await keepProfile(f.api, true)).toBe('made')
    expect(f.created).toEqual([{ url: PAGE, type: 'normal', focused: false, state: 'minimized' }])
    expect([...f.states.values()]).toEqual(['minimized'])
    expect(await keepProfile(f.api, true)).toBe('none')
    await f.open(['https://example.org/'])
    expect(await keepProfile(f.api, true)).toBe('dropped')
    expect(f.keepers()).toBe(0)
  })

  it('never keeps a window while agents are off', async () => {
    const f = fake()
    expect(await keepProfile(f.api, false)).toBe('none')
    await keepProfile(f.api, true)
    expect(await keepProfile(f.api, false)).toBe('dropped')
    expect(f.keepers()).toBe(0)
  })

  it('drops a second keeper a race made', async () => {
    const f = fake('mac', [['https://example.com/'], [PAGE], [PAGE]])
    await keepProfile(f.api, true)
    expect(f.keepers()).toBe(1)
  })

  it('follows the windows as they open and close, so the last one is never alone (the 2026-11-21 case)', async () => {
    const f = fake()
    initProfileKeeper(f.api, async () => f.local.agentControl === true, true)
    await f.settle()
    expect(f.keepers()).toBe(1)
    // The person opens a window of their own: two windows, no keeper.
    const theirs = await f.open(['https://example.org/'])
    expect(f.keepers()).toBe(0)
    // They close it again: one left, the keeper comes back.
    await f.close(theirs)
    expect(f.keepers()).toBe(1)
    // The last real window closes: the keeper is still there, so the profile keeps its extensions.
    await f.close(100)
    expect(f.wins.size).toBe(1)
    expect(f.keepers()).toBe(1)
  })

  it('a keeper the person closed is not made again until another window opens', async () => {
    const f = fake()
    initProfileKeeper(f.api, async () => f.local.agentControl === true, true)
    await f.settle()
    const keeper = [...f.wins].find(([, u]) => u[0] === PAGE)![0]
    await f.close(keeper)
    expect(f.keepers()).toBe(0)
    const other = await f.open(['https://example.org/'])
    await f.close(other)
    expect(f.keepers()).toBe(1)
  })

  it('goes with the agents switch', async () => {
    const f = fake()
    initProfileKeeper(f.api, async () => f.local.agentControl === true, true)
    await f.settle()
    await f.switchAgents(false)
    expect(f.keepers()).toBe(0)
    await f.switchAgents(true)
    expect(f.keepers()).toBe(1)
  })

  it('closing the last real window leaves one keeper, never a second (the URL is hidden, the tab is not)', async () => {
    const f = fake()
    initProfileKeeper(f.api, async () => true, true)
    await f.settle()
    await f.close(100)
    await f.settle()
    expect([...f.wins.values()]).toEqual([[PAGE]])
  })

  it('a keeper the person closes after the background restarted is still theirs to close', async () => {
    const f = fake()
    initProfileKeeper(f.api, async () => true, true)
    await f.settle()
    f.restart()
    initProfileKeeper(f.api, async () => true, true)
    await f.settle()
    expect(f.keepers()).toBe(1)
    const keeper = [...f.wins].find(([, u]) => u[0] === PAGE)![0]
    await f.close(keeper)
    await f.settle()
    expect(f.keepers()).toBe(0)
  })

  it('a keeper whose page has not loaded, or no page list at all, is still known: never a second one', async () => {
    for (const pages of ['loading', 'broken'] as const) {
      const f = fake('mac', [['https://example.com/']], pages)
      initProfileKeeper(f.api, async () => true, true)
      await f.settle()
      await f.close(100)
      await f.settle()
      expect([...f.wins.values()]).toEqual([[PAGE]])
    }
  })

  it('does nothing off a Mac or in Firefox', async () => {
    const linux = fake('linux')
    initProfileKeeper(linux.api, async () => true, true)
    await linux.settle()
    expect(linux.created).toEqual([])
    const firefox = fake('mac')
    initProfileKeeper(firefox.api, async () => true, false)
    await firefox.settle()
    expect(firefox.created).toEqual([])
  })
})
