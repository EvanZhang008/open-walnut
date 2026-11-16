/**
 * The append normalizer (src/core/drawings/elements.ts): agent skeletons become complete scene
 * elements, ids never collide, ties between elements are made on both sides, and the installed
 * drawing library restores the result without dropping or rewiring anything.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeAppendElements, SKELETON_TYPES } from '../../../src/core/drawings/elements.js'
import { DrawingInputError, emptyScene, type SceneElement } from '../../../src/core/drawings/scene.js'

let n = 0
const opts = { now: 1_700_000_000_000, newId: () => `gen${++n}`, randomInt: () => 42 }

function run(input: unknown[], existing: SceneElement[] = [], files: Record<string, unknown> = {}) {
  return normalizeAppendElements(input, existing, files, opts)
}

/** The fields every element the library makes carries (element/types.ts _ExcalidrawElementBase). */
const BASE_FIELDS = [
  'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle',
  'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId', 'index', 'roundness', 'seed',
  'version', 'versionNonce', 'isDeleted', 'boundElements', 'updated', 'link', 'locked',
]

describe('normalizeAppendElements', () => {
  it('fills every base field for each skeleton type', () => {
    const { added } = run([
      { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { type: 'ellipse', x: 10, y: 10 },
      { type: 'diamond', x: 20, y: 20, width: 40, height: 40 },
      { type: 'text', x: 0, y: 100, text: 'Hello' },
      { type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]] },
      { type: 'line', x: 0, y: 0, points: [[0, 0], [0, 80]] },
      { type: 'freedraw', x: 5, y: 5, points: [[0, 0], [3, 4], [6, 1]] },
    ])
    expect(added.map((e) => e.type)).toEqual([...SKELETON_TYPES])
    for (const el of added) {
      for (const f of BASE_FIELDS) expect(el, `${el.type}.${f}`).toHaveProperty(f)
      expect(el.index).toBeNull()
      expect(el.isDeleted).toBe(false)
    }
    const text = added[3]!
    expect(text).toMatchObject({ fontFamily: 5, fontSize: 20, lineHeight: 1.25, textAlign: 'left', verticalAlign: 'top', containerId: null, originalText: 'Hello', autoResize: true })
    expect(text.width).toBeGreaterThan(0)
    const arrow = added[4]!
    expect(arrow).toMatchObject({ endArrowhead: 'arrow', startArrowhead: null, elbowed: false, startBinding: null, endBinding: null, width: 100, height: 0 })
    expect(added[5]).toMatchObject({ endArrowhead: null, height: 80 })
    expect(added[6]).toMatchObject({ pressures: [], simulatePressure: true, width: 6, height: 4 })
  })

  it('anchors points at the first one, as the library stores them', () => {
    const { added } = run([{ type: 'line', x: 10, y: 10, points: [[5, 5], [15, 25]] }])
    expect(added[0]).toMatchObject({ x: 15, y: 15, points: [[0, 0], [10, 20]] })
  })

  it('gives every addition a new id, maps temporary ids, and refuses one that exists or repeats', () => {
    const existing = [{ id: 'old', type: 'rectangle', isDeleted: true }] as SceneElement[]
    const { added, idMap } = run([{ id: 'mine', type: 'rectangle', x: 0, y: 0 }, { type: 'ellipse', x: 0, y: 0 }], existing)
    expect(added[0]!.id).not.toBe('mine')
    expect(idMap).toEqual({ mine: added[0]!.id })
    expect(new Set(added.map((e) => e.id)).size).toBe(2)
    expect(() => run([{ id: 'old', type: 'rectangle', x: 0, y: 0 }], existing)).toThrow(/already an element/)
    expect(() => run([{ id: 'a', type: 'text', x: 0, y: 0, text: 'x' }, { id: 'a', type: 'text', x: 0, y: 0, text: 'y' }])).toThrow(/twice/)
  })

  it('turns a shape label into a bound text element tied on both sides', () => {
    const { added } = run([{ type: 'rectangle', x: 0, y: 0, width: 200, height: 80, text: 'API' }])
    expect(added).toHaveLength(2)
    const [box, label] = added as [SceneElement, SceneElement]
    expect(box.boundElements).toEqual([{ type: 'text', id: label.id }])
    expect(label).toMatchObject({ type: 'text', containerId: box.id, text: 'API', textAlign: 'center', verticalAlign: 'middle' })
    expect((label.x as number) + (label.width as number) / 2).toBeCloseTo(100)
  })

  it('binds an arrow to a new shape and an existing one, adding only the existing shape\'s entry', () => {
    const existing = [{ id: 'old', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, version: 3, boundElements: [{ type: 'text', id: 't' }] }] as SceneElement[]
    const { added, updatedExisting, idMap } = run([
      { id: 'new', type: 'ellipse', x: 400, y: 0, width: 100, height: 100 },
      { id: 'link', type: 'arrow', start: { id: 'old' }, end: { id: 'new' } },
    ], existing)
    const arrow = added.find((e) => e.id === idMap.link)!
    expect(arrow.startBinding).toMatchObject({ elementId: 'old', focus: 0 })
    expect(arrow.endBinding).toMatchObject({ elementId: idMap.new, focus: 0 })
    expect(arrow.x).toBeGreaterThan(100) // starts at the old box's right edge
    expect((arrow.points as number[][])[1]![0]).toBeGreaterThan(0)
    expect(added.find((e) => e.id === idMap.new)!.boundElements).toEqual([{ type: 'arrow', id: idMap.link }])
    expect(updatedExisting).toHaveLength(1)
    expect(updatedExisting[0]).toMatchObject({ id: 'old', version: 4, boundElements: [{ type: 'text', id: 't' }, { type: 'arrow', id: idMap.link }] })
  })

  it('refuses ties that would leave one side dangling', () => {
    expect(() => run([{ type: 'arrow', x: 0, y: 0, end: { id: 'nowhere' } }])).toThrow(/names no element/)
    expect(() => run([{ type: 'text', x: 0, y: 0, text: 'x', containerId: 'old' }], [{ id: 'old', type: 'rectangle' } as SceneElement])).toThrow(/same batch/)
    expect(() => run([{ type: 'line', x: 0, y: 0, start: { id: 'a' } }, { id: 'a', type: 'rectangle', x: 0, y: 0 }])).toThrow(/only an arrow/)
  })

  it('refuses unknown types, bad numbers and an image without its file', () => {
    for (const bad of [
      { type: 'selection', x: 0, y: 0 },
      { type: 'hexagon', x: 0, y: 0 },
      { type: 'rectangle', x: Number.NaN, y: 0 },
      { type: 'rectangle', x: 2e6, y: 0 },
      { type: 'text', x: 0, y: 0, text: '   ' },
      { type: 'freedraw', x: 0, y: 0, points: [[0, 0]] },
      { type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'missing' },
      { type: 'rectangle', x: 0, y: 0, fillStyle: 'polka' },
    ]) {
      expect(() => run([bad]), JSON.stringify(bad)).toThrow(DrawingInputError)
    }
    expect(() => run([])).toThrow(/non-empty/)
    expect(() => run(Array.from({ length: 501 }, () => ({ type: 'rectangle', x: 0, y: 0 })))).toThrow(/At most/)
  })

  it('keeps a complete element\'s own fields but rebuilds its ties and history', () => {
    const { added } = run([{
      type: 'rectangle', x: 1, y: 2, width: 3, height: 4, seed: 7, customData: { by: 'agent' }, futureField: 'kept',
      version: 99, isDeleted: true, boundElements: [{ type: 'arrow', id: 'ghost' }], index: 'zz',
    }])
    expect(added[0]).toMatchObject({ seed: 7, customData: { by: 'agent' }, futureField: 'kept', version: 1, isDeleted: false, boundElements: null, index: null })
  })
})

// ── The installed library restores what the normalizer makes ─────────────────

const LIB = path.resolve(__dirname, '../../../web/node_modules/@excalidraw/excalidraw/dist/dev/index.js')

/** The few browser globals the library's module body touches, so its pure restore runs in node. */
function shimBrowser(): void {
  const g = globalThis as Record<string, unknown>
  if (g.window) return
  const noop = () => {}
  const element = () => ({
    style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, classList: { add: noop, remove: noop },
    getContext: () => ({ measureText: (t: string) => ({ width: String(t).length * 10 }), font: '' }),
  })
  g.window = globalThis
  g.devicePixelRatio = 1
  g.document = {
    createElement: element, addEventListener: noop, removeEventListener: noop, querySelector: () => null,
    documentElement: element(), head: element(), body: element(),
    fonts: { add: noop, check: () => true, load: async () => [], addEventListener: noop, ready: Promise.resolve() },
  }
  g.Element = class { replaceChildren() {} }
  g.HTMLElement = g.Element
  g.addEventListener = noop
  g.removeEventListener = noop
  g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop })
  g.FontFace = class { status = 'loaded'; load() { return Promise.resolve(this) } }
  if (!g.location) g.location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '', hash: '' }
}

describe.skipIf(!existsSync(LIB))('the installed drawing library restores appended elements', () => {
  it('keeps every element, its id, its ties, and assigns order keys', async () => {
    shimBrowser()
    const lib = await import(pathToFileURL(LIB).href) as { restore: (data: unknown, a: null, b: null, o: { repairBindings: boolean }) => { elements: SceneElement[] } }
    const scene = emptyScene()
    const firstRun = run([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 60, text: 'Client' },
      { id: 'b', type: 'diamond', x: 400, y: 0, width: 120, height: 120, text: '\u670d\u52a1' },
    ])
    const first = firstRun.added
    const a = firstRun.idMap.a!
    const b = firstRun.idMap.b!
    // The scene as a restore + save leaves it: order keys assigned.
    const saved = lib.restore({ ...scene, elements: first }, null, null, { repairBindings: true }).elements
    expect(saved.every((e) => typeof e.index === 'string')).toBe(true)

    const { added, updatedExisting } = run([
      { type: 'arrow', start: { id: a }, end: { id: b } },
      { type: 'ellipse', x: 0, y: 200, width: 80, height: 80 },
      { type: 'line', x: 0, y: 300, points: [[0, 0], [50, 10], [100, 0]] },
      { type: 'freedraw', x: 200, y: 300, points: [[0, 0], [1, 2], [3, 3]] },
      { type: 'text', x: 0, y: 400, text: 'note\nsecond line' },
    ], saved)
    const replaced = new Map(updatedExisting.map((e) => [e.id, e]))
    const elements = [...saved.map((e) => replaced.get(e.id) ?? e), ...added]
    const restored = lib.restore({ ...scene, elements }, null, null, { repairBindings: true }).elements

    expect(restored.map((e) => e.id)).toEqual(elements.map((e) => e.id))
    expect(restored.every((e) => e.isDeleted === false)).toBe(true)
    const indices = restored.map((e) => e.index as string)
    expect(indices.every((i) => typeof i === 'string')).toBe(true)
    expect([...indices].sort()).toEqual(indices) // order kept, keys ascending
    expect(indices.slice(0, saved.length)).toEqual(saved.map((e) => e.index)) // existing keys untouched
    const byId = new Map(restored.map((e) => [e.id, e]))
    const arrow = restored.find((e) => e.type === 'arrow')!
    expect(arrow.startBinding).toMatchObject({ elementId: a })
    expect(arrow.endBinding).toMatchObject({ elementId: b })
    expect((byId.get(a)!.boundElements as Array<{ id: string }>).map((x) => x.id)).toContain(arrow.id)
    expect((byId.get(b)!.boundElements as Array<{ id: string }>).map((x) => x.id)).toContain(arrow.id)
    const labels = restored.filter((e) => e.type === 'text' && e.containerId)
    expect(labels.map((l) => l.containerId).sort()).toEqual([a, b].sort())
  })
})
