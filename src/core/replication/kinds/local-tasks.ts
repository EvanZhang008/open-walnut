/**
 * The `local-tasks` copy kind: the ids of the tasks Walnut keeps local (host-private.ts) and of
 * their sessions, on each host replica, in `cache/replica/local-tasks.json` (file-copy.ts). Ids
 * only: no title, no text. A host holds none of those tasks' rows, so without this list a call
 * about one would read as "not found"; with it, the host's own answer while the Mac is away says
 * the task is kept on the Mac (replica/kept-local-calls.ts, why `task_kept_local`).
 *
 * Hosts only (the companion holds the tasks themselves: gate.ts COMPANION_COPY_KINDS leaves it
 * out, so an older or a newer companion is never sent it). No choice of its own: it goes with the
 * tasks, which no switch turns off. An older host answers `404 unknown_kind`, which rests the kind
 * there; it holds none of those rows either, since the filter is the Mac's. One row per task,
 * unordered, no digest, and no half rule: a task leaving the list loses nothing.
 */

import fsp from 'node:fs/promises'
import { matchIdRef } from '../../../lib/id-ref.js'
import { sha12 } from '../kind.js'
import { hostPrivacyNow, taskFree } from '../host-private.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'
import { copyStateFile, keepsCopies } from './gate.js'

export const LOCAL_TASKS_SCHEMA_VERSION = 1
/** No half rule: a task leaving the list is a task the host may now hold, never a loss. */
export const LOCAL_TASKS_REMOVAL_FLOOR = Number.MAX_SAFE_INTEGER
const MAX_SESSIONS = 500

export interface LocalTaskRow { id: string; sessions: string[] }

async function leaderRows(): Promise<LocalTaskRow[]> {
  const p = await hostPrivacyNow()
  if (p.tasks.size === 0) return []
  const byTask = new Map<string, Array<{ sid: string; at: string }>>([...p.tasks].sort().map((id) => [id, []]))
  const sessions = await (await import('../../session-tracker.js')).sessionRowsForReplica()
  for (const s of sessions) {
    if (!p.sessions.has(s.claudeSessionId)) continue
    // A session a newer one detached is kept through its old task: listed under it.
    const list = byTask.get(s.taskId) ?? (s.legacyTaskId ? byTask.get(s.legacyTaskId) : undefined)
    list?.push({ sid: s.claudeSessionId, at: s.lastActiveAt || s.startedAt || '' })
  }
  // The newest sessions when a task has more than the row holds; ids sorted, so the row's hash holds.
  return [...byTask].map(([id, list]) => ({
    id,
    sessions: [...new Map(list.map((x) => [x.sid, x])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_SESSIONS).map((x) => x.sid).sort(),
  }))
}

export const LOCAL_TASKS_KIND: CopyKind<LocalTaskRow> = {
  kind: 'local-tasks',
  schemaVersion: LOCAL_TASKS_SCHEMA_VERSION,
  key: (r) => r.id,
  // The follower's own hash of a put row (kind-follower.ts): the same, so a held row is never sent again.
  hash: (r) => sha12(JSON.stringify(r)),
  ordered: false,
  digest: false,
  owners: taskFree('the ids of the tasks kept off this host and of their sessions: ids only, the list that says so'),
  rows: leaderRows,
  watch: (soon) => {
    const name = `local-tasks-copy-${Math.random().toString(36).slice(2, 10)}`
    let stopped = false
    let stopSessions: (() => void) | null = null
    void import('../../event-bus.js').then(({ bus }) => {
      if (stopped) return
      bus.subscribe(name, (event) => { if (event.name.startsWith('task:')) soon() }, { global: true, interest: ['task:'] })
    })
    void import('../../session-tracker.js').then(({ onSessionStoreWrite }) => {
      if (!stopped) stopSessions = onSessionStoreWrite(soon)
    })
    return () => {
      stopped = true
      stopSessions?.()
      void import('../../event-bus.js').then(({ bus }) => bus.unsubscribe(name)).catch(() => {})
    }
  },
}

// --- Follower ---

function isRow(v: unknown): v is LocalTaskRow {
  const r = v as Record<string, unknown> | null
  return !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 2 && typeof r.id === 'string' && r.id.length > 0
    && Array.isArray(r.sessions) && r.sessions.length <= MAX_SESSIONS && r.sessions.every((s) => typeof s === 'string' && s.length > 0)
}

const copy = createFileCopy<LocalTaskRow>({
  kind: 'local-tasks',
  schemaVersion: LOCAL_TASKS_SCHEMA_VERSION,
  label: 'local tasks list copy',
  removalFloor: LOCAL_TASKS_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.id,
})

export const localTasksFollower = copy.follower

/** What this host's copy says the Mac keeps to itself. */
export interface LocalTasksHere { tasks: ReadonlySet<string>; sessions: ReadonlySet<string> }

const EMPTY: LocalTasksHere = { tasks: new Set(), sessions: new Set() }
let here: { sig: string; value: LocalTasksHere } | null = null

/** Read the copy again when its file changed (a stat), else keep what was read. Never throws. */
export async function refreshLocalTasksHere(): Promise<LocalTasksHere> {
  if (!keepsCopies('local-tasks')) return EMPTY
  let sig = ''
  try {
    const st = await fsp.stat(copyStateFile('local-tasks'))
    sig = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    here = { sig: '', value: EMPTY }
    return EMPTY
  }
  if (here && here.sig === sig) return here.value
  const rows = await copy.read().catch(() => null)
  const tasks = new Set<string>()
  const sessions = new Set<string>()
  for (const r of Object.values(rows ?? {})) {
    tasks.add(r.id)
    for (const s of r.sessions) sessions.add(s)
  }
  here = { sig, value: { tasks, sessions } }
  return here.value
}

/** The shortest string read as an id prefix (a session may pass a task's short id). */
const ID_PREFIX_MIN = 6

/**
 * Whether `ref` names a task this host's copy says the Mac keeps local, or one of its sessions:
 * the id, a prefix of 6 or more (lib/id-ref.ts), or a path segment (`/tasks/<id>`).
 */
export function namesKeptLocal(ref: string, here: LocalTasksHere): boolean {
  if (here.tasks.size === 0) return false
  const one = (v: string): boolean => {
    if (here.tasks.has(v) || here.sessions.has(v)) return true
    if (v.length < ID_PREFIX_MIN || /\s/.test(v)) return false
    return matchIdRef(here.tasks, v, String).length > 0 || matchIdRef(here.sessions, v, String).length > 0
  }
  const v = ref.trim()
  if (one(v)) return true
  return !/\s/.test(v) && v.includes('/') && v.split(/[/?#]/).some((seg) => seg !== v && seg.length > 0 && one(seg))
}

/** The last read of the copy (refreshLocalTasksHere), empty before the first. */
export function localTasksHere(): LocalTasksHere {
  return here?.value ?? EMPTY
}

/** Tests only. */
export function _resetLocalTasksCopyForTesting(): void {
  copy.reset()
  here = null
}
