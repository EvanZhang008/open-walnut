/**
 * Session profile (P2) — a bundle of launch config a session carries.
 *
 * A `SessionProfile` (src/core/types.ts) is expanded into `claude` CLI args at
 * spawn, persisted on the SessionRecord, and RE-RESOLVED at cold resume so a
 * reaped session comes back with its identity intact. Sessions with `lane` set
 * are exempt from host capacity and hidden from the default session lists.
 *
 * Coverage:
 *   1. arg assembly — replace vs append prompt, --mcp-config, --allowedTools
 *   2. record round-trip — profile/lane persist and come back
 *   3. capacity — checkSessionLimit ignores lane records
 *   4. listing — projection + getRecentSessions exclude lane records
 *   5. presets — walnutMcpProfile / personalAiProfile shape, mergeProfiles semantics
 *
 * ZERO real side effects: the CLI is a MockDaemon-spawned mock-claude.mjs (never
 * the real `claude`), all stores are redirected into a temp dir by
 * createMockConstants, and nothing is killed that the test didn't spawn.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
// Liveness: mirror just enough real semantics for the capacity test (a record
// with a pid is alive, a terminal one is dead) without probing real processes.
vi.mock('../../src/utils/session-liveness.js', () => ({
  isLocalJsonlFresh: () => 'unknown',
  isSessionProcessAlive: async (s: { process_status?: string; host?: string; pid?: number | null }) => {
    if (s.process_status === 'stopped' || s.process_status === 'error') return false
    if (s.host) return true
    return s.pid != null
  },
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { walnutMcpProfile, personalAiProfile, mergeProfiles } from '../../src/core/sessions/profiles.js'
import type { SessionProfile } from '../../src/core/types.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
const tmpBase = WALNUT_HOME

let daemon: MockDaemon

function useDaemon<T extends { _testDaemonUrl?: string }>(target: T): T {
  target._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
  return target
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** The argv the daemon was asked to spawn for `sid`, minus the leading binary. */
async function spawnedArgs(sid: string): Promise<string[]> {
  await waitUntil(
    () => daemon.getCommandHistoryFor('start').some((e) => e.payload.sid === sid),
    5000,
    `start command for ${sid}`,
  )
  const entry = daemon.getCommandHistoryFor('start').find((e) => e.payload.sid === sid)!
  return entry.payload.args as string[]
}

/** Spawn one session through the mock daemon and return its argv. */
async function argsForSend(
  taskId: string,
  profile: SessionProfile | undefined,
  appendSystemPrompt?: string,
): Promise<string[]> {
  const session = useDaemon(new ClaudeCodeSession(taskId, 'proj', MOCK_CLI))
  session.send(
    'hello', tmpBase, undefined, 'bypass', undefined, appendSystemPrompt,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    profile ? { profile } : undefined,
  )
  await session.awaitSpawn().catch(() => {})
  const sid = session.sessionId
  expect(sid, 'session should have a pre-assigned id').toBeTruthy()
  const args = await spawnedArgs(sid!)
  await session.gracefulStop(true).catch(() => {})
  return args
}

/** Value that follows `flag` in an argv, or undefined when absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

beforeAll(async () => {
  daemon = await createMockDaemon()
})

afterAll(async () => {
  await daemon.stop()
})

beforeEach(async () => {
  bus.clear()
  daemon.clearCommandHistory()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
})

afterEach(async () => {
  bus.clear()
  await new Promise((r) => setImmediate(r))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ══════════════════════════════════════════════════════════════════
//  1. Arg assembly
// ══════════════════════════════════════════════════════════════════

describe('profile → CLI arg assembly', () => {
  it('replace mode emits --system-prompt and NO --append-system-prompt', async () => {
    const args = await argsForSend('t-replace', {
      systemPrompt: 'You are the Personal AI.',
      systemPromptMode: 'replace',
    })
    expect(flagValue(args, '--system-prompt')).toBe('You are the Personal AI.')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('append mode composes profile prompt FIRST, caller append after', async () => {
    const args = await argsForSend(
      't-append',
      { systemPrompt: 'PROFILE', systemPromptMode: 'append' },
      'CALLER',
    )
    expect(args).not.toContain('--system-prompt')
    expect(flagValue(args, '--append-system-prompt')).toBe('PROFILE\n\nCALLER')
  })

  it('unset systemPromptMode defaults to append (never a silent full replace)', async () => {
    const args = await argsForSend('t-append-default', { systemPrompt: 'PROFILE' }, 'CALLER')
    expect(args).not.toContain('--system-prompt')
    expect(flagValue(args, '--append-system-prompt')).toBe('PROFILE\n\nCALLER')
  })

  it('replace mode still forwards the caller append as its own flag', async () => {
    const args = await argsForSend(
      't-replace-plus-append',
      { systemPrompt: 'REPLACED', systemPromptMode: 'replace' },
      'CALLER',
    )
    expect(flagValue(args, '--system-prompt')).toBe('REPLACED')
    expect(flagValue(args, '--append-system-prompt')).toBe('CALLER')
  })

  it('mcpServers become one --mcp-config arg that parses back to the same JSON', async () => {
    const mcpServers = {
      walnut: { command: 'open-walnut', args: ['mcp'] },
      other: { command: 'thing', args: ['--flag', 'v'], env: { K: 'V' } },
    }
    const args = await argsForSend('t-mcp', { mcpServers })
    const raw = flagValue(args, '--mcp-config')
    expect(raw, '--mcp-config should be present').toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({ mcpServers })
  })

  it('allowedTools is comma-joined', async () => {
    const args = await argsForSend('t-tools', { allowedTools: ['Read', 'Bash(git log:*)', 'mcp__walnut'] })
    expect(flagValue(args, '--allowedTools')).toBe('Read,Bash(git log:*),mcp__walnut')
  })

  it('no profile → none of the three flags appear (unchanged behavior)', async () => {
    const args = await argsForSend('t-none', undefined)
    expect(args).not.toContain('--system-prompt')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('empty profile collections emit no flags', async () => {
    const args = await argsForSend('t-empty', { mcpServers: {}, allowedTools: [] })
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
  })

  it('a personal-ai-like profile produces all three flags in one argv', async () => {
    const args = await argsForSend('t-personal-ai-like', {
      systemPrompt: 'You are Walnut, a Personal AI.',
      systemPromptMode: 'replace',
      mcpServers: walnutMcpProfile().mcpServers,
      allowedTools: ['mcp__walnut', 'Read'],
    })
    expect(args).toContain('--system-prompt')
    expect(args).toContain('--mcp-config')
    expect(args).toContain('--allowedTools')
    // Profile flags sit BEFORE --input-format, i.e. inside the flag block the
    // daemon replays verbatim on a bridge resume.
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('--input-format'))
  })
})

// ══════════════════════════════════════════════════════════════════
//  2. Record round-trip (persist → cold-resume re-resolution)
// ══════════════════════════════════════════════════════════════════

describe('profile record round-trip', () => {
  it('createSessionRecord persists profile + lane and reads them back', async () => {
    const { createSessionRecord, getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const profile: SessionProfile = {
      systemPrompt: 'P',
      systemPromptMode: 'replace',
      mcpServers: { walnut: { command: 'open-walnut', args: ['mcp'] } },
      allowedTools: ['Read'],
    }
    await createSessionRecord('sid-profile', 'task-1', 'proj', tmpBase, { pid: 1234, profile, lane: 'personal-ai' })
    const record = await getSessionByClaudeId('sid-profile')
    expect(record?.profile).toEqual(profile)
    expect(record?.lane).toBe('personal-ai')
  })

  it('the persisted profile survives an unrelated record update (payload spill)', async () => {
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } =
      await import('../../src/core/session-tracker.js')
    const profile: SessionProfile = { mcpServers: { walnut: { command: 'open-walnut', args: ['mcp'] } } }
    await createSessionRecord('sid-spill', 'task-2', 'proj', tmpBase, { pid: 1235, profile, lane: 'lane-a' })
    await updateSessionRecord('sid-spill', { title: 'renamed' })
    const record = await getSessionByClaudeId('sid-spill')
    expect(record?.title).toBe('renamed')
    expect(record?.profile).toEqual(profile)
    expect(record?.lane).toBe('lane-a')
  })

  it('a spawned session persists its profile onto the record', async () => {
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const profile: SessionProfile = {
      systemPrompt: 'IDENTITY',
      systemPromptMode: 'replace',
      allowedTools: ['Read'],
    }
    const session = useDaemon(new ClaudeCodeSession('t-persist', 'proj', MOCK_CLI))
    session.send(
      'hello', tmpBase, undefined, 'bypass', undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { profile, lane: 'personal-ai' },
    )
    await session.awaitSpawn().catch(() => {})
    const sid = session.sessionId!
    // persistSessionRecord runs off the spawn/result path — poll for the row.
    let record: Awaited<ReturnType<typeof getSessionByClaudeId>> = null
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      record = await getSessionByClaudeId(sid)
      if (record?.profile) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await session.gracefulStop(true).catch(() => {})
    expect(record?.profile).toEqual(profile)
    expect(record?.lane).toBe('personal-ai')
  })

  it('resolveResumeArgs returns the record profile + lane for the cold-resume spawn', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
    const profile: SessionProfile = {
      systemPrompt: 'RESUMED IDENTITY',
      systemPromptMode: 'replace',
      mcpServers: { walnut: { command: 'open-walnut', args: ['mcp'] } },
      allowedTools: ['Read', 'Grep'],
    }
    await createSessionRecord('sid-resume', 'task-3', 'proj', tmpBase, { pid: 4321, profile, lane: 'personal-ai' })
    // Private method — reached through the instance under test, deliberately:
    // the contract asserted here is "the resume path re-reads the profile", and
    // every cold-spawn caller funnels through this one resolver.
    const resolved = await (sessionRunner as unknown as {
      resolveResumeArgs: (id: string) => Promise<{
        model?: string
        effort?: string
        profile?: SessionProfile
        lane?: string
      }>
    }).resolveResumeArgs('sid-resume')
    expect(resolved.profile).toEqual(profile)
    expect(resolved.lane).toBe('personal-ai')
  })

  it('resolveResumeArgs leaves profile undefined for a plain session', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
    await createSessionRecord('sid-plain', 'task-4', 'proj', tmpBase, { pid: 4322 })
    const resolved = await (sessionRunner as unknown as {
      resolveResumeArgs: (id: string) => Promise<{ profile?: SessionProfile; lane?: string }>
    }).resolveResumeArgs('sid-plain')
    expect(resolved.profile).toBeUndefined()
    expect(resolved.lane).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
//  3. Capacity — lane sessions never occupy a slot
// ══════════════════════════════════════════════════════════════════

describe('checkSessionLimit ignores lane sessions', () => {
  it('a lane session does not count toward the host limit', async () => {
    const { createSessionRecord, checkSessionLimit } = await import('../../src/core/session-tracker.js')
    await createSessionRecord('cap-lane', 't1', 'p', tmpBase, { pid: 1001, lane: 'personal-ai' })
    await createSessionRecord('cap-normal', 't2', 'p', tmpBase, { pid: 1002 })
    const result = await checkSessionLimit(undefined, { local: 2 })
    expect(result.running).toBe(1)
    expect(result.allowed).toBe(true)
  })

  it('lane sessions cannot exhaust capacity even at the limit', async () => {
    const { createSessionRecord, checkSessionLimit } = await import('../../src/core/session-tracker.js')
    await createSessionRecord('cap-lane-1', 't1', 'p', tmpBase, { pid: 1101, lane: 'personal-ai' })
    await createSessionRecord('cap-lane-2', 't2', 'p', tmpBase, { pid: 1102, lane: 'other' })
    const result = await checkSessionLimit(undefined, { local: 1 })
    expect(result.running).toBe(0)
    expect(result.allowed).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
//  4. Listing — lane sessions hidden by default, opt-in to include
// ══════════════════════════════════════════════════════════════════

describe('lane sessions are hidden from the default listings', () => {
  it('isListableSession excludes lane records and keeps plain ones', async () => {
    const { isListableSession, isLaneSession } = await import('../../src/core/session-tracker.js')
    const base = {
      claudeSessionId: 'x', taskId: 't', project: 'p',
      process_status: 'running' as const, mode: 'bypass' as const,
      startedAt: '', lastActiveAt: '', messageCount: 0,
    }
    expect(isListableSession(base)).toBe(true)
    expect(isLaneSession(base)).toBe(false)
    expect(isListableSession({ ...base, lane: 'personal-ai' })).toBe(false)
    expect(isLaneSession({ ...base, lane: 'personal-ai' })).toBe(true)
    // Empty string is not a lane (a blank field must not hide a real session).
    expect(isLaneSession({ ...base, lane: '' })).toBe(false)
  })

  it('getRecentSessions excludes lane records by default and includes them on request', async () => {
    const { createSessionRecord, getRecentSessions } = await import('../../src/core/session-tracker.js')
    await createSessionRecord('list-normal', 't1', 'p', tmpBase, { pid: 2001 })
    await createSessionRecord('list-lane', 't2', 'p', tmpBase, { pid: 2002, lane: 'personal-ai' })
    const ids = (await getRecentSessions(10)).map((s) => s.claudeSessionId)
    expect(ids).toContain('list-normal')
    expect(ids).not.toContain('list-lane')
    const withLanes = (await getRecentSessions(10, { includeLanes: true })).map((s) => s.claudeSessionId)
    expect(withLanes).toContain('list-lane')
  })

  it('buildSessionProjection excludes lane records', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { buildSessionProjection } = await import('../../src/core/session-projection.js')
    await createSessionRecord('proj-normal', 't1', 'p', tmpBase, { pid: 3001 })
    await createSessionRecord('proj-lane', 't2', 'p', tmpBase, { pid: 3002, lane: 'personal-ai' })
    const projection = await buildSessionProjection()
    const ids = projection.sessions.map((s) => s.id)
    expect(ids).toContain('proj-normal')
    expect(ids).not.toContain('proj-lane')
  })
})

// ══════════════════════════════════════════════════════════════════
//  5. Presets
// ══════════════════════════════════════════════════════════════════

describe('profile presets', () => {
  it('walnutMcpProfile mounts `open-walnut mcp` and nothing else', () => {
    expect(walnutMcpProfile()).toEqual({
      mcpServers: { walnut: { command: 'open-walnut', args: ['mcp'] } },
    })
  })

  it('personalAiProfile is a full-replace persona + the walnut MCP mount', () => {
    // Was "is a P3 stub" (it threw). P3 implemented it; the persona/addendum
    // contract lives in tests/core/personal-ai-lane.test.ts — this only pins the shape
    // the arg-assembly tests above depend on.
    const profile = personalAiProfile('Ada')
    expect(profile.systemPromptMode).toBe('replace')
    expect(profile.systemPrompt).toContain('You are Walnut')
    expect(profile.mcpServers).toEqual(walnutMcpProfile().mcpServers)
  })

  it('mergeProfiles unions mcpServers per key and dedupes allowedTools', () => {
    const merged = mergeProfiles(
      { mcpServers: { mine: { command: 'mine' } }, allowedTools: ['Read'] },
      walnutMcpProfile(),
    )
    expect(Object.keys(merged!.mcpServers!).sort()).toEqual(['mine', 'walnut'])
    expect(merged!.allowedTools).toEqual(['Read'])
    expect(mergeProfiles(undefined, walnutMcpProfile())).toEqual(walnutMcpProfile())
    expect(mergeProfiles(walnutMcpProfile(), undefined)).toEqual(walnutMcpProfile())
  })

  it('the overlay wins on a scalar field', () => {
    const merged = mergeProfiles(
      { systemPrompt: 'base', systemPromptMode: 'append' },
      { systemPrompt: 'overlay', systemPromptMode: 'replace' },
    )
    expect(merged).toEqual({ systemPrompt: 'overlay', systemPromptMode: 'replace' })
  })
})
