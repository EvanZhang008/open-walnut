/**
 * Every Claude Code process gets the Walnut MCP tools, whenever it was started
 * (src/core/sessions/walnut-mcp-mount.ts, ClaudeCodeSession.applySpawnWalnutMount
 * and ensureLiveWalnutMount).
 *
 * 2026-11-10: the mount was decided once, at a session's first spawn, and stored on
 * the record, so Main, the VPs and every lead older than the mount resumed with a
 * record that had none and never got the tools. The class is "a session that was
 * created without the mount": each test starts from one and checks it gets the
 * tools at its next spawn (fresh, resume, fork) or, while it runs, before its next
 * turn, with no restart.
 *
 * ZERO real side effects: mock-claude.mjs under a MockDaemon, stores in a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

// Which hosts' daemons serve `walnut mcp-server` (capability walnut-mcp-v1).
const serving = { on: true }
vi.mock('../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/daemon-connection.js')>()),
  getConnectedDaemonConnection: () => ({ hasCapability: (cap: string) => serving.on && cap === 'walnut-mcp-v1' }),
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { hostWalnutMcpServer } from '../../src/core/sessions/walnut-mcp-mount.js'
import type { SessionProfile } from '../../src/core/types.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
let daemon: MockDaemon

async function waitUntil(pred: () => boolean, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function newSession(taskId: string): ClaudeCodeSession {
  const s = new ClaudeCodeSession(taskId, 'proj', MOCK_CLI)
  s._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
  return s
}

/** Spawn and return the `--mcp-config` the daemon was asked to start with (parsed), or null. */
async function spawnMcpConfig(
  taskId: string,
  opts: { profile?: SessionProfile; resume?: string; fork?: boolean; message?: string } = {},
): Promise<{ config: { mcpServers: Record<string, unknown> } | null; session: ClaudeCodeSession }> {
  const session = newSession(taskId)
  session.send(
    opts.message ?? 'hello', WALNUT_HOME, opts.resume, 'bypass', undefined, undefined,
    undefined, undefined, opts.fork, undefined, undefined, undefined, undefined, undefined,
    opts.profile ? { profile: opts.profile } : undefined,
  )
  await session.awaitSpawn().catch(() => {})
  let entry: { payload: Record<string, unknown> } | undefined
  await waitUntil(() => {
    entry = daemon.getCommandHistoryFor('start')[0]
    return !!entry
  }, 8000, 'start command')
  const args = entry!.payload.args as string[]
  const at = args.indexOf('--mcp-config')
  return { config: at >= 0 ? JSON.parse(args[at + 1]!) : null, session }
}

beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop() })

beforeEach(async () => {
  serving.on = true
  bus.clear()
  daemon.clearCommandHistory()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  const [db, tracker] = await Promise.all([import('../../src/core/session-db.js'), import('../../src/core/session-tracker.js')])
  db.closeDb()
  tracker._resetSessionTrackerForTesting()
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('a session created without the Walnut mount gets it at its next spawn', () => {
  it('a fresh spawn with no profile gets the host mount, and the record keeps no profile', async () => {
    const { config, session } = await spawnMcpConfig('t-fresh')
    expect(config?.mcpServers.walnut).toEqual(hostWalnutMcpServer())
    expect(session.requestedMcpServers).toContain('walnut')
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const record = await getSessionByClaudeId(session.sessionId!)
    expect(record?.profile?.mcpServers?.walnut).toBeUndefined()
    await session.gracefulStop(true).catch(() => {})
  })

  it('a cold resume of a session with no profile (Main, a VP, an old lead) gets it', async () => {
    const { config, session } = await spawnMcpConfig('t-resume', { resume: '11111111-2222-4333-8444-555555555555' })
    expect(config?.mcpServers.walnut).toEqual(hostWalnutMcpServer())
    await session.gracefulStop(true).catch(() => {})
  })

  it('a fork gets it too', async () => {
    const { config, session } = await spawnMcpConfig('t-fork', { resume: '11111111-2222-4333-8444-666666666666', fork: true })
    expect(config?.mcpServers.walnut).toEqual(hostWalnutMcpServer())
    await session.gracefulStop(true).catch(() => {})
  })

  it('a caller\'s own profile keeps its own choice: never doubled, never added to', async () => {
    const own: SessionProfile = { mcpServers: { other: { command: 'o' } } }
    const a = await spawnMcpConfig('t-own', { profile: own })
    expect(Object.keys(a.config?.mcpServers ?? {})).toEqual(['other'])
    await a.session.gracefulStop(true).catch(() => {})
    daemon.clearCommandHistory()
    const hub: SessionProfile = { mcpServers: { walnut: { command: 'hub', args: ['mcp'] } } }
    const b = await spawnMcpConfig('t-hub', { profile: hub })
    expect(b.config?.mcpServers.walnut).toEqual({ command: 'hub', args: ['mcp'] })
    await b.session.gracefulStop(true).catch(() => {})
  })

  it('a daemon without the server: no mount', async () => {
    serving.on = false
    const { config, session } = await spawnMcpConfig('t-old-daemon')
    expect(config).toBeNull()
    await session.gracefulStop(true).catch(() => {})
  })
})

describe('a RUNNING process without the mount gets it before its next turn, with no restart', () => {
  it('mcp_set_servers goes out before the line of the next turn, once, and the process is the same', async () => {
    let results = 0
    bus.subscribe('test', (e: BusEvent) => { if (e.name === EventNames.SESSION_RESULT) results++ }, { global: true })
    serving.on = false // started before the mount existed
    const { config, session } = await spawnMcpConfig('t-live', { message: 'snapshot-clean-turn:one' })
    expect(config).toBeNull()
    await waitUntil(() => results >= 1, 15000, 'first result')
    expect(session.requestedMcpServers).not.toContain('walnut')
    const pid = session.pid
    const setServers = () => daemon.getCommandHistory().filter((e) => e.cmd === 'sendRaw' && JSON.stringify(e.payload).includes('mcp_set_servers'))
    serving.on = true // the host's daemon now serves it
    expect(await session.writeMessage('snapshot-clean-turn:two')).toBe(true)
    // The ack came back before the turn's line was written.
    expect(setServers()).toHaveLength(1)
    const order = daemon.getCommandHistory().map((e) => e.cmd)
    expect(order.lastIndexOf('sendRaw')).toBeLessThan(order.lastIndexOf('send'))
    expect(session.requestedMcpServers).toContain('walnut')
    await waitUntil(() => results >= 2, 15000, 'second result')
    expect(session.pid).toBe(pid)
    expect(await session.writeMessage('snapshot-clean-turn:three')).toBe(true)
    await waitUntil(() => results >= 3, 15000, 'third result')
    expect(setServers()).toHaveLength(1)
    await session.gracefulStop(true).catch(() => {})
  }, 60_000)

  it('two writers while the mount request is out: one request, both wait for it, lines go out in order', async () => {
    let results = 0
    bus.subscribe('test', (e: BusEvent) => { if (e.name === EventNames.SESSION_RESULT) results++ }, { global: true })
    serving.on = false
    const { session } = await spawnMcpConfig('t-live-order', { message: 'snapshot-clean-turn:one' })
    await waitUntil(() => results >= 1, 15000, 'first result')
    serving.on = true
    daemon.clearCommandHistory()
    const [a, b] = await Promise.all([
      session.writeMessage('snapshot-clean-turn:first'),
      session.writeMessage('snapshot-clean-turn:second'),
    ])
    expect(a && b).toBe(true)
    const history = daemon.getCommandHistory()
    const raws = history.filter((e) => e.cmd === 'sendRaw' && JSON.stringify(e.payload).includes('mcp_set_servers'))
    expect(raws).toHaveLength(1)
    const sends = history.filter((e) => e.cmd === 'send').map((e) => JSON.stringify(e.payload))
    expect(sends).toHaveLength(2)
    expect(sends[0]).toContain('first')
    expect(sends[1]).toContain('second')
    expect(history.indexOf(raws[0])).toBeLessThan(history.findIndex((e) => e.cmd === 'send'))
    await session.gracefulStop(true).catch(() => {})
  }, 60_000)
})
