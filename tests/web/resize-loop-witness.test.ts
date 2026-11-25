/**
 * The ResizeObserver loop error has no file or stack (2026-11-23: 43 in a day filed as "Other in
 * the unknown chunk"), so the page notes which observers ran in the frame and its log line names
 * them. Node env: ResizeObserver and requestAnimationFrame are stubbed with the surface the
 * witness touches.
 */
import { describe, it, expect, vi } from 'vitest'

type Cb = (entries: Array<{ target: unknown }>, ro: unknown) => void
const frames: Array<() => void> = []
class NativeRO {
  cb: Cb
  constructor(cb: Cb) { this.cb = cb }
  fire(target: unknown) { this.cb([{ target }], this) }
}
const el = (tag: string, cls: string, testid?: string) => ({ tagName: tag.toUpperCase(), className: cls, getAttribute: (k: string) => (k === 'data-testid' ? testid ?? null : null) })
Object.assign(globalThis, { window: { ResizeObserver: NativeRO }, requestAnimationFrame: (f: () => void) => { frames.push(f); return frames.length } })

const { afterNextFrame, installResizeLoopWitness, resizeLoopWitness } = await import('../../web/src/utils/resize-loop-witness')

describe('resize loop witness', () => {
  it('names the observers whose callbacks ran this frame, by tag, classes and test id only, and forgets them next frame', () => {
    installResizeLoopWitness()
    installResizeLoopWitness() // a second install wraps nothing twice
    const RO = (globalThis as unknown as { window: { ResizeObserver: new (cb: Cb) => NativeRO } }).window.ResizeObserver
    expect(RO).not.toBe(NativeRO)
    let calls = 0
    const ro = new RO(() => { calls++ })
    ro.fire(el('div', 'session-panel-input glass extra', 'composer'))
    ro.fire(el('div', 'session-panel-input glass extra', 'composer'))
    new RO(() => { calls++ }).fire(el('span', ''))
    expect(calls).toBe(3)
    // The callback's `this` is the observer, as the native one calls it.
    let self: unknown = null
    const plain = new RO(function (this: unknown) { self = this })
    plain.fire(el('p', ''))
    expect(self).toBe(plain)
    expect(resizeLoopWitness()).toBe('div.session-panel-input.glass[composer], span, p')
    for (const f of frames.splice(0)) f()
    expect(resizeLoopWitness()).toBe('')
  })

  it('after a loop, names what the next frame delivers: the boxes left undelivered', async () => {
    const RO = (globalThis as unknown as { window: { ResizeObserver: new (cb: Cb) => NativeRO } }).window.ResizeObserver
    const ro = new RO(() => {})
    ro.fire(el('div', 'session-panel-input'))
    let next: string | null = null
    afterNextFrame((n) => { next = n })
    // The next frame: its animation callbacks (the tick, then ours), then its observers.
    for (const f of frames.splice(0)) f()
    ro.fire(el('div', 'session-history'))
    expect(next).toBeNull()
    await vi.waitFor(() => expect(next).toBe('div.session-history'))
  })
})
