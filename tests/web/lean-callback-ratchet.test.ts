/**
 * No memoized closure keeps a render alive: use useLeanCallback (2026-11-13).
 *
 * V8 and JavaScriptCore give every closure made in one render one shared scope, holding every
 * variable any of them reads. A `useCallback` value, or a `useMemo` value that is or holds a
 * closure, is born in the render where its deps last changed and keeps that whole render alive;
 * that render's scope holds the cached closures it read, born in still earlier renders, and so
 * on. Heap snapshot of the Home page after 80 minutes of live use: 183 of 187 TodoPanel render
 * scopes were reachable from another one (`<button>.onClick` -> `ensureManualSort` -> its
 * render -> ...), each with that render's task list, maps and task notes (78 to 362 copies of
 * the note strings); MainPage's old renders hung on the same chain through the callbacks it
 * hands the panel. The earlier member of the class, a callback kept in state, is guarded by
 * tests/web/no-closure-in-state.test.ts (9686b1d17).
 *
 * The fix is web/src/hooks/useLeanCallback.ts: the same identity rule as useCallback, a function
 * that keeps only a ref. For an object of handlers, name each with useLeanCallback or build the
 * object in a module-level function.
 *
 * Counted per file by tests/helpers/render-closure-scan.ts: [useCallback calls, closure-holding
 * memos], pinned in lean-callback-ratchet.counts.json. Ratchet: counts may only fall; use
 * useLeanCallback. A file that fell is lowered in the pin file (the failure prints the row).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { renderClosureRows, scanRenderClosures } from '../helpers/render-closure-scan'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PINS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'lean-callback-ratchet.counts.json'), 'utf8')) as Record<string, [number, number]>

/** The Home page chain the leak was measured on: nothing left here, ever. */
const ZERO = ['web/src/components/tasks/TodoPanel.tsx', 'web/src/pages/MainPage.tsx', 'web/src/App.tsx']

describe('memoized closures that keep a render alive (web/src)', () => {
  const rows = renderClosureRows(ROOT)

  it('the Home page chain has none', () => {
    for (const f of ZERO) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} moved: point ZERO at its new path`).toBe(true)
      expect(rows[f] ?? [0, 0], `${f}: use useLeanCallback, or a module-level factory for an object of handlers`).toEqual([0, 0])
      expect(PINS[f]).toBeUndefined()
    }
  })

  it('no file has more than its pin (ratchet: counts may only fall; use useLeanCallback)', () => {
    const grew: string[] = []
    for (const [f, [cb, memo]] of Object.entries(rows)) {
      const [pinCb, pinMemo] = PINS[f] ?? [0, 0]
      if (cb > pinCb) grew.push(`${f}: ${cb} useCallback (pin ${pinCb})`)
      if (memo > pinMemo) grew.push(`${f}: ${memo} closure-holding useMemo (pin ${pinMemo})`)
    }
    expect(grew, 'a new memoized closure: use useLeanCallback (web/src/hooks/useLeanCallback.ts), or build the handlers object in a module-level function').toEqual([])
  })

  it('a file that fell is lowered in the pin file', () => {
    const fell: string[] = []
    for (const [f, pin] of Object.entries(PINS)) {
      const now = rows[f] ?? [0, 0]
      if (now[0] < pin[0] || now[1] < pin[1]) fell.push(now[0] || now[1] ? `"${f}": [${now[0]}, ${now[1]}]` : `"${f}": remove the row`)
    }
    expect(fell, 'lower these rows in tests/web/lean-callback-ratchet.counts.json').toEqual([])
  })

  it('counts each form it guards and leaves transient and lean closures alone', () => {
    const scan = (s: string) => scanRenderClosures('Fake.tsx', s)
    expect(scan('const a = useCallback(() => 1, []); const b = React.useCallback((x) => x, [y]);')).toEqual({ useCallback: 2, closureMemo: 0 })
    // Comments and strings never count.
    expect(scan('// useCallback(() => 1, [])\nconst s = "useCallback(";')).toEqual({ useCallback: 0, closureMemo: 0 })
    const memo = (body: string) => scan(`const v = useMemo(${body}, [a]);`).closureMemo
    expect(memo('() => (x: number) => x')).toBe(1)
    expect(memo('() => ({ n: 1, onOpen: () => go() })')).toBe(1)
    expect(memo('() => ({ open() { go() } })')).toBe(1)
    expect(memo('() => ({ nested: { pick: (t) => t.id } })')).toBe(1)
    expect(memo('() => ready ? { run: () => 1 } : undefined')).toBe(1)
    expect(memo('() => { if (!x) return null; const f = 1; return { f, toggle: (id) => set(id) }; }')).toBe(1)
    expect(memo('() => [() => 1]')).toBe(1)
    expect(memo('function () { return () => 1 }')).toBe(1)
    // Data, a function only handed to a call, a factory's result, and lean names are fine.
    expect(memo('() => tasks.filter((t) => t.open).map((t) => t.id)')).toBe(0)
    expect(memo('() => makeCtl({ tasks, onOpen })')).toBe(0)
    expect(memo('() => ({ count: n, onOpen, isPinned: isPinnedRow })')).toBe(0)
    expect(memo('() => { const add = (x) => out.push(x); add(1); return out; }')).toBe(0)
    expect(memo('() => <Row onClick={go} />')).toBe(0)
    expect(scan('const f = useLeanCallback(() => 1, [a]);')).toEqual({ useCallback: 0, closureMemo: 0 })
  })
})
