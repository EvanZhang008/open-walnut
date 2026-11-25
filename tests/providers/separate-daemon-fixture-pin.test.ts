/**
 * A browser fixture server that replaces the local daemon program (it overrides findDaemonBinary)
 * and talks to that program over its own port file (daemon.port) tests the separate daemon, so it
 * must say so with WALNUT_IN_PROCESS_DAEMON. Since in_process_daemon is on by default, a server
 * without the pin runs its daemon in process and has no program to swap: on 2026-11-25 the nightly
 * daemon-swap-upload spec waited 30 s for "the old daemon" to drain and failed 3 of 3.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../e2e/browser')

describe('browser fixtures that swap the daemon program pin its mode', () => {
  it('every fixture overriding findDaemonBinary and reading daemon.port sets WALNUT_IN_PROCESS_DAEMON', () => {
    const members: string[] = []
    const missing: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      if (!/findDaemonBinary\s*=/.test(text) || !text.includes("'daemon.port'")) continue
      members.push(f)
      if (!/WALNUT_IN_PROCESS_DAEMON\s*:/.test(text)) missing.push(f)
    }
    expect(members, 'the scan found the known member').toContain('daemon-swap-upload-server.ts')
    expect(missing, 'set WALNUT_IN_PROCESS_DAEMON in the fixture env: 0 to test the separate program').toEqual([])
  })
})
