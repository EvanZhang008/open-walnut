/**
 * A host slice is rebuilt on every task and session change, for every connected host: it reads the
 * stores' own rows and copies only what it ships. 2026-11-24: buildHostSlice copied all ~7.5k
 * session rows (listSessions) and, with a lead in the slice, all ~8k tasks (listTasks) per build;
 * it made 830 whole-table copies in the ten minutes after a restart, most of the server's garbage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src/core/host-slice.ts')
/** Every reader that hands out a copy of a whole store. */
const WHOLE_STORE_COPIES = ['listSessions', 'listTasks', 'listTasksSlim']

describe('the host slice reads the stores without copying them', () => {
  it('calls no whole-store copy', () => {
    const src = fs.readFileSync(SRC, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const used = WHOLE_STORE_COPIES.filter((name) => new RegExp(`\\b${name}\\(`).test(src))
    expect(used, 'read sessionRowsForReplica / taskStoreForReplica (read only) instead').toEqual([])
  })

  it('the readers it uses instead exist', () => {
    const tracker = fs.readFileSync(path.resolve(__dirname, '../../src/core/session-tracker.ts'), 'utf8')
    const tasks = fs.readFileSync(path.resolve(__dirname, '../../src/core/task-manager.ts'), 'utf8')
    expect(tracker).toMatch(/export async function sessionRowsForReplica\(/)
    expect(tasks).toMatch(/export async function taskStoreForReplica\(/)
  })
})
