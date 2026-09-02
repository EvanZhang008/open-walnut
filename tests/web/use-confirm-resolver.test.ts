/**
 * ConfirmProvider must never drop a resolver.
 *
 * `useConfirm` hands every caller a promise and shows ONE dialog. Before this was
 * pinned, the provider kept the outstanding request in a single `useState` slot and
 * settled only whatever `stateRef.current` happened to hold, so a second
 * `confirm()` arriving while one was open silently REPLACED the first: the first
 * caller's `resolve` became unreachable from every callback and its `await` parked
 * forever. That failure is invisible by construction — no error, no rejection, no
 * timeout, just a code path that stops mid-flow (a half-finished move, a dialog the
 * user answered that "did nothing").
 *
 * The nastiest variant is two asks in the SAME tick: `stateRef.current = state` was
 * a render-phase write, so both calls read `null`, neither saw the other, and the
 * loser was lost with nothing on screen to hint at it. Hence the occupant is now
 * tracked at CALL time (`pendingRef`), and this file asserts the promise
 * observably SETTLES rather than asserting on any internal field.
 *
 * HOW this runs without a DOM (root vitest is `environment: 'node'`; no jsdom, no
 * @testing-library — see tests/web/use-project-actions.test.ts for the pattern):
 * React is mocked with a hand-rolled hook store and the provider FUNCTION is
 * invoked directly, so the code under test is the real provider, not a replica.
 * The mock path matters: web/src imports resolve React out of web/node_modules, so
 * a mock keyed on the repo root's `react` silently misses. The JSX factories are
 * mocked too (the real dev runtime reads React's private internals, which a mocked
 * React does not have) and `ConfirmDialog` is stubbed — the dialog's own markup is
 * not what is under test, the resolver bookkeeping is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hand-rolled hook store ────────────────────────────────────────────────────
// Slots are keyed by CALL ORDER, which is stable because the provider calls its
// hooks unconditionally. `dirty` records that a setState happened so the harness
// knows to re-invoke the function for a fresh view of `state`.
const slots = new Map<number, unknown>()
let cursor = 0
let dirty = false
/** Effects queued by this render pass. The provider's only effect has `[]` deps,
 *  so it is run once at mount and its cleanup kept for `unmount()`. */
let queuedEffects: Array<() => void | (() => void)> = []

vi.mock('../../web/node_modules/react', () => ({
  createContext: () => ({ Provider: { $$: 'ConfirmContext.Provider' } }),
  useContext: () => null,
  useState: <T,>(initial: T) => {
    const i = cursor++
    if (!slots.has(i)) slots.set(i, initial)
    const set = (next: T | ((prev: T) => T)) => {
      const prev = slots.get(i) as T
      slots.set(i, typeof next === 'function' ? (next as (p: T) => T)(prev) : next)
      dirty = true
    }
    return [slots.get(i) as T, set] as const
  },
  useRef: <T,>(initial: T) => {
    const i = cursor++
    if (!slots.has(i)) slots.set(i, { current: initial })
    return slots.get(i) as { current: T }
  },
  useCallback: <T,>(fn: T) => fn,
  useEffect: (fn: () => void | (() => void)) => { queuedEffects.push(fn) },
}))

const jsxFactory = (type: unknown, props: Record<string, unknown>) => ({ type, props })
vi.mock('../../web/node_modules/react/jsx-runtime', () => ({
  jsx: jsxFactory, jsxs: jsxFactory, Fragment: { $$: 'Fragment' },
}))
vi.mock('../../web/node_modules/react/jsx-dev-runtime', () => ({
  jsxDEV: jsxFactory, Fragment: { $$: 'Fragment' },
}))

const DIALOG = { $$: 'ConfirmDialogStub' }
vi.mock('@/components/common/ConfirmDialog', () => ({ ConfirmDialog: DIALOG }))

const { ConfirmProvider } = await import('@/hooks/useConfirm')

// ── Harness ───────────────────────────────────────────────────────────────────

interface Ctx {
  confirm: (opts: { title: string }) => Promise<boolean>
  alert: (opts: { title: string }) => Promise<void>
  prompt: (opts: { title: string; defaultValue?: string }) => Promise<string | null>
}
interface DialogProps {
  title: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: (value?: string) => void
  onCancel: () => void
}
interface Element { type: unknown; props: Record<string, unknown> }

/** One mounted provider, driven by hand. */
function mount() {
  slots.clear()
  dirty = false
  queuedEffects = []
  let tree = invoke()
  const cleanups: Array<() => void> = []
  // Mount effects, once (the provider's only effect has [] deps).
  for (const fn of queuedEffects) {
    const c = fn()
    if (typeof c === 'function') cleanups.push(c)
  }
  queuedEffects = []

  function invoke(): Element {
    cursor = 0
    dirty = false
    return ConfirmProvider({ children: null }) as unknown as Element
  }
  /** Re-invoke only when a setState happened — mirrors React's render trigger. */
  function current(): Element {
    if (dirty) tree = invoke()
    return tree
  }
  const ctx = (): Ctx => current().props.value as Ctx
  /** The single visible dialog's props, or null when nothing is on screen. */
  const visible = (): DialogProps | null => {
    const kids = current().props.children
    const list = (Array.isArray(kids) ? kids : [kids]) as Array<Element | null | false>
    const dialogs = list.filter((k): k is Element => !!k && typeof k === 'object' && k.type === DIALOG)
    // Single-visible-dialog UX: never a stack.
    expect(dialogs.length).toBeLessThanOrEqual(1)
    return dialogs[0] ? (dialogs[0].props as unknown as DialogProps) : null
  }
  return {
    get confirm() { return ctx().confirm },
    get alert() { return ctx().alert },
    get prompt() { return ctx().prompt },
    visible,
    clickConfirm: (value?: string) => { const d = visible(); expect(d).not.toBeNull(); d!.onConfirm(value) },
    clickCancel: () => { const d = visible(); expect(d).not.toBeNull(); d!.onCancel() },
    unmount: () => { for (const c of cleanups) c() },
  }
}

const PENDING = Symbol('pending')

/**
 * What a promise has settled to after the microtask queue drains — or PENDING.
 * Asserting "settled" is the whole point: the bug was a promise that never did,
 * which no `await` in a test can catch (it just hangs until the 30s timeout).
 */
async function settled<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  let out: T | typeof PENDING = PENDING
  let done = false
  void p.then((v) => { done = true; out = v })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  return done ? out : PENDING
}

beforeEach(() => { slots.clear(); queuedEffects = []; dirty = false; cursor = 0 })

describe('a displaced request settles instead of parking', () => {
  it('a second confirm while one is open cancels the first and shows the second', async () => {
    const h = mount()
    const first = h.confirm({ title: 'Move across providers?' })
    expect(h.visible()?.title).toBe('Move across providers?')

    const second = h.confirm({ title: 'Delete task?' })

    // THE ratchet: the displaced caller is answered "no", not left hanging.
    expect(await settled(first)).toBe(false)
    // …and the screen belongs to the newer ask, still exactly one dialog.
    expect(h.visible()?.title).toBe('Delete task?')

    h.clickConfirm()
    expect(await settled(second)).toBe(true)
    expect(h.visible()).toBeNull()
  })

  it('two asks in the SAME tick still settle the loser (no render in between)', async () => {
    const h = mount()
    // The regression's worst shape: the provider never re-rendered between these
    // two calls, so a render-phase ref read `null` for both.
    const first = h.confirm({ title: 'first' })
    const second = h.confirm({ title: 'second' })

    expect(await settled(first)).toBe(false)
    expect(h.visible()?.title).toBe('second')
    h.clickCancel()
    expect(await settled(second)).toBe(false)
  })

  it('settles a displaced prompt as null and a displaced alert as done', async () => {
    const h = mount()
    const typed = h.prompt({ title: 'Rename folder', defaultValue: 'Marina' })
    const note = h.alert({ title: 'Save failed' })
    // The prompt lost the slot to the alert: null = cancelled, never a value.
    expect(await settled(typed)).toBeNull()
    expect(h.visible()?.title).toBe('Save failed')

    const ask = h.confirm({ title: 'Really?' })
    // An awaited alert that is displaced must still complete, or its caller stops.
    expect(await settled(note)).toBeUndefined()
    expect(h.visible()?.title).toBe('Really?')
    h.clickCancel()
    expect(await settled(ask)).toBe(false)
  })

  it('a chain of asks leaves nothing outstanding', async () => {
    const h = mount()
    const pending = [1, 2, 3, 4].map((n) => h.confirm({ title: `ask ${n}` }))
    const last = h.confirm({ title: 'ask 5' })
    for (const p of pending) expect(await settled(p)).toBe(false)
    expect(h.visible()?.title).toBe('ask 5')
    h.clickConfirm()
    expect(await settled(last)).toBe(true)
  })
})

describe('unmount and double-answer', () => {
  it('unmounting the provider settles the outstanding request', async () => {
    const h = mount()
    const pending = h.confirm({ title: 'Move across providers?' })
    h.unmount()
    expect(await settled(pending)).toBe(false)
  })

  it('answering twice resolves once and does not throw on the second click', async () => {
    const h = mount()
    const p = h.prompt({ title: 'Rename folder' })
    const dialog = h.visible()!
    dialog.onConfirm('Harbour')
    expect(await settled(p)).toBe('Harbour')
    // A double click (or an Esc racing the button) hits the same stale callbacks:
    // the request is gone, so there is nothing left to settle a second time.
    expect(() => { dialog.onCancel(); dialog.onConfirm('other') }).not.toThrow()
    expect(h.visible()).toBeNull()
  })

  it('an answered request is not re-settled by a later unmount', async () => {
    const h = mount()
    const p = h.confirm({ title: 'Move across providers?' })
    h.clickConfirm()
    expect(await settled(p)).toBe(true)
    h.unmount()
    // Still true: a promise settles once, and unmount must not pretend otherwise.
    expect(await settled(p)).toBe(true)
  })
})
