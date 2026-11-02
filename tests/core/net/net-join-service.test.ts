/**
 * Step 2 of the invite script on a new machine installs the login service, and the
 * service needs a daemon to run: the compiled Walnut file is one. Without it the install
 * threw "No standalone daemon binary supplied" on every new machine (2026-11-02), and
 * every test missed it because each joined with a daemon already running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFailure, keepRunning, serviceInstall, type KeepRunningIo } from '../../../src/commands/net.js'

const FILE = '/Users/a/.local/share/open-walnut/versions/0.7.0/walnut'
let out = ''

function io(over: Partial<KeepRunningIo> = {}): KeepRunningIo & { installs: unknown[] } {
  const installs: unknown[] = []
  return {
    installs,
    daemonUp: async () => null,
    waitDaemon: async () => true,
    compiled: async () => true,
    execPath: FILE,
    install: async (o) => { installs.push(o); return 0 },
    ...over,
  }
}

beforeEach(() => {
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true }) as typeof process.stdout.write)
})
afterEach(() => vi.restoreAllMocks())

describe('step 2 on a joining machine', () => {
  it('a new machine: installs the service with the compiled Walnut file as its daemon', async () => {
    const x = io()
    expect(await keepRunning(x)).toBe(true)
    expect(x.installs).toEqual([{ yes: true, executable: FILE }])
    expect(out).toBe('  2/3  Keep it running ... on (starts when you log in)\n')
  })

  it('a daemon a server started: handed over to the service the same way', async () => {
    const x = io({ daemonUp: async () => 'running' })
    expect(await keepRunning(x)).toBe(true)
    expect(x.installs).toEqual([{ yes: true, executable: FILE }])
  })

  it('the service already runs: nothing installed', async () => {
    const x = io({ daemonUp: async () => 'service' })
    expect(await keepRunning(x)).toBe(true)
    expect(x.installs).toEqual([])
    expect(out).toBe('  2/3  Keep it running ... on (already running)\n')
  })

  it('a Walnut under Node: says how to get the file, on screen, and installs nothing', async () => {
    const x = io({ compiled: async () => false })
    expect(await keepRunning(x)).toBe(false)
    expect(x.installs).toEqual([])
    expect(out).toContain('  2/3  Keep it running ... needs the installed Walnut file (this Walnut runs under Node).')
    expect(out).toContain('install.sh | sh, then run this again.')
  })

  it('an install that fails or a daemon that never answers: says what to run', async () => {
    for (const x of [io({ install: async () => 1 }), io({ waitDaemon: async () => false })]) {
      out = ''
      expect(await keepRunning(x)).toBe(false)
      // By the file's path: a new shell has no ~/.local/bin on PATH, and another walnut may be there.
      expect(out).toBe(`  2/3  Keep it running ... did not start. Run \`${FILE} daemon status\` to see why, then this again.\n`)
    }
  })

  // 2026-11-02: the existing-Mac join stopped here twice and the log named no reason: the
  // install's own report was swallowed. Its reason now leads the line.
  it('an install that fails says why, from its own report', async () => {
    const x = io({ install: async () => ({ code: 1, why: 'another daemon holds this machine\'s daemon dir' }) })
    expect(await keepRunning(x)).toBe(false)
    expect(out).toBe(`  2/3  Keep it running ... did not start: another daemon holds this machine's daemon dir. Run \`${FILE} daemon status\` to see why, then this again.\n`)
    expect(installFailure(JSON.stringify({ ok: false, failure: { code: 'x', message: 'this account cannot start\n the daemon' } }, null, 2))).toBe('this account cannot start the daemon')
    expect(installFailure('{"ok":true}')).toBeUndefined()
    expect(installFailure('not json')).toBeUndefined()
  })

  // 2026-11-02: a Mac whose Walnut had run 26 days. The temp cleanup had removed its daemon's
  // pid and port files while it ran: its files come back from its lock, and it is handed over.
  it('a daemon that lost its files to the temp cleanup: found again, and handed over like any', async () => {
    let files = false
    const x = io({ daemonUp: async () => (files ? 'running' : null), recoverLostDaemon: async () => { files = true; return 54307 } })
    expect(await keepRunning(x)).toBe(true)
    expect(x.installs).toEqual([{ yes: true, executable: FILE }])
    // A daemon that answers is never looked for; nor is one in a test's dir.
    const asked: string[] = []
    expect(await keepRunning(io({ daemonUp: async () => 'running', recoverLostDaemon: async () => { asked.push('x'); return 1 } }))).toBe(true)
    expect(await keepRunning(io({ testDaemonDir: '/t', recoverLostDaemon: async () => { asked.push('x'); return 1 } }))).toBe(false)
    expect(asked).toEqual([])
  })

  it('serviceInstall: the compiled file, or the way to get it', () => {
    expect(serviceInstall(true, FILE)).toEqual({ yes: true, executable: FILE })
    expect('error' in serviceInstall(false, '/usr/local/bin/node')).toBe(true)
  })
})
