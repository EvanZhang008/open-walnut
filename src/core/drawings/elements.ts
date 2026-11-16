/**
 * Turn the shapes an agent appends into complete scene elements (pure: no fs, no Walnut imports).
 *
 * An agent describes a shape the way the drawing library's own "element skeleton" does
 * (`convertToExcalidrawElements`, data/transform.ts): `{type:'rectangle', x, y, width, height,
 * text?}`, `{type:'arrow', x, y, points, start?:{id}, end?:{id}}` and so on. This module fills
 * in every field the library's element factories set (element/newElement.ts `_newElementBase`,
 * `newTextElement`, `newLinearElement`, `newArrowElement`, `newFreeDrawElement`), with the
 * library's defaults (DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_FAMILY = Excalifont, per-font line
 * heights from FONT_METADATA, BOUND_TEXT_PADDING). A complete element is accepted too: its own
 * valid fields are kept, and only the fields that tie it to other elements are rebuilt here.
 *
 * The rules that keep a file sound:
 *  - An addition never replaces anything: every added element gets a NEW id. An `id` the caller
 *    gives is a temporary name inside the batch (`"box1"`), so other additions can point at it
 *    (`start: {id: "box1"}`, `containerId`, `frameId`); the answer's `idMap` says which new id
 *    each temporary one became. A temporary id that equals an id already in the scene (deleted
 *    elements included) is refused as ambiguous, and so is one used twice.
 *  - Ties between elements are made on both sides or not at all. A label is a text element
 *    whose `containerId` names its shape AND a `boundElements` entry on that shape; only a
 *    shape added in the same append can take a label. An arrow bound to a shape lists the shape
 *    in its binding AND the shape lists the arrow; the one change this makes to an existing
 *    element is that added `boundElements` entry (with its version bumped), never a removal.
 *  - `index` (the fractional order key) is left null: the library's restore assigns keys after
 *    the last existing one (syncInvalidIndices), so no key is invented here.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { DrawingInputError, MAX_APPEND_ELEMENTS, type SceneElement } from './scene.js'

/** The types an agent describes as a skeleton. */
export const SKELETON_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw'] as const
/** Other element types accepted as complete elements. `selection` is never stored. */
const COMPLETE_ONLY_TYPES = new Set(['frame', 'magicframe', 'image', 'iframe', 'embeddable'])
export const CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const BINDABLE_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image', 'iframe', 'embeddable', 'frame', 'magicframe'])

// The library's defaults (constants.ts), read from the installed package.
const DEFAULTS = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
} as const
const DEFAULT_DIMENSION = 100
const DEFAULT_LINEAR = { width: 100, height: 0 }
const DEFAULT_FONT_SIZE = 20
const DEFAULT_FONT_FAMILY = 5 // Excalifont
/** FONT_FAMILY value -> unitless line height (FONT_METADATA metrics). */
export const LINE_HEIGHT: Record<number, number> = { 1: 1.25, 2: 1.15, 3: 1.2, 5: 1.25, 6: 1.35, 7: 1.15, 8: 1.25, 9: 1.15 }
export const BOUND_TEXT_PADDING = 5
/** The gap a binding keeps between an arrow tip and its shape. */
const BINDING_GAP = 4
const MAX_COORD = 1e6
const MAX_ID_LENGTH = 128
const MAX_TEXT_LENGTH = 20_000
const MAX_POINTS = 20_000

export const FILL_STYLES = new Set(['hachure', 'cross-hatch', 'solid', 'zigzag'])
export const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted'])
export const TEXT_ALIGNS = new Set(['left', 'center', 'right'])
export const VERTICAL_ALIGNS = new Set(['top', 'middle', 'bottom'])
export const ARROWHEADS = new Set([
  'arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond',
  'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many',
])
/** Fields that tie an element to others or to its history: always rebuilt here, never copied. */
const REBUILT_FIELDS = new Set([
  'id', 'index', 'isDeleted', 'version', 'versionNonce', 'updated', 'boundElements', 'containerId',
  'startBinding', 'endBinding', 'start', 'end', 'label', 'lastCommittedPoint', 'frameId',
])

export interface NormalizeOptions {
  now?: number
  newId?: () => string
  randomInt?: () => number
}

/** A new element id, the same alphabet and length class as the library's nanoid ids. */
export function newElementId(): string {
  return randomBytes(15).toString('base64url')
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function fail(i: number, msg: string): never {
  throw new DrawingInputError(`elements[${i}]: ${msg}`)
}

function num(i: number, v: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(i, `${field} must be a finite number`)
  const min = opts.min ?? -MAX_COORD
  const max = opts.max ?? MAX_COORD
  if (v < min || v > max) fail(i, `${field} must be between ${min} and ${max}`)
  return v
}

function optNum(i: number, v: unknown, field: string, fallback: number, opts?: { min?: number; max?: number }): number {
  return v === undefined || v === null ? fallback : num(i, v, field, opts)
}

function optStr(i: number, v: unknown, field: string, fallback: string, allowed?: Set<string>): string {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'string' || (allowed && !allowed.has(v))) {
    fail(i, allowed ? `${field} must be one of ${[...allowed].join(', ')}` : `${field} must be a string`)
  }
  return v
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ')
}

/** A wide (CJK, fullwidth) character takes about one em; a Latin one a little over half. */
function charWidth(cp: number): number {
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 1 : 0.55
}

/**
 * The box a text takes. The server cannot measure with the real font (the library measures on a
 * canvas), so this is an estimate; the editor re-measures every text element once its fonts load.
 */
export function estimateTextBox(text: string, fontSize: number, lineHeight: number): { width: number; height: number } {
  const lines = text.split('\n')
  let widest = 0
  for (const line of lines) {
    let w = 0
    for (const ch of line) w += charWidth(ch.codePointAt(0) ?? 0)
    widest = Math.max(widest, w)
  }
  return { width: Math.ceil(widest * fontSize), height: Math.ceil(lines.length * fontSize * lineHeight) }
}

function points(i: number, raw: unknown, min: number): Array<[number, number]> {
  if (!Array.isArray(raw) || raw.length < min) fail(i, `points must be an array of at least ${min} [x, y] pairs`)
  if (raw.length > MAX_POINTS) fail(i, `points may hold at most ${MAX_POINTS} pairs`)
  return raw.map((p, k) => {
    if (!Array.isArray(p) || p.length < 2) fail(i, `points[${k}] must be an [x, y] pair`)
    return [num(i, p[0], `points[${k}][0]`), num(i, p[1], `points[${k}][1]`)] as [number, number]
  })
}

/** Points made relative to their first one, as the library stores them (first point at 0,0). */
function anchorPoints(x: number, y: number, pts: Array<[number, number]>): { x: number; y: number; points: Array<[number, number]> } {
  const [ox, oy] = pts[0]!
  if (ox === 0 && oy === 0) return { x, y, points: pts }
  return { x: x + ox, y: y + oy, points: pts.map(([px, py]) => [px - ox, py - oy] as [number, number]) }
}

/** The box of a point list. A loop, not Math.min(...xs): a long stroke overflows the argument limit. */
export function pointsExtent(pts: ReadonlyArray<readonly number[]>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    const x = p[0]!
    const y = p[1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

export function sizeFromPoints(pts: ReadonlyArray<readonly number[]>): { width: number; height: number } {
  const e = pointsExtent(pts)
  return { width: e.maxX - e.minX, height: e.maxY - e.minY }
}

function refId(i: number, raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string' && raw) return raw
  if (isObj(raw) && typeof raw.id === 'string' && raw.id) return raw.id
  if (isObj(raw) && typeof raw.elementId === 'string' && raw.elementId) return raw.elementId
  fail(i, `${field} must name an element id ({ id })`)
}

/** Where the line between two box centers leaves the first box, pushed out by `gap`. */
function edgePoint(from: Obj, toward: { x: number; y: number }, gap: number): { x: number; y: number } {
  const w = Number(from.width) || 0
  const h = Number(from.height) || 0
  const cx = (Number(from.x) || 0) + w / 2
  const cy = (Number(from.y) || 0) + h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const tx = dx === 0 ? Infinity : (w / 2) / Math.abs(dx)
  const ty = dy === 0 ? Infinity : (h / 2) / Math.abs(dy)
  const t = Math.min(tx, ty)
  const len = Math.hypot(dx, dy)
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap }
}

function center(el: Obj): { x: number; y: number } {
  return { x: (Number(el.x) || 0) + (Number(el.width) || 0) / 2, y: (Number(el.y) || 0) + (Number(el.height) || 0) / 2 }
}

/**
 * The elements to append, normalized, and the existing elements an addition binds to (with the
 * one added `boundElements` entry). Throws DrawingInputError (400) for anything it cannot add
 * soundly; nothing is added unless every element is sound.
 */
export function normalizeAppendElements(
  input: unknown,
  existing: readonly SceneElement[],
  files: Record<string, unknown>,
  opts: NormalizeOptions = {},
): { added: SceneElement[]; updatedExisting: SceneElement[]; idMap: Record<string, string> } {
  if (!Array.isArray(input) || input.length === 0) throw new DrawingInputError('elements must be a non-empty array')
  if (input.length > MAX_APPEND_ELEMENTS) throw new DrawingInputError(`At most ${MAX_APPEND_ELEMENTS} elements per append`)
  const now = opts.now ?? Date.now()
  const makeId = opts.newId ?? newElementId
  const rand = opts.randomInt ?? (() => randomInt(1, 2 ** 31 - 1))

  const existingById = new Map<string, SceneElement>()
  for (const el of existing) existingById.set(el.id, el)
  const taken = new Set(existingById.keys())

  const fresh = (): string => {
    let id = makeId()
    while (taken.has(id)) id = makeId()
    taken.add(id)
    return id
  }
  // Pass 1: ids. Every addition gets a new id; a given id is a temporary name mapped to it.
  const tempToNew = new Map<string, string>()
  const temps: Array<string | undefined> = input.map((raw, i) => {
    if (!isObj(raw)) fail(i, 'must be an object')
    if (raw.id === undefined || raw.id === null || raw.id === '') return undefined
    if (typeof raw.id !== 'string' || raw.id.length > MAX_ID_LENGTH) fail(i, `id must be a string of at most ${MAX_ID_LENGTH} characters`)
    if (existingById.has(raw.id)) fail(i, `id "${raw.id}" is already an element of the drawing; give an addition a new temporary id (or none)`)
    if (tempToNew.has(raw.id)) fail(i, `id "${raw.id}" appears twice in this batch`)
    tempToNew.set(raw.id, '')
    return raw.id
  })
  const ids: string[] = temps.map((temp) => {
    const id = fresh()
    if (temp !== undefined) tempToNew.set(temp, id)
    return id
  })
  /** A reference: a temporary id of this batch, else an id already in the drawing. */
  const resolve = (ref: string): string => tempToNew.get(ref) ?? ref
  const typeOfNew = new Map(ids.map((id, i) => [id, (input[i] as Obj).type]))

  const batch = new Map<string, Obj>() // id -> element being built
  const added: Obj[] = []
  const labels: Array<{ container: Obj; i: number; label: Obj }> = []
  const pendingBindings: Array<{ arrow: Obj; i: number; side: 'start' | 'end'; target: string }> = []
  const pendingContainers: Array<{ text: Obj; i: number; container: string }> = []

  const base = (raw: Obj, i: number, type: string): Obj => {
    const el: Obj = {}
    // A complete element keeps its own fields (forward compatibility, as the library's restore does).
    for (const [k, v] of Object.entries(raw)) if (!REBUILT_FIELDS.has(k) && k !== 'text') el[k] = v
    const groupIds = raw.groupIds
    if (groupIds !== undefined && (!Array.isArray(groupIds) || groupIds.some((g) => typeof g !== 'string'))) fail(i, 'groupIds must be an array of strings')
    const roundness = raw.roundness
    if (roundness !== undefined && roundness !== null && !(isObj(roundness) && [1, 2, 3].includes(roundness.type as number))) {
      fail(i, 'roundness must be null or { type: 1 | 2 | 3 }')
    }
    const link = raw.link
    if (link !== undefined && link !== null && typeof link !== 'string') fail(i, 'link must be a string')
    Object.assign(el, {
      id: ids[i],
      type,
      x: num(i, raw.x ?? 0, 'x'),
      y: num(i, raw.y ?? 0, 'y'),
      width: 0,
      height: 0,
      angle: optNum(i, raw.angle, 'angle', 0, { min: -7, max: 7 }),
      strokeColor: optStr(i, raw.strokeColor, 'strokeColor', DEFAULTS.strokeColor),
      backgroundColor: optStr(i, raw.backgroundColor, 'backgroundColor', DEFAULTS.backgroundColor),
      fillStyle: optStr(i, raw.fillStyle, 'fillStyle', DEFAULTS.fillStyle, FILL_STYLES),
      strokeWidth: optNum(i, raw.strokeWidth, 'strokeWidth', DEFAULTS.strokeWidth, { min: 0.1, max: 100 }),
      strokeStyle: optStr(i, raw.strokeStyle, 'strokeStyle', DEFAULTS.strokeStyle, STROKE_STYLES),
      roughness: optNum(i, raw.roughness, 'roughness', DEFAULTS.roughness, { min: 0, max: 10 }),
      opacity: optNum(i, raw.opacity, 'opacity', DEFAULTS.opacity, { min: 0, max: 100 }),
      groupIds: (groupIds as string[] | undefined) ?? [],
      frameId: null,
      index: null,
      roundness: roundness ?? null,
      seed: Number.isSafeInteger(raw.seed) && (raw.seed as number) > 0 ? raw.seed : rand(),
      version: 1,
      versionNonce: rand(),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: link ?? null,
      locked: raw.locked === true,
    })
    if (raw.customData !== undefined) {
      if (!isObj(raw.customData)) fail(i, 'customData must be an object')
      el.customData = raw.customData
    }
    if (raw.frameId !== undefined && raw.frameId !== null) {
      const frameId = resolve(refId(i, raw.frameId, 'frameId')!)
      const frameType = (existingById.get(frameId)?.type ?? typeOfNew.get(frameId)) as string | undefined
      if (frameType !== 'frame' && frameType !== 'magicframe') fail(i, `frameId "${frameId}" names no frame`)
      el.frameId = frameId
    }
    return el
  }

  const textFields = (i: number, raw: Obj, text: string): Obj => {
    const fontFamily = raw.fontFamily === undefined || raw.fontFamily === null ? DEFAULT_FONT_FAMILY : raw.fontFamily
    if (typeof fontFamily !== 'number' || !LINE_HEIGHT[fontFamily]) fail(i, `fontFamily must be one of ${Object.keys(LINE_HEIGHT).join(', ')}`)
    const fontSize = optNum(i, raw.fontSize, 'fontSize', DEFAULT_FONT_SIZE, { min: 1, max: 1000 })
    const lineHeight = optNum(i, raw.lineHeight, 'lineHeight', LINE_HEIGHT[fontFamily]!, { min: 0.5, max: 5 })
    return { text, originalText: text, fontSize, fontFamily, lineHeight, autoResize: raw.autoResize !== false }
  }

  const readText = (i: number, v: unknown, field: string): string => {
    if (typeof v !== 'string') fail(i, `${field} must be a string`)
    const text = normalizeText(v)
    if (!text.trim()) fail(i, `${field} must not be empty`)
    if (text.length > MAX_TEXT_LENGTH) fail(i, `${field} may be at most ${MAX_TEXT_LENGTH} characters`)
    return text
  }

  input.forEach((rawIn, i) => {
    const raw = rawIn as Obj
    const type = raw.type
    if (typeof type !== 'string') fail(i, 'type is required')
    if (!(SKELETON_TYPES as readonly string[]).includes(type) && !COMPLETE_ONLY_TYPES.has(type)) {
      fail(i, `type "${type}" is not supported; use ${SKELETON_TYPES.join(', ')}`)
    }
    const el = base(raw, i, type)

    switch (type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        el.width = optNum(i, raw.width, 'width', DEFAULT_DIMENSION, { min: 0 })
        el.height = optNum(i, raw.height, 'height', DEFAULT_DIMENSION, { min: 0 })
        if ((el.width as number) === 0 && (el.height as number) === 0) fail(i, 'width and height cannot both be 0')
        const label: Obj | undefined = isObj(raw.label) ? raw.label : raw.text !== undefined ? { text: raw.text } : undefined
        if (label) labels.push({ container: el, i, label })
        break
      }
      case 'text': {
        Object.assign(el, textFields(i, raw, readText(i, raw.text, 'text')))
        el.textAlign = optStr(i, raw.textAlign, 'textAlign', 'left', TEXT_ALIGNS)
        el.verticalAlign = optStr(i, raw.verticalAlign, 'verticalAlign', 'top', VERTICAL_ALIGNS)
        el.containerId = null
        const box = estimateTextBox(el.text as string, el.fontSize as number, el.lineHeight as number)
        el.width = typeof raw.width === 'number' && raw.width > 0 ? num(i, raw.width, 'width', { min: 0 }) : box.width
        el.height = typeof raw.height === 'number' && raw.height > 0 ? num(i, raw.height, 'height', { min: 0 }) : box.height
        const container = refId(i, raw.containerId, 'containerId')
        if (container) pendingContainers.push({ text: el, i, container })
        break
      }
      case 'line':
      case 'arrow': {
        const startRef = refId(i, raw.start ?? raw.startBinding, 'start')
        const endRef = refId(i, raw.end ?? raw.endBinding, 'end')
        let pts: Array<[number, number]>
        if (raw.points !== undefined) {
          pts = points(i, raw.points, 2)
        } else if (type === 'arrow' && startRef && endRef && raw.x === undefined && raw.y === undefined) {
          pts = [] // derived from the two shapes once every batch element exists
        } else {
          const w = optNum(i, raw.width, 'width', DEFAULT_LINEAR.width)
          const h = optNum(i, raw.height, 'height', DEFAULT_LINEAR.height)
          pts = [[0, 0], [w || DEFAULT_LINEAR.width, h]]
        }
        if (pts.length) Object.assign(el, anchorPoints(el.x as number, el.y as number, pts))
        el.points = (el.points as Array<[number, number]> | undefined) ?? pts
        if ((el.points as unknown[]).length) Object.assign(el, sizeFromPoints(el.points as Array<[number, number]>))
        el.lastCommittedPoint = null
        el.startBinding = null
        el.endBinding = null
        const headDefault = type === 'arrow' ? 'arrow' : null
        const head = (v: unknown, field: string, fallback: string | null): string | null => {
          if (v === undefined) return fallback
          if (v === null) return null
          if (typeof v !== 'string' || !ARROWHEADS.has(v)) fail(i, `${field} must be null or one of ${[...ARROWHEADS].join(', ')}`)
          return v
        }
        el.startArrowhead = head(raw.startArrowhead, 'startArrowhead', null)
        el.endArrowhead = head(raw.endArrowhead, 'endArrowhead', headDefault)
        if (type === 'arrow') {
          // An elbow arrow needs fixed-point bindings the server cannot compute; it is added straight.
          el.elbowed = false
          delete el.fixedSegments
          delete el.startIsSpecial
          delete el.endIsSpecial
          if (startRef) pendingBindings.push({ arrow: el, i, side: 'start', target: startRef })
          if (endRef) pendingBindings.push({ arrow: el, i, side: 'end', target: endRef })
        } else if (startRef || endRef) {
          fail(i, 'only an arrow can connect to shapes; use type "arrow"')
        }
        break
      }
      case 'freedraw': {
        Object.assign(el, anchorPoints(el.x as number, el.y as number, points(i, raw.points, 2)))
        Object.assign(el, sizeFromPoints(el.points as Array<[number, number]>))
        const pressures = raw.pressures
        if (pressures !== undefined && (!Array.isArray(pressures) || pressures.some((p) => typeof p !== 'number' || !Number.isFinite(p)))) {
          fail(i, 'pressures must be an array of numbers')
        }
        el.pressures = (pressures as number[] | undefined) ?? []
        el.simulatePressure = typeof raw.simulatePressure === 'boolean' ? raw.simulatePressure : (el.pressures as number[]).length === 0
        el.lastCommittedPoint = null
        break
      }
      case 'frame':
      case 'magicframe': {
        el.width = num(i, raw.width, 'width', { min: 1 })
        el.height = num(i, raw.height, 'height', { min: 1 })
        if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') fail(i, 'name must be a string')
        el.name = raw.name ?? null
        break
      }
      case 'image': {
        if (typeof raw.fileId !== 'string' || !isObj(files[raw.fileId])) fail(i, 'an image needs a fileId already in the drawing\'s files')
        el.width = num(i, raw.width, 'width', { min: 1 })
        el.height = num(i, raw.height, 'height', { min: 1 })
        el.fileId = raw.fileId
        el.status = 'saved'
        el.scale = Array.isArray(raw.scale) && raw.scale.length === 2 && raw.scale.every((s) => s === 1 || s === -1) ? raw.scale : [1, 1]
        el.crop = null
        break
      }
      case 'iframe':
      case 'embeddable': {
        el.width = num(i, raw.width, 'width', { min: 1 })
        el.height = num(i, raw.height, 'height', { min: 1 })
        break
      }
    }
    batch.set(el.id as string, el)
    added.push(el)
  })

  // Labels: a text element tied to its new shape on both sides.
  for (const { container, i, label } of labels) {
    const textId = fresh()
    const text: Obj = {
      ...base({ strokeColor: label.strokeColor ?? container.strokeColor, opacity: container.opacity, groupIds: container.groupIds }, i, 'text'),
      id: textId,
      ...textFields(i, label, readText(i, label.text, 'text')),
      textAlign: optStr(i, label.textAlign, 'label.textAlign', 'center', TEXT_ALIGNS),
      verticalAlign: optStr(i, label.verticalAlign, 'label.verticalAlign', 'middle', VERTICAL_ALIGNS),
      containerId: container.id,
    }
    if (container.frameId) text.frameId = container.frameId
    const box = estimateTextBox(text.text as string, text.fontSize as number, text.lineHeight as number)
    const maxWidth = Math.max(1, (container.width as number) - BOUND_TEXT_PADDING * 2)
    text.width = Math.min(box.width, maxWidth)
    text.height = box.height
    const c = center(container)
    text.x = c.x - (text.width as number) / 2
    text.y = c.y - (text.height as number) / 2
    container.boundElements = [{ type: 'text', id: textId }]
    // The label sits right after its shape, as the library orders a container and its text.
    added.splice(added.indexOf(container) + 1, 0, text)
    batch.set(textId, text)
  }

  // A text element naming a container: only a shape of this append, tied on both sides.
  for (const { text, i, container: ref } of pendingContainers) {
    const container = resolve(ref)
    const target = batch.get(container)
    if (!target) fail(i, `containerId "${ref}" must name a shape added in this same batch`)
    if (!CONTAINER_TYPES.has(target.type as string) && target.type !== 'arrow') fail(i, `containerId "${container}" is a ${String(target.type)}, which cannot hold text`)
    if (Array.isArray(target.boundElements) && target.boundElements.some((b) => (b as Obj).type === 'text')) {
      fail(i, `"${container}" already has a label`)
    }
    text.containerId = container
    target.boundElements = [...((target.boundElements as Obj[] | null) ?? []), { type: 'text', id: text.id }]
    const c = center(target)
    text.x = c.x - (text.width as number) / 2
    text.y = c.y - (text.height as number) / 2
  }

  // Arrow bindings: both sides, to a shape in this append or one already in the drawing.
  const updated = new Map<string, Obj>()
  const lookup = (id: string): Obj | undefined => batch.get(id) ?? updated.get(id) ?? existingById.get(id)
  const derived = new Set<Obj>()
  for (const b of pendingBindings) {
    const target = lookup(resolve(b.target))
    if (!target || target.isDeleted === true) fail(b.i, `${b.side} "${b.target}" names no element in the drawing or this append`)
    if (!BINDABLE_TYPES.has(target.type as string)) fail(b.i, `${b.side} "${b.target}" is a ${String(target.type)}, which an arrow cannot connect to`)
    if (target.type === 'text' && target.containerId) fail(b.i, `${b.side} "${b.target}" is a label; connect to its shape instead`)
    if ((b.arrow.points as unknown[]).length === 0) derived.add(b.arrow)
    b.arrow[b.side === 'start' ? 'startBinding' : 'endBinding'] = { elementId: target.id, focus: 0, gap: BINDING_GAP }
    const entry = { type: 'arrow', id: b.arrow.id }
    const list = (target.boundElements as Obj[] | null) ?? []
    if (list.some((e) => e.id === b.arrow.id)) continue
    if (batch.has(target.id as string)) {
      target.boundElements = [...list, entry]
    } else {
      updated.set(target.id as string, {
        ...target,
        boundElements: [...list, entry],
        version: (Number(target.version) || 1) + 1,
        versionNonce: rand(),
        updated: now,
      })
    }
  }

  // An arrow given only its two shapes runs from the edge of one to the edge of the other.
  for (const arrow of derived) {
    const from = lookup((arrow.startBinding as Obj).elementId as string)!
    const to = lookup((arrow.endBinding as Obj).elementId as string)!
    const start = edgePoint(from, center(to), BINDING_GAP)
    const end = edgePoint(to, center(from), BINDING_GAP)
    arrow.x = start.x
    arrow.y = start.y
    arrow.points = [[0, 0], [end.x - start.x, end.y - start.y]]
    Object.assign(arrow, sizeFromPoints(arrow.points as Array<[number, number]>))
  }

  return { added: added as SceneElement[], updatedExisting: [...updated.values()] as SceneElement[], idMap: Object.fromEntries(tempToNew) }
}
