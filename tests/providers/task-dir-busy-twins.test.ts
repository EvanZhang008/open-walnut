/**
 * The daemon judges a task directory busy from ALL the work running on the
 * host, never from its sessions alone. 2026-11-08: a cleanup pass took a
 * running simulator check's Walnut.app; the check ran through host_exec, which
 * the daemon's busy test never counted, and the paths were compared as
 * strings (/home vs /local/home, /var vs /private/var).
 *
 * The guard reads the source: a new kind of host work missing from
 * `hostWorkNow`, or a task-dir command that builds its own `busy` again,
 * fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../src/providers', f), 'utf8')
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`function ${name}(`)
  expect(start, `${name} missing`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}
const src = read('daemon-standalone.ts')

describe('task directory busy check in the daemon', () => {
  it('counts sessions, host commands and ACP workers', () => {
    const body = fnBody(src, 'hostWorkNow')
    for (const kind of ['sessions.values()', 'spawnInfo', 'hostExec', '.active()', 'taskId', 'acp', 'workers.values()', 'w.taskDir']) expect(body).toContain(kind)
  })

  it('reads the open files for a low-disk prune of directories in use', () => {
    const body = fnBody(src, 'cmdTaskDirPrune')
    expect(body).toMatch(/cmd\.live === true/)
    // The daemon passes its runtime's child-process use as the second argument.
    expect(body).toMatch(/readOpenPaths\(TASK_DIR_ROOT, childUse\)/)
    expect(body).toMatch(/openPaths/)
  })

  it('task-dir commands use taskDirBusy, never their own string test', () => {
    for (const cmd of ['cmdTaskDirRemove', 'cmdTaskDirPrune']) {
      const body = fnBody(src, cmd)
      expect(body).toMatch(/busy = taskDirBusy/)
      expect(body).not.toMatch(/startsWith\(dir/)
    }
  })
})
