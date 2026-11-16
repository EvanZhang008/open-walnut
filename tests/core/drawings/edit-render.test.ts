/**
 * One edit of a drawing (src/core/drawings/edit.ts): changes, removals that leave no dangling
 * tie, additions with temporary ids; and the SVG picture an agent reads (render.ts).
 */
import { describe, expect, it } from 'vitest'
import { applySceneEdit } from '../../../src/core/drawings/edit.js'
import { normalizeAppendElements } from '../../../src/core/drawings/elements.js'
import { renderSceneSvg } from '../../../src/core/drawings/render.js'
import { DrawingInputError, emptyScene, validateSceneInput, type DrawingScene, type SceneElement } from '../../../src/core/drawings/scene.js'

type El = SceneElement & Record<string, unknown>

/** A scene with box A (labelled "Alpha"), box B, and an arrow bound A -> B, built by the normalizer itself. */
function boxesAndArrow(): { scene: DrawingScene; a: string; b: string; arrow: string; label: string } {
  const { added, idMap } = normalizeAppendElements([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, text: 'Alpha' },
    { id: 'b', type: 'rectangle', x: 300, y: 0, width: 120, height: 60 },
    { id: 'arrow', type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
  ], [], {})
  const label = added.find((e) => e.type === 'text')!.id
  return { scene: { ...emptyScene(), elements: added }, a: idMap.a!, b: idMap.b!, arrow: idMap.arrow!, label }
}

const byId = (scene: DrawingScene) => new Map(scene.elements.map((e) => [e.id, e as El]))

/** Every tie points at a live element and is listed on both sides. */
function expectTiesConsistent(scene: DrawingScene): void {
  const m = byId(scene)
  for (const el of scene.elements as El[]) {
    if (el.isDeleted) continue
    for (const b of (el.boundElements as Array<{ id: string; type: string }> | null) ?? []) {
      const other = m.get(b.id)
      expect(other && !other.isDeleted, `${el.id} lists ${b.id}`).toBe(true)
      if (b.type === 'text') expect(other!.containerId).toBe(el.id)
      else expect([(other!.startBinding as { elementId?: string } | null)?.elementId, (other!.endBinding as { elementId?: string } | null)?.elementId]).toContain(el.id)
    }
    for (const side of ['startBinding', 'endBinding'] as const) {
      const target = (el[side] as { elementId?: string } | null)?.elementId
      if (!target) continue
      expect(m.get(target)?.isDeleted, `${el.id} ${side}`).toBe(false)
      expect(((m.get(target)!.boundElements as Array<{ id: string }>) ?? []).map((x) => x.id)).toContain(el.id)
    }
    if (typeof el.containerId === 'string') {
      expect(m.get(el.containerId)?.isDeleted).toBe(false)
      expect(((m.get(el.containerId)!.boundElements as Array<{ id: string }>) ?? []).map((x) => x.id)).toContain(el.id)
    }
  }
  // The result is still a scene the server reads.
  expect(() => validateSceneInput(scene, { requireVersion: true })).not.toThrow()
}

describe('applySceneEdit: update', () => {
  it('changes a label through its shape, moves the label with the shape, and bumps versions', () => {
    const { scene, a, label } = boxesAndArrow()
    const { scene: next } = applySceneEdit(scene, { update: [{ id: a, x: 50, y: 40, text: 'Alpha v2', strokeColor: '#e03131' }] })
    const m = byId(next)
    expect(m.get(a)).toMatchObject({ x: 50, y: 40, strokeColor: '#e03131', version: 2 })
    expect(m.get(label)).toMatchObject({ text: 'Alpha v2', originalText: 'Alpha v2', containerId: a, version: 2 })
    const l = m.get(label)!
    expect((l.x as number) + (l.width as number) / 2).toBeCloseTo(110)
    expect(m.get(label)!.versionNonce).not.toBe(scene.elements.find((e) => e.id === label)!.versionNonce)
    expectTiesConsistent(next)
  })

  it('gives a shape without one a label, and edits a free text', () => {
    const { scene, b } = boxesAndArrow()
    const withText = applySceneEdit(scene, { add: [{ id: 't', type: 'text', x: 0, y: 200, text: 'draft' }] })
    const t = withText.idMap.t!
    const { scene: next } = applySceneEdit(withText.scene, { update: [{ id: b, text: 'Beta' }, { id: t, text: 'final\nline two', fontSize: 28 }] })
    const m = byId(next)
    const labelRef = (m.get(b)!.boundElements as Array<{ id: string; type: string }>).find((x) => x.type === 'text')!
    expect(m.get(labelRef.id)).toMatchObject({ text: 'Beta', containerId: b })
    expect(m.get(t)).toMatchObject({ text: 'final\nline two', originalText: 'final\nline two', fontSize: 28 })
    expect(m.get(t)!.height as number).toBeGreaterThan(60)
    expectTiesConsistent(next)
  })

  it('refuses a patch that would change identity, ties or a field the type has not', () => {
    const { scene, a, arrow } = boxesAndArrow()
    for (const update of [
      [{ id: a, type: 'ellipse' }],
      [{ id: a, boundElements: [] }],
      [{ id: arrow, startBinding: null }],
      [{ id: a, fontSize: 30 }],
      [{ id: a, x: 'left' }],
      [{ id: a, isDeleted: true }],
      [{ id: 'missing', x: 1 }],
      [{ x: 1 }],
    ]) {
      expect(() => applySceneEdit(scene, { update }), JSON.stringify(update)).toThrow(DrawingInputError)
    }
    expect(() => applySceneEdit(scene, { remove: [a], update: [{ id: a, x: 1 }] })).toThrow(/removed in this same edit/)
    expect(() => applySceneEdit(scene, {})).toThrow(/nothing to change/)
  })
})

describe('applySceneEdit: remove', () => {
  it('removes a shape with its label and undoes the arrow binding to it', () => {
    const { scene, a, b, arrow, label } = boxesAndArrow()
    const { scene: next } = applySceneEdit(scene, { remove: [a] })
    const m = byId(next)
    expect(m.get(a)!.isDeleted).toBe(true)
    expect(m.get(label)!.isDeleted).toBe(true)
    expect(m.get(arrow)!.startBinding).toBeNull()
    expect(m.get(arrow)!.endBinding).toMatchObject({ elementId: b })
    expect(next.elements).toHaveLength(scene.elements.length) // marked deleted, as the editor does
    expectTiesConsistent(next)
  })

  it('removes an arrow and takes it off both shapes', () => {
    const { scene, a, b, arrow } = boxesAndArrow()
    const { scene: next } = applySceneEdit(scene, { remove: [arrow] })
    const m = byId(next)
    for (const id of [a, b]) expect(((m.get(id)!.boundElements as Array<{ id: string }>) ?? []).map((x) => x.id)).not.toContain(arrow)
    expectTiesConsistent(next)
  })
})

describe('tidying a hand drawing in one edit', () => {
  it('removes three strokes and adds two labelled boxes joined by a bound arrow', () => {
    const strokes = normalizeAppendElements([0, 1, 2].map((k) => ({ type: 'freedraw', x: k * 100, y: 0, points: [[0, 0], [30, 10], [60, 0]] })), [], {}).added
    const scene = { ...emptyScene(), elements: strokes }
    const { scene: next, idMap } = applySceneEdit(scene, {
      remove: strokes.map((s) => s.id),
      add: [
        { id: 'box1', type: 'rectangle', x: 0, y: 0, width: 140, height: 60, text: 'Request' },
        { id: 'box2', type: 'rectangle', x: 300, y: 0, width: 140, height: 60, text: 'Response' },
        { id: 'edge', type: 'arrow', start: { id: 'box1' }, end: { id: 'box2' } },
      ],
    })
    expect(Object.keys(idMap).sort()).toEqual(['box1', 'box2', 'edge'])
    const m = byId(next)
    for (const s of strokes) expect(m.get(s.id)!.isDeleted).toBe(true)
    const arrow = m.get(idMap.edge!)!
    expect(arrow.startBinding).toMatchObject({ elementId: idMap.box1 })
    expect(arrow.endBinding).toMatchObject({ elementId: idMap.box2 })
    expect((arrow.points as number[][]).length).toBe(2)
    const live = next.elements.filter((e) => !e.isDeleted).map((e) => e.type)
    expect(live).toEqual(['rectangle', 'text', 'rectangle', 'text', 'arrow'])
    expectTiesConsistent(next)
  })
})

describe('renderSceneSvg', () => {
  it('draws shapes, every line of text (CJK too, escaped) and arrows with heads', () => {
    const { added } = normalizeAppendElements([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 80, text: '\u767b\u5f55 <user>' },
      { id: 'b', type: 'ellipse', x: 300, y: 0, width: 120, height: 80 },
      { type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
      { type: 'text', x: 0, y: 150, text: '\u7b2c\u4e00\u884c\nsecond & third' },
      { type: 'freedraw', x: 0, y: 250, points: [[0, 0], [10, 5], [20, 0]] },
    ], [], {})
    const { svg, width, height } = renderSceneSvg({ ...emptyScene(), elements: added })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(width).toBeGreaterThan(420)
    expect(height).toBeGreaterThan(250)
    expect(svg).toContain(`width="${width}" height="${height}"`)
    expect(svg).toContain('\u767b\u5f55 &lt;user&gt;')
    expect(svg).toContain('>\u7b2c\u4e00\u884c</tspan>')
    expect(svg).toContain('>second &amp; third</tspan>')
    expect(svg).toMatch(/<rect x="0" y="0" width="160" height="80"/)
    expect(svg).toMatch(/<ellipse cx="360" cy="40"/)
    // The arrow's line and its open head: two polylines in one group.
    expect(svg.match(/<g><polyline[^>]+\/><polyline[^>]+\/><\/g>/)).not.toBeNull()
    expect(svg).not.toContain('undefined')
    expect(svg).not.toContain('NaN')
  })

  it('skips deleted elements and refuses to pass a hostile colour into markup', () => {
    const { svg } = renderSceneSvg({
      ...emptyScene(),
      elements: [
        { id: 'x', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '"/><script>alert(1)</script>' },
        { id: 'y', type: 'text', x: 0, y: 0, text: 'gone', isDeleted: true },
      ] as SceneElement[],
    })
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('gone')
    expect(svg).toContain('stroke="#1e1e1e"')
  })

  it('embeds raster pictures only, and draws a 100k-point stroke without overflowing', () => {
    const png = `data:image/png;base64,${'A'.repeat(64)}`
    const svgDoc = `data:image/svg+xml;base64,${'A'.repeat(64)}`
    const points = Array.from({ length: 100_000 }, (_, k) => [k % 500, Math.floor(k / 500)])
    const { svg } = renderSceneSvg({
      ...emptyScene(),
      files: { p: { dataURL: png }, s: { dataURL: svgDoc } },
      elements: [
        { id: 'a', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'p' },
        { id: 'b', type: 'image', x: 20, y: 0, width: 10, height: 10, fileId: 's' },
        { id: 'c', type: 'freedraw', x: 0, y: 50, points },
      ] as SceneElement[],
    })
    expect(svg).toContain(png)
    expect(svg).not.toContain('image/svg+xml')
    expect(svg).toMatch(/height="2\d\d"/) // 200 rows of points plus padding and offset
    // An agent's stroke is capped at 20k points; at the cap the size is still computed by a loop.
    const many = points.slice(0, 20_000)
    const stroke = normalizeAppendElements([{ type: 'freedraw', x: 0, y: 0, points: many }], [], {}).added[0]!
    expect(stroke).toMatchObject({ width: 499, height: 39 })
    const { scene: moved } = applySceneEdit({ ...emptyScene(), elements: [stroke] }, { update: [{ id: stroke.id, points: many.map(([x, y]) => [x! * 2, y!]) }] })
    expect(moved.elements[0]).toMatchObject({ width: 998, height: 39 })
  })

  it('caps the picture size for a scene spread far apart', () => {
    const { width, height } = renderSceneSvg({
      ...emptyScene(),
      elements: [
        { id: 'p', type: 'rectangle', x: -500_000, y: 0, width: 10, height: 10 },
        { id: 'q', type: 'rectangle', x: 500_000, y: 0, width: 10, height: 10 },
      ] as SceneElement[],
    })
    expect(Math.max(width, height)).toBeLessThanOrEqual(4096)
  })
})
