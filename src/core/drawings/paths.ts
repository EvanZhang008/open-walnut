/**
 * Where drawings live in the Notes vault, and the checks every vault path a caller sends passes.
 *
 * Placement (vault-relative, the vault root is notesRoot()):
 *   no task                      inbox/<title>.excalidraw
 *   a task in a project          Projects/<project folder>/<task title> (<task id>)/<title>.excalidraw
 *   a task in Inbox              inbox/<task title> (<task id>)/<title>.excalidraw
 *
 * The project folder is the project's own (`projectNotesFolderFor`, where its Tracking.md lives),
 * taken from the task the server looked up, never from the caller. The task folder is found by
 * its id, not its title: a task renamed or moved to another project keeps the folder its drawings
 * are in (the store looks the `(<id>)` folder up first), so a list never loses them.
 *
 * Pure: the fs checks (symlinks, the real path) are in store.ts.
 */

import { isInboxProject } from '../inbox-project.js'
import { projectNotesFolderFor } from '../tracking-note.js'
import { DrawingInputError, SCENE_EXT } from './scene.js'

export const INBOX_FOLDER = 'inbox'
const MAX_SEGMENT = 80
/** The longest title Walnut picks by itself (from the first text, or the task's title). */
export const AUTO_TITLE_MAX = 60
const MAX_PATH = 1024

/**
 * Fold a title into one file or folder name: Unicode kept (CJK, accents, emoji), path and
 * shell-hostile characters (`/ \ : * ? " < > |`, controls) become `-`, whitespace collapses,
 * leading dots go (no hidden files) and so do trailing dots and spaces. Cut by code point, so an
 * emoji is never split. Null when nothing usable is left.
 */
export function foldName(raw: string, max = MAX_SEGMENT): string | null {
  const folded = Array.from(
    raw
      .normalize('NFC')
      // Arrows people type in a diagram's first line ("Order -> review") read as arrows in the name.
      .replace(/<->/g, '\u2194')
      .replace(/->|=>/g, '\u2192')
      .replace(/<-/g, '\u2190')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/\.{2,}/g, '.')
      .trim()
      .replace(/^[.\s]+/, ''),
  )
    .slice(0, max)
    .join('')
    .replace(/[.\s]+$/, '')
  return folded || null
}

/** A task id as it appears in a folder name. */
export function folderSafeId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, '-')
}

const TASK_FOLDER_RE = / \(([A-Za-z0-9_-]+)\)$/

/** The task id a folder name carries (`<title> (<id>)`), or null. */
export function taskIdOfFolder(name: string): string | null {
  return TASK_FOLDER_RE.exec(name)?.[1] ?? null
}

/** The task a vault path is filed under: the nearest folder named for a task, or undefined. */
export function taskIdOfPath(rel: string): string | undefined {
  const parts = rel.split('/').slice(0, -1)
  for (let i = parts.length - 1; i >= 0; i--) {
    const id = taskIdOfFolder(parts[i]!)
    if (id) return id
  }
  return undefined
}

/** Whether `name` is the folder of the task with this id. */
export function isTaskFolder(name: string, taskId: string): boolean {
  return taskIdOfFolder(name) === folderSafeId(taskId)
}

export interface TaskPlacement {
  id: string
  title: string
  project?: string
}

/** The folder a task's drawings go in when it has none yet. */
export function taskFolderFor(task: TaskPlacement): string {
  const root = isInboxProject(task.project) ? INBOX_FOLDER : projectNotesFolderFor(task.project!)
  if (!root) throw new DrawingInputError(`The project name "${task.project}" cannot be a folder in Notes`, 422)
  const name = `${foldName(task.title, 60) ?? 'Task'} (${folderSafeId(task.id)})`
  return `${root}/${name}`
}

/**
 * How a drawing got its title, kept in `scene.appState.walnutTitle`: `set` by a person or an
 * agent (never renamed by itself), `auto` when Walnut picked it (the editor renames it once to
 * the scene's first text).
 */
export type TitleSource = 'set' | 'auto'

/** The first non-empty line of a text, folded into a name of at most AUTO_TITLE_MAX characters. */
export function firstLineName(text: string): string | null {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const name = foldName(line.replace(/\t/g, ' '), AUTO_TITLE_MAX)
    if (name) return name
  }
  return null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "Drawing YYYY-MM-DD HH.mm" in local time: the last fallback, never "Untitled drawing". */
export function datedDrawingTitle(now: Date): string {
  return `Drawing ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`
}

/**
 * The title Walnut picks for a new drawing nobody named: the first line of its first text, else
 * the task's title, else the date and time.
 */
export function autoDrawingTitle(input: { firstText?: string; taskTitle?: string; now?: Date }): string {
  return (input.firstText ? firstLineName(input.firstText) : null)
    ?? (input.taskTitle ? foldName(input.taskTitle, AUTO_TITLE_MAX) : null)
    ?? datedDrawingTitle(input.now ?? new Date())
}

/** The scene file name for a title (already checked to fold to a name); `n > 1` numbers it. */
export function sceneFileName(title: string, n = 1): string {
  const base = foldName(title)
  if (!base) throw new DrawingInputError('title has no characters a file name can use')
  return `${n > 1 ? `${base} ${n}` : base}${SCENE_EXT}`
}

/** A drawing's title: its file name without the extension. */
export function titleOfScenePath(scenePath: string): string {
  const name = scenePath.split('/').pop() ?? scenePath
  return name.replace(/\.excalidraw$/i, '')
}

/**
 * Check a vault-relative scene path a caller sent. Refused: anything not a string, absolute or
 * drive paths, empty, `.` or `..` segments, hidden segments, NUL, and anything not ending in
 * `.excalidraw`. Returns the clean forward-slash path.
 */
export function cleanScenePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new DrawingInputError('path is required')
  if (raw.length > MAX_PATH) throw new DrawingInputError('path is too long')
  if (raw.includes('\0')) throw new DrawingInputError('invalid path')
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) throw new DrawingInputError('path must be relative to Notes')
  const segments = unified.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') throw new DrawingInputError('invalid path')
    if (seg.startsWith('.')) throw new DrawingInputError('invalid path: hidden folders and files are not drawings')
  }
  const clean = segments.join('/')
  if (!clean.toLowerCase().endsWith(SCENE_EXT) || clean.length === SCENE_EXT.length) {
    throw new DrawingInputError(`path must name a ${SCENE_EXT} file`)
  }
  return clean
}
