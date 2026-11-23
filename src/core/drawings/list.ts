/**
 * Finding drawings: the task a request names, the folder a task's drawings are in, and the list of
 * drawings (store.ts holds the reads and writes of one scene).
 *
 * A list must not re-read every scene on every poll: each file's revision is cached by its mtime
 * and size, and a vault of thousands of drawings is read in bounded batches, never all at once.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { getNotesTree, type TreeNode } from '../notes-tree.js'
import { isTaskFolder, taskFolderFor, taskIdOfPath, titleOfScenePath, type TaskPlacement } from './paths.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import { DrawingInputError, MAX_SCENE_BYTES, SCENE_EXT } from './scene.js'
import { isInside, noteAbs, realNotesRoot } from '../notes/note-paths.js'
import { mapLimit } from '../../utils/map-limit.js'

export interface DrawingListEntry {
  path: string
  title: string
  revision: string
  updatedAt: string
  taskId?: string
}

/** Scene files a list reads at once. */
const LIST_CONCURRENCY = 4

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
export async function locateTaskFolder(task: TaskPlacement): Promise<string> {
  const expected = taskFolderFor(task)
  const { tree } = await getNotesTree()
  const found = taskFolders(tree, task.id)
  if (found.includes(expected)) return expected
  return found.sort()[0] ?? expected
}

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

/** For tests: forget the cached revisions. */
export function resetRevisionCache(): void {
  revisionCache.clear()
}

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
  const root = await realNotesRoot()
  const entries = await mapLimit(candidates, LIST_CONCURRENCY, async (rel): Promise<DrawingListEntry | null> => {
    const abs = noteAbs(rel)
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
