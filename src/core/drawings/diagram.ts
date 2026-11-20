/**
 * "Make a diagram" and "Text to diagram" inside the drawing editor: one short model call on the
 * server that answers with element skeletons the editor adds as one undoable edit. Nothing is
 * written to disk here.
 *
 *   tidy  the selection (or the whole scene): rendered to a PNG with the drawing renderer
 *         (render.ts, then sharp) so strokes without text are understood, plus the elements' text
 *         and geometry as compact JSON
 *   text  a description the person typed (prompt only)
 *
 * The model is Walnut's own (model.ts sendMessage, the user's configured main model; Walnut never
 * names an engine's default). It must answer with ONLY JSON: an array of skeleton shapes (the drawing
 * library's `convertToExcalidrawElements` input), laid out with its top left at (0,0). The answer is
 * checked with the same rules an agent's append passes (elements.ts normalizeAppendElements), then
 * cleaned to known fields; a reply that is not usable is asked for once more, then it is a 502. The
 * whole call has DIAGRAM_DEADLINE_MS (504), and a caller that goes away cancels it.
 */

import { log } from '../../logging/index.js'
import { normalizeAppendElements } from './elements.js'
import { renderSceneSvgYielding } from './render.js'
import { DrawingInputError, DrawingServiceError, MAX_APPEND_ELEMENTS, type SceneElement } from './scene.js'

export const MAX_DIAGRAM_ELEMENTS = 2000
export const MAX_DIAGRAM_PROMPT = 4000
/** The largest request body (the selection with its pictures). */
export const MAX_DIAGRAM_BODY_BYTES = 10 * 1024 * 1024
/** The picture's longest side: what a vision model reads at full detail. */
const IMAGE_SIDE = 1568
/** The element JSON sent along; past it, stroke points are left out. */
const MAX_FACTS_CHARS = 100_000
const MAX_POINTS_SENT = 24
const MAX_REPLY_ELEMENTS = Math.min(300, MAX_APPEND_ELEMENTS)

// A real sketch of about 30 shapes took 53 s on a large model (2026-11-16), so the deadline leaves room.
export const diagramTuning = { deadlineMs: 150_000 }

export type DiagramMode = 'tidy' | 'text'

export interface DiagramInput {
  mode?: unknown
  elements?: unknown
  prompt?: unknown
  files?: unknown
  taskId?: unknown
  sessionId?: unknown
}

export type Skeleton = Record<string, unknown> & { type: string }

export interface DiagramResult {
  elements: Skeleton[]
  note?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Input ───────────────────────────────────────────────────────────────────

interface Checked {
  mode: DiagramMode
  elements: SceneElement[]
  files: Record<string, unknown>
  prompt: string
}

export function checkDiagramInput(input: DiagramInput): Checked {
  if (input.mode !== 'tidy' && input.mode !== 'text') throw new DrawingInputError('mode must be tidy or text')
  if (input.mode === 'text') {
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new DrawingInputError('prompt is required for mode text')
    if (input.prompt.length > MAX_DIAGRAM_PROMPT) throw new DrawingInputError(`prompt may be at most ${MAX_DIAGRAM_PROMPT} characters`, 413)
    return { mode: 'text', elements: [], files: {}, prompt: input.prompt.trim() }
  }
  if (!Array.isArray(input.elements)) throw new DrawingInputError('elements must be an array for mode tidy')
  if (input.elements.length > MAX_DIAGRAM_ELEMENTS) throw new DrawingInputError(`At most ${MAX_DIAGRAM_ELEMENTS} elements per diagram`, 413)
  const elements = input.elements.filter((el): el is SceneElement =>
    isObj(el) && typeof el.type === 'string' && typeof el.id === 'string' && el.isDeleted !== true)
  if (elements.length === 0) throw new DrawingInputError('elements holds nothing to turn into a diagram')
  if (input.files !== undefined && input.files !== null && !isObj(input.files)) throw new DrawingInputError('files must be an object')
  // Only the pictures these elements show go to the renderer.
  const files: Record<string, unknown> = {}
  const given = (input.files ?? {}) as Obj
  for (const el of elements) if (typeof el.fileId === 'string' && isObj(given[el.fileId])) files[el.fileId] = given[el.fileId]
  return { mode: 'tidy', elements, files, prompt: '' }
}

// ── What the model sees ─────────────────────────────────────────────────────

const r = (v: unknown): number => Math.round(Number(v) || 0)

function sampled(points: unknown): number[][] | undefined {
  if (!Array.isArray(points) || points.length < 2) return undefined
  const step = Math.max(1, Math.ceil(points.length / MAX_POINTS_SENT))
  const out: number[][] = []
  for (let i = 0; i < points.length; i += step) {
    const p = points[i]
    if (Array.isArray(p)) out.push([r(p[0]), r(p[1])])
  }
  const last = points[points.length - 1]
  if (Array.isArray(last) && (points.length - 1) % step !== 0) out.push([r(last[0]), r(last[1])])
  return out
}

/** The elements' text and geometry, compact: what the picture cannot say exactly. */
export function diagramFacts(elements: readonly SceneElement[]): string {
  const facts = (withPoints: boolean) => elements.map((el) => {
    const o: Obj = { id: el.id, type: el.type, x: r(el.x), y: r(el.y) }
    if (el.width) o.w = r(el.width)
    if (el.height) o.h = r(el.height)
    const text = el.type === 'text' ? (typeof el.originalText === 'string' && el.originalText ? el.originalText : el.text) : undefined
    if (typeof text === 'string' && text.trim()) o.text = text
    if (typeof el.containerId === 'string') o.in = el.containerId
    if ((el.type === 'frame' || el.type === 'magicframe') && typeof el.name === 'string') o.name = el.name
    const start = isObj(el.startBinding) ? el.startBinding.elementId : undefined
    const end = isObj(el.endBinding) ? el.endBinding.elementId : undefined
    if (typeof start === 'string') o.from = start
    if (typeof end === 'string') o.to = end
    if (withPoints) {
      const pts = sampled(el.points)
      if (pts) o.points = pts
    }
    return o
  })
  const full = JSON.stringify(facts(true))
  if (full.length <= MAX_FACTS_CHARS) return full
  const lean = JSON.stringify(facts(false))
  return lean.length <= MAX_FACTS_CHARS ? lean : `${lean.slice(0, MAX_FACTS_CHARS)} ...(cut)`
}

/** The selection as a PNG (base64), or null when this machine cannot make one. */
async function selectionPng(elements: SceneElement[], files: Record<string, unknown>): Promise<string | null> {
  try {
    const { svg } = await renderSceneSvgYielding({ elements, appState: { viewBackgroundColor: '#ffffff' }, files })
    const { loadSharp } = await import('../../utils/image-compress.js')
    const sharp = await loadSharp()
    if (!sharp) return null
    const png = await sharp(Buffer.from(svg)).resize({ width: IMAGE_SIDE, height: IMAGE_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    return png.toString('base64')
  } catch (err) {
    log.memory.warn('diagram: the selection could not be drawn as a picture; sending its elements only', { error: (err as Error).message })
    return null
  }
}

export const DIAGRAM_SYSTEM = `You turn a whiteboard sketch, or a description, into a clean diagram for a hand-drawn style whiteboard editor.
Reply with ONLY a JSON array: no markdown fence, no commentary. Each item is one shape:
- {"id":"a","type":"rectangle","x":0,"y":0,"width":180,"height":70,"label":{"text":"Load balancer"}}   (also "ellipse" and "diamond")
- {"id":"t1","type":"text","x":0,"y":0,"text":"A title or a note","fontSize":20}
- {"type":"arrow","x":0,"y":0,"start":{"id":"a"},"end":{"id":"b"},"label":{"text":"yes"}}   (label optional)
- {"type":"line","x":0,"y":0,"points":[[0,0],[200,0]]}
Rules:
- ids are temporary names, unique in your reply. An arrow between two shapes names them in start and end.
- Lay it out cleanly: aligned rows or columns, even gaps of 60 px or more, nothing overlapping, the top left at (0,0).
- Boxes fit their label (about 10 px per character, at least 120 by 60). Rectangles for steps and parts, diamonds for decisions, ellipses for a start or an end.
- Keep every word the person wrote, in their language; fix only obvious typos. Add no facts of your own.
- At most ${MAX_REPLY_ELEMENTS} items. strokeColor and backgroundColor are optional hex colours.
If part of the input cannot be understood, reply {"elements":[...],"note":"one short sentence saying what was left out"} instead of the bare array.`

function userContent(input: Checked, png: string | null): Array<Obj> {
  if (input.mode === 'text') return [{ type: 'text', text: `Draw this as a clean diagram:\n${input.prompt}` }]
  const text = [
    png ? 'The picture shows the selected part of the whiteboard.' : 'No picture is available; the elements below are the selected part of the whiteboard.',
    'Turn it into a clean diagram with the same meaning: read hand-drawn strokes as the boxes, arrows and words they stand for, keep every typed word.',
    'Its elements (px; "in" = the shape a text is the label of, "from"/"to" = what an arrow connects):',
    diagramFacts(input.elements),
  ].join('\n')
  return [
    ...(png ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] : []),
    { type: 'text', text },
  ]
}

// ── The answer ──────────────────────────────────────────────────────────────

class BadReply extends Error {}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function labelOf(v: unknown, fallback: unknown): Obj | undefined {
  const text = isObj(v) ? v.text : fallback
  if (typeof text !== 'string' || !text.trim()) return undefined
  const label: Obj = { text: text.slice(0, 2000) }
  if (isObj(v) && num(v.fontSize)) label.fontSize = v.fontSize
  return label
}

const STYLE_FIELDS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeStyle', 'strokeWidth', 'roughness', 'opacity'] as const
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])

/** One reply item reduced to the skeleton fields the editor takes. */
function cleanItem(raw: unknown, i: number): Skeleton {
  if (!isObj(raw)) throw new BadReply(`item ${i} is not an object`)
  const type = raw.type
  if (typeof type !== 'string' || !(SHAPES.has(type) || type === 'text' || type === 'arrow' || type === 'line')) {
    throw new BadReply(`item ${i} has type ${JSON.stringify(type)}; use rectangle, ellipse, diamond, text, arrow or line`)
  }
  const out: Skeleton = { type, id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : `item-${i}` }
  if (num(raw.x) !== undefined) out.x = raw.x
  if (num(raw.y) !== undefined) out.y = raw.y
  for (const f of STYLE_FIELDS) if (raw[f] !== undefined) out[f] = raw[f]
  if (SHAPES.has(type)) {
    if (num(raw.width) !== undefined) out.width = raw.width
    if (num(raw.height) !== undefined) out.height = raw.height
    const label = labelOf(raw.label, raw.text)
    if (label) out.label = label
  } else if (type === 'text') {
    if (typeof raw.text !== 'string' || !raw.text.trim()) throw new BadReply(`item ${i} is a text without text`)
    out.text = raw.text.slice(0, 2000)
    if (num(raw.fontSize) !== undefined) out.fontSize = raw.fontSize
    if (raw.textAlign !== undefined) out.textAlign = raw.textAlign
  } else {
    if (raw.points !== undefined) out.points = raw.points
    for (const side of ['start', 'end'] as const) {
      const ref = raw[side]
      const id = isObj(ref) ? ref.id : typeof ref === 'string' ? ref : undefined
      if (typeof id === 'string' && id) out[side] = { id: id.slice(0, 64) }
    }
    if (type === 'arrow') {
      const label = labelOf(raw.label, raw.text)
      if (label) out.label = label
      // Bound at both ends: the arrow runs between its shapes (the checks route it), wherever the model put it.
      if (out.start && out.end) { delete out.x; delete out.y; delete out.points }
    }
    if (raw.startArrowhead !== undefined) out.startArrowhead = raw.startArrowhead
    if (raw.endArrowhead !== undefined) out.endArrowhead = raw.endArrowhead
  }
  return out
}

/** The reply's JSON: the array, or `{elements, note}`; a markdown fence or a lead sentence is tolerated. */
function replyJson(text: string): { items: unknown; note?: string } {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const start = unfenced.search(/[[{]/)
  if (start < 0) throw new BadReply('the reply holds no JSON')
  const close = unfenced[start] === '[' ? ']' : '}'
  const end = unfenced.lastIndexOf(close)
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch (err) {
    throw new BadReply(`the reply is not valid JSON (${(err as Error).message})`)
  }
  if (Array.isArray(parsed)) return { items: parsed }
  if (isObj(parsed) && Array.isArray(parsed.elements)) {
    return { items: parsed.elements, ...(typeof parsed.note === 'string' && parsed.note.trim() ? { note: parsed.note.trim().slice(0, 500) } : {}) }
  }
  throw new BadReply('the reply is neither a JSON array nor {"elements": [...]}')
}

/**
 * The model's reply as skeletons the editor adds: checked with the append rules (a bad reference, a
 * wild coordinate or a missing field is a BadReply), arrows given the positions those rules compute
 * from the shapes they connect, and the whole moved so its top left is (0,0).
 */
export function parseDiagramReply(text: string): DiagramResult {
  const { items, note } = replyJson(text)
  if (!Array.isArray(items) || items.length === 0) throw new BadReply('the reply has no shapes')
  if (items.length > MAX_REPLY_ELEMENTS) throw new BadReply(`the reply has ${items.length} shapes; at most ${MAX_REPLY_ELEMENTS}`)
  const cleaned = items.map(cleanItem)
  const ids = new Set<string>()
  for (const item of cleaned) {
    while (ids.has(item.id as string)) item.id = `${item.id as string}-${ids.size}`
    ids.add(item.id as string)
  }
  for (const item of cleaned) {
    for (const side of ['start', 'end'] as const) {
      const ref = item[side] as Obj | undefined
      if (ref && !ids.has(ref.id as string)) throw new BadReply(`an arrow's ${side} names "${String(ref.id)}", which is not in the reply`)
    }
  }
  let normalized
  try {
    normalized = normalizeAppendElements(cleaned, [], {})
  } catch (err) {
    throw new BadReply((err as Error).message)
  }
  const byId = new Map(normalized.added.map((el) => [el.id, el]))
  // Lines and arrows take the position the checks computed (from their shapes when bound).
  for (const item of cleaned) {
    if (item.type !== 'arrow' && item.type !== 'line') continue
    const el = byId.get(normalized.idMap[item.id as string]!)
    if (!el) continue
    item.x = el.x
    item.y = el.y
    item.points = el.points
  }
  let minX = Infinity
  let minY = Infinity
  for (const item of cleaned) {
    const pts = Array.isArray(item.points) ? item.points as number[][] : [[0, 0]]
    for (const p of pts) {
      minX = Math.min(minX, (Number(item.x) || 0) + (Number(p[0]) || 0))
      minY = Math.min(minY, (Number(item.y) || 0) + (Number(p[1]) || 0))
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0 }
  for (const item of cleaned) {
    item.x = Math.round((Number(item.x) || 0) - minX)
    item.y = Math.round((Number(item.y) || 0) - minY)
  }
  return { elements: cleaned, ...(note ? { note } : {}) }
}

// ── The call ────────────────────────────────────────────────────────────────

/**
 * One diagram: the model answers within diagramTuning.deadlineMs (else 504), with a usable reply
 * (one retry, then 502). `signal` is the caller going away.
 */
export async function makeDiagram(input: DiagramInput, opts: { signal?: AbortSignal } = {}): Promise<DiagramResult> {
  const checked = checkDiagramInput(input)
  const deadlineMs = diagramTuning.deadlineMs
  const timeout = AbortSignal.timeout(deadlineMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const timedOut = () => new DrawingServiceError(`The model did not answer within ${Math.round(deadlineMs / 1000)} s`, 504)
  const png = checked.mode === 'tidy' ? await selectionPng(checked.elements, checked.files) : null
  const { sendMessage } = await import('../../model/model.js')
  const { replyText } = await import('../../model/reply-text.js')
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: userContent(checked, png) }]
  const usage = {
    source: 'drawing' as const,
    ...(typeof input.taskId === 'string' && input.taskId ? { taskId: input.taskId } : {}),
    ...(typeof input.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId } : {}),
  }
  let lastProblem = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal.aborted) throw timeout.aborted ? timedOut() : new DrawingServiceError('The diagram was cancelled', 503)
    let result
    try {
      result = await sendMessage({
        system: DIAGRAM_SYSTEM,
        messages: messages as Parameters<typeof sendMessage>[0]['messages'],
        config: { maxTokens: 8192 },
        signal,
        purpose: 'interactive',
        // The tidy selection's picture must reach the model on the claude-cli provider too.
        images: 'send',
        usage,
      })
    } catch (err) {
      if (timeout.aborted) throw timedOut()
      if (opts.signal?.aborted) throw new DrawingServiceError('The diagram was cancelled', 503)
      throw new DrawingServiceError(`The model call failed: ${(err as Error).message}`, 502)
    }
    if (result.aborted || timeout.aborted) {
      if (timeout.aborted) throw timedOut()
      throw new DrawingServiceError('The diagram was cancelled', 503)
    }
    const text = replyText(result)
    try {
      return parseDiagramReply(text)
    } catch (err) {
      if (!(err instanceof BadReply)) throw err
      lastProblem = err.message
      log.memory.warn('diagram: the model reply was not usable', { attempt, problem: lastProblem, head: text.slice(0, 120) })
      messages.push(
        { role: 'assistant', content: text || '(empty)' },
        { role: 'user', content: `That reply could not be used: ${lastProblem}. Reply again with ONLY the JSON array of shapes.` },
      )
    }
  }
  throw new DrawingServiceError(`The model did not return a usable diagram: ${lastProblem}`, 502)
}
