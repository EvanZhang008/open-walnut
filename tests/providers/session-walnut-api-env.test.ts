/**
 * A local claude session is told which Walnut launched it.
 *
 * The in-session `walnut` CLI and the walnut MCP child resolve their server from
 * OPEN_WALNUT_API_URL and default to :3456. Before this, a session launched by
 * any other server (an ephemeral test server, the Playwright fixture, a vitest
 * server) wrote its tasks into the user's real Walnut (reproduced 2026-09-23).
 * The spawn now carries `--settings {"env":{"OPEN_WALNUT_API_URL":…}}`, the
 * CLI's own way to set a session's env.
 *
 * ZERO real side effects: the CLI is a MockDaemon-spawned mock-claude.mjs, and
 * all stores are redirected into a temp dir by createMockConstants.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
const tmpBase = WALNUT_HOME
let daemon: MockDaemon

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

/** Spawn one local session through the mock daemon and return its argv. */
async function spawnArgs(taskId: string): Promise<string[]> {
  const session = new ClaudeCodeSession(taskId, 'proj', MOCK_CLI)
  ;(session as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
  session.send('hello', tmpBase, undefined, 'bypass')
  await session.awaitSpawn().catch(() => {})
  const sid = session.sessionId!
  await waitUntil(() => daemon.getCommandHistoryFor('start').some((e) => e.payload.sid === sid))
  const args = daemon.getCommandHistoryFor('start').find((e) => e.payload.sid === sid)!.payload.args as string[]
  await session.gracefulStop(true).catch(() => {})
  return args
}

function settingsOf(args: string[]): { env?: Record<string, string>; hooks?: Record<string, unknown> } | undefined {
  const i = args.indexOf('--settings')
  if (i < 0) return undefined
  return JSON.parse(args[i + 1]) as { env?: Record<string, string>; hooks?: Record<string, unknown> }
}

function settingsEnv(args: string[]): Record<string, string> | undefined {
  return settingsOf(args)?.env
}

const COMPACT_HOOK = {
  SessionStart: [{
    matcher: 'compact',
    hooks: [{ type: 'command', command: 'walnut tools call open_items \'{"hook":"compact"}\' 2>/dev/null || true', timeout: 20 }],
  }],
}

beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop() })

beforeEach(async () => {
  bus.clear()
  daemon.clearCommandHistory()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
})

afterEach(async () => {
  setSelfApiRoot(null)
  bus.clear()
  await new Promise((r) => setImmediate(r))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('local session spawn → launching server URL', () => {
  it('carries OPEN_WALNUT_API_URL for the server listening in this process', async () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    const args = await spawnArgs('t-self-url')
    expect(settingsEnv(args)).toEqual({ OPEN_WALNUT_API_URL: 'http://127.0.0.1:45678' })
    // One settings arg carries both: the env and the post-compaction hook.
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    expect(settingsOf(args)?.hooks).toEqual(COMPACT_HOOK)
  })

  it('no server listening here: no env, the post-compaction hook still rides', async () => {
    const args = await spawnArgs('t-no-server')
    expect(settingsOf(args)).toEqual({ hooks: COMPACT_HOOK })
  })

  it('WALNUT_COMPACT_OPEN_ITEMS=0 turns the hook off (argv unchanged from before it)', async () => {
    process.env.WALNUT_COMPACT_OPEN_ITEMS = '0'
    try {
      const args = await spawnArgs('t-hook-off')
      expect(args).not.toContain('--settings')
    } finally {
      delete process.env.WALNUT_COMPACT_OPEN_ITEMS
    }
  })
})
