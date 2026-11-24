/**
 * The readers that run on every change read the stores' own rows and copy only what they keep.
 *
 * A host slice is rebuilt on every task and session change, for every connected host: it reads the
 * stores' own rows and copies only what it ships. 2026-11-24: buildHostSlice copied all ~7.5k
 * session rows (listSessions) and, with a lead in the slice, all ~8k tasks (listTasks) per build;
 * it made 830 whole-table copies in the ten minutes after a restart, most of the server's garbage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src/core/host-slice.ts')
/** Hot functions outside host-slice.ts, by file: the status pass's read runs on every task change
 *  (2026-11-24: about 480 copies of the whole board in ten minutes after a restart). */
const HOT_FUNCTIONS: Record<string, string[]> = {
  'src/core/user-status-sync.ts': ['readPass'],
  // Every threads read of a node (routes, the Board's thread states, the status pass).
  'src/core/org/threads-store.ts': ['withTaskAsks'],
}
const bodyOf = (src: string, fn: string): string => {
  const start = src.search(new RegExp(`(async )?function ${fn}(<[^(]*>)?\\(`))
  if (start < 0) return ''
  const next = src.slice(start + 1).search(/\n(export )?(async )?function /)
  return src.slice(start, next < 0 ? undefined : start + 1 + next)
}
const strip = (src: string) => src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
/** Every reader that hands out a copy of a whole store. */
const WHOLE_STORE_COPIES = ['listSessions', 'listTasks', 'listTasksSlim']

describe('the host slice reads the stores without copying them', () => {
  it('calls no whole-store copy', () => {
    const src = fs.readFileSync(SRC, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const used = WHOLE_STORE_COPIES.filter((name) => new RegExp(`\\b${name}\\(`).test(src))
    expect(used, 'read sessionRowsForReplica / taskStoreForReplica (read only) instead').toEqual([])
  })

  it('the status pass and the threads read read the board without copying it', () => {
    for (const [rel, fns] of Object.entries(HOT_FUNCTIONS)) {
      const src = strip(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8'))
      for (const fn of fns) {
        const body = bodyOf(src, fn)
        expect(body, `${rel} ${fn} not found`).not.toBe('')
        const used = WHOLE_STORE_COPIES.filter((name) => new RegExp(`\\b${name}\\(`).test(body))
        expect(used, `${rel} ${fn}: read taskStoreForReplica (read only) and copy only what it writes`).toEqual([])
      }
    }
  })

  it('reads its tasks and boards from the kept rows, never parsed again per build', () => {
    // 2026-11-24: per build, SQLite reads parsed every child row (childTasks, listTasksByIds) and
    // every team board file (getBoard): about a tenth of the CPU in a memory burst after a restart.
    const src = strip(fs.readFileSync(SRC, 'utf8'))
    const used = ['listTasksByIds', 'getBoard', 'getDb', 'rowToTask'].filter((name) => new RegExp(`\\b${name}\\b`).test(src))
    expect(used, 'read taskStoreSnapshot with tasksByIdOf / tasksByParentOf, and getBoardView').toEqual([])
  })

  it('the readers it uses instead exist', () => {
    const tracker = fs.readFileSync(path.resolve(__dirname, '../../src/core/session-tracker.ts'), 'utf8')
    const tasks = fs.readFileSync(path.resolve(__dirname, '../../src/core/task-manager.ts'), 'utf8')
    expect(tracker).toMatch(/export async function sessionRowsForReplica\(/)
    expect(tasks).toMatch(/export async function taskStoreForReplica\(/)
    expect(tasks).toMatch(/export async function taskStoreSnapshot\(/)
  })
})
