/**
 * Phone back gesture = close the last layer (web/src/hooks/usePhoneOverlayHistory.ts,
 * spec 4.3). Pure stack rules, then the store against a fake browser history whose
 * back() lands asynchronously, as a real one does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  popToDepth, markerDepth, markerId, stateWithMarker, stateWithoutMarker, nextDepth, closePlan,
  edgeSwipeCloses, __phoneOverlayInternals as store, __resetPhoneOverlaysForTest,
  isPhoneOverlayOpen, phoneOverlayIds, afterPhoneOverlayBacks, type StackItem,
} from '../../web/src/hooks/usePhoneOverlayHistory'

const item = (id: string, depth: number, pushed = true): StackItem => ({ id, kind: 'session', depth, pushed })

describe('pure stack rules', () => {
  it('reads the marker depth and id, 0 / null without one', () => {
    expect(markerDepth(null)).toBe(0)
    expect(markerDepth({ usr: null, key: 'k', idx: 2 })).toBe(0)
    expect(markerDepth({ walnutOverlay: { id: 'drawer', kind: 'drawer', depth: 2 } })).toBe(2)
    expect(markerId({ walnutOverlay: { id: 'chat', kind: 'chat', depth: 1 } })).toBe('chat')
    expect(markerId(undefined)).toBeNull()
  })

  it('keeps react-router keys when adding and removing the marker', () => {
    const router = { usr: { from: 'x' }, key: 'abc', idx: 3 }
    const withM = stateWithMarker(router, { id: 'chat', kind: 'chat', depth: 1 })
    expect(withM).toMatchObject(router)
    expect(stateWithoutMarker(withM)).toEqual(router)
    expect(nextDepth(withM)).toBe(2)
    expect(nextDepth(router)).toBe(1)
  })

  it('a popstate closes every layer above the target, top first', () => {
    const stack = [item('session:a', 1), item('task-detail:t', 2), item('sheet:x', 3)]
    const r = popToDepth(stack, 1)
    expect(r.kept.map((e) => e.id)).toEqual(['session:a'])
    expect(r.closed.map((e) => e.id)).toEqual(['sheet:x', 'task-detail:t'])
    expect(popToDepth(stack, 0).closed).toHaveLength(3)
    expect(popToDepth(stack, 3).closed).toHaveLength(0)
  })

  it('never closes a layer whose push is still waiting', () => {
    const r = popToDepth([item('drawer', 1), item('chat', 0, false)], 0)
    expect(r.closed.map((e) => e.id)).toEqual(['drawer'])
    expect(r.kept.map((e) => e.id)).toEqual(['chat'])
  })

  it('maps a UI close to back, go or a direct close', () => {
    const own = stateWithMarker(null, { id: 'chat', kind: 'chat', depth: 1 })
    expect(closePlan(item('chat', 1), own)).toEqual({ kind: 'back' })
    const above = stateWithMarker(null, { id: 'task-detail:t', kind: 'task-detail', depth: 3 })
    expect(closePlan(item('chat', 1), above)).toEqual({ kind: 'go', steps: 3 })
    expect(closePlan(item('chat', 1), { key: 'replaced' })).toEqual({ kind: 'direct' })
    expect(closePlan(item('chat', 0, false), own)).toEqual({ kind: 'direct' })
  })

  it('edge swipe closes at 30% of the width', () => {
    expect(edgeSwipeCloses(0.6 * 390, 390)).toBe(true)
    expect(edgeSwipeCloses(0.2 * 390, 390)).toBe(false)
    expect(edgeSwipeCloses(117, 390)).toBe(true)
    expect(edgeSwipeCloses(10, 0)).toBe(false)
  })
})

/** A session history whose back/go land in a later task, like a browser's. */
class FakeHistory {
  entries: { state: unknown; url: string }[] = [{ state: { key: 'home', idx: 0 }, url: 'https://w.test/' }]
  index = 0
  pushes = 0
  constructor(private fire: (state: unknown) => void) {}
  get state() { return this.entries[this.index].state }
  get length() { return this.entries.length }
  pushState(state: unknown, _t: string, url?: string) {
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push({ state: structuredClone(state), url: url ?? this.entries[this.index].url })
    this.index += 1
    this.pushes += 1
  }
  replaceState(state: unknown, _t: string, url?: string) {
    this.entries[this.index] = { state: structuredClone(state), url: url ?? this.entries[this.index].url }
  }
  back() { this.go(-1) }
  go(n: number) {
    setTimeout(() => {
      this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + n))
      this.fire(this.state)
    }, 0)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('store against an async history', () => {
  let history: FakeHistory
  let closes: string[]
  let popListeners: ((ev: { state: unknown }) => void)[]
  const g = globalThis as unknown as { window?: unknown }

  beforeEach(() => {
    __resetPhoneOverlaysForTest()
    closes = []
    popListeners = []
    history = new FakeHistory((state) => { for (const l of popListeners) l({ state }) })
    g.window = {
      history,
      get location() { return { href: history.entries[history.index].url } },
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener: (type: string, fn: (ev: { state: unknown }) => void) => { if (type === 'popstate') popListeners.push(fn) },
    }
  })
  afterEach(() => { delete g.window })

  const open = (id: string, extra: Record<string, unknown> = {}) => store.open({
    id, kind: 'session', open: true, onClose: ({ fromHistory }) => closes.push(`${id}:${fromHistory}`), ...extra,
  })

  it('back closes only the top layer, then the next', async () => {
    open('session:a')
    open('task-detail:t')
    expect(history.length).toBe(3)
    history.back()
    await tick()
    expect(closes).toEqual(['task-detail:t:true'])
    expect(phoneOverlayIds()).toEqual(['session:a'])
    history.back()
    await tick()
    expect(closes).toEqual(['task-detail:t:true', 'session:a:true'])
    expect(isPhoneOverlayOpen()).toBe(false)
  })

  it('a UI close goes through history and leaves no empty back', async () => {
    const e = open('chat')
    store.close(e)
    await tick()
    expect(closes).toEqual(['chat:true'])
    expect(history.index).toBe(0)
    // The next open reuses the forward slot: the stack never grows.
    open('chat')
    expect(history.length).toBe(2)
  })

  it('a StrictMode release + reopen in one tick keeps the same entry', async () => {
    const e = open('session:a')
    store.release(e)
    open('session:a')
    await tick()
    expect(history.pushes).toBe(1)
    expect(history.index).toBe(1)
    expect(isPhoneOverlayOpen('session:a')).toBe(true)
  })

  it('a push issued while a back is in flight waits for it', async () => {
    const drawer = open('drawer')
    store.close(drawer) // back() is now in flight
    open('chat')
    await tick()
    expect(closes).toEqual(['drawer:true'])
    expect(markerId(history.state)).toBe('chat')
    expect(markerDepth(history.state)).toBe(1)
    expect(history.length).toBe(2)
  })

  it('a navigation after closing layers waits for their backs, so the back cannot undo it', async () => {
    // A link opened in a plugin's App closes the modal it was in, then navigates
    // (plugins/LinkCaptureHost.tsx). Pushed at once, the route would be the entry the
    // back then leaves.
    const detail = open('task-detail:t')
    store.close(detail)
    const ran: string[] = []
    afterPhoneOverlayBacks(() => { ran.push('nav'); history.pushState({ key: 'app', idx: 1 }, '', 'https://w.test/apps/x') })
    expect(ran).toEqual([])
    await tick()
    expect(closes).toEqual(['task-detail:t:true'])
    expect(ran).toEqual(['nav'])
    expect(history.entries[history.index].url).toBe('https://w.test/apps/x')
    // Nothing pending: it runs at once, and only once.
    afterPhoneOverlayBacks(() => ran.push('now'))
    await tick()
    expect(ran).toEqual(['nav', 'now'])
  })

  it('open flipping false pops only its own entry and never calls onClose', async () => {
    const e = open('note:a.md')
    store.release(e)
    await tick()
    expect(closes).toEqual([])
    expect(history.index).toBe(0)
  })

  it('a deep link replaces the first entry with its base, so back lands home', () => {
    history.entries[0].url = 'https://w.test/?session=s1'
    open('session:s1', { deepLinkBaseUrl: '/' })
    expect(history.entries.map((x) => x.url)).toEqual(['https://w.test/', 'https://w.test/?session=s1'])
    expect(markerDepth(history.entries[0].state)).toBe(0)
  })
})
