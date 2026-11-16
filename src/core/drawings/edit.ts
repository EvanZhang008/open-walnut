/**
 * One edit of a drawing: change existing elements, remove some, add new ones, in one step (pure).
 *
 * This is what lets an agent tidy a hand drawing: remove the freehand strokes, add boxes with
 * text and an arrow between them, fix a typo in a label, move a shape. `append` is this edit with
 * only `add`. The rules that keep the file sound:
 *
 *  - update: `{id, ...patch}` on an element that exists and is not deleted. Only the fields in
 *    PATCHABLE change, each checked; `id` and `type` never do (a new type is remove + add), and
 *    the ties (`boundElements`, `containerId`, bindings), `index` and the history fields are
 *    Walnut's. Every changed element gets version + 1, a new versionNonce and `updated`. A label's
 *    new text is re-measured and re-centred in its shape; `text` on a shape edits its label (or
 *    gives it one). Moving a shape moves its label with it. Arrows bound to a moved shape are not
 *    re-routed: the editor re-routes them when the shape is next touched.
 *  - remove: the element is marked deleted (as the editor does), with its label, and every tie
 *    to it is undone on the other side: a shape's `boundElements` entry, an arrow's binding, a
 *    frame membership. Nothing is left pointing at a deleted element.
 *  - add: the normalizer (elements.ts), against the scene as the removes and updates left it.
 */

import { randomInt } from 'node:crypto'
import {
  ARROWHEADS, BOUND_TEXT_PADDING, CONTAINER_TYPES, estimateTextBox, FILL_STYLES, LINE_HEIGHT, normalizeAppendElements,
  sizeFromPoints, STROKE_STYLES, TEXT_ALIGNS, VERTICAL_ALIGNS, type NormalizeOptions,
} from './elements.js'
import { DrawingInputError, type DrawingScene, type SceneElement } from './scene.js'

export interface SceneEdit {
  update?: unknown
  remove?: unknown
  add?: unknown
}

const MAX_EDITS = 1000
const FONT_FAMILIES = new Set(Object.keys(LINE_HEIGHT).map(Number))
const CONTAINERS = CONTAINER_TYPES

type Obj = Record<string, unknown>
type Check = (v: unknown, el: Obj) => boolean

const finite = (min = -1e6, max = 1e6): Check => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const oneOf = (set: Set<unknown>): Check => (v) => set.has(v)
const str: Check = (v) => typeof v === 'string'
const strOrNull: Check = (v) => v === null || typeof v === 'string'
const isPoints: Check = (v) => Array.isArray(v) && v.length >= 2 && v.length <= 20_000
  && v.every((p) => Array.isArray(p) && p.length >= 2 && finite()(p[0], {}) && finite()(p[1], {}))

/** The fields an update may change, with the check each value passes (and the types it applies to). */
const PATCHABLE: Record<string, { check: Check; types?: Set<string> }> = {
  x: { check: finite() },
  y: { check: finite() },
  width: { check: finite(0) },
  height: { check: finite(0) },
  angle: { check: finite(-7, 7) },
  strokeColor: { check: str },
  backgroundColor: { check: str },
  fillStyle: { check: oneOf(FILL_STYLES) },
  strokeWidth: { check: finite(0.1, 100) },
  strokeStyle: { check: oneOf(STROKE_STYLES) },
  roughness: { check: finite(0, 10) },
  opacity: { check: finite(0, 100) },
  roundness: { check: (v) => v === null || (!!v && typeof v === 'object' && [1, 2, 3].includes((v as Obj).type as number)) },
  link: { check: strOrNull },
  locked: { check: (v) => typeof v === 'boolean' },
  groupIds: { check: (v) => Array.isArray(v) && v.every((g) => typeof g === 'string') },
  customData: { check: (v) => !!v && typeof v === 'object' && !Array.isArray(v) },
  text: { check: (v) => typeof v === 'string' && !!v.trim() && v.length <= 20_000, types: new Set(['text', ...CONTAINERS]) },
  fontSize: { check: finite(1, 1000), types: new Set(['text']) },
  fontFamily: { check: oneOf(FONT_FAMILIES), types: new Set(['text']) },
  textAlign: { check: oneOf(TEXT_ALIGNS), types: new Set(['text']) },
  verticalAlign: { check: oneOf(VERTICAL_ALIGNS), types: new Set(['text']) },
  points: { check: isPoints, types: new Set(['line', 'arrow', 'freedraw']) },
  startArrowhead: { check: (v) => v === null || ARROWHEADS.has(v as string), types: new Set(['line', 'arrow']) },
  endArrowhead: { check: (v) => v === null || ARROWHEADS.has(v as string), types: new Set(['line', 'arrow']) },
  name: { check: strOrNull, types: new Set(['frame', 'magicframe']) },
}

function list(v: unknown, field: string): unknown[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new DrawingInputError(`${field} must be an array`)
  if (v.length > MAX_EDITS) throw new DrawingInputError(`${field} may hold at most ${MAX_EDITS} entries`)
  return v
}

/** Check the shape of an edit before the scene is read, so bad input is a 400 even with a stale revision. */
export function checkSceneEdit(edit: SceneEdit): void {
  const update = list(edit.update, 'update')
  const remove = list(edit.remove, 'remove')
  const add = list(edit.add, 'add')
  if (!update.length && !remove.length && !add.length) throw new DrawingInputError('nothing to change: give update, remove or add')
  update.forEach((u, i) => {
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw new DrawingInputError(`update[${i}] must be an object`)
    if (typeof (u as Obj).id !== 'string') throw new DrawingInputError(`update[${i}].id must be a string`)
  })
  remove.forEach((r, i) => { if (typeof r !== 'string') throw new DrawingInputError(`remove[${i}] must be an element id`) })
  add.forEach((a, i) => { if (!a || typeof a !== 'object' || Array.isArray(a)) throw new DrawingInputError(`add[${i}] must be an object`) })
}

function centerLabel(text: Obj, container: Obj): void {
  const maxWidth = Math.max(1, (Number(container.width) || 0) - BOUND_TEXT_PADDING * 2)
  const box = estimateTextBox(String(text.text), Number(text.fontSize) || 20, Number(text.lineHeight) || 1.25)
  text.width = Math.min(box.width, maxWidth)
  text.height = box.height
  text.x = (Number(container.x) || 0) + (Number(container.width) || 0) / 2 - (text.width as number) / 2
  text.y = (Number(container.y) || 0) + (Number(container.height) || 0) / 2 - (text.height as number) / 2
}

export function applySceneEdit(
  scene: DrawingScene,
  edit: SceneEdit,
  opts: NormalizeOptions = {},
): { scene: DrawingScene; idMap: Record<string, string> } {
  checkSceneEdit(edit)
  const now = opts.now ?? Date.now()
  const rand = opts.randomInt ?? (() => randomInt(1, 2 ** 31 - 1))
  const elements = scene.elements.map((el) => el)
  const index = new Map<string, number>(elements.map((el, i) => [el.id, i]))
  const changed = new Set<string>()
  const get = (id: string): Obj | undefined => {
    const i = index.get(id)
    return i === undefined ? undefined : (elements[i] as Obj)
  }
  /** A copy of the element to change, made once per edit. */
  const mut = (id: string): Obj => {
    const i = index.get(id)!
    if (!changed.has(id)) {
      elements[i] = { ...elements[i]! } as SceneElement
      changed.add(id)
    }
    return elements[i] as Obj
  }
  const live = (id: string, what: string): Obj => {
    const el = get(id)
    if (!el || el.isDeleted === true) throw new DrawingInputError(`${what}: no element "${id}" in the drawing`)
    return el
  }

  // Remove: the element and its label, and every tie to them on the other side.
  const removed = new Set<string>()
  for (const id of list(edit.remove, 'remove') as string[]) {
    const el = live(id, 'remove')
    removed.add(id)
    for (const b of (el.boundElements as Obj[] | null) ?? []) {
      if (b.type === 'text' && get(b.id as string)?.containerId === id) removed.add(b.id as string)
    }
  }
  for (const id of removed) mut(id).isDeleted = true
  elements.forEach((el) => {
    if (removed.has(el.id) || el.isDeleted === true) return
    const o = el as Obj
    const bound = o.boundElements as Obj[] | null
    if (bound?.some((b) => removed.has(b.id as string))) mut(el.id).boundElements = bound.filter((b) => !removed.has(b.id as string))
    for (const side of ['startBinding', 'endBinding'] as const) {
      const binding = o[side] as Obj | null
      if (binding && removed.has(binding.elementId as string)) mut(el.id)[side] = null
    }
    if (typeof o.containerId === 'string' && removed.has(o.containerId)) mut(el.id).containerId = null
    if (typeof o.frameId === 'string' && removed.has(o.frameId)) mut(el.id).frameId = null
  })

  // Update: checked fields only, on live elements.
  for (const [i, rawU] of (list(edit.update, 'update') as Obj[]).entries()) {
    const id = rawU.id as string
    if (removed.has(id)) throw new DrawingInputError(`update[${i}]: "${id}" is removed in this same edit`)
    const before = live(id, `update[${i}]`)
    const type = before.type as string
    if (rawU.type !== undefined && rawU.type !== type) throw new DrawingInputError(`update[${i}]: the type of "${id}" cannot change; remove it and add a new element`)
    const el = mut(id)
    let labelText: string | undefined
    for (const [k, v] of Object.entries(rawU)) {
      if (k === 'id' || k === 'type') continue
      const rule = PATCHABLE[k]
      if (!rule) throw new DrawingInputError(`update[${i}]: "${k}" cannot be changed`)
      if (rule.types && !rule.types.has(type)) throw new DrawingInputError(`update[${i}]: a ${type} has no "${k}"`)
      if (!rule.check(v, el)) throw new DrawingInputError(`update[${i}]: "${k}" has an invalid value`)
      if (k === 'text' && CONTAINERS.has(type)) { labelText = (v as string).replace(/\r\n?/g, '\n'); continue }
      el[k] = k === 'text' ? (v as string).replace(/\r\n?/g, '\n') : v
    }
    if (rawU.text !== undefined && type === 'text') el.originalText = el.text
    if (rawU.fontFamily !== undefined && type === 'text') el.lineHeight = LINE_HEIGHT[el.fontFamily as number] ?? el.lineHeight
    if (rawU.points !== undefined) {
      const pts = el.points as number[][]
      const [ox, oy] = pts[0]!
      el.x = (el.x as number) + ox!
      el.y = (el.y as number) + oy!
      el.points = pts.map((p) => [p[0]! - ox!, p[1]! - oy!])
      Object.assign(el, sizeFromPoints(el.points as number[][]))
    }
    if (type === 'text') {
      const container = typeof el.containerId === 'string' ? get(el.containerId) : undefined
      if (container && container.isDeleted !== true) centerLabel(el, container)
      else if ((rawU.text !== undefined || rawU.fontSize !== undefined || rawU.fontFamily !== undefined) && el.autoResize !== false) {
        const box = estimateTextBox(String(el.text), Number(el.fontSize) || 20, Number(el.lineHeight) || 1.25)
        el.width = box.width
        el.height = box.height
      }
    }
    // A shape's label follows the shape; `text` on a shape edits (or makes) its label.
    if (CONTAINERS.has(type)) {
      const labelRef = ((el.boundElements as Obj[] | null) ?? []).find((b) => b.type === 'text' && get(b.id as string)?.isDeleted !== true)
      if (labelRef) {
        const label = mut(labelRef.id as string)
        if (labelText !== undefined) { label.text = labelText; label.originalText = labelText }
        centerLabel(label, el)
      } else if (labelText !== undefined) {
        const { added } = normalizeAppendElements(
          [{ type: 'rectangle', x: 0, y: 0, width: el.width, height: el.height, text: labelText, strokeColor: el.strokeColor }],
          elements, scene.files, opts,
        )
        const label = { ...added[1]!, containerId: id, groupIds: el.groupIds, frameId: el.frameId ?? null } as Obj
        centerLabel(label, el)
        el.boundElements = [...((el.boundElements as Obj[] | null) ?? []), { type: 'text', id: label.id }]
        index.set(label.id as string, elements.length)
        elements.push(label as SceneElement)
      }
    }
  }

  for (const id of changed) {
    const el = get(id)!
    const orig = scene.elements.find((e) => e.id === id)
    el.version = (Number(orig?.version) || 1) + 1
    el.versionNonce = rand()
    el.updated = now
  }

  // Add: against the scene as removes and updates left it.
  const toAdd = list(edit.add, 'add')
  if (!toAdd.length) return { scene: { ...scene, elements }, idMap: {} }
  const { added, updatedExisting, idMap } = normalizeAppendElements(toAdd, elements, scene.files, { ...opts, now, randomInt: rand })
  const replaced = new Map(updatedExisting.map((el) => [el.id, el]))
  return { scene: { ...scene, elements: [...elements.map((el) => replaced.get(el.id) ?? el), ...added] }, idMap }
}
