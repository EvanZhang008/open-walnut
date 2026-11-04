/**
 * Home's session columns open whole in their first frame (web/src/pages/session-columns-motion.ts).
 *
 * 2026-11-04, the user: "I click new task the quick action etc show really slow ... it should
 * instantly show, no delay". auto-animate's default entry held a new column at opacity 0 for the
 * first half of 480 ms, and slid every other column by animating its WIDTH (a full layout on every
 * frame). The rule: an opening or closing column never moves, a column that kept its size slides by
 * transform alone, nothing else in the strip moves. The ratchet below fails on any auto-animate use
 * in the web app that runs its default motion, which is what brought the delay in.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { columnKeyframes, columnMotion, COLUMN_SLIDE_MS } from '../../web/src/pages/session-columns-motion'

const box = (left: number, width: number) => ({ top: 0, left, width, height: 800 })

describe('columnKeyframes', () => {
  it('never moves a column that opens or closes', () => {
    expect(columnKeyframes('add', true, box(0, 300))).toBeNull()
    expect(columnKeyframes('remove', true, box(0, 300))).toBeNull()
  })

  it('snaps a column whose size changed (a column opened or closed beside it)', () => {
    expect(columnKeyframes('remain', true, box(0, 400), box(300, 300))).toBeNull()
  })

  it('slides a reordered column of the same size by transform only', () => {
    const frames = columnKeyframes('remain', true, box(0, 300), box(300, 300))
    expect(frames).toEqual([{ transform: 'translate(-300px, 0px)' }, { transform: 'translate(0, 0)' }])
    for (const f of frames!) expect(Object.keys(f)).toEqual(['transform'])
  })

  it('leaves everything that is not a column (a resize handle) where it lands', () => {
    expect(columnKeyframes('remain', false, box(0, 6), box(300, 6))).toBeNull()
  })

  it('does nothing for a column that did not move', () => {
    expect(columnKeyframes('remain', true, box(10, 300), box(10, 300))).toBeNull()
  })
})

const WEB_SRC = path.resolve(__dirname, '../../web/src')
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : []
  })
}

describe('columnMotion (the plugin auto-animate calls)', () => {
  // A stand-in for the browser's KeyframeEffect, recording what the plugin built.
  class FakeEffect {
    constructor(public target: unknown, public frames: Keyframe[], public options: KeyframeEffectOptions) {}
  }
  beforeEach(() => { vi.stubGlobal('KeyframeEffect', FakeEffect) })
  afterEach(() => { vi.unstubAllGlobals() })
  const el = (column: boolean) => ({ classList: { contains: (c: string) => column && c === 'main-page-session-column' }, style: {} as Record<string, string> }) as unknown as Element

  it('gives an opening column an empty effect that ends at once', () => {
    const fx = columnMotion(el(true), 'add', box(0, 300)) as unknown as FakeEffect
    expect(fx).toBeInstanceOf(FakeEffect)
    expect(fx.frames).toEqual([])
    expect(fx.options.duration).toBe(0)
  })

  it('takes a closing column out with an empty effect, auto-animate lifting it out of the flow meanwhile', () => {
    const node = el(true)
    vi.stubGlobal('HTMLElement', Object)
    const fx = columnMotion(node, 'remove', box(0, 300)) as unknown as FakeEffect
    expect((node as unknown as { style: Record<string, string> }).style.visibility, 'never painted over the columns that took its room').toBe('hidden')
    expect(fx).toBeInstanceOf(FakeEffect)
    expect(fx.frames).toEqual([])
    expect(fx.options.duration).toBe(0)
  })

  it('reads "remain" as old box first, new box second: the slide starts where the column was', () => {
    const fx = columnMotion(el(true), 'remain', box(300, 300), box(0, 300)) as unknown as FakeEffect
    expect(fx.frames).toEqual([{ transform: 'translate(300px, 0px)' }, { transform: 'translate(0, 0)' }])
    expect(fx.options.duration).toBe(COLUMN_SLIDE_MS)
  })

  it('never moves a resize handle or any other child of the strip', () => {
    const fx = columnMotion(el(false), 'remain', box(300, 6), box(0, 6)) as unknown as FakeEffect
    expect(fx.frames).toEqual([])
  })
})

describe('auto-animate ratchet', () => {
  it('every auto-animate in the web app runs a plugin of its own, never the default fade-in', () => {
    const offenders: string[] = []
    const calls: string[] = []
    for (const file of sources(WEB_SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\b(useAutoAnimate|autoAnimate)\s*(?:<[^>]*>)?\(([^)]*)\)/g)) {
        const where = `${path.relative(WEB_SRC, file)}: ${m[0].slice(0, 80)}`
        calls.push(where)
        // The argument must name a plugin function: `{ duration }`, `undefined` or nothing run the default motion.
        if (!/^\s*[A-Za-z_$][\w$]*Motion\s*$/.test(m[2])) offenders.push(where)
      }
    }
    expect(calls.length, 'Home still slides its columns with auto-animate').toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
