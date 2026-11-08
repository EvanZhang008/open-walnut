/**
 * Both daemon twins judge a task directory busy from ALL the work running on
 * the host, never from their sessions alone. 2026-11-08: a cleanup pass took a
 * running simulator check's Walnut.app; the check ran through host_exec, which
 * the daemon's busy test never counted, and the paths were compared as
 * strings (/home vs /local/home, /var vs /private/var).
 *
 * The guard reads the sources: a new kind of host work added to one twin's
 * `hostWorkNow` and not the other's, or a task-dir command that builds its own
 * `busy` again, fails here.
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
const twins = { standalone: read('daemon-standalone.ts'), source: read('daemon-source.ts') }

describe('task directory busy check in both daemon twins', () => {
  it.each(Object.entries(twins))('%s counts sessions, host commands and ACP workers', (_name, src) => {
    const body = fnBody(src, 'hostWorkNow')
    for (const kind of ['sessions.values()', 'spawnInfo', 'hostExec', '.active()', 'taskId', 'acp', 'workers.values()', 'w.taskDir']) expect(body).toContain(kind)
  })

  it.each(Object.entries(twins))('%s task-dir commands use taskDirBusy, never their own string test', (_name, src) => {
    for (const cmd of ['cmdTaskDirRemove', 'cmdTaskDirPrune']) {
      const body = fnBody(src, cmd)
      expect(body).toMatch(/busy = taskDirBusy/)
      expect(body).not.toMatch(/startsWith\(dir/)
    }
  })
})
