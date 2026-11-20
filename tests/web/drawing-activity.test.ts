/**
 * The person's steps on the canvas (web/src/components/drawing/drawing-activity.ts), which the
 * Drawing plugin records beside their voice: drawn, changed, removed, selected and pointed at,
 * each named by its words, with a scene from outside taken as a baseline and never as a step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTracker, POINT_DWELL_MS, type Activity, type ActivityElement } from '../../web/src/components/drawing/drawing-activity'

const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<ActivityElement> = {}): ActivityElement =>
  ({ id, type: 'rectangle', version: 1, x, y, width: w, height: h, ...extra })
const label = (id: string, of: string, text: string, version = 1): ActivityElement =>
  ({ id, type: 'text', version, x: 0, y: 0, width: 10, height: 10, text, containerId: of })

function setup() {
  const steps: Activity[] = []
  let now = 1_000
  const tracker = new ActivityTracker((a) => steps.push(a), () => now)
  return { steps, tracker, tick: (ms: number) => { now += ms; vi.advanceTimersByTime(ms) } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ActivityTracker', () => {
  it('takes the first scene as a baseline, then reports what the person drew, changed and removed', () => {
    const { steps, tracker } = setup()
    const orders = box('orders', 0, 0, 100, 60, { boundElements: [{ id: 'orders-t', type: 'text' }] })
    tracker.baseline([orders, label('orders-t', 'orders', 'orders')])
    expect(steps).toEqual([])
    const redis = box('redis', 200, 0, 80, 40, { boundElements: [{ id: 'redis-t', type: 'text' }] })
    tracker.change([orders, label('orders-t', 'orders', 'orders'), redis, label('redis-t', 'redis', 'Redis cache')], {})
    expect(steps).toEqual([{ kind: 'add', ids: ['redis'], labels: ['Redis cache'], at: 1_000 }])
    // Typing in a shape's label is a change to the shape.
    tracker.change([orders, label('orders-t', 'orders', 'orders table', 2), redis, label('redis-t', 'redis', 'Redis cache')], {})
    expect(steps.at(-1)).toMatchObject({ kind: 'edit', ids: ['orders'], labels: ['orders table'] })
    tracker.change([orders, label('orders-t', 'orders', 'orders table', 2)], {})
    expect(steps.at(-1)).toMatchObject({ kind: 'delete', ids: ['redis', 'redis-t'], labels: ['Redis cache', 'Redis cache'] })
  })

  it('reports the selection as the shapes, once per change', () => {
    const { steps, tracker } = setup()
    const els = [box('a', 0, 0, 10, 10, { boundElements: [{ id: 'a-t', type: 'text' }] }), label('a-t', 'a', 'A')]
    tracker.baseline(els)
    tracker.change(els, { 'a-t': true })
    tracker.change(els, { 'a-t': true })
    tracker.change(els, {})
    expect(steps.map((s) => [s.kind, s.ids])).toEqual([['select', ['a']], ['select', []]])
  })

  it('a scene from outside is a new baseline: an agent\'s shape is not the person\'s step', () => {
    const { steps, tracker } = setup()
    tracker.baseline([box('a', 0, 0, 10, 10)])
    tracker.baseline([box('a', 0, 0, 10, 10), box('agent', 50, 50, 10, 10)])
    tracker.change([box('a', 0, 0, 10, 10), box('agent', 50, 50, 10, 10)], {})
    expect(steps).toEqual([])
  })

  it('names the smallest shape under the pointer after it rests there', () => {
    const { steps, tracker, tick } = setup()
    tracker.baseline([
      { ...box('frame', -500, -500, 2_000, 2_000), type: 'frame', name: 'Storage' },
      box('big', 0, 0, 400, 400),
      box('small', 10, 10, 50, 50, { boundElements: [{ id: 's-t', type: 'text' }] }),
      label('s-t', 'small', 'orders'),
      { ...box('arrow', 0, 0, 400, 400), type: 'arrow' },
    ])
    tracker.pointer(20, 20)
    tick(POINT_DWELL_MS - 10)
    expect(steps).toEqual([])
    tick(20)
    expect(steps).toEqual([{ kind: 'point', ids: ['small'], labels: ['orders'], at: 1_000 }])
    // Passing over another shape on the way is not pointing at it.
    tracker.pointer(300, 300)
    tick(100)
    tracker.pointer(20, 20)
    tick(POINT_DWELL_MS)
    expect(steps).toHaveLength(1)
    tracker.pointer(300, 300)
    tick(POINT_DWELL_MS)
    expect(steps.at(-1)).toMatchObject({ kind: 'point', ids: ['big'] })
    tracker.pointer(-400, -400)
    tick(POINT_DWELL_MS)
    expect(steps.at(-1)).toMatchObject({ kind: 'point', ids: ['frame'], labels: ['Storage'] })
    tracker.pointer(5_000, 5_000)
    tick(POINT_DWELL_MS)
    expect(steps.at(-1)).toMatchObject({ kind: 'point', ids: [], labels: [] })
  })

  it('hits a shape drawn right to left (negative width) and stops its timer on dispose', () => {
    const { steps, tracker, tick } = setup()
    tracker.baseline([box('neg', 100, 100, -80, -60)])
    expect(tracker.hit(50, 60)).toBe('neg')
    tracker.pointer(50, 60)
    tracker.dispose()
    tick(POINT_DWELL_MS * 2)
    expect(steps).toEqual([])
  })
})
