/**
 * Rows a server shows as stored that its own stores do not hold: on a host's Walnut service that
 * keeps no copy of the leader's data (WALNUT_COPIES=none), the slice the leader pushed for this
 * host's sessions (the sessions, their tasks and their teams' Boards), read through the runtime
 * (replica/slice-source.ts installs it). The task store (task-manager.ts loadStore), the Board
 * store (boards/board-store.ts), the session registry (session-tracker.ts) and the request
 * readers (session-requests.ts) read them beneath
 * their own rows, so every reader of a task, a Board or a session (every route, the caller rule,
 * open_items, the write port's bases) answers from the rows a copy would give for them. A stored
 * row of the same id wins.
 *
 * Nothing installs it on the leader, the companion or a host replica with a copy: there every
 * function here answers "none" at the cost of one null check.
 */
import type { SessionRecord, Task } from './types.js'
import type { BoardFile } from './boards/board-store.js'
import type { SessionRequest } from './session-requests.js'
import { matchIdRef } from '../lib/id-ref.js'

export interface UnstoredRows {
  /** The tasks to show, as the slice has them now. */
  tasks(): readonly Task[]
  /** The Board kept for `taskId` (its own, not its team's), or null. */
  board(taskId: string): BoardFile | null
  /** Whose Board `taskId`'s team shares, as the leader worked it out (host-slice.ts boardOf), or null. */
  boardOwner(taskId: string): string | null
  /** This host's sessions of the Walnut, as the slice names them. */
  sessions(): readonly SessionRecord[]
  /** The pending requests one of those sessions asks or is asked. */
  requests(): readonly SessionRequest[]
}

let installed: UnstoredRows | null = null
/** Moves whenever the rows may have changed (an install, a new slice): the task store's cache key. */
let gen = 0

export function installUnstoredRows(rows: UnstoredRows | null): void {
  installed = rows
  gen += 1
}

/** The rows changed (a new slice came): the task store rebuilds its view on its next read. */
export function unstoredRowsChanged(): void {
  gen += 1
}

export function hasUnstoredRows(): boolean {
  return installed !== null
}

export function unstoredGeneration(): number {
  return gen
}

/** The tasks to show beneath the stored ones (`stored`: ids the store holds, which win). */
export function unstoredTasks(stored: ReadonlySet<string>): Task[] {
  if (!installed) return []
  let rows: readonly Task[] = []
  try { rows = installed.tasks() } catch { return [] }
  const out: Task[] = []
  for (const t of rows) if (t && typeof t.id === 'string' && !stored.has(t.id)) out.push(t)
  return out
}

/** Whether the rows hold a task with this id, or one whose id starts with it (a task_get of a prefix). */
export function holdsUnstoredTask(id: string): boolean {
  if (!installed || !id) return false
  try { return matchIdRef(installed.tasks().filter((t) => typeof t?.id === 'string'), id).length > 0 } catch { return false }
}

/** What the rows hold, by id: what a copyless away read may answer (replica/copyless-reads.ts). */
export const sliceHolds = {
  task: holdsUnstoredTask,
  session(id: string): boolean {
    if (!installed || !id) return false
    try { return installed.sessions().some((s) => s?.claudeSessionId === id) } catch { return false }
  },
  request(id: string): boolean {
    if (!installed || !id) return false
    try { return installed.requests().some((r) => r?.id === id) } catch { return false }
  },
}

/** The Board to show for `taskId` when the store has none. */
export function unstoredBoard(taskId: string): BoardFile | null {
  if (!installed) return null
  try { return installed.board(taskId) } catch { return null }
}

/** The team Board owner the leader named for `taskId` (board-team.ts resolveTeamBoardTask), or null. */
export function unstoredBoardOwner(taskId: string): string | null {
  if (!installed) return null
  try { return installed.boardOwner(taskId) } catch { return null }
}

/** The sessions to show beneath the registry's own rows. */
export function unstoredSessions(): readonly SessionRecord[] {
  if (!installed) return []
  try { return installed.sessions() } catch { return [] }
}

/** The requests to show beneath the stored ones (`stored`: ids the store holds, which win). */
export function unstoredRequests(stored: ReadonlySet<string>): SessionRequest[] {
  if (!installed) return []
  let rows: readonly SessionRequest[] = []
  try { rows = installed.requests() } catch { return [] }
  return rows.filter((r) => !stored.has(r.id))
}
