/**
 * Where a host replica's away reads and writes take their rows: ONE source per server, named
 * here, so a read and the write it is followed by never see two different tasks.
 *
 *   copy   the copy stores the leader's rounds keep on this host (task store, Board store):
 *          what every host replica with a copy answers from, its routes and its write port alike.
 *   slice  a service that keeps no copy (slice-source.ts): the slice the leader pushed for this
 *          host's sessions, installed beneath the same stores (core/unstored-rows.ts), so it is
 *          read by the same code; a task outside it answers `no_copy`.
 *
 * The source gives rows as they are kept; the overlay (overlay.ts) folds this host's pending
 * journal records over them for every reader (away-wiring.ts shownTask, away-reads.ts).
 *
 * `missing` is the source's answer for a write on a task it does not hold: the copy holds every
 * task of the Walnut, so such a task does not exist (`not_found`); the slice holds only this
 * host's, so such a task needs the leader (`no_copy`).
 */
import { refusalAnswer, type PortAnswer, type TaskRow } from './write-port.js'

/** A Board document as a source keeps it (the store's shape: the page and its parts, no overlay). */
export interface BoardDoc {
  html: string
  version: number
  updated_at?: string
  updated_by?: string
  updated_session_id?: string
  html_sources?: import('../providers/offline-board-core.js').OfflineHtmlSource[]
  threads?: Record<string, unknown>
  marks?: Record<string, unknown>
  projects?: Record<string, unknown>
  choices?: Record<string, unknown>
}

export interface RowSource {
  readonly kind: 'copy' | 'slice'
  /** Read the source again when its rows are older than `maxAgeMs` (the copy is always current). */
  refresh?(maxAgeMs?: number): Promise<void>
  /** A task as the source keeps it (exact id), or null. */
  task(id: string): Promise<TaskRow | null>
  /** The Board document kept for `taskId`, or null when it has none. */
  board(taskId: string): Promise<BoardDoc | null>
  /** A write's answer for a task this source does not hold. */
  missing(id: string): PortAnswer
  /** Stops reading it (the server stops). */
  stop?(): void
}

async function copyTask(id: string): Promise<TaskRow | null> {
  try {
    const { getTask } = await import('../core/task-manager.js')
    const t = await getTask(id)
    return t && t.id === id ? (t as unknown as TaskRow) : null
  } catch {
    return null
  }
}

async function copyBoard(taskId: string): Promise<BoardDoc | null> {
  try {
    const { getBoard } = await import('../core/boards/board-store.js')
    return (await getBoard(taskId)) as unknown as BoardDoc | null
  } catch {
    return null
  }
}

/** The copy stores of a host replica with a copy. */
export function copyRowSource(): RowSource {
  return {
    kind: 'copy',
    task: copyTask,
    board: copyBoard,
    missing: (id) => refusalAnswer('not_found', `Task ${id} not found`),
  }
}
