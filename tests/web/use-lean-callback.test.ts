/**
 * useLeanCallback (web/src/hooks/useLeanCallback.ts): useCallback's identity
 * rule, with a function that keeps no render alive (2026-11-13, the TodoPanel render chain).
 *
 * Rendered for real (react-dom on a linkedom document). The retention test forces a full GC
 * (Bun.gc under bun, global gc under node with --expose-gc, else the V8 flag trick) and reads a
 * WeakRef: a render's array must be collected once two later renders replaced it with the lean
 * hook, and must stay alive with plain useCallback (the control, so the test proves something).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import v8 from 'node:v8'
import vm from 'node:vm'
import { Component, createElement, act, useCallback, useMemo } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { useLeanCallback } from '../../web/src/hooks/useLeanCallback'

type Root = { render: (n: unknown) => void; unmount: () => void }
let doc: Document
let root: Root | null = null

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el) as Root
})
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount() }); root = null }
  doc.body.innerHTML = ''
})
const render = async (node: unknown) => { const r = root!; await act(async () => { r.render(node) }) }

type Fn = (x: number) => string
interface Seen { fns: Fn[]; duringRender: string[] }

function Probe({ label, dep, seen }: { label: string; dep: number; seen: Seen }) {
  const fn = useLeanCallback((x: number) => `${label}:${x}`, [dep])
  seen.fns.push(fn)
  // A call during render, as a useMemo that calls a callback does.
  seen.duringRender.push(useMemo(() => fn(0), [fn, label]))
  return null
}

describe('useLeanCallback', () => {
  it('keeps its identity until a dep changes, and changes it exactly then', async () => {
    const seen: Seen = { fns: [], duringRender: [] }
    await render(createElement(Probe, { label: 'a', dep: 1, seen }))
    await render(createElement(Probe, { label: 'b', dep: 1, seen }))
    await render(createElement(Probe, { label: 'c', dep: 2, seen }))
    await render(createElement(Probe, { label: 'd', dep: 2, seen }))
    const [r1, r2, r3, r4] = seen.fns
    expect(r1).toBe(r2)
    expect(r3).not.toBe(r2)
    expect(r4).toBe(r3)
  })

  it('every identity runs the latest committed render; a call during render sees the commit before it', async () => {
    const seen: Seen = { fns: [], duringRender: [] }
    await render(createElement(Probe, { label: 'a', dep: 1, seen }))
    await render(createElement(Probe, { label: 'b', dep: 1, seen }))
    await render(createElement(Probe, { label: 'c', dep: 2, seen }))
    await render(createElement(Probe, { label: 'd', dep: 2, seen }))
    // useCallback would run 'a' here (the first render of its deps); every lean identity runs
    // the latest committed render, so an identity someone still holds keeps no render of its own.
    expect(seen.fns[0](7)).toBe('d:7')
    expect(seen.fns[2](7)).toBe('d:7')
    // A new identity starts with its own render's fn (as useCallback's would); with the deps
    // unchanged, a call during render runs the previous commit's fn, never an uncommitted one.
    expect(seen.duringRender).toEqual(['a:0', 'a:0', 'c:0', 'c:0'])
  })

  it('a dropped render with new deps never reaches the identity the page still holds', async () => {
    const seen: Seen = { fns: [], duringRender: [] }
    // Probe renders, then its sibling throws: React drops the whole render, as it drops an
    // interrupted transition, and the error boundary keeps nothing of it.
    function Thrower({ boom }: { boom: boolean }) { if (boom) throw new Error('dropped'); return null }
    class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      render() { return this.state.failed ? null : (this.props.children as never) }
    }
    const tree = (label: string, dep: number, boom: boolean) =>
      createElement(Boundary, null, createElement(Probe, { label, dep, seen }), createElement(Thrower, { boom }))
    await render(tree('committed', 1, false))
    const held = seen.fns[0]
    const error = console.error
    console.error = () => {}
    try { await render(tree('dropped', 2, true)) } finally { console.error = error }
    expect(seen.fns.at(-1)).not.toBe(held)
    expect(held(1)).toBe('committed:1')
  })

  it('a dropped render with the same deps never writes the slot the page still holds', async () => {
    const seen: Seen = { fns: [], duringRender: [] }
    function Thrower({ boom }: { boom: boolean }) { if (boom) throw new Error('dropped'); return null }
    class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      render() { return this.state.failed ? null : (this.props.children as never) }
    }
    const tree = (label: string, boom: boolean) =>
      createElement(Boundary, null, createElement(Probe, { label, dep: 1, seen }), createElement(Thrower, { boom }))
    await render(tree('committed', false))
    const held = seen.fns[0]
    const error = console.error
    console.error = () => {}
    try { await render(tree('dropped', true)) } finally { console.error = error }
    // The review's Move up case: the identity did not change, and it must still run the commit.
    expect(held(1)).toBe('committed:1')
  })

  it('the returned function is the module-level caller, not a closure of the component', async () => {
    const seen: Seen = { fns: [], duringRender: [] }
    await render(createElement(Probe, { label: 'a', dep: 1, seen }))
    // Structural half of the retention proof, true on every engine: the function React keeps
    // is makeLean's arrow (it reads only its slot), not the arrow written in Probe.
    expect(String(seen.fns[0])).toMatch(/lean\.(own|box)/)
    expect(String(seen.fns[0])).not.toMatch(/label/)
  })
})

/** A full collection, or null when this runtime cannot force one. */
function gcFn(): (() => void) | null {
  const bun = (globalThis as { Bun?: { gc: (sync: boolean) => void } }).Bun
  if (bun) return () => bun.gc(true)
  const g = (globalThis as { gc?: () => void }).gc
  if (typeof g === 'function') return g
  try {
    v8.setFlagsFromString('--expose-gc')
    const fromVm = vm.runInNewContext('gc') as (() => void) | undefined
    return typeof fromVm === 'function' ? fromVm : null
  } catch { return null }
}
const forceGc = gcFn()

type UseCb = (fn: () => number, deps: readonly unknown[]) => () => number
function Holds({ big, use, keep }: { big: number[]; use: UseCb; keep: { fn?: () => number } }) {
  // Deps that never change: useCallback keeps the FIRST render's closure, and with it `big`.
  keep.fn = use(() => big.length, [])
  return null
}

/** Three renders, each with its own array; only a WeakRef to the first leaves this frame. */
async function firstRenderArray(key: string, use: UseCb, keep: { fn?: () => number }): Promise<WeakRef<number[]>> {
  const make = () => Array.from({ length: 50_000 }, (_, i) => i)
  let first: number[] | null = make()
  const ref = new WeakRef(first)
  await render(createElement(Holds, { key, big: first, use, keep }))
  first = null
  // Two more renders: the second retires React's alternate fiber, which still held the first props.
  await render(createElement(Holds, { key, big: make(), use, keep }))
  await render(createElement(Holds, { key, big: make(), use, keep }))
  return ref
}

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 6 && ref.deref() !== undefined; i++) {
    await new Promise((r) => setTimeout(r, 0))
    forceGc!()
  }
  return ref.deref() === undefined
}

function HoldsByDeps({ big, use, keep }: { big: number[]; use: UseCb; keep: { first?: () => number } }) {
  // Deps that change every render: each render makes a new identity. The FIRST identity is kept
  // outside, as a memoized row keeps the onClick it was rendered with.
  const fn = use(() => big.length, [big])
  keep.first ??= fn
  return null
}

describe('useLeanCallback retains no render', () => {
  it.skipIf(!forceGc)('an old identity someone still holds keeps no render of its own', async () => {
    // The 2026-11-13 live A/B: identities whose deps had changed still held the last fn of their
    // run, whose render held older identities, so renders still chained. Kept identity, three
    // renders with new deps: the first render's array must be collectable.
    const keep: { first?: () => number } = {}
    const make = () => Array.from({ length: 50_000 }, (_, i) => i)
    let first: number[] | null = make()
    const ref = new WeakRef(first)
    await render(createElement(HoldsByDeps, { key: 'deps', big: first, use: useLeanCallback as unknown as UseCb, keep }))
    first = null
    await render(createElement(HoldsByDeps, { key: 'deps', big: make(), use: useLeanCallback as unknown as UseCb, keep }))
    await render(createElement(HoldsByDeps, { key: 'deps', big: make(), use: useLeanCallback as unknown as UseCb, keep }))
    expect(await collected(ref)).toBe(true)
    expect(keep.first!()).toBe(50_000)
  })

  it.skipIf(!forceGc)('a replaced render is collected with the lean hook, and kept by plain useCallback', async () => {
    const leanKeep: { fn?: () => number } = {}
    const lean = await firstRenderArray('lean', useLeanCallback as unknown as UseCb, leanKeep)
    expect(await collected(lean)).toBe(true)
    expect(leanKeep.fn!()).toBe(50_000)

    const plainKeep: { fn?: () => number } = {}
    const plain = await firstRenderArray('plain', useCallback as unknown as UseCb, plainKeep)
    expect(await collected(plain)).toBe(false)
    expect(plainKeep.fn!()).toBe(50_000)
  })
})
