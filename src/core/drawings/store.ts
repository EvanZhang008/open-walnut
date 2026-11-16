/**
 * Drawing storage: `.excalidraw` scene files in the Notes vault, each with a Markdown companion.
 *
 * The scene file is the source of truth and the only thing a save must not lose:
 *  - every write of it runs under the note lock (`withUserFileLock`: in-process and across
 *    processes, the same lock the notes editor and agents take for a vault file);
 *  - inside the lock a write checks the caller's revision against the bytes on disk (CAS) and
 *    refuses a stale one with the current document (409), so nobody overwrites an edit they
 *    did not see;
 *  - the new bytes go to a hidden temp file in the same folder, are flushed, and replace the
 *    file by rename, so a reader or a crash sees the old scene or the new one, never half;
 *  - a create is exclusive (hard link of the temp file), so two creates never share a file.
 *
 * Each step is done once: a save parses (or, for the editor, checks) the scene once, encodes it
 * once and hashes it once, and for a scene over 1 MB those steps run in a worker thread
 * (scene-codec.ts). A document carries its scene's BYTES; the route sends them as they are, and
 * `doc.scene` parses them only if someone asks.
 *
 * The companion note (companion-sync.ts) is written AFTER the scene, from what the save just
 * wrote. A companion that cannot be written does not fail the save: the answer carries
 * `indexWarning`, and the next read of the drawing tries again. A read never creates one.
 *
 * Paths: callers send vault-relative paths; every one is checked (paths.ts) and then resolved
 * against the REAL vault path: a symlinked drawing or a folder that leads out of the vault is
 * refused. Task placement comes from the task the server looks up, never from the caller.
 */

import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { bus, EventNames } from '../event-bus.js'
import { followMovedDrawingCompanion, followMovedNote } from '../note-moves.js'
import { invalidateNotesTree } from '../notes-tree.js'
import { companionPathFor } from './companion.js'
import { companionKnownCurrent, companionPathForeign, companionPathTaken, resetCompanionCache, syncDrawingCompanion, type SceneFacts } from './companion-sync.js'
import { applySceneEdit, checkSceneEdit, type SceneEdit } from './edit.js'
import { locateTaskFolder, resetRevisionCache, resolveDrawingTask } from './list.js'
import {
  autoDrawingTitle, cleanScenePath, foldName, INBOX_FOLDER, sceneFileName, taskIdOfPath, titleOfScenePath, type TitleSource,
} from './paths.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import {
  DrawingInputError, emptyScene, MAX_SCENE_BYTES, parseSceneBytes, sceneRevision, serializeScene, type DrawingScene,
} from './scene.js'
import {
  createExclusively, ensureVaultDir, fileIdentity, readSceneFile, replaceAtomically, resolveVaultFile,
} from './vault-files.js'

export { renderDrawing, drawingRenderDir, type DrawingRender } from './render-file.js'
export { listDrawings, resolveDrawingTask, type DrawingListEntry } from './list.js'

export interface DrawingDoc {
  path: string
  title: string
  revision: string
  /** The scene, parsed from the document's bytes on first use (sceneBytesOf has the bytes). */
  readonly scene: DrawingScene
  taskId?: string
  /** Set when the scene was saved but its companion note could not be brought up to date. */
  indexWarning?: string
  /** After an edit that added elements: each temporary id the caller gave -> the new id. */
  idMap?: Record<string, string>
}

/** A stale revision: the drawing changed since the caller read it. */
export class DrawingConflictError extends DrawingInputError {
  constructor(public readonly current: DrawingDoc) {
    super('The drawing changed since it was read', 409)
    this.name = 'DrawingConflictError'
  }
}

const MAX_TITLE = 200
/** firstText only names the drawing (its first line); a longer one is not a first text. */
const MAX_FIRST_TEXT = 100_000
const MAX_NAME_TRIES = 200
/** How long, and for how many creates, a repeated create id answers with the file it made. */
const CREATE_ID_TTL_MS = 10 * 60_000
const CREATE_IDS_MAX = 500
const SCENE_BYTES = Symbol('sceneBytes')

function checkSize(bytes: string): void {
  if (Buffer.byteLength(bytes) > MAX_SCENE_BYTES) {
    throw new DrawingInputError(`The drawing would be larger than ${MAX_SCENE_BYTES} bytes`, 413)
  }
}

function docOf(rel: string, bytes: string, revision: string, extra: { idMap?: Record<string, string> } = {}): DrawingDoc {
  const taskId = taskIdOfPath(rel)
  let parsed: DrawingScene | undefined
  const doc = {
    path: rel,
    title: titleOfScenePath(rel),
    revision,
    ...(taskId ? { taskId } : {}),
    ...(extra.idMap ? { idMap: extra.idMap } : {}),
    get scene(): DrawingScene { return (parsed ??= parseSceneBytes(bytes)) },
  } as DrawingDoc
  Object.defineProperty(doc, SCENE_BYTES, { value: bytes, enumerable: false })
  return doc
}

/** The exact scene bytes of a document, as they are on disk: what the route sends. */
export function sceneBytesOf(doc: DrawingDoc): string {
  return (doc as unknown as Record<symbol, string | undefined>)[SCENE_BYTES] ?? serializeScene(doc.scene)
}

/**
 * Revisions known to be readable scenes (checked by a read, or written by a save here). A save
 * replaces only a file that is a scene; this spares the save a second parse of the file it
 * replaces when the editor's own read (or its last save) already proved it.
 */
const KNOWN_SCENES_MAX = 1000
const knownScenes = new Set<string>()
function rememberScene(revision: string): void {
  knownScenes.delete(revision)
  knownScenes.add(revision)
  if (knownScenes.size > KNOWN_SCENES_MAX) knownScenes.delete(knownScenes.values().next().value!)
}

async function withCompanion(doc: DrawingDoc, facts: SceneFacts, create: boolean): Promise<DrawingDoc> {
  const indexWarning = await syncDrawingCompanion(doc.path, facts, { create })
  if (indexWarning) doc.indexWarning = indexWarning
  return doc
}

// ── Operations ───────────────────────────────────────────────────────────────

/** A title a caller gave: absent or blank is null (Walnut picks one); anything else must fold to a name. */
function givenTitle(raw: unknown, field = 'title'): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new DrawingInputError(`${field} must be a string`)
  if (raw.length > MAX_TITLE) throw new DrawingInputError(`${field} may be at most ${MAX_TITLE} characters`)
  if (!raw.trim()) return null
  if (!foldName(raw)) throw new DrawingInputError(`${field} has no characters a file name can use`)
  return raw
}

/** The scene's appState with its title source (paths.ts TitleSource). */
function withTitleSource(scene: DrawingScene, source: TitleSource): DrawingScene {
  return { ...scene, appState: { ...scene.appState, walnutTitle: source } }
}

/**
 * A new, empty drawing. Named by `title` when given (`walnutTitle: 'set'`); otherwise Walnut picks
 * the name (`'auto'`): the first line of `firstText` (the first words the person wrote), else the
 * task's title, else the date and time. A taken name is numbered (" 2", " 3"). `clientId` (the
 * caller's own id for this create) makes a repeat of the same create answer the same file.
 */
export async function createDrawing(input: CreateInput, opts: { now?: Date } = {}): Promise<DrawingDoc> {
  const clientId = createIdOf(input.clientId)
  if (!clientId) return createNew(input, opts)
  const now = Date.now()
  // Oldest first (a Map keeps insertion order, and a repeat re-inserts): drop the expired.
  for (const [id, entry] of recentCreates) {
    if (now - entry.at <= CREATE_ID_TTL_MS) break
    recentCreates.delete(id)
  }
  const seen = recentCreates.get(clientId)
  const madePath = seen ? await seen.made : null
  if (madePath) {
    try {
      return await readDrawing(madePath) as DrawingDoc
    } catch (err) {
      // Its file is gone since: the caller still has no drawing, so it gets a new one.
      if (!(err instanceof DrawingInputError && err.status === 404)) throw err
    }
  }
  const made = createNew(input, opts)
  recentCreates.delete(clientId)
  recentCreates.set(clientId, { at: now, made: made.then((doc) => doc.path, () => null) })
  while (recentCreates.size > CREATE_IDS_MAX) recentCreates.delete(recentCreates.keys().next().value!)
  return made
}

type CreateInput = { title?: unknown; taskId?: unknown; sessionId?: unknown; firstText?: unknown; clientId?: unknown }

/**
 * Creates by the caller's create id: a create whose answer was lost on the way and is sent again
 * gets the file the first one made, never a second empty one. A repeat that arrives while the
 * first is still running waits for it.
 */
const recentCreates = new Map<string, { at: number; made: Promise<string | null> }>()

function createIdOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(raw)) throw new DrawingInputError('clientId must be 8 to 100 letters, digits, - or _')
  return raw
}

async function createNew(input: CreateInput, opts: { now?: Date }): Promise<DrawingDoc> {
  const title = givenTitle(input.title)
  if (input.firstText !== undefined && input.firstText !== null && typeof input.firstText !== 'string') throw new DrawingInputError('firstText must be a string')
  if (typeof input.firstText === 'string' && input.firstText.length > MAX_FIRST_TEXT) throw new DrawingInputError(`firstText may be at most ${MAX_FIRST_TEXT} characters`, 413)
  const task = await resolveDrawingTask(input)
  const name = title ?? autoDrawingTitle({ firstText: input.firstText as string | undefined, taskTitle: task?.title, now: opts.now })
  const folder = task ? await locateTaskFolder(task) : INBOX_FOLDER
  await ensureVaultDir(folder)
  const bytes = serializeScene(withTitleSource(emptyScene(), title ? 'set' : 'auto'))
  const revision = sceneRevision(bytes)
  rememberScene(revision)
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const rel = `${folder}/${sceneFileName(name, n)}`
    const abs = await resolveVaultFile(rel)
    // A companion path that is already someone else's note moves the name on too.
    if (await companionPathForeign(rel)) continue
    const created = await withUserFileLock(abs, () => createExclusively(abs, bytes))
    if (!created) continue
    invalidateNotesTree()
    bus.emit(EventNames.NOTES_TREE_CHANGED, { path: rel }, ['web-ui'])
    log.memory.info('drawing created', { path: rel, taskId: task?.id })
    return withCompanion(docOf(rel, bytes, revision), { revision, texts: [], identity: await fileIdentity(abs) }, true)
  }
  throw new DrawingInputError('Could not find a free name for the drawing', 409)
}

/**
 * Read a drawing. `notModified(revision)` true (the caller already holds this revision) answers
 * without the scene, so a poll costs a hash. A read repairs a companion that exists and is ours;
 * it never creates one.
 */
export async function readDrawing(
  rawPath: unknown,
  opts: { notModified?: (revision: string) => boolean } = {},
): Promise<DrawingDoc | { notModified: true; revision: string; indexWarning?: string }> {
  const rel = cleanScenePath(rawPath)
  const abs = await resolveVaultFile(rel)
  const { bytes, identity } = await readSceneFile(abs)
  const large = isLargeScene(bytes.length)
  if (opts.notModified) {
    const revision = await runCodec<string>('hash', bytes, large)
    if (opts.notModified(revision)) {
      if (await companionKnownCurrent(abs, companionPathFor(rel), revision)) return { notModified: true, revision }
      const { texts } = await runCodec<{ texts: string[] }>('inspect', bytes, large)
      const indexWarning = await syncDrawingCompanion(rel, { revision, texts, identity }, { create: false })
      return { notModified: true, revision, ...(indexWarning ? { indexWarning } : {}) }
    }
  }
  const { revision, texts } = await runCodec<{ revision: string; texts: string[] }>('inspect', bytes, large)
  rememberScene(revision)
  return withCompanion(docOf(rel, bytes, revision), { revision, texts, identity }, false)
}

interface Encoded { bytes: string; revision: string; texts: string[]; idMap?: Record<string, string> }

/**
 * Run `fn` under the scene's note lock when `revision` is still the one on disk (CAS): `fn` gets the
 * current bytes. A stale revision is a DrawingConflictError carrying the current document; a file
 * that is not a scene is never handed to `fn`.
 */
async function underRevision<T>(
  rel: string,
  abs: string,
  revision: unknown,
  fn: (bytes: string, large: boolean) => Promise<T>,
): Promise<T> {
  if (typeof revision !== 'string' || !revision) throw new DrawingInputError('revision is required: read the drawing first')
  return withUserFileLock(abs, async () => {
    // Re-checked under the lock: the file must still be a regular file inside the vault.
    await resolveVaultFile(rel)
    const { bytes } = await readSceneFile(abs)
    const large = isLargeScene(bytes.length)
    const current = await runCodec<string>('hash', bytes, large)
    if (!knownScenes.has(current)) {
      // Never replace a file that is not a scene (422), and never answer a conflict with one.
      try {
        await runCodec('inspect', bytes, large)
      } catch (err) {
        if (current !== revision) throw new DrawingInputError('The drawing changed since it was read, and is no longer a readable scene', 409)
        throw err
      }
      rememberScene(current)
    }
    if (current !== revision) throw new DrawingConflictError(docOf(rel, bytes, current))
    return fn(bytes, large)
  })
}

/** Save what `compute` makes of the current bytes, under the lock, if `revision` is still current. */
async function changeScene(
  rawPath: unknown,
  revision: unknown,
  compute: (bytes: string, large: boolean) => Promise<Encoded>,
): Promise<DrawingDoc> {
  const rel = cleanScenePath(rawPath)
  const abs = await resolveVaultFile(rel)
  const { doc, facts } = await underRevision(rel, abs, revision, async (bytes, large) => {
    const next = await compute(bytes, large)
    rememberScene(next.revision)
    checkSize(next.bytes)
    if (next.bytes !== bytes) {
      await replaceAtomically(abs, next.bytes)
      bus.emit(EventNames.DRAWING_UPDATED, { path: rel, revision: next.revision }, ['web-ui'])
    }
    return {
      doc: docOf(rel, next.bytes, next.revision, { idMap: next.idMap }),
      facts: { revision: next.revision, texts: next.texts, identity: await fileIdentity(abs) },
    }
  })
  return withCompanion(doc, facts, true)
}

/**
 * Put the drawing's new bytes at a free name for `title` in its own folder: in place when the name
 * is its own (or differs only in letter case), else at the first free numbered name, created
 * exclusively before the old file goes. Runs under the old file's lock. Returns the new path.
 */
async function placeRenamed(rel: string, abs: string, title: string, bytes: string): Promise<string> {
  const folder = rel.split('/').slice(0, -1).join('/')
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const candidate = `${folder ? `${folder}/` : ''}${sceneFileName(title, n)}`
    if (candidate === rel) {
      await replaceAtomically(abs, bytes)
      return rel
    }
    const candidateAbs = await resolveVaultFile(candidate)
    if (candidate.toLowerCase() === rel.toLowerCase()) {
      // Only the letter case changes: on a case-insensitive disk the candidate IS this file.
      const there = await fileIdentity(candidateAbs)
      const mine = await fileIdentity(abs)
      if ((!there || (mine && there.ino === mine.ino)) && !(await companionPathTaken(candidate, rel))) {
        await replaceAtomically(abs, bytes)
        await fsp.rename(abs, candidateAbs)
        return candidate
      }
      continue
    }
    // Anything at the candidate's companion path (even a leftover of ours) would leave the
    // companion behind, so that name counts as taken.
    if (await companionPathTaken(candidate)) continue
    if (!(await createExclusively(candidateAbs, bytes))) continue
    await fsp.unlink(abs)
    return candidate
  }
  throw new DrawingInputError('Could not find a free name for the drawing', 409)
}

/**
 * Rename a drawing (same folder): the scene moves to the first free name for `title` (" 2", " 3"),
 * its companion note follows (with the Notes index and bookmarks), and the title counts as chosen
 * (`walnutTitle: 'set'`). Only when `revision` is current; 400 for a title that cannot be a name.
 */
export async function renameDrawing(rawPath: unknown, revision: unknown, rawTitle: unknown): Promise<DrawingDoc> {
  const rel = cleanScenePath(rawPath)
  const title = givenTitle(rawTitle)
  if (!title) throw new DrawingInputError('title is required')
  const abs = await resolveVaultFile(rel)
  const moved = await underRevision(rel, abs, revision, async (bytes, large) => {
    const { scene } = await runCodec<{ scene: DrawingScene }>('decode', bytes, large)
    const next = await runCodec<Encoded>('encode', { scene: withTitleSource(scene, 'set'), validate: false }, large)
    checkSize(next.bytes)
    rememberScene(next.revision)
    const to = await placeRenamed(rel, abs, title, next.bytes)
    const toAbs = await resolveVaultFile(to)
    return { to, next, identity: await fileIdentity(toAbs) }
  })
  const { to, next, identity } = moved
  if (to !== rel) {
    invalidateNotesTree()
    // The companion note follows, with the index and bookmarks (the same steps as a Notes move).
    await followMovedDrawingCompanion(rel, to)
    await followMovedNote(rel, to, { indexed: false })
    bus.emit(EventNames.NOTES_TREE_CHANGED, { path: to }, ['web-ui'])
  }
  bus.emit(EventNames.DRAWING_UPDATED, { path: to, revision: next.revision, ...(to !== rel ? { from: rel } : {}) }, ['web-ui'])
  log.memory.info('drawing renamed', { from: rel, to })
  return withCompanion(docOf(to, next.bytes, next.revision), { revision: next.revision, texts: next.texts, identity }, true)
}

/** Replace the scene (the editor's save), only when `revision` is the one on disk. */
export async function writeDrawing(rawPath: unknown, revision: unknown, rawScene: unknown): Promise<DrawingDoc> {
  const encoded = await runCodec<Encoded>('encode', { scene: rawScene, validate: true }, false)
  checkSize(encoded.bytes) // refuse an oversize scene before taking the lock
  return changeScene(rawPath, revision, async () => encoded)
}

/**
 * The editor's save from the raw request body (`{path, revision, scene}` as JSON text): the scene
 * is parsed, checked and encoded once, in the worker when the body is large.
 */
export async function writeDrawingBody(body: string): Promise<DrawingDoc> {
  const prepared = await runCodec<{ path: unknown; revision: unknown; bytes: string; newRevision: string; texts: string[] }>('body', body, isLargeScene(body.length))
  checkSize(prepared.bytes)
  return changeScene(prepared.path, prepared.revision, async () => ({ bytes: prepared.bytes, revision: prepared.newRevision, texts: prepared.texts }))
}

/**
 * Change, remove and add elements in one step (an agent's edit, edit.ts), only when `revision` is
 * current. The edit's shape is checked first, so bad input is a 400 even when the revision is stale.
 */
export async function editDrawing(rawPath: unknown, revision: unknown, edit: SceneEdit): Promise<DrawingDoc> {
  checkSceneEdit(edit)
  return changeScene(rawPath, revision, async (bytes, large) => {
    const { scene } = await runCodec<{ scene: DrawingScene }>('decode', bytes, large)
    const { scene: next, idMap } = applySceneEdit(scene, edit)
    const encoded = await runCodec<Encoded>('encode', { scene: next, validate: false }, large)
    return { ...encoded, idMap }
  })
}

/** Add elements without removing or replacing any: `editDrawing` with only `add`. */
export async function appendToDrawing(rawPath: unknown, revision: unknown, elements: unknown): Promise<DrawingDoc> {
  if (!Array.isArray(elements) || elements.length === 0) throw new DrawingInputError('elements must be a non-empty array')
  return editDrawing(rawPath, revision, { add: elements })
}

export { moveDrawingCompanion, deleteDrawingCompanion } from './companion-sync.js'

/** For tests: forget the in-memory caches (a test that swaps the vault). */
export function resetDrawingCaches(): void {
  resetRevisionCache()
  knownScenes.clear()
  recentCreates.clear()
  resetCompanionCache()
}
