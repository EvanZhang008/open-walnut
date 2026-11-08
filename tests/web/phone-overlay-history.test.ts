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
  let phoneNow: boolean
  let mediaListeners: ((ev: { matches: boolean }) => void)[]
  const g = globalThis as unknown as { window?: unknown }

  /** The phone media query changes, as a resize or rotation fires it. */
  const setPhone = (v: boolean) => { phoneNow = v; for (const l of [...mediaListeners]) l({ matches: v }) }

  beforeEach(() => {
    __resetPhoneOverlaysForTest()
    closes = []
    popListeners = []
    phoneNow = true
    mediaListeners = []
    history = new FakeHistory((state) => { for (const l of popListeners) l({ state }) })
    g.window = {
      history,
      get location() { return { href: history.entries[history.index].url } },
      matchMedia: () => ({
        get matches() { return phoneNow },
        addEventListener: (_t: string, fn: (ev: { matches: boolean }) => void) => { mediaListeners.push(fn) },
        removeEventListener() {},
      }),
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

  it('leaving the phone layout closes every layer, top first, and says it was the breakpoint', async () => {
    const infos: string[] = []
    const mark = (id: string) => ({ onClose: (i: { fromHistory: boolean; breakpoint?: boolean }) => infos.push(`${id}:${i.fromHistory}:${i.breakpoint === true}`) })
    open('session:a', mark('session:a'))
    open('viewer:web:a', mark('viewer:web:a'))
    store.leavePhone()
    await tick()
    // A session's view keeps itself open on this flag (it becomes the desktop split).
    expect(infos).toEqual(['viewer:web:a:true:true', 'session:a:true:true'])
    expect(isPhoneOverlayOpen()).toBe(false)
    expect(history.index).toBe(0)
    // A back is never the breakpoint.
    open('viewer:files:a', mark('viewer:files:a'))
    history.back()
    await tick()
    expect(infos.at(-1)).toBe('viewer:files:a:true:false')
  })

  it('open flipping false pops only its own entry and never calls onClose', async () => {
    const e = open('note:a.md')
    store.release(e)
    await tick()
    expect(closes).toEqual([])
    expect(history.index).toBe(0)
  })

  const keep = (id: string) => open(id, { keepOnBreakpoint: true })
  /** No overlay marker left anywhere on the browser's stack at or below where it is. */
  const noGhost = () => {
    expect(markerDepth(history.state)).toBe(0)
    for (const x of history.entries.slice(0, history.index + 1)) expect(markerDepth(x.state)).toBe(0)
  }

  describe('leaving phone layout (a real media change)', () => {
    it('closes a temporary layer, keeps a keepOnBreakpoint one, and leaves no ghost entry', async () => {
      keep('session:a')
      keep('viewer:files:a')
      keep('file:/r/a.ts')
      open('sheet:phase')
      expect(history.index).toBe(4)
      setPhone(false)
      // The stack is empty at once; only the sheet's owner heard a close.
      expect(phoneOverlayIds()).toEqual([])
      expect(closes).toEqual(['sheet:phase:true'])
      await tick()
      expect(history.index).toBe(0)
      noGhost()
      expect(closes).toEqual(['sheet:phase:true'])
    })

    it('the owners releasing their dropped layers afterwards never call onClose or move history', async () => {
      const s = keep('session:a')
      const f = keep('file:/r/a.ts')
      setPhone(false)
      await tick()
      const at = history.index
      store.release(f)
      store.release(s)
      await tick()
      expect(closes).toEqual([])
      expect(history.index).toBe(at)
      noGhost()
    })

    /** A previous route below the base, so an overshoot is seen (a clamp at 0 would hide it). */
    const withPreviousRoute = () => {
      history.entries = [{ state: { key: 'prev', idx: 0 }, url: 'https://w.test/prev' }, { state: { key: 'home', idx: 1 }, url: 'https://w.test/' }]
      history.index = 1
    }

    it('a kept layer the user was already closing still closes when its back lands after the breakpoint', async () => {
      keep('session:a')
      const f = keep('file:/r/a.ts')
      store.close(f) // back in flight
      setPhone(false)
      await tick()
      await tick()
      expect(closes).toEqual(['file:/r/a.ts:true'])
      expect(history.index).toBe(0)
      noGhost()
    })

    it('a breakpoint during a UI close unwinds from where that back lands: never past the base into the previous route', async () => {
      withPreviousRoute()
      keep('session:a')
      const f = keep('file:/r/a.ts')
      expect(history.index).toBe(3)
      store.close(f) // back(-1) in flight
      setPhone(false) // a go(-2) counted now would end on 'prev'
      await tick()
      await tick()
      await tick()
      expect(history.index).toBe(1)
      expect((history.state as { key?: string }).key).toBe('home')
      noGhost()
      expect(closes).toEqual(['file:/r/a.ts:true'])
    })

    it('a go close (layers above) during a breakpoint also stops at the base', async () => {
      withPreviousRoute()
      const s = keep('session:a')
      keep('viewer:files:a')
      keep('file:/r/a.ts')
      store.close(s) // go(-3) in flight
      setPhone(false)
      await tick()
      await tick()
      await tick()
      expect(history.index).toBe(1)
      noGhost()
      // The go closed all three: every one of them still hears it.
      expect([...closes].sort()).toEqual(['file:/r/a.ts:true', 'session:a:true', 'viewer:files:a:true'])
    })

    it('a layer reopened before the deferred unwind is pushed only after it, one above the base', async () => {
      withPreviousRoute()
      keep('session:a')
      const f = keep('file:/r/a.ts')
      store.close(f)
      setPhone(false)
      phoneNow = true
      keep('session:a') // rotated straight back
      await tick()
      await tick()
      await tick()
      expect(phoneOverlayIds()).toEqual(['session:a'])
      expect(markerId(history.state)).toBe('session:a')
      expect(markerDepth(history.state)).toBe(1)
      expect(history.index).toBe(2)
      expect((history.entries[1].state as { key?: string }).key).toBe('home')
      expect(history.length).toBe(3)
    })

    it('a layer reopened while the breakpoint back is in flight waits for it, then pushes once at depth 1', async () => {
      keep('session:a')
      keep('file:/r/a.ts')
      setPhone(false)
      // Rotated straight back: the owner reopens before history.go(-2) has landed.
      phoneNow = true
      keep('session:a')
      expect(markerDepth(history.state)).toBe(2) // nothing pushed on the entry being left
      await tick()
      expect(phoneOverlayIds()).toEqual(['session:a'])
      expect(markerId(history.state)).toBe('session:a')
      expect(markerDepth(history.state)).toBe(1)
      expect(history.length).toBe(2)
      expect(closes).toEqual([])
    })

    it('repeated rotation never grows history and never closes a kept layer', async () => {
      for (let round = 0; round < 3; round += 1) {
        keep('session:a')
        keep('viewer:files:a')
        open('sheet:x')
        setPhone(false)
        await tick()
        noGhost()
        setPhone(true)
        await tick()
      }
      expect(closes).toEqual(['sheet:x:true', 'sheet:x:true', 'sheet:x:true'])
      expect(history.length).toBeLessThanOrEqual(4)
      expect(history.index).toBe(0)
    })
  })

  /**
   * Releases in one tick (MainPage remounts a column with key={sid} when a session is
   * replaced: S/viewer/file unmount in one commit while the new S mounts). Each release
   * used to see the new S on top, plan a `go` it ignored, and leave its entry behind.
   */
  describe('releases settled together (replacement)', () => {
    const withPreviousRoute = () => {
      history.entries = [{ state: { key: 'prev', idx: 0 }, url: 'https://w.test/prev' }, { state: { key: 'home', idx: 1 }, url: 'https://w.test/' }]
      history.index = 1
    }
    const settle = async () => { for (let i = 0; i < 4; i += 1) await tick() }
    const keyNow = () => (history.state as { key?: string }).key
    const markersAbove = () => history.entries.slice(2, history.index + 1).map((x) => markerId(x.state))

    it('a replaced session with its view and file: one unwind, the new session one above home, no ghost', async () => {
      withPreviousRoute()
      const s = keep('session:old'); const v = keep('viewer:files:old'); const f = keep('file:/r/a.ts')
      expect(history.index).toBe(4)
      store.release(s); store.release(v); store.release(f)
      keep('session:new')
      await settle()
      expect(phoneOverlayIds()).toEqual(['session:new'])
      expect(history.index).toBe(2)
      expect(markersAbove()).toEqual(['session:new'])
      expect(markerDepth(history.state)).toBe(1)
      expect(history.length).toBe(3)
      expect(closes).toEqual([])
      // Back from the new session lands home and closes it: no ghost in between.
      history.back(); await settle()
      expect(keyNow()).toBe('home')
      expect(closes).toEqual(['session:new:true'])
    })

    it('a single replaced session leaves no ghost either', async () => {
      withPreviousRoute()
      const s = keep('session:old')
      store.release(s)
      keep('session:new')
      await settle()
      expect(history.index).toBe(2)
      expect(markersAbove()).toEqual(['session:new'])
    })

    it('a parent released while its child lives: the child is re-seated right above what stays', async () => {
      withPreviousRoute()
      keep('session:a'); const v = keep('viewer:files:a'); keep('file:/r/a.ts')
      store.release(v)
      await settle()
      expect(phoneOverlayIds()).toEqual(['session:a', 'file:/r/a.ts'])
      expect(markersAbove()).toEqual(['session:a', 'file:/r/a.ts'])
      expect(markerDepth(history.state)).toBe(2)
      expect(closes).toEqual([])
    })

    it('StrictMode: the same ids released and reclaimed in one tick keep their entries and their order', async () => {
      withPreviousRoute()
      const s = keep('session:a'); const v = keep('viewer:files:a')
      const pushes = history.pushes
      store.release(s); store.release(v)
      keep('viewer:files:a'); keep('session:a') // child effects remount first
      await settle()
      expect(history.pushes).toBe(pushes)
      expect(phoneOverlayIds()).toEqual(['session:a', 'viewer:files:a'])
      expect(history.index).toBe(3)
    })

    it('a release while a UI close is in flight: waits for that back, then unwinds once, never past home', async () => {
      withPreviousRoute()
      const s = keep('session:old'); const v = keep('viewer:files:old'); const f = keep('file:/r/a.ts')
      store.close(f) // back(-1) in flight
      store.release(s); store.release(v); store.release(f)
      keep('session:new')
      await settle()
      expect(history.index).toBe(2)
      expect(keyNow()).not.toBe('prev')
      expect(markersAbove()).toEqual(['session:new'])
    })

    it('a release and a breakpoint in one tick: one unwind to home', async () => {
      withPreviousRoute()
      keep('session:a'); const v = keep('viewer:files:a')
      store.release(v)
      setPhone(false)
      await settle()
      expect(history.index).toBe(1)
      expect(keyNow()).toBe('home')
      expect(closes).toEqual([])
    })

    it('afterPhoneOverlayBacks waits for the release unwind', async () => {
      withPreviousRoute()
      keep('session:a'); const v = keep('viewer:files:a')
      store.release(v)
      const ran: number[] = []
      afterPhoneOverlayBacks(() => ran.push(history.index))
      expect(ran).toEqual([])
      await settle()
      expect(ran).toEqual([2])
    })

    it('an entry a navigate(replace) already wiped is not unwound again', async () => {
      withPreviousRoute()
      const s = keep('session:a')
      history.replaceState({ key: 'replaced' }, '')
      store.release(s)
      await settle()
      expect(history.index).toBe(2)
      expect(keyNow()).toBe('replaced')
    })

    it('no history API: open, release and close do not throw and push nothing', async () => {
      g.window = {
        matchMedia: () => ({ get matches() { return true }, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
      }
      const s = keep('session:a')
      store.release(s)
      const t = open('sheet:x')
      store.close(t)
      await settle()
      expect(closes).toEqual(['sheet:x:false'])
      expect(phoneOverlayIds()).toEqual([])
    })
  })

  it('a deep link replaces the first entry with its base, so back lands home', () => {
    history.entries[0].url = 'https://w.test/?session=s1'
    open('session:s1', { deepLinkBaseUrl: '/' })
    expect(history.entries.map((x) => x.url)).toEqual(['https://w.test/', 'https://w.test/?session=s1'])
    expect(markerDepth(history.entries[0].state)).toBe(0)
  })
})
