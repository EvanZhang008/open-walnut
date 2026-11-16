/**
 * The Drawing scene file: a standard `.excalidraw` JSON document in the Notes vault.
 *
 * Pure on purpose (no fs, no Walnut imports): the file shape, its revision and its text are
 * graded by tests/core/drawings/companion-paths.test.ts and reused by the store, the routes and
 * the companion note. The server never imports the drawing library itself (it is a browser
 * bundle); field names and defaults here were read from the installed library's own
 * `serializeAsJSON` and `restore` (data/json.ts, data/restore.ts).
 *
 * What a scene file holds:
 *   { type: 'excalidraw', version: 2, source, elements: [...], appState: {...}, files: {...} }
 * Unknown top-level keys and unknown element fields are kept as written: the library's own
 * restore keeps unknown element fields for forward compatibility, and so do we.
 */

import { createHash } from 'node:crypto'
import { emptySceneValue } from './scene-text.js'

// Shared with the browser's editor (scene-text.ts has no Node import).
export { SCENE_SOURCE, SCENE_TYPE, SCENE_VERSION, sceneText } from './scene-text.js'
export const SCENE_EXT = '.excalidraw'

/**
 * The largest scene file Walnut writes (serialized bytes). A scene with pasted pictures
 * carries them as data URLs in `files`, so it is far larger than a note (MAX_NOTE_SIZE is
 * 2 MB); the global JSON body cap is 15 MB, and a request also carries its envelope.
 */
export const MAX_SCENE_BYTES = 10 * 1024 * 1024

/** The most elements one append may add. An agent's diagram is tens of shapes, not thousands. */
export const MAX_APPEND_ELEMENTS = 500

export type SceneElement = Record<string, unknown> & { id: string; type: string }

export interface DrawingScene {
  type: 'excalidraw'
  version: number
  source: string
  elements: SceneElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
  [extra: string]: unknown
}

/** A new scene: the appState keys the library keeps in an exported file, at their defaults. */
export function emptyScene(): DrawingScene {
  return emptySceneValue()
}

/** A refusal of what a caller sent, with the HTTP status the route answers. */
export class DrawingInputError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 413 | 422 = 400) {
    super(message)
    this.name = 'DrawingInputError'
  }
}

/** Every element type the library stores (element/types.ts ExcalidrawElement, minus `selection`). */
export const ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'rectangle', 'diamond', 'ellipse', 'text', 'line', 'arrow', 'freedraw', 'image', 'frame', 'magicframe', 'iframe', 'embeddable',
])

/**
 * Check a scene and return it in the file's shape. Required: `type: "excalidraw"`, a supported
 * `version` (a file from a newer format is refused, never rewritten), and elements that each
 * carry a unique string id, a known type and a finite position. Every other field is the
 * library's to restore, so an editor save is never refused for a field this server does not
 * know; unknown fields are kept. A scene from the editor may omit `version` (it is 2).
 *
 * SELF-CONTAINED on purpose (no reference outside its own body but builtins): the scene worker
 * (scene-codec.ts) runs this same function from its source text, so a large scene is checked off
 * the event loop by the one implementation. It throws a plain Error carrying `status`.
 */
export function validateSceneShape(raw: unknown, requireVersion: boolean): DrawingScene {
  const types = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'line', 'arrow', 'freedraw', 'image', 'frame', 'magicframe', 'iframe', 'embeddable'])
  const refuse = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }) }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(raw)) return refuse('scene must be an object')
  if (raw.type !== 'excalidraw') refuse('scene.type must be "excalidraw"')
  if (raw.version === undefined && requireVersion) refuse('scene.version is missing')
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) refuse('scene.version must be a positive integer')
    if ((raw.version as number) > 2) refuse(`scene version ${String(raw.version)} is newer than this Walnut reads (2); update Walnut to open it`)
  }
  if (!Array.isArray(raw.elements)) refuse('scene.elements must be an array')
  if (raw.appState !== undefined && raw.appState !== null && !isObj(raw.appState)) refuse('scene.appState must be an object')
  if (raw.files !== undefined && raw.files !== null && !isObj(raw.files)) refuse('scene.files must be an object')
  const ids = new Set<string>()
  const elements = raw.elements as unknown[]
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (!isObj(el)) return refuse(`scene.elements[${i}] must be an object`)
    if (typeof el.id !== 'string' || !el.id) refuse(`scene.elements[${i}].id must be a non-empty string`)
    // Two elements with one id: the library would give one a new id on open, so a save drops a tie.
    if (ids.has(el.id as string)) refuse(`scene.elements[${i}].id "${String(el.id)}" is used twice`)
    ids.add(el.id as string)
    if (typeof el.type !== 'string' || !types.has(el.type)) refuse(`scene.elements[${i}].type "${String(el.type)}" is not a drawing element`)
    if (typeof el.x !== 'number' || !Number.isFinite(el.x)) refuse(`scene.elements[${i}].x must be a finite number`)
    if (typeof el.y !== 'number' || !Number.isFinite(el.y)) refuse(`scene.elements[${i}].y must be a finite number`)
  }
  return {
    ...raw,
    type: 'excalidraw',
    version: (raw.version as number | undefined) ?? 2,
    source: 'walnut',
    elements: raw.elements as SceneElement[],
    appState: (raw.appState as Record<string, unknown> | undefined) ?? {},
    files: (raw.files as Record<string, unknown> | undefined) ?? {},
  }
}

function asInputError(err: unknown, prefix = ''): DrawingInputError {
  const status = (err as { status?: number }).status
  return new DrawingInputError(`${prefix}${(err as Error).message}`, status === 422 ? 422 : 400)
}

/** validateSceneShape, refusing with DrawingInputError (400). */
export function validateSceneInput(raw: unknown, opts: { requireVersion?: boolean } = {}): DrawingScene {
  try {
    return validateSceneShape(raw, opts.requireVersion === true)
  } catch (err) {
    throw asInputError(err)
  }
}

/** The bytes of a scene file, indented like the library's own export. */
export function serializeScene(scene: DrawingScene): string {
  return `${JSON.stringify(scene, null, 2)}\n`
}

/**
 * Read a scene file's bytes. A file that is not a scene answers 422 and is never rewritten:
 * the bytes on disk are someone's drawing (or someone's other file) and stay as they are.
 */
export function parseSceneBytes(bytes: string): DrawingScene {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    throw new DrawingInputError('This file is not a readable drawing (invalid JSON)', 422)
  }
  try {
    return validateSceneShape(parsed, true)
  } catch (err) {
    throw new DrawingInputError(`This file is not a readable drawing: ${(err as Error).message}`, 422)
  }
}

/** The revision of a scene file: the sha256 of its exact bytes, so any change by anyone is a new revision. Opaque to clients. */
export function sceneRevision(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
