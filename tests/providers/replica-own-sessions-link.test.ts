/**
 * The own-sessions link (daemon-connection.ts assertLocalDialAllowed, ownSessionsOnly): the one
 * '__local__' connection a host replica holds, its session runner's, to the runtime in its own
 * process while the host's one Walnut service runs and judges its own sessions (land 3b). It runs
 * sessions and does nothing a leader's link does: its hello names no Walnut (no `binds`, so the
 * runtime binds no gateway call to it), and no command that describes a Walnut to the host or
 * pushes a leader's state into it (LEADER_ONLY_COMMANDS) leaves it, whichever path asks.
 *
 * The class guard at the end: every such push in src/ (a `.send('<x>.configure' | sync | put |
 * drop | remove | claim | slice` call) is in LEADER_ONLY_COMMANDS or named a setting of the link's
 * own sessions with why, so a new one is refused on the link from the day it is written.
 *
 * MACHINE SAFETY: no socket, no process: the runtime is a fake in-process client.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InProcessConnect } from '../../src/providers/in-process-daemon-socket.js'

const sent: Array<Record<string, unknown>> = []
let fakeConnect: InProcessConnect | null = null

vi.mock('../../src/providers/in-process-daemon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/in-process-daemon.js')>()),
  inProcessDaemonConnect: () => fakeConnect,
}))

const { _resetServerRoleForTesting, _resetServiceRuntimeForTesting, holdServiceRuntime } = await import('../../src/core/server-role.js')
const { DaemonConnection, LEADER_ONLY_COMMANDS, setOwnSessionsLink } = await import('../../src/providers/daemon-connection.js')
const { IN_PROCESS_DAEMON_URL } = await import('../../src/providers/in-process-daemon-socket.js')
const { ADVERTISED_DAEMON_CAPABILITIES } = await import('../../src/providers/daemon-capabilities.js')

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
let saved: Record<string, string | undefined> = {}

/** A runtime that answers every command ok, its hello with every capability a daemon advertises. */
function fakeRuntime(): InProcessConnect {
  return (onFrame) => ({
    send: (frame) => {
      sent.push(frame)
      const reply = frame.cmd === 'hello'
        ? { id: frame.id, ok: true, capabilities: [...ADVERTISED_DAEMON_CAPABILITIES], version: 'test', instanceId: 'runtime-test', dir: '/nonexistent/service-runtime' }
        : { id: frame.id, ok: true }
      queueMicrotask(() => onFrame(reply))
    },
    close: () => {},
  })
}

describe('a host replica\'s own-sessions link', () => {
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
    _resetServerRoleForTesting()
    holdServiceRuntime({ dir: '/nonexistent/service-runtime', home: '/nonexistent/home', env: {} })
    setOwnSessionsLink(true)
    sent.length = 0
    fakeConnect = fakeRuntime()
  })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    _resetServerRoleForTesting()
    _resetServiceRuntimeForTesting()
    setOwnSessionsLink(false)
    fakeConnect = null
  })

  it('opens to the runtime in this process, and its hello names no Walnut', async () => {
    const conn = new DaemonConnection('__local__', null)
    try {
      await conn.connectDirect(IN_PROCESS_DAEMON_URL)
      expect(conn.connected).toBe(true)
      const hello = sent.find((f) => f.cmd === 'hello')
      expect(hello).toBeTruthy()
      // A binding hello would hold the runtime's gateway calls for a Walnut this link never names.
      expect(hello!.binds).toBeUndefined()
      expect(hello!.readOps).toBeUndefined()
      // A session command goes, as on any link.
      await expect(conn.send('status', { sid: 'own-session' })).resolves.toMatchObject({ ok: true })
    } finally { conn.disconnect() }
  })

  it('sends no leader command, whichever path asks for one', async () => {
    const conn = new DaemonConnection('__local__', null)
    try {
      await conn.connectDirect(IN_PROCESS_DAEMON_URL)
      for (const cmd of LEADER_ONLY_COMMANDS) {
        await expect(conn.send(cmd, { home: '/nonexistent/replica-home' }), cmd).rejects.toThrow(/own-sessions link sends no leader command/)
      }
      expect(sent.filter((f) => LEADER_ONLY_COMMANDS.has(String(f.cmd)))).toEqual([])
    } finally { conn.disconnect() }
  })

  it('a leader\'s own local link is not one: it sends them as before', async () => {
    for (const k of KEYS) delete process.env[k]
    _resetServerRoleForTesting()
    _resetServiceRuntimeForTesting()
    const conn = new DaemonConnection('__local__', null)
    try {
      await conn.connectDirect(IN_PROCESS_DAEMON_URL)
      await expect(conn.send('hooks.configure', { home: '/nonexistent/leader-home', config: {} })).resolves.toMatchObject({ ok: true })
      expect(sent.some((f) => f.cmd === 'hooks.configure')).toBe(true)
      expect(sent.find((f) => f.cmd === 'hello')!.binds).toBe(true)
    } finally { conn.disconnect() }
  })
})

/** Pushes that are the settings of the sessions a link starts (keyed by the home it starts them with), with why. */
const SESSION_SETTINGS: Record<string, string> = {
  'workspace.configure': 'sent right before a workspace command of a session this link starts (workspaces/daemon-client.ts push)',
  'turns.configure': 'the turn snapshot settings the sessions this link starts are kept under (turn-snapshots/settings-push.ts)',
}

describe('class guard: every leader push in src/ is a LEADER_ONLY_COMMANDS member', () => {
  it('finds each `.send(\'<x>.configure|sync|put|drop|remove|claim|slice\'` and its name in the set', () => {
    const root = path.resolve(__dirname, '../../src')
    const found = new Map<string, string>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/\.send\('([a-z][a-zA-Z]*\.(?:configure|sync|put|drop|remove|claim|slice)[a-zA-Z]*)'/g)) found.set(m[1]!, path.relative(root, p))
        }
      }
    }
    walk(root)
    // The scan sees the pushes it is meant for (it would pass empty otherwise).
    expect(found.has('leader.configure') && found.has('host.slice') && found.has('triggers.configure')).toBe(true)
    const missing = [...found].filter(([cmd]) => !LEADER_ONLY_COMMANDS.has(cmd) && !(cmd in SESSION_SETTINGS)).map(([cmd, file]) => `${cmd} (src/${file})`)
    expect(missing, 'a leader push the own-sessions link would send: add it to LEADER_ONLY_COMMANDS in daemon-connection.ts').toEqual([])
  })
})
