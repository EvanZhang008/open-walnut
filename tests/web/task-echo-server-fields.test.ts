/**
 * The task store swallows the WS echo of the page's own optimistic write (useTasks
 * consumeEcho), but an echo also carries what only the server writes. 2026-10-31: a park
 * from the task menu guarded its echo for 5 s; the turn on that task ended inside the
 * window, the server derived user_status Waiting, and that update was swallowed as the
 * echo, so the Home panel kept the task under Working until a reload.
 *
 * Checked from the source: every consumeEcho of a task event hands the task to
 * takeServerOwned, and takeServerOwned takes user_status (and the replica's mark).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.resolve(__dirname, '../../web/src/hooks/useTasks.ts'), 'utf8')

describe('a swallowed task echo still takes the server-owned fields', () => {
  it('every consumeEcho of a task event calls takeServerOwned', () => {
    const sites = SRC.split('\n').filter((l) => /consumeEcho\(`[a-z]+:\$\{task\.id\}`\)/.test(l))
    // create, move, update, phase, complete: the scan still reads the source.
    expect(sites.length).toBeGreaterThanOrEqual(5)
    const bare = sites.filter((l) => !l.includes('takeServerOwned(task)'))
    expect(bare, 'a new swallowed task echo: hand it to takeServerOwned').toEqual([])
  })

  it('takeServerOwned takes the derived user status and the replica mark', () => {
    const at = SRC.indexOf('const takeServerOwned')
    expect(at).toBeGreaterThan(0)
    const body = SRC.slice(at, SRC.indexOf('}, []);', at))
    expect(body).toContain('user_status')
    expect(body).toContain('replica_sync')
  })
})
