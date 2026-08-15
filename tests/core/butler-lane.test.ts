/**
 * Butler lanes (P3) — "one chat conversation ⇄ one long-lived Claude Code session".
 *
 * A lane key (`chat:<agentId>:<conversationId>`) is the durable binding between a
 * butler conversation and the `claude` session that answers its turns. This file
 * covers the two properties the whole feature rests on:
 *
 *   1. IDENTITY — one session per conversation, forever. A second call must reuse
 *      the record, and two conversations must never share a session.
 *   2. LAUNCH SHAPE — the SESSION_START the lane emits carries the butler profile
 *      (coordinator persona, full-replace, walnut MCP mounted) and the lane tag.
 *
 * ZERO real side effects: no `claude` is ever spawned — the 'session-runner'
 * subscriber here is a FAKE that only records events (and, being registered under
 * the same subscriber name, would displace a real runner rather than race it).
 * Every store is redirected into a temp dir by createMockConstants.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { butlerLaneKey, parseLaneKey, getOrCreateLaneSession } from '../../src/core/sessions/butler-lane.js'
import { butlerProfile, walnutMcpProfile } from '../../src/core/sessions/profiles.js'
import type { SessionStartEvent } from '../../src/core/event-types.js'

/** SESSION_START payloads captured from the fake runner, in emit order. */
let started: SessionStartEvent[] = []

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) {
      started.push(event.data as SessionStartEvent)
    }
  })
}

beforeEach(async () => {
  bus.clear()
  started = []
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
  installFakeRunner()
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ══════════════════════════════════════════════════════════════════
//  1. Lane identity
// ══════════════════════════════════════════════════════════════════

describe('lane key', () => {
  it('is namespaced per agent + conversation', () => {
    expect(butlerLaneKey('general', 'conv-abc')).toBe('chat:general:conv-abc')
    expect(butlerLaneKey('research', 'conv-abc')).toBe('chat:research:conv-abc')
  })
})

describe('parseLaneKey', () => {
  it('round-trips butlerLaneKey', () => {
    expect(parseLaneKey(butlerLaneKey('general', 'conv-abc')))
      .toEqual({ agentId: 'general', conversationId: 'conv-abc' })
    expect(parseLaneKey(butlerLaneKey('research', 'conv-9f2e-4a')))
      .toEqual({ agentId: 'research', conversationId: 'conv-9f2e-4a' })
  })

  it('splits ONCE — a conversation id keeps every colon it contains', () => {
    // Pinning the parse rule, not today's id format: agentId is the FIRST segment
    // after 'chat:', the conversationId is ALL the rest. A three-way split would
    // silently truncate the conversation id (→ token-truth written under a key
    // nothing reads) if conversation ids ever grow a separator.
    expect(parseLaneKey('chat:general:conv-a:b:c'))
      .toEqual({ agentId: 'general', conversationId: 'conv-a:b:c' })
  })

  it('returns null for anything that is not a butler chat lane', () => {
    expect(parseLaneKey(undefined)).toBeNull()
    expect(parseLaneKey(null)).toBeNull()
    expect(parseLaneKey('')).toBeNull()
    // Not our namespace — a future lane kind must not be read as a chat lane.
    expect(parseLaneKey('notes:general:conv-a')).toBeNull()
    // Prefix only / missing pieces.
    expect(parseLaneKey('chat:')).toBeNull()
    expect(parseLaneKey('chat:general')).toBeNull()
    expect(parseLaneKey('chat:general:')).toBeNull()
    expect(parseLaneKey('chat::conv-a')).toBeNull()
  })
})

describe('getOrCreateLaneSession', () => {
  it('creates once, then reuses the SAME session for the same conversation', async () => {
    const first = await getOrCreateLaneSession('general', 'conv-one', { firstMessage: 'hello' })
    expect(first.created).toBe(true)
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const second = await getOrCreateLaneSession('general', 'conv-one', { firstMessage: 'again' })
    expect(second.sessionId).toBe(first.sessionId)
    // created=false is the caller's signal to send the message itself — a second
    // `true` would mean the message rode a spawn that never happened.
    expect(second.created).toBe(false)
    // And no second spawn was requested.
    expect(started).toHaveLength(1)
  })

  it('gives different conversations different sessions', async () => {
    const a = await getOrCreateLaneSession('general', 'conv-a', { firstMessage: 'a' })
    const b = await getOrCreateLaneSession('general', 'conv-b', { firstMessage: 'b' })
    expect(b.sessionId).not.toBe(a.sessionId)
    expect(started.map((e) => e.lane)).toEqual(['chat:general:conv-a', 'chat:general:conv-b'])
  })

  it('gives different agents on the same conversation id different sessions', async () => {
    const g = await getOrCreateLaneSession('general', 'conv-shared', { firstMessage: 'g' })
    const r = await getOrCreateLaneSession('research', 'conv-shared', { firstMessage: 'r' })
    expect(r.sessionId).not.toBe(g.sessionId)
  })

  it('persists the lane on the record and hides it from the default listings', async () => {
    const { getSessionByLane, getRecentSessions, isLaneSession } =
      await import('../../src/core/session-tracker.js')
    const lane = await getOrCreateLaneSession('general', 'conv-record', { firstMessage: 'hi' })

    const record = await getSessionByLane('chat:general:conv-record')
    expect(record?.claudeSessionId).toBe(lane.sessionId)
    expect(record && isLaneSession(record)).toBe(true)
    // Seeded before the CLI exists — must not paint a phantom "working…" badge.
    expect(record?.process_status).toBe('idle')
    expect(record?.cwd).toBe(WALNUT_HOME)

    const listed = (await getRecentSessions(10)).map((s) => s.claudeSessionId)
    expect(listed).not.toContain(lane.sessionId)
    const withLanes = (await getRecentSessions(10, { includeLanes: true })).map((s) => s.claudeSessionId)
    expect(withLanes).toContain(lane.sessionId)
  })

  it('getSessionByLane returns null for an unknown lane and for an empty key', async () => {
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    await getOrCreateLaneSession('general', 'conv-only', { firstMessage: 'x' })
    expect(await getSessionByLane('chat:general:conv-missing')).toBeNull()
    expect(await getSessionByLane('')).toBeNull()
  })

  it('a lane lookup survives a row whose payload is not valid JSON', async () => {
    // json_extract RAISES on malformed JSON, so without the json_valid guard ONE
    // corrupt row would make the butler unable to find its own lane, ever.
    const { getSessionByLane, createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { getDb } = await import('../../src/core/session-db.js')
    await createSessionRecord('corrupt-row', 't', 'p', WALNUT_HOME, { pid: 1 })
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?')
      .run('not json at all', 'corrupt-row')

    const lane = await getOrCreateLaneSession('general', 'conv-after-corrupt', { firstMessage: 'x' })
    const found = await getSessionByLane('chat:general:conv-after-corrupt')
    expect(found?.claudeSessionId).toBe(lane.sessionId)
  })

  it('concurrent first sends for one conversation share a single session', async () => {
    // Two producers (chat + cron) can race the first record write; each minting
    // its own id would permanently split the conversation across two CLIs.
    const [a, b] = await Promise.all([
      getOrCreateLaneSession('general', 'conv-race', { firstMessage: 'a' }),
      getOrCreateLaneSession('general', 'conv-race', { firstMessage: 'b' }),
    ])
    expect(b.sessionId).toBe(a.sessionId)
    expect(started).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════════════
//  2. Launch shape — what SESSION_START actually carries
// ══════════════════════════════════════════════════════════════════

describe('the SESSION_START a lane emits', () => {
  it('carries the butler profile, the lane tag, and the pre-minted id', async () => {
    const lane = await getOrCreateLaneSession('general', 'conv-shape', { firstMessage: 'do a thing' })
    expect(started).toHaveLength(1)
    const ev = started[0]

    expect(ev.lane).toBe('chat:general:conv-shape')
    expect(ev.preassignedSessionId).toBe(lane.sessionId)
    // Taskless + rooted at the butler's own home dir.
    expect(ev.taskId).toBe('')
    expect(ev.cwd).toBe(WALNUT_HOME)
    // The user's message IS the first turn (created=true tells the caller not to
    // send it again).
    expect(ev.message).toBe('do a thing')

    // Full replacement of the CLI's own prompt, carrying the coordinator persona.
    expect(ev.profile?.systemPromptMode).toBe('replace')
    expect(ev.profile?.systemPrompt).toContain('You are Walnut, a personal intelligent butler')
    expect(ev.profile?.systemPrompt).toContain('You are a COORDINATOR, not an executor')
    // Walnut's data reaches the CLI over MCP, not native tools.
    expect(ev.profile?.mcpServers).toEqual(walnutMcpProfile().mcpServers)
    // Latency guard: without an explicit effort the CLI inherits the user's
    // global effortLevel (xhigh on coding-tuned machines → 100s+ chat turns).
    expect(ev.effort).toBe('medium')
  })
})

// ══════════════════════════════════════════════════════════════════
//  3. butlerProfile preset
// ══════════════════════════════════════════════════════════════════

describe('butlerProfile', () => {
  it('is a full-replace persona plus the walnut MCP mount', () => {
    const profile = butlerProfile('Ada')
    expect(profile.systemPromptMode).toBe('replace')
    expect(profile.mcpServers).toEqual(walnutMcpProfile().mcpServers)
    // No tool restriction in the MVP — the butler runs on the user's own machine.
    expect(profile.allowedTools).toBeUndefined()
  })

  it('interpolates the user name into the persona', () => {
    expect(butlerProfile('Ada').systemPrompt).toContain('a personal intelligent butler for Ada')
  })

  it('names the MCP task tools and the paste-verbatim citation rule', () => {
    const prompt = butlerProfile('Ada').systemPrompt!
    for (const tool of ['task_list', 'task_get', 'task_create', 'task_update', 'task_complete', 'search']) {
      expect(prompt).toContain(tool)
    }
    expect(prompt).toContain('Claude Code session')
    expect(prompt).toContain('verbatim')
    // Still a coordinator even though the CLI hands it file/shell tools.
    expect(prompt).toContain('coordinator, not an executor')
  })
})

// ══════════════════════════════════════════════════════════════════
//  4. ensureLaneClaudeMd — memory via {cwd}/CLAUDE.md @imports
// ══════════════════════════════════════════════════════════════════

describe('ensureLaneClaudeMd', () => {
  it('writes the managed CLAUDE.md with memory imports when none exists', async () => {
    const { ensureLaneClaudeMd } = await import('../../src/core/sessions/butler-lane.js')
    await ensureLaneClaudeMd()
    const content = await fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')
    expect(content).toContain('walnut:butler-lane-context')
    for (const imp of ['@AGENTS.md', '@memory/MEMORY.md', '@memory/USER.md']) {
      expect(content).toContain(imp)
    }
  })

  it('refreshes a stale MANAGED copy but never touches a user-authored file', async () => {
    const { ensureLaneClaudeMd } = await import('../../src/core/sessions/butler-lane.js')
    // Stale managed copy (has the marker, older body) → rewritten.
    await fsp.writeFile(`${WALNUT_HOME}/CLAUDE.md`, '<!-- walnut:butler-lane-context v1 -->\nold body\n', 'utf-8')
    await ensureLaneClaudeMd()
    expect(await fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')).toContain('@memory/MEMORY.md')

    // User-authored file (no marker) → byte-identical after the call.
    const userFile = '# My own instructions\ndo not touch\n'
    await fsp.writeFile(`${WALNUT_HOME}/CLAUDE.md`, userFile, 'utf-8')
    await ensureLaneClaudeMd()
    expect(await fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')).toBe(userFile)
  })

  it('is invoked by lane resolution (spawn path)', async () => {
    await getOrCreateLaneSession('general', 'conv-claudemd', { firstMessage: 'hi' })
    const content = await fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')
    expect(content).toContain('walnut:butler-lane-context')
  })
})
