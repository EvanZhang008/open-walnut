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
import path from 'node:path'
import { NOTES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { bus, EventNames } from '../event-bus.js'
import { getNotesTree, invalidateNotesTree, type TreeNode } from '../notes-tree.js'
import { companionPathFor } from './companion.js'
import { companionKnownCurrent, companionPathForeign, resetCompanionCache, syncDrawingCompanion, type SceneFacts } from './companion-sync.js'
import { applySceneEdit, checkSceneEdit, type SceneEdit } from './edit.js'
import {
  cleanScenePath, INBOX_FOLDER, isTaskFolder, sceneFileName, taskFolderFor, taskIdOfFolder,
  titleOfScenePath, type TaskPlacement,
} from './paths.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import {
  DrawingInputError, emptyScene, MAX_SCENE_BYTES, parseSceneBytes, sceneRevision, SCENE_EXT, serializeScene, type DrawingScene,
} from './scene.js'
import {
  createExclusively, ensureVaultDir, fileIdentity, isInside, readSceneFile, replaceAtomically, resolveVaultFile, vaultReal,
} from './vault-files.js'

export { renderDrawing, drawingRenderDir, type DrawingRender } from './render-file.js'

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

export interface DrawingListEntry {
  path: string
  title: string
  revision: string
  updatedAt: string
  taskId?: string
}

/** A stale revision: the drawing changed since the caller read it. */
export class DrawingConflictError extends DrawingInputError {
  constructor(public readonly current: DrawingDoc) {
    super('The drawing changed since it was read', 409)
    this.name = 'DrawingConflictError'
  }
}

/** Scene files a list reads at once: a vault of thousands of drawings is read in bounded batches, never all at once. */
const LIST_CONCURRENCY = 4
const MAX_TITLE = 200
const MAX_NAME_TRIES = 200
const SCENE_BYTES = Symbol('sceneBytes')

function checkSize(bytes: string): void {
  if (Buffer.byteLength(bytes) > MAX_SCENE_BYTES) {
    throw new DrawingInputError(`The drawing would be larger than ${MAX_SCENE_BYTES} bytes`, 413)
  }
}

function taskIdOfPath(rel: string): string | undefined {
  const parts = rel.split('/').slice(0, -1)
  for (let i = parts.length - 1; i >= 0; i--) {
    const id = taskIdOfFolder(parts[i]!)
    if (id) return id
  }
  return undefined
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

// ── Task context ────────────────────────────────────────────────────────────

/**
 * The task a request names, by `taskId` or through `sessionId`. Null when it names neither.
 * A task or session that does not exist is a 404: a drawing meant for a task never lands in
 * Inbox by accident.
 */
export async function resolveDrawingTask(input: { taskId?: unknown; sessionId?: unknown }): Promise<TaskPlacement | null> {
  const { taskId, sessionId } = input
  if (taskId !== undefined && taskId !== null && taskId !== '' && typeof taskId !== 'string') throw new DrawingInputError('taskId must be a string')
  if (sessionId !== undefined && sessionId !== null && sessionId !== '' && typeof sessionId !== 'string') throw new DrawingInputError('sessionId must be a string')
  let id = typeof taskId === 'string' && taskId ? taskId : undefined
  if (!id && typeof sessionId === 'string' && sessionId) {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const session = await getSessionByClaudeId(sessionId)
    if (!session) throw new DrawingInputError(`Session not found: ${sessionId}`, 404)
    if (!session.taskId) throw new DrawingInputError(`Session ${sessionId} belongs to no task`, 404)
    id = session.taskId
  }
  if (!id) return null
  const { getTask } = await import('../task-manager.js')
  const { missingIsNull } = await import('../../lib/id-ref.js')
  const task = await getTask(id).catch(missingIsNull)
  if (!task) throw new DrawingInputError(`Task not found: ${id}`, 404)
  return { id: task.id, title: task.title, project: task.project || '' }
}

function walkFiles(nodes: TreeNode[], visit: (node: TreeNode) => void): void {
  for (const node of nodes) {
    if (node.type === 'folder') walkFiles(node.children ?? [], visit)
    else visit(node)
  }
}

/** Every folder named for this task (`<title> (<id>)`), vault-relative. */
function taskFolders(nodes: TreeNode[], taskId: string, out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (isTaskFolder(node.name, taskId)) out.push(node.path)
    else taskFolders(node.children ?? [], taskId, out)
  }
  return out
}

/** The folder a task's drawings are in: the one already named for its id, else its new one. */
async function locateTaskFolder(task: TaskPlacement): Promise<string> {
  const expected = taskFolderFor(task)
  const { tree } = await getNotesTree()
  const found = taskFolders(tree, task.id)
  if (found.includes(expected)) return expected
  return found.sort()[0] ?? expected
}

// ── Revision cache (a list must not re-read every scene on every poll) ────────

const revisionCache = new Map<string, { mtimeMs: number; size: number; revision: string }>()

async function cachedRevision(abs: string): Promise<{ revision: string; mtimeMs: number } | null> {
  let stat
  try {
    stat = await fsp.lstat(abs)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_SCENE_BYTES) return null
  const hit = revisionCache.get(abs)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { revision: hit.revision, mtimeMs: stat.mtimeMs }
  const bytes = await fsp.readFile(abs, 'utf-8')
  const revision = await runCodec<string>('hash', bytes, isLargeScene(bytes.length))
  revisionCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, revision })
  return { revision, mtimeMs: stat.mtimeMs }
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

export async function listDrawings(input: { taskId?: unknown; sessionId?: unknown }): Promise<DrawingListEntry[]> {
  const task = await resolveDrawingTask(input)
  const { tree } = await getNotesTree()
  const roots = task ? taskFolders(tree, task.id).map((p) => `${p}/`) : null
  const candidates: string[] = []
  walkFiles(tree, (node) => {
    if (!node.path.toLowerCase().endsWith(SCENE_EXT)) return
    if (roots && !roots.some((r) => node.path.startsWith(r))) return
    candidates.push(node.path)
  })
  const root = await vaultReal()
  const entries = await mapBounded(candidates, LIST_CONCURRENCY, async (rel): Promise<DrawingListEntry | null> => {
    const abs = path.join(NOTES_DIR, ...rel.split('/'))
    try {
      const realDir = await fsp.realpath(path.dirname(abs))
      if (realDir !== root && !isInside(realDir, root)) return null
    } catch {
      return null
    }
    const rev = await cachedRevision(abs)
    if (!rev) return null
    const taskId = taskIdOfPath(rel)
    return { path: rel, title: titleOfScenePath(rel), revision: rev.revision, updatedAt: new Date(rev.mtimeMs).toISOString(), ...(taskId ? { taskId } : {}) }
  })
  // Every drawing, newest first: none is hidden behind a cap.
  return entries
    .filter((e): e is DrawingListEntry => e !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
}

/** `fn` over `items` with at most `limit` running at once, results in input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function createDrawing(input: { title?: unknown; taskId?: unknown; sessionId?: unknown }): Promise<DrawingDoc> {
  if (input.title !== undefined && input.title !== null && typeof input.title !== 'string') throw new DrawingInputError('title must be a string')
  if (typeof input.title === 'string' && input.title.length > MAX_TITLE) throw new DrawingInputError(`title may be at most ${MAX_TITLE} characters`)
  const task = await resolveDrawingTask(input)
  const folder = task ? await locateTaskFolder(task) : INBOX_FOLDER
  await ensureVaultDir(folder)
  const bytes = serializeScene(emptyScene())
  const revision = sceneRevision(bytes)
  rememberScene(revision)
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const rel = `${folder}/${sceneFileName(input.title as string | undefined, n)}`
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

/** Save what `compute` makes of the current bytes, under the lock, if `revision` is still current. */
async function changeScene(
  rawPath: unknown,
  revision: unknown,
  compute: (bytes: string, large: boolean) => Promise<Encoded>,
): Promise<DrawingDoc> {
  const rel = cleanScenePath(rawPath)
  if (typeof revision !== 'string' || !revision) throw new DrawingInputError('revision is required: read the drawing first')
  const abs = await resolveVaultFile(rel)
  const { doc, facts } = await withUserFileLock(abs, async () => {
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
  revisionCache.clear()
  knownScenes.clear()
  resetCompanionCache()
}
