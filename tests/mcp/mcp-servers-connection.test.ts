/**
 * McpConnection against a REAL stdio MCP server process (tests/fixtures/mcp/fake-stdio-server.mjs):
 * lazy start, reuse, one shared start, crash and cooldown, start failures with the server's own
 * words, deadlines, cancel, refusals, results passed through as sent, the env allowlist, the tool
 * cache, idle close, restart, dispose during a slow start, and the replica refusal.
 *
 * No mocks below the SDK: every case spawns the fixture with `node`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mcp-connection'))

const { McpConnection, resolveDefinition, RETRY_COOLDOWN_MS } = await import('../../src/core/mcp-servers/connection.js')
const { McpCallError } = await import('../../src/core/mcp-servers/types.js')
type Connection = InstanceType<typeof McpConnection>
type Definition = Parameters<typeof resolveDefinition>[0]

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/fake-stdio-server.mjs')

const quietLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quietLog } }

let dir: string
let logFile: string
let clock: number | null
const open: Connection[] = []

function connect(def: Partial<Definition> & { env?: Record<string, string> } = {}, hooks: { replica?: boolean } = {}) {
  let statusEvents = 0
  const connection = new McpConnection(resolveDefinition({
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    ...def,
    env: { FAKE_MCP_LOG: logFile, ...(def.env ?? {}) },
  }), 'test-plugin', {
    onStatus: () => { statusEvents += 1 },
    log: quietLog,
    replica: hooks.replica ?? false,
    clientVersion: '0.0.0-test',
    now: () => clock ?? Date.now(),
  })
  open.push(connection)
  return { connection, statusEvents: () => statusEvents }
}

function events(kind?: string): Array<{ pid: number; kind: string; tool?: string; cursor?: string | null }> {
  if (!fs.existsSync(logFile)) return []
  return fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((event) => !kind || event.kind === kind)
}

function alive(pid: number | null): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function failureOf(promise: Promise<unknown>): Promise<InstanceType<typeof McpCallError>> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(McpCallError)
    return error as InstanceType<typeof McpCallError>
  }
  throw new Error('expected the call to fail')
}

const textOf = (result: { content: Array<{ type: string; text?: unknown }> }) => JSON.parse(String(result.content[0]?.text))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-conn-'))
  logFile = path.join(dir, 'events.jsonl')
  clock = null
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.dispose()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('McpConnection lifecycle', () => {
  it('starts on the first call, not on registration, and reuses one process', async () => {
    const { connection } = connect()
    expect(connection.status().state).toBe('idle')
    expect(connection.pid()).toBeNull()
    expect(events('start')).toHaveLength(0)

    const first = await connection.call('echo', { a: 1 })
    expect(textOf(first)).toEqual({ echoed: { a: 1 } })
    const status = connection.status()
    expect(status.state).toBe('ready')
    expect(status.serverInfo).toEqual({ name: 'fake-mcp', version: '1.2.3' })
    const pid = connection.pid()
    expect(alive(pid)).toBe(true)

    await connection.call('echo', { a: 2 })
    expect(connection.pid()).toBe(pid)
    expect(events('start')).toHaveLength(1)
  })

  it('concurrent first calls share one start', async () => {
    const { connection } = connect({ env: { FAKE_MCP_START_DELAY_MS: '300' } })
    const results = await Promise.all([1, 2, 3, 4].map((n) => connection.call('echo', { n })))
    expect(results.map((one) => textOf(one).echoed.n)).toEqual([1, 2, 3, 4])
    expect(events('start')).toHaveLength(1)
  })

  it('a crash mid-call fails that call after it was sent, cools down, then starts afresh', async () => {
    clock = 1_000_000
    const { connection } = connect()
    await connection.call('echo', {})
    const firstPid = connection.pid()

    const failure = await failureOf(connection.call('drop', {}))
    expect(failure.failure).toBe('closed')
    expect(failure.stage).toBe('after-call')
    await waitFor(() => connection.status().state === 'failed')
    expect(connection.status().lastError).toMatch(/stopped unexpectedly\. It said: fake-mcp: dropping on purpose/)
    expect(alive(firstPid)).toBe(false)

    // Inside the cooldown: refused before anything is sent, no new process.
    const cooling = await failureOf(connection.call('echo', {}))
    expect(cooling.failure).toBe('unavailable')
    expect(cooling.stage).toBe('before-call')
    expect(events('start')).toHaveLength(1)

    clock += RETRY_COOLDOWN_MS + 1
    await connection.call('echo', {})
    expect(connection.status().state).toBe('ready')
    expect(connection.status().lastError).toBeUndefined()
    expect(connection.pid()).not.toBe(firstPid)
    expect(events('start')).toHaveLength(2)
  })

  it('a command that does not exist says so, before the call', async () => {
    const { connection } = connect({ command: path.join(dir, 'no-such-binary') })
    const failure = await failureOf(connection.call('echo', {}))
    expect(failure.stage).toBe('before-call')
    expect(failure.failure).toBe('unavailable')
    expect(failure.message).toMatch(/could not start: its command was not found/)
    expect(connection.status().state).toBe('failed')
  })

  it('a server that exits at start is reported with its own last stderr line', async () => {
    const { connection } = connect({ env: { FAKE_MCP_EXIT_AT_START: 'login required: run the setup once' } })
    const failure = await failureOf(connection.call('echo', {}))
    expect(failure.stage).toBe('before-call')
    expect(connection.status().lastError).toMatch(/could not start.*It said: login required: run the setup once/)
  })

  it('a start that outlasts its budget fails with the budget named, and leaves no process', async () => {
    const { connection } = connect({ startupTimeoutMs: 400, env: { FAKE_MCP_START_DELAY_MS: '20000' } })
    const failure = await failureOf(connection.call('echo', {}))
    expect(failure.message).toMatch(/did not finish starting within 400 ms/)
    expect(connection.status().state).toBe('failed')
    expect(connection.pid()).toBeNull()
  })
})

describe('McpConnection calls', () => {
  it('a slow answer times out AFTER the call was sent and the server stays usable', async () => {
    const { connection } = connect()
    await connection.call('echo', {})
    const failure = await failureOf(connection.call('slow', { ms: 5000 }, { timeoutMs: 200 }))
    expect(failure.failure).toBe('timeout')
    expect(failure.stage).toBe('after-call')
    expect(connection.status().state).toBe('ready')
    expect(textOf(await connection.call('echo', { again: true }))).toEqual({ echoed: { again: true } })
  })

  it('a cancelled call is reported as cancelled', async () => {
    const { connection } = connect()
    await connection.call('echo', {})
    const controller = new AbortController()
    const pending = connection.call('slow', { ms: 5000 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const failure = await failureOf(pending)
    expect(failure.failure).toBe('aborted')
  })

  it('a JSON-RPC error is a refusal before anything ran; isError is an answer, not a throw', async () => {
    const { connection } = connect()
    const refused = await failureOf(connection.call('no_such_tool', {}))
    expect(refused.failure).toBe('refused')
    expect(refused.stage).toBe('before-call')
    expect(refused.message).toMatch(/Unknown tool: no_such_tool/)

    const answer = await connection.call('fail', {})
    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toEqual({ error: 'channel_not_found', message: 'No such channel' })
  })

  it('a structured answer that breaks its outputSchema is handed over as sent, even after tools/list', async () => {
    const { connection } = connect()
    const tools = await connection.listTools()
    expect(tools.find((tool) => tool.name === 'mismatch')).toBeDefined()
    const answer = await connection.call('mismatch', {})
    expect(answer.structuredContent).toEqual({ count: 'many' })
  })

  it('the process gets the allowlisted env plus its own, never the server\'s secrets', async () => {
    process.env.WALNUT_TEST_PROVIDER_SECRET = 'sk-should-not-leak'
    try {
      const { connection } = connect({
        env: { FAKE_MCP_ENV_KEYS: 'HOME,PATH,WALNUT_TEST_PROVIDER_SECRET,PLUGIN_GIVEN', PLUGIN_GIVEN: 'yes' },
      })
      const seen = textOf(await connection.call('env', {}))
      expect(seen.HOME).toBe(process.env.HOME)
      expect(seen.PATH).toBe(process.env.PATH)
      expect(seen.PLUGIN_GIVEN).toBe('yes')
      expect(seen.WALNUT_TEST_PROVIDER_SECRET).toBeNull()
    } finally {
      delete process.env.WALNUT_TEST_PROVIDER_SECRET
    }
  })
})

describe('McpConnection tools', () => {
  it('maps annotations, follows pages, caches, refreshes, and drops the cache on list_changed', async () => {
    const { connection, statusEvents } = connect({ env: { FAKE_MCP_PAGE_SIZE: '4', FAKE_MCP_PAD: '7' } })
    const tools = await connection.listTools()
    expect(tools).toHaveLength(16)
    expect(events('list')).toHaveLength(4)
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(byName.echo).toMatchObject({ readOnly: true, destructive: false, description: 'Echo the arguments back.\nSecond line.' })
    expect(byName.note_write).toMatchObject({ readOnly: false, destructive: false })
    expect(byName.wipe).toMatchObject({ readOnly: false, destructive: true })
    expect(byName.add_tool).toMatchObject({ readOnly: false })
    expect(connection.status().toolCount).toBe(16)
    const eventsAfterFirstList = statusEvents()

    await connection.listTools()
    expect(events('list')).toHaveLength(4)
    await connection.listTools({ refresh: true })
    expect(events('list')).toHaveLength(8)
    expect(statusEvents()).toBe(eventsAfterFirstList)

    // The server announces the change before it answers, so the next list asks again.
    await connection.call('add_tool', { name: 'late_arrival' })
    const again = await connection.listTools()
    expect(events('list')).toHaveLength(13)
    expect(again.map((tool) => tool.name)).toContain('late_arrival')
    expect(connection.status().toolCount).toBe(17)
  })
})

describe('McpConnection shutdown paths', () => {
  it('closes after being idle and starts again on the next call', async () => {
    const { connection } = connect({ idleCloseMs: 300 })
    await connection.call('echo', {})
    const pid = connection.pid()
    await waitFor(() => connection.status().state === 'idle')
    await waitFor(() => !alive(pid))
    await connection.call('echo', {})
    expect(connection.status().state).toBe('ready')
    expect(connection.pid()).not.toBe(pid)
  })

  it('a call in flight keeps an idle timer from closing the process under it', async () => {
    const { connection } = connect({ idleCloseMs: 200 })
    await connection.call('echo', {})
    const answer = await connection.call('slow', { ms: 700 })
    expect(textOf(answer)).toEqual({ slept: 700 })
  })

  it('restart replaces the process and is ready again', async () => {
    const { connection } = connect()
    await connection.call('echo', {})
    const pid = connection.pid()
    const status = await connection.restart()
    expect(status.state).toBe('ready')
    expect(connection.pid()).not.toBe(pid)
    await waitFor(() => !alive(pid))
  })

  it('restart clears a failure without waiting out the cooldown', async () => {
    clock = 5_000_000
    const { connection } = connect()
    await connection.call('echo', {})
    await failureOf(connection.call('drop', {}))
    await waitFor(() => connection.status().state === 'failed')
    const status = await connection.restart()
    expect(status.state).toBe('ready')
    expect(status.lastError).toBeUndefined()
  })

  it('dispose during a slow start ends that start and refuses every later call', async () => {
    const { connection } = connect({ env: { FAKE_MCP_START_DELAY_MS: '20000' } })
    const pending = failureOf(connection.call('echo', {}))
    await waitFor(() => connection.status().state === 'starting')
    await connection.dispose()
    const failure = await pending
    expect(failure.stage).toBe('before-call')
    const later = await failureOf(connection.call('echo', {}))
    expect(later.message).toMatch(/no longer registered/)
    expect(events('call')).toHaveLength(0)
  })

  it('a replica never starts a server', async () => {
    const { connection } = connect({}, { replica: true })
    const failure = await failureOf(connection.call('echo', {}))
    expect(failure.failure).toBe('unavailable')
    expect(failure.stage).toBe('before-call')
    expect(failure.message).toMatch(/primary Walnut/)
    expect(events('start')).toHaveLength(0)
  })
})
