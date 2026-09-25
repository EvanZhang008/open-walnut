/**
 * This machine's Claude Code (src/core/hosts/local-readiness.ts): the setup
 * banner's three states, the one-click fixes, and the re-check. The machine
 * itself is a seam (a scripted preflight and host.fix), so nothing is installed
 * and no real claude runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-local-readiness'))

import {
  createLocalClaudeIo, getLocalClaude, localClaudeConfigChanged, refreshLocalClaude, setLocalClaudeIo, startLocalClaudeFix, wireLocalClaude,
  type LocalClaudeIo, type LocalMachineParts,
} from '../../src/core/hosts/local-readiness.js'
import { defaultDaemonExtraPaths, type HostPreflightResult } from '../../src/providers/host-runtime-core.js'
import type { PreflightConnection } from '../../src/core/hosts/host-readiness.js'

const OPUS_55 = { minVersion: '2.1.280', model: 'Opus 5.5' }
const BIN = '/Users/dev/.local/bin/claude'
const READY: HostPreflightResult = {
  claude: { found: true, path: BIN, kind: 'native', needsNode: false, version: '2.1.280', auth: 'ok', versionOk: true, minVersion: '2.1.280', installMethod: 'native' },
  compiler: { found: false }, dtach: { found: false }, platform: 'darwin', arch: 'arm64',
}

/** A machine whose answer is `state`, with fixes that change it. */
function machine(initial: HostPreflightResult, fixes: Partial<Record<string, (s: { p: HostPreflightResult }) => Record<string, unknown>>> = {}) {
  const box = { p: structuredClone(initial) }
  let t = 1_000
  const asked: Array<string | undefined> = []
  const fixed: Array<[string, Record<string, unknown>]> = []
  const io: Partial<LocalClaudeIo> = {
    onDaemonConnected: () => () => {},
    now: () => t,
    floor: async () => OPUS_55,
    preflight: async (min) => { asked.push(min); return { result: structuredClone(box.p), source: 'daemon' } },
    fix: async (action, params) => {
      fixed.push([action, params])
      const run = fixes[action]
      return { result: run ? run(box) as never : { action, ok: false, error: 'installer-failed', manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash', log: 'boom', durationMs: 1 } }
    },
  }
  setLocalClaudeIo(io)
  return { box, asked, fixed, tick: (ms: number) => { t += ms } }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => setLocalClaudeIo())

describe('local Claude Code readiness', () => {
  it('a ready machine has no problems, and the floor of the configured model is what the probe was asked for', async () => {
    const m = machine(READY)
    const s = await refreshLocalClaude()
    expect(m.asked).toEqual(['2.1.280'])
    expect(s).toMatchObject({ checkedAt: 1_000, source: 'daemon', problems: [], claude: { auth: 'ok', version: '2.1.280' } })
  })

  it('the three banner states, worded for this computer, and no terminal lines', async () => {
    machine({ ...READY, claude: { found: false } })
    expect((await refreshLocalClaude())!.problems).toEqual([
      { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] },
    ])
    machine({ ...READY, claude: { ...READY.claude, auth: 'not-logged-in' } })
    expect((await refreshLocalClaude())!.problems).toEqual([
      { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'] },
    ])
    machine({ ...READY, claude: { ...READY.claude, version: '2.1.258', versionOk: false } })
    expect((await refreshLocalClaude())!.problems).toEqual([
      { kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.', commands: ['claude update'] },
    ])
  })

  it('the banner\'s one-click update: running, then re-checked, then gone; every step reaches the listener', async () => {
    const m = machine({ ...READY, claude: { ...READY.claude, version: '2.1.258', versionOk: false } }, {
      'update-claude': (b) => { b.p = structuredClone(READY); return { action: 'update-claude', ok: true, claude: { path: BIN, kind: 'native', version: '2.1.280' } } },
    })
    const seen: Array<string[]> = []
    const off = wireLocalClaude({ onChange: (s) => seen.push((s?.problems ?? []).map((p) => `${p.kind}${p.fix ? ':' + p.fix.state : ''}`)) })
    await refreshLocalClaude()
    const started = startLocalClaudeFix('claude_outdated')
    expect(started).toMatchObject({ ok: true, status: { fixing: { action: 'update-claude', text: 'Updating Claude Code' } } })
    expect(started.ok && started.status.problems[0]!.fix).toMatchObject({ state: 'running' })
    // A second click while it runs starts nothing.
    expect(startLocalClaudeFix('claude_outdated')).toEqual({ ok: false, error: 'busy' })
    await vi.waitFor(() => expect(getLocalClaude()!.problems).toEqual([]))
    off()
    expect(m.fixed).toEqual([['update-claude', { minClaudeVersion: '2.1.280' }]])
    expect(getLocalClaude()!.lastFix).toMatchObject({ action: 'update-claude', ok: true, text: 'Updated Claude Code to 2.1.280' })
    expect(getLocalClaude()!.fixing).toBeUndefined()
    expect(seen[0]).toEqual(['claude_outdated'])
    expect(seen).toContainEqual(['claude_outdated:running'])
    expect(seen[seen.length - 1]).toEqual([])
  })

  it('a failed install keeps the line with its reason and the exact command, and can be tried again', async () => {
    const m = machine({ ...READY, claude: { found: false } })
    await refreshLocalClaude()
    expect(startLocalClaudeFix('claude_missing').ok).toBe(true)
    await vi.waitFor(() => expect(getLocalClaude()!.problems[0]!.fix?.state).toBe('failed'))
    expect(getLocalClaude()!.problems[0]).toMatchObject({
      kind: 'claude_missing', commands: ['curl -fsSL https://claude.ai/install.sh | bash'],
      fix: { action: 'install-claude-native', state: 'failed', text: 'Could not install Claude Code automatically (the installer failed)' },
    })
    expect(startLocalClaudeFix('claude_missing').ok).toBe(true)
    await settle()
    expect(m.fixed.map(([a]) => a)).toEqual(['install-claude-native', 'install-claude-native'])
  })

  it('refuses what it cannot or must not do: sign-in, an unmanaged install, an unknown problem, nothing checked yet', async () => {
    expect(startLocalClaudeFix('claude_missing')).toEqual({ ok: false, error: 'not-checked' })
    machine({ ...READY, claude: { ...READY.claude, auth: 'not-logged-in' } })
    await refreshLocalClaude()
    expect(startLocalClaudeFix('claude_not_logged_in')).toEqual({ ok: false, error: 'no-fix' })
    expect(startLocalClaudeFix('claude_outdated')).toEqual({ ok: false, error: 'no-such-problem' })
    machine({ ...READY, claude: { ...READY.claude, version: '2.1.258', versionOk: false, installMethod: 'homebrew' } })
    await refreshLocalClaude()
    expect(startLocalClaudeFix('claude_outdated')).toEqual({ ok: false, error: 'no-fix' })
  })

  it('the 15s poll shares a fresh answer; a click always asks; two callers share one probe', async () => {
    const m = machine({ ...READY, claude: { ...READY.claude, auth: 'not-logged-in' } })
    await refreshLocalClaude()
    m.tick(5_000)
    await refreshLocalClaude({ maxAgeMs: 10_000 })
    expect(m.asked).toHaveLength(1)
    await refreshLocalClaude()
    expect(m.asked).toHaveLength(2)
    await Promise.all([refreshLocalClaude(), refreshLocalClaude()])
    expect(m.asked).toHaveLength(3)
    // The user signed in: the next check has no line left.
    m.box.p = structuredClone(READY)
    m.tick(15_000)
    expect((await refreshLocalClaude({ maxAgeMs: 10_000 }))!.problems).toEqual([])
  })
})

describe('failed re-check and floor changes', () => {
  it('keeps the previous good answer and stamps checkError', async () => {
    let fail = false
    let t = 1_000
    setLocalClaudeIo({
      now: () => t, floor: async () => OPUS_55,
      preflight: async () => (fail ? { result: null, source: 'daemon', error: 'unknown command' } : { result: structuredClone(READY), source: 'daemon' }),
    })
    await refreshLocalClaude()
    fail = true
    t = 2_000
    expect(await refreshLocalClaude()).toBeNull()
    expect(getLocalClaude()).toMatchObject({ checkedAt: 2_000, checkError: 'unknown command', problems: [], claude: { version: '2.1.280' } })
  })

  it('a config change re-probes only when the configured model\'s floor moved', async () => {
    let floor: typeof OPUS_55 | null = OPUS_55
    let asked = 0
    setLocalClaudeIo({ now: () => 1, floor: async () => floor, preflight: async () => { asked++; return { result: structuredClone(READY), source: 'daemon' } } })
    await refreshLocalClaude()
    await localClaudeConfigChanged()
    expect(asked).toBe(1)
    floor = null
    await localClaudeConfigChanged()
    await vi.waitFor(() => expect(asked).toBe(2))
  })
})

// ── The machine itself: the daemon first, else this process on the session PATH ──

/** A claude that answers --version and a signed-in `auth status --json`, nothing else. */
function writeClaude(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'case "$1" in',
    `  --version) echo "${version} (Claude Code)" ;;`,
    '  auth) echo \'{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}\' ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

function daemonConn(answer: HostPreflightResult) {
  const sent: Array<[string, unknown, number | undefined]> = []
  const conn: PreflightConnection = {
    hasCapability: (c: string) => c === 'preflight-v1',
    send: async (type: string, payload: unknown, timeoutMs?: number) => { sent.push([type, payload, timeoutMs]); return { ok: true, ...structuredClone(answer) } },
  } as unknown as PreflightConnection
  return { conn, sent }
}

describe('the machine: the local daemon first, else this process', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-local-claude-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const parts = (over: Partial<LocalMachineParts>): LocalMachineParts => ({
    connection: async () => null, onDaemonConnected: () => () => {}, loginShellPath: async () => null,
    env: { HOME: tmp, PATH: '/usr/bin:/bin', SHELL: '' }, ...over,
  })

  it('asks the connected local daemon, with the floor, and says so', async () => {
    const { conn, sent } = daemonConn(READY)
    const io = createLocalClaudeIo(parts({ connection: async () => conn, loginShellPath: async () => { throw new Error('must not run in process') } }))
    const answer = await io.preflight('2.1.280')
    expect(answer.source).toBe('daemon')
    expect(answer.result?.claude).toMatchObject({ path: BIN, version: '2.1.280', auth: 'ok' })
    expect(sent).toEqual([['host.preflight', { minClaudeVersion: '2.1.280' }, 14_000]])
  })

  // Coordinator finding: the in-process fallback put the daemon's fallback dirs
  // ahead of the user's PATH and reported a different claude than sessions run.
  it('in process, a claude earlier in the login-shell PATH wins over the first fallback dir', async () => {
    const fallbackDir = defaultDaemonExtraPaths(tmp)[0]!
    writeClaude(fallbackDir, '2.1.282')
    const loginDir = path.join(tmp, 'login', 'bin')
    const mine = writeClaude(loginDir, '2.1.280')
    const io = createLocalClaudeIo(parts({ loginShellPath: async () => `${loginDir}:/usr/bin:/bin` }))
    const answer = await io.preflight('2.1.280')
    expect(answer.source).toBe('in-process')
    expect(answer.result?.claude).toMatchObject({ found: true, path: mine, version: '2.1.280', versionOk: true, auth: 'ok' })
    // No login-shell PATH (the capture failed): the daemon's own order, fallback dirs first.
    const bare = await createLocalClaudeIo(parts({})).preflight(undefined)
    expect(bare.result?.claude).toMatchObject({ path: path.join(fallbackDir, 'claude'), version: '2.1.282' })
  })

  it('an answer this process gave itself is replaced by the daemon\'s once the local daemon connects', async () => {
    let conn: PreflightConnection | null = null
    let connected: (() => void) | undefined
    const inProcessAnswer = { ...READY, claude: { ...READY.claude, path: '/elsewhere/claude', version: '2.1.282' } }
    const { conn: daemon, sent } = daemonConn(READY)
    setLocalClaudeIo({
      now: () => 1,
      floor: async () => OPUS_55,
      onDaemonConnected: (cb) => { connected = cb; return () => { connected = undefined } },
      preflight: async (min) => (conn
        ? { result: (await daemon.send('host.preflight', { minClaudeVersion: min })) as unknown as HostPreflightResult, source: 'daemon' }
        : { result: structuredClone(inProcessAnswer), source: 'in-process' }),
    })
    const seen: string[] = []
    const off = wireLocalClaude({ onChange: (s) => seen.push(`${s?.source}:${s?.claude.path}`) })
    await refreshLocalClaude()
    expect(getLocalClaude()).toMatchObject({ source: 'in-process', claude: { path: '/elsewhere/claude' } })
    conn = daemon
    connected!()
    await vi.waitFor(() => expect(getLocalClaude()).toMatchObject({ source: 'daemon', claude: { path: BIN } }))
    expect(seen).toEqual(['in-process:/elsewhere/claude', `daemon:${BIN}`])
    // A daemon answer is kept: a reconnect asks nothing more.
    connected!()
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(1)
    off()
    expect(connected).toBeUndefined()
  })

  it('a daemon connect asks nothing when nothing was asked before (a test server that opted out)', async () => {
    let connected: (() => void) | undefined
    let asked = 0
    setLocalClaudeIo({ onDaemonConnected: (cb) => { connected = cb; return () => {} }, preflight: async () => { asked++; return { result: READY, source: 'daemon' } } })
    const off = wireLocalClaude({ onChange: () => {} })
    connected!()
    await new Promise((r) => setTimeout(r, 10))
    expect(asked).toBe(0)
    expect(getLocalClaude()).toBeUndefined()
    off()
  })
})
