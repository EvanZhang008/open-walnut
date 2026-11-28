/**
 * Guard: a server on a copy of the person's data never writes to his real accounts.
 *
 * 2026-11-27: an ephemeral server (`bun run dev:ephemeral`, a snapshot of the data dir) synced the
 * person's real IMAP and work mailboxes with the copy's live credentials, and a test script that
 * opened a message in its Mail page marked that message read in the real mailbox. The outward
 * doors (doors.ts OUTWARD_DOORS) already stood before every write to an account, but only the
 * leader permit closed them. Now every kind of door is placed by what it reaches (DOOR_REACH), a
 * copy closes every 'account' door at boot (closeAccountDoors, web/server.ts), and:
 *  - a new kind fails to compile until it is placed, and fails here until a door names it;
 *  - each 'account' kind refuses on a copy through every act helper (assert, refusal, begin), and
 *    each 'walnut' kind still goes; the timers' "doors open" query is untouched;
 *  - every built-in integration (src/integrations/<dir>/manifest.json) is registered below with
 *    the account doors its writes pass, or none: a new integration fails until it is registered;
 *  - an MCP tool the server does not mark readOnlyHint is refused on a copy before the server is
 *    asked (a plugin's Slack post goes through walnut.mcp), a read-only one still answers;
 *  - which servers are copies (accountIsolationReason): a snapshot, an ephemeral server; a test
 *    fixture's, the Demo's and the sandbox's own accounts are not.
 * The ratchet that each door function checks its door before it acts is
 * outward-doors-ratchet.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-account-doors'))

const doors = await import('../../../../src/core/leader/switch/doors.js')
const { WALNUT_HOME } = await import('../../../../src/constants.js')
const { accountIsolationReason, DATA_COPY_MARKER, OWN_ACCOUNTS_FLAG, throwawayServerReason } = await import('../../../../src/core/remote-sync-isolation.js')
const { McpConnection, resolveDefinition } = await import('../../../../src/core/mcp-servers/connection.js')
const { McpCallError } = await import('../../../../src/core/mcp-servers/types.js')
const { errorReply } = await import('../../../../src/integrations/mail/contract.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const SRC = path.join(ROOT, 'src')

/** The kinds of the OutwardDoorKind union, read from its source. */
function unionKinds(): string[] {
  const src = fs.readFileSync(path.join(SRC, 'core/leader/switch/doors.ts'), 'utf-8')
  const union = src.match(/export type OutwardDoorKind =([\s\S]*?)\n\n/)?.[1] ?? ''
  return [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
}

afterEach(() => {
  doors.closeAccountDoors(null)
  doors.setOutwardDoorChecker(null)
})

describe('every door kind is placed by what it reaches', () => {
  it('DOOR_REACH names every kind of the union, and no other', () => {
    const kinds = unionKinds()
    expect(kinds.length).toBeGreaterThan(10)
    expect(Object.keys(doors.DOOR_REACH).sort()).toEqual([...kinds].sort())
  })

  it('every account kind names a door (a kind no door asks would close nothing)', () => {
    for (const [kind, reach] of Object.entries(doors.DOOR_REACH)) {
      if (reach !== 'account') continue
      expect(doors.OUTWARD_DOORS.some((d) => d.kind === kind), `kind ${kind} has no door in OUTWARD_DOORS`).toBe(true)
    }
  })

  it('the person\'s mailbox, calendar, phone, trackers, plugins, MCP servers, data repo and companion are accounts', () => {
    for (const kind of ['mail-send', 'mail-unsubscribe', 'mail-write', 'calendar-write', 'push', 'apns', 'task-sync', 'plugin-fetch', 'mcp-write', 'git-push', 'companion-upload'] as const) {
      expect(doors.DOOR_REACH[kind], kind).toBe('account')
    }
  })
})

describe('a copy closes every account door, and only those', () => {
  const kinds = Object.keys(doors.DOOR_REACH) as Array<keyof typeof doors.DOOR_REACH>

  it.each(kinds)('%s', async (kind) => {
    doors.closeAccountDoors('an ephemeral server')
    expect(doors.accountDoorsGuarded()).toBe(true)
    // The permit is not involved: nothing else reads the process as guarded by it.
    expect(doors.leaderPermitActive()).toBe(false)
    const thrown = (() => { try { doors.assertOutwardDoor(kind, 'op-1'); return null } catch (e) { return e } })()
    const refusal = doors.outwardDoorRefusal(kind, 'op-1')
    const begun = await doors.beginOutwardSend(kind, 'op-1').then(() => null, (e: unknown) => e)
    if (doors.DOOR_REACH[kind] === 'account') {
      expect(doors.isPermitRefusal(thrown), `${kind}: assertOutwardDoor refuses on a copy`).toBe(true)
      expect(doors.isPermitRefusal(begun), `${kind}: beginOutwardSend refuses on a copy`).toBe(true)
      expect(refusal).toMatch(/isolated test server \(an ephemeral server\)/)
      expect(doors.doorRefusalMessage(thrown)).toMatch(/never changes your real accounts/)
    } else {
      expect(thrown, `${kind} reaches only this Walnut: it still goes`).toBeNull()
      expect(begun).toBeNull()
      expect(refusal).toBeNull()
    }
  })

  it('leaves the timers\' doors open: a copy holds no due work back', () => {
    doors.closeAccountDoors('an ephemeral server')
    expect(doors.outwardDoorsOpen()).toBe(true)
    expect(doors.doorsClosed()).toBe(false)
    expect(doors.doorTimerFloorMs(1_000)).toBe(1_000)
  })

  it('keeps open only the kinds named on purpose (a sync plugin\'s end-to-end test)', () => {
    doors.closeAccountDoors('an ephemeral server', ['task-sync'])
    expect(() => doors.assertOutwardDoor('task-sync', 'x')).not.toThrow()
    expect(() => doors.assertOutwardDoor('mail-write', 'x')).toThrow(/did not act/)
  })

  it('closes whatever the permit says, and the permit still refuses with its own sentence', () => {
    doors.setOutwardDoorChecker(() => {}, () => true)
    doors.closeAccountDoors('a copy of your Walnut data at /tmp/x')
    expect(() => doors.assertOutwardDoor('mail-write', 'read:a:m')).toThrow(/isolated test server/)
    doors.closeAccountDoors(null)
    expect(() => doors.assertOutwardDoor('mail-write', 'read:a:m')).not.toThrow()
    doors.setOutwardDoorChecker(() => { throw Object.assign(new Error('not the leader'), { name: 'PermitNotHeld' }) })
    let err: unknown
    try { doors.assertOutwardDoor('mail-write', 'read:a:m') } catch (e) { err = e }
    expect(doors.doorRefusalMessage(err)).toBe(doors.NOT_LEADER_MESSAGE)
  })

  it('a mail route answers 503 with the copy\'s sentence, and logs no error', () => {
    doors.closeAccountDoors('an ephemeral server')
    let err: unknown
    try { doors.assertOutwardDoor('mail-write', 'read:acct:m1') } catch (e) { err = e }
    const log = { error: vi.fn() }
    const reply = errorReply({ log }, err)
    expect(reply.status).toBe(503)
    expect((reply.json as { message: string }).message).toMatch(/is an isolated test server/)
    expect(log.error).not.toHaveBeenCalled()
  })
})

/**
 * Every built-in integration, by its directory (or file) under src/integrations/ with a
 * manifest.json, and the account doors its writes pass. A new integration fails here until it
 * is listed: name the door kinds its writes go through (and give it doors in OUTWARD_DOORS if it
 * brings a new way out), or [] when it writes to no account.
 */
const INTEGRATION_DOORS: Record<string, readonly string[]> = {
  mail: ['mail-send', 'mail-write', 'mail-unsubscribe'],
  'mail-imap': ['mail-send', 'mail-write'],
  calendar: ['calendar-write'],
  jira: ['task-sync'],
  'ms-todo': ['task-sync'],
  local: [],
}

/**
 * The same for every plugin of the plugin store in this repository (plugin-store/<dir>): it is not
 * built in, so on a copy its own network writes are refused by the guard
 * (core/plugins/copy-network-guard.ts) besides the doors it passes.
 */
const STORE_PLUGIN_DOORS: Record<string, readonly string[]> = {
  'notes-import': ['plugin-fetch'], // reads Notion with its own fetch; its client refuses every write itself
  'walnut-drawing': [],
  'walnut-rhythm': ['plugin-fetch'],
}

describe('every built-in integration is registered with the account doors its writes pass', () => {
  const dirs = fs.readdirSync(path.join(SRC, 'integrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC, 'integrations', e.name, 'manifest.json')))
    .map((e) => e.name)
  const storeDirs = fs.readdirSync(path.join(ROOT, 'plugin-store'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'plugin-store', e.name, 'manifest.json')))
    .map((e) => e.name)

  it('lists every plugin of the plugin store, and no other', () => {
    expect(storeDirs.length).toBeGreaterThan(0)
    expect(storeDirs.filter((d) => !(d in STORE_PLUGIN_DOORS)), 'a new store plugin: list it in STORE_PLUGIN_DOORS with the account doors its writes pass').toEqual([])
    expect(Object.keys(STORE_PLUGIN_DOORS).filter((d) => !storeDirs.includes(d))).toEqual([])
  })

  it('lists every integration directory, and no other', () => {
    expect(dirs.length).toBeGreaterThan(3)
    expect(dirs.filter((d) => !(d in INTEGRATION_DOORS)), 'a new integration: list it in INTEGRATION_DOORS with the account doors its writes pass').toEqual([])
    expect(Object.keys(INTEGRATION_DOORS).filter((d) => !dirs.includes(d)), 'INTEGRATION_DOORS names an integration that is gone').toEqual([])
  })

  it('names only account kinds that exist', () => {
    for (const [dir, kinds] of Object.entries(INTEGRATION_DOORS)) {
      for (const kind of kinds) expect(doors.DOOR_REACH[kind as keyof typeof doors.DOOR_REACH], `${dir}: ${kind}`).toBe('account')
    }
  })
})

describe('an MCP write on a copy is refused before the server is asked', () => {
  const FIXTURE = path.join(ROOT, 'tests/fixtures/mcp/fake-stdio-server.mjs')
  const quietLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quietLog } }
  let dir: string
  let logFile: string
  let connection: InstanceType<typeof McpConnection> | null = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-account-doors-mcp-'))
    logFile = path.join(dir, 'calls.jsonl')
  })
  afterEach(async () => {
    await connection?.dispose().catch(() => {})
    connection = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function connect() {
    connection = new McpConnection(resolveDefinition({
      name: 'fake', command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_LOG: logFile },
    }), 'test-plugin', { onStatus: () => {}, log: quietLog, replica: false, clientVersion: '0.0.0-test', now: () => Date.now() })
    return connection
  }

  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e: { kind: string }) => e.kind === 'call').map((e: { tool: string }) => e.tool)

  it('a tool without readOnlyHint is refused, a read-only one answers', async () => {
    doors.closeAccountDoors('an ephemeral server')
    const c = connect()
    const err = await c.call('note_write', {}).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(McpCallError)
    expect((err as InstanceType<typeof McpCallError>).failure).toBe('unavailable')
    expect((err as Error).message).toMatch(/isolated test server/)
    await expect(c.call('wipe', {})).rejects.toBeInstanceOf(McpCallError)
    const answer = await c.call('echo', { a: 1 })
    expect(answer.isError).not.toBe(true)
    expect(calls()).toEqual(['echo'])
  })

  it('the person\'s own Walnut calls every tool', async () => {
    const c = connect()
    await c.call('note_write', {})
    expect(calls()).toEqual(['note_write'])
  })
})

/**
 * Every file that starts a `claude -p` (its argv names `'--output-format', 'stream-json'`) keeps
 * the person's own MCP servers out on a copy: it pushes --strict-mcp-config when the account doors
 * are closed. A new launcher fails here until it does, or names the file that does it for it.
 */
const CLAUDE_LAUNCH_STRICT_BY: Record<string, string> = {
  // The session argv builder: its caller passes the session's flags in (sessionArgs).
  'providers/claude-session-argv.ts': 'providers/claude-code-session.ts',
}

describe('every claude launcher loads none of the person\'s MCP servers on a copy', () => {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && fs.readFileSync(p, 'utf-8').split('\n').some((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l) && /'--output-format',\s*'stream-json'/.test(l))) files.push(path.relative(SRC, p))
    }
  }
  walk(SRC)

  it.each(files)('%s', (rel) => {
    const by = CLAUDE_LAUNCH_STRICT_BY[rel] ?? rel
    const src = fs.readFileSync(path.join(SRC, by), 'utf-8')
    expect(src, `${by}: push '--strict-mcp-config' when accountDoorsClosedWhy() names a copy`).toMatch(/accountDoorsClosedWhy\(\)\)\s*(?:sessionArgs|args)\.push\('--strict-mcp-config'\)/)
  })

  it('finds the launchers it knows', () => {
    expect(files).toEqual(expect.arrayContaining(['providers/inline-subagent.ts', 'model/providers/adapter-claude-cli.ts', 'providers/micro-claude-warm.ts', 'providers/claude-session-argv.ts']))
  })
})

describe('which servers are copies of the person\'s data (accountIsolationReason)', () => {
  const argv = process.argv
  const env = { VITEST: process.env.VITEST, VITEST_WORKER_ID: process.env.VITEST_WORKER_ID, NODE_ENV: process.env.NODE_ENV }
  const marker = path.join(WALNUT_HOME, DATA_COPY_MARKER)

  beforeEach(() => { fs.mkdirSync(WALNUT_HOME, { recursive: true }) })
  afterEach(() => {
    process.argv = argv
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(marker, { force: true })
  })

  const outsideTestRunner = () => {
    delete process.env.VITEST
    delete process.env.VITEST_WORKER_ID
    delete process.env.NODE_ENV
  }

  it('a snapshot is a copy, whatever serves it: a fixture flag or a test runner does not open it', () => {
    fs.writeFileSync(marker, '{}')
    process.argv = [...argv, OWN_ACCOUNTS_FLAG]
    expect(accountIsolationReason()).toMatch(/copy of your Walnut data/)
  })

  it('a snapshot is a throwaway server for task sync and the topics mail bridge too', () => {
    fs.writeFileSync(marker, '{}')
    process.argv = [...argv, OWN_ACCOUNTS_FLAG]
    outsideTestRunner()
    expect(throwawayServerReason()).toMatch(/copy of your Walnut data/)
  })

  it('an ephemeral server is a copy, even with a test runner\'s variables leaked into it', () => {
    process.argv = [...argv, '--_ephemeral-child']
    expect(accountIsolationReason()).toBe('an ephemeral server')
  })

  it('a test fixture server keeps its own fixture accounts', () => {
    process.argv = [...argv, '--_ephemeral-child', OWN_ACCOUNTS_FLAG]
    expect(accountIsolationReason()).toBeNull()
  })

  it('a test runner\'s own home is not a copy, nor a test cluster\'s server on a temp home', () => {
    expect(accountIsolationReason()).toBeNull()
    outsideTestRunner()
    expect(accountIsolationReason()).toBeNull()
  })

  it('every fixture server under tests/ that poses as an ephemeral server says its accounts are fixtures', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
        if (!/\.(ts|mts|mjs)$/.test(e.name)) continue
        const text = fs.readFileSync(p, 'utf-8')
        if (/process\.argv\.push\([^)]*'--_ephemeral-child'/.test(text) && !text.includes("'--_own-accounts'")) offenders.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'tests'))
    walk(path.join(ROOT, 'scripts'))
    expect(offenders, 'a fixture server on a synthetic home pushes --_own-accounts next to --_ephemeral-child').toEqual([])
  })
})

describe('the boot closes the account doors before anything reaches an account', () => {
  it('web/server.ts startServer decides it from accountIsolationReason, before the plugins load', () => {
    const src = fs.readFileSync(path.join(SRC, 'web/server.ts'), 'utf-8')
    const start = src.indexOf('export async function startServer(')
    const body = src.slice(start)
    const close = body.indexOf('closeAccountDoors(why')
    expect(close, 'startServer closes the account doors').toBeGreaterThan(-1)
    expect(body.slice(0, close)).toMatch(/accountIsolationReason\(\)/)
    // A copy made by hand on this machine whose original runs too (home-move.ts) closes them alike.
    expect(body.slice(0, close)).toMatch(/const why = accountIsolationReason\(\) \?\? \(IS_EPHEMERAL \? null : await \(await import\('\.\.\/core\/home-move\.js'\)\)\.copyOfLiveHomeOnThisMachine\(WALNUT_HOME\)\)/)
    for (const later of ['loadPlugins(', 'registry.endLoading(', 'startMail']) {
      const at = body.indexOf(later)
      if (at > -1) expect(close, `the doors close before ${later}`).toBeLessThan(at)
    }
  })

  it('the ephemeral launcher marks every snapshot as a copy before the child starts', () => {
    const src = fs.readFileSync(path.join(SRC, 'commands/web-ephemeral.ts'), 'utf-8')
    const mark = src.indexOf('DATA_COPY_MARKER), JSON.stringify')
    expect(mark).toBeGreaterThan(-1)
    expect(mark).toBeLessThan(src.indexOf("spawn(process.execPath, [binPath, 'web', '--_ephemeral-child']"))
  })
})
