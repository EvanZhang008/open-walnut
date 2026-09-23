/**
 * Personal AI lanes (P3) — "one chat conversation ⇄ one long-lived Claude Code session".
 *
 * A lane key (`chat:<agentId>:<conversationId>`) is the durable binding between a
 * Personal AI conversation and the `claude` session that answers its turns. This file
 * covers the two properties the whole feature rests on:
 *
 *   1. IDENTITY — one session per conversation, forever. A second call must reuse
 *      the record, and two conversations must never share a session.
 *   2. LAUNCH SHAPE — the SESSION_START the lane emits carries the Personal AI profile
 *      (two work modes, full-replace, walnut MCP mounted) and the lane tag.
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
import { WALNUT_HOME, conversationFile } from '../../src/constants.js'
import { personalAiLaneKey, parseLaneKey, getOrCreateLaneSession } from '../../src/core/sessions/personal-ai-lane.js'
import { personalAiProfile, walnutMcpProfile } from '../../src/core/sessions/profiles.js'
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
    expect(personalAiLaneKey('general', 'conv-abc')).toBe('chat:general:conv-abc')
    expect(personalAiLaneKey('research', 'conv-abc')).toBe('chat:research:conv-abc')
  })
})

describe('parseLaneKey', () => {
  it('round-trips personalAiLaneKey', () => {
    expect(parseLaneKey(personalAiLaneKey('general', 'conv-abc')))
      .toEqual({ agentId: 'general', conversationId: 'conv-abc' })
    expect(parseLaneKey(personalAiLaneKey('research', 'conv-9f2e-4a')))
      .toEqual({ agentId: 'research', conversationId: 'conv-9f2e-4a' })
    expect(personalAiLaneKey('sample-plugin:observer', 'conv-plugin'))
      .toBe('chat:sample-plugin%3Aobserver:conv-plugin')
    expect(parseLaneKey(personalAiLaneKey('sample-plugin:observer', 'conv-plugin')))
      .toEqual({ agentId: 'sample-plugin:observer', conversationId: 'conv-plugin' })
  })

  it('splits ONCE — a conversation id keeps every colon it contains', () => {
    // Pinning the parse rule, not today's id format: agentId is the FIRST segment
    // after 'chat:', the conversationId is ALL the rest. A three-way split would
    // silently truncate the conversation id (→ token-truth written under a key
    // nothing reads) if conversation ids ever grow a separator.
    expect(parseLaneKey('chat:general:conv-a:b:c'))
      .toEqual({ agentId: 'general', conversationId: 'conv-a:b:c' })
  })

  it('returns null for anything that is not a Personal AI chat lane', () => {
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

  describe('engine: chats follow the ONE default engine', () => {
    afterEach(async () => {
      const { updateConfig } = await import('../../src/core/config-manager.js')
      await updateConfig({ defaults: { priority: 'backlog' } as never })
      const { _resetEngineProbeCache } = await import('../../src/core/agents/engine-probe.js')
      _resetEngineProbeCache()
      const { _resetDefaultEngineAvailabilityForTesting } = await import('../../src/core/agents/default-engine.js')
      _resetDefaultEngineAvailabilityForTesting()
    })

    it('a Codex default moves chat too, and the chat still gets Walnut’s persona', async () => {
      // One question, one answer: "which engine does Walnut use" covers coding
      // sessions, Ask Walnut and chats alike. The probe is pinned so the
      // default resolver never spawns `codex --version`.
      const { _seedEngineProbeCache } = await import('../../src/core/agents/engine-probe.js')
      _seedEngineProbeCache('codex', { installed: true, version: 'codex 0.9.0', reason: null })
      const { updateConfig } = await import('../../src/core/config-manager.js')
      await updateConfig({ defaults: { priority: 'backlog', engine: 'codex' } as never })

      // An ACP lane emits its SESSION_START and THEN waits for the record a real
      // spawn would create (90s). This test only judges the launch, so it waits
      // for the event, not for the (never-arriving) record.
      const pending = getOrCreateLaneSession('general', 'conv-codex-default', { firstMessage: 'hello there' })
        .catch(() => undefined)
      for (let i = 0; i < 100 && started.length < 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const start = started.at(-1)
      expect(start?.engine).toBe('codex')
      // ACP has no system-prompt channel: without the persona on the message a
      // Codex default would silently turn every chat into a bare provider chat.
      const { ASK_PROFILE_BANNER_OPEN, ASK_PROFILE_BANNER_CLOSE } = await import('../../src/core/sessions/ask-profile-prefix.js')
      expect(start?.message.startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true)
      expect(start?.message).toContain(ASK_PROFILE_BANNER_CLOSE)
      expect(start?.message.trimEnd().endsWith('hello there')).toBe(true)
      void pending
    })

    it('a default engine this machine cannot run falls back to claude instead of breaking chat', async () => {
      const { _seedEngineProbeCache } = await import('../../src/core/agents/engine-probe.js')
      _seedEngineProbeCache('codex', { installed: false, version: null, reason: 'not found on PATH' })
      // The launch path never probes under vitest; pull the pinned verdict into
      // the resolver's mirror the way the server's background refresh would.
      const { refreshDefaultEngineAvailability } = await import('../../src/core/agents/default-engine.js')
      await refreshDefaultEngineAvailability('codex')
      const { updateConfig } = await import('../../src/core/config-manager.js')
      await updateConfig({ defaults: { priority: 'backlog', engine: 'codex' } as never })

      await getOrCreateLaneSession('general', 'conv-codex-missing', { firstMessage: 'x' })
      expect(started.at(-1)?.engine ?? 'claude').toBe('claude')
    })

    it('an unknown default engine value reads as claude', async () => {
      const { updateConfig } = await import('../../src/core/config-manager.js')
      await updateConfig({ defaults: { priority: 'backlog', engine: 'not-an-engine' } as never })

      await getOrCreateLaneSession('general', 'conv-bad-engine', { firstMessage: 'z' })
      expect(started.at(-1)?.engine ?? 'claude').toBe('claude')
    })
  })

  it('gives different conversations different sessions', async () => {
    const a = await getOrCreateLaneSession('general', 'conv-a', { firstMessage: 'a' })
    const b = await getOrCreateLaneSession('general', 'conv-b', { firstMessage: 'b' })
    expect(b.sessionId).not.toBe(a.sessionId)
    expect(started.map((e) => e.lane)).toEqual(['chat:general:conv-a', 'chat:general:conv-b'])
  })

  it('gives different agents on the same conversation id different sessions', async () => {
    const g = await getOrCreateLaneSession('general', 'conv-shared', { firstMessage: 'g' })
    // Must be a REAL console agent: resolveLane now looks the id up in the
    // registry (55c33352) and throws on unknown ids. 'mentor' is a builtin.
    const r = await getOrCreateLaneSession('mentor', 'conv-shared', { firstMessage: 'r' })
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
    // corrupt row would make the Personal AI unable to find its own lane, ever.
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
  it('carries the Personal AI profile, the lane tag, and the pre-minted id', async () => {
    const lane = await getOrCreateLaneSession('general', 'conv-shape', { firstMessage: 'do a thing' })
    expect(started).toHaveLength(1)
    const ev = started[0]

    expect(ev.lane).toBe('chat:general:conv-shape')
    expect(ev.preassignedSessionId).toBe(lane.sessionId)
    // Taskless + rooted at the Personal AI's own home dir.
    expect(ev.taskId).toBe('')
    expect(ev.cwd).toBe(WALNUT_HOME)
    // The user's message IS the first turn (created=true tells the caller not to
    // send it again).
    expect(ev.message).toBe('do a thing')

    // Appended on top of the CLI's own prompt (keeps env/date/skills/MCP
    // instructions), carrying the two work modes.
    expect(ev.profile?.systemPromptMode).toBe('append')
    expect(ev.profile?.systemPrompt).toContain('Personal AI')
    expect(ev.profile?.systemPrompt).toContain('## Walnut operating contract')
    // Walnut's data reaches the CLI over MCP, not native tools.
    expect(ev.profile?.mcpServers).toEqual(walnutMcpProfile().mcpServers)
    // Latency guard: without an explicit effort the CLI inherits the user's
    // global effortLevel (xhigh on coding-tuned machines → 100s+ chat turns).
    expect(ev.effort).toBe('medium')
  })
})

// ══════════════════════════════════════════════════════════════════
//  3. personalAiProfile preset
// ══════════════════════════════════════════════════════════════════

describe('personalAiProfile', () => {
  it('is an appended persona plus the walnut MCP mount', () => {
    const profile = personalAiProfile('Ada')
    expect(profile.systemPromptMode).toBe('append')
    // The precedence header settles the identity conflict with the CLI's own
    // prompt (persona wins on identity/tone, default keeps tools/safety/env).
    expect(profile.systemPrompt).toContain('## Persona override')
    expect(profile.mcpServers).toEqual(walnutMcpProfile().mcpServers)
    // No tool restriction in the MVP — the Personal AI runs on the user's own machine.
    expect(profile.allowedTools).toBeUndefined()
  })

  it('interpolates the user name into the persona', () => {
    expect(personalAiProfile('Ada').systemPrompt).toContain('Personal AI')
    expect(personalAiProfile('Ada').systemPrompt).toContain('Ada')
  })

  it('carries the short operating contract without parameter tables', () => {
    const prompt = personalAiProfile('Ada').systemPrompt!
    expect(prompt).toContain('## Walnut operating contract')
    expect(prompt).toContain('`task_start` starts an existing task')
    // The 4-phase rewrite (22b34fee) deliberately dropped "Only a human may set
    // COMPLETE" for "You may set any phase; none is reserved" — assert TODAY's
    // rule, so this test states the contract rather than a retired one.
    expect(prompt).toContain('none is reserved')
    expect(prompt).toContain('NEED_ACTION')
    expect(prompt).not.toContain('/api/')
    expect(prompt).not.toContain('tasks.sqlite')
  })
})

// ══════════════════════════════════════════════════════════════════
//  4. Standing memory — Walnut-owned injection into the system prompt
//     (engine-neutral: never delivered via CLAUDE.md/AGENTS.md conventions)
// ══════════════════════════════════════════════════════════════════

describe('buildLaneMemoryContext', () => {
  it('injects memory and user profile without the home-directory AGENTS.md', async () => {
    const { buildLaneMemoryContext, LANE_MEMORY_HEADER } = await import('../../src/core/sessions/personal-ai-lane.js')
    await fsp.mkdir(`${WALNUT_HOME}/memory`, { recursive: true })
    await fsp.writeFile(`${WALNUT_HOME}/AGENTS.md`, '# Old vault layout\nSTALE-PARA-MARKER\n', 'utf-8')
    await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`, '## Deploy rule\nuse dev:prod\n', 'utf-8')
    await fsp.writeFile(`${WALNUT_HOME}/memory/USER.md`, '## Name\nAda\n', 'utf-8')

    const block = await buildLaneMemoryContext()
    expect(block).toContain(LANE_MEMORY_HEADER)
    expect(block).not.toContain('STALE-PARA-MARKER')
    expect(block).not.toContain('Home directory guide')
    expect(block).toContain('Deploy rule')
    expect(block).toContain('## Name')
  })

  it('missing files contribute nothing and never throw', async () => {
    const { buildLaneMemoryContext, LANE_MEMORY_HEADER } = await import('../../src/core/sessions/personal-ai-lane.js')
    const block = await buildLaneMemoryContext()
    expect(block).toContain(LANE_MEMORY_HEADER)
    expect(block).not.toContain('### Global memory')
  })

  it('the lane spawn carries the memory block inside profile.systemPrompt', async () => {
    await fsp.mkdir(`${WALNUT_HOME}/memory`, { recursive: true })
    await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`, '## Marker entry XYZZY\nbody\n', 'utf-8')
    await getOrCreateLaneSession('general', 'conv-meminject', { firstMessage: 'hi' })
    expect(started).toHaveLength(1)
    const prompt = started[0].profile?.systemPrompt ?? ''
    expect(prompt).toContain('Standing memory (injected by Walnut)')
    expect(prompt).toContain('Marker entry XYZZY')
  })

})

// ══════════════════════════════════════════════════════════════════
//  5. The conversation seed — a fresh lane is told what already happened
//
//  THE INVARIANT: every engine that answers a turn in a conversation must be
//  given that conversation's whole prior content. A lane minted for a
//  conversation that already has turns used to start with an EMPTY context while
//  the phone and the console kept rendering the whole thing, so it answered
//  "there is no such context in this conversation" about text on the screen.
// ══════════════════════════════════════════════════════════════════

/** Write a conversation store DIRECTLY — fixture data, no per-entry write lock. */
async function seedConversation(
  conversationId: string,
  turns: Array<{ user: string; assistant: string; engine?: string }>,
  compactionSummary: string | null = null,
): Promise<void> {
  const entries: unknown[] = []
  let t = Date.parse('2026-09-01T00:00:00.000Z')
  for (const turn of turns) {
    entries.push({ tag: 'ai', role: 'user', content: turn.user, timestamp: new Date(t += 1000).toISOString() })
    entries.push({
      tag: 'ai', role: 'assistant',
      content: [{ type: 'text', text: turn.assistant }],
      timestamp: new Date(t += 1000).toISOString(),
      ...(turn.engine ? { engine: turn.engine } : {}),
    })
  }
  const file = conversationFile('general', conversationId)
  await fsp.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({
    version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary, entries,
  }), 'utf-8')
}

async function storeOf(conversationId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(conversationFile('general', conversationId), 'utf-8'))
}

/** Standing memory of a known size — the half of the persona that GROWS. */
async function setMemory(bytes: number): Promise<void> {
  await fsp.mkdir(`${WALNUT_HOME}/memory`, { recursive: true })
  await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`, `## Standing notes\n\n${'m'.repeat(bytes)}\n`, 'utf-8')
}

/** A conversation big enough that the seed fills every byte of argv headroom. */
async function seedWhale(conversationId: string): Promise<void> {
  const body = 'z'.repeat(1500)
  await seedConversation(conversationId, Array.from({ length: 300 }, (_, i) => ({
    user: `question ${i}`, assistant: `answer ${i} ${body}`, engine: 'walnut-agent-fallback',
  })))
}

describe('the conversation seed on a fresh mint', () => {
  it('puts the prior turns in the spawn profile, newest last, without thinking or tool bytes', async () => {
    await seedConversation('conv-seeded', [
      { user: 'what broke the deploy?', assistant: 'A stale asset mirror.', engine: 'walnut-agent-fallback' },
      { user: 'and the fix?', assistant: 'One directory per build.', engine: 'walnut-agent-fallback' },
    ], '## Goal\nEARLIER-SUMMARY-MARKER')

    await getOrCreateLaneSession('general', 'conv-seeded', { firstMessage: 'anything else?' })
    const prompt = started[0].profile?.systemPrompt ?? ''

    expect(prompt).toContain('## Conversation so far (injected by Walnut)')
    expect(prompt).toContain('what broke the deploy?')
    expect(prompt).toContain('A stale asset mirror.')
    expect(prompt).toContain('EARLIER-SUMMARY-MARKER')
    // Order: the persona comes first, then the seed, then the turns in order.
    expect(prompt.indexOf('Personal AI')).toBeLessThan(prompt.indexOf('## Conversation so far'))
    expect(prompt.indexOf('A stale asset mirror.')).toBeLessThan(prompt.indexOf('One directory per build.'))
    // The message riding the spawn is NOT repeated inside the recap.
    expect(prompt).not.toContain('anything else?')

    // The record carries the identical string: a cold --resume re-emits the
    // record's prompt, and the cache prefix has to match the spawn byte for byte.
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    const record = await getSessionByLane('chat:general:conv-seeded')
    expect(record?.profile?.systemPrompt).toBe(prompt)

    // And the lane's high-water mark is latched, so the turn-time catch-up knows
    // this lane has already been given everything up to here.
    const store = await storeOf('conv-seeded')
    const laneSeen = store.laneSeen as Record<string, string>
    expect(laneSeen[`lane:${record!.claudeSessionId}`]).toBe(
      ((store.entries as Array<{ timestamp: string }>).at(-1))!.timestamp,
    )
  })

  it('mints with no seed at all for an empty conversation, but still latches the mark', async () => {
    const lane = await getOrCreateLaneSession('general', 'conv-fresh', { firstMessage: 'first ever' })
    expect(started[0].profile?.systemPrompt).not.toContain('## Conversation so far')
    const laneSeen = (await storeOf('conv-fresh')).laneSeen as Record<string, string>
    // Present with an empty value: the KEY is the "was seeded" latch.
    expect(Object.keys(laneSeen)).toEqual([`lane:${lane.sessionId}`])
    expect(laneSeen[`lane:${lane.sessionId}`]).toBe('')
  })

  it('caps a whale conversation under the spawn-argv ceiling, keeps the NEWEST turns, and says what it dropped', async () => {
    // The spawn prompt rides the argv and the provider THROWS over 64KB
    // (claude-code-session MAX_PROFILE_PROMPT_BYTES) — an uncapped seed would not
    // degrade, it would break the mint and take the whole chat down. One real
    // conversation on a live box holds 881 pre-lane entries.
    const body = 'z'.repeat(1500)
    const turns = Array.from({ length: 300 }, (_, i) => ({
      user: `question ${i}`, assistant: `answer ${i} ${body}`, engine: 'walnut-agent-fallback',
    }))
    await seedConversation('conv-whale', turns)

    await getOrCreateLaneSession('general', 'conv-whale', { firstMessage: 'next' })
    const prompt = started[0].profile?.systemPrompt ?? ''
    expect(Buffer.byteLength(prompt, 'utf-8')).toBeLessThan(65536)
    // Newest kept whole, oldest gone, and the omission is STATED — a silent
    // truncation reproduces the very failure being fixed.
    expect(prompt).toContain('question 299')
    expect(prompt).toContain(`answer 299 ${body}`)
    expect(prompt).not.toContain('question 0\n')
    expect(prompt).toContain('earlier turns omitted')
  })

  it('carries the recap in the FIRST MESSAGE when the argv could not hold the seed', async () => {
    // The argv is a hard ceiling the provider throws on; stdin is not. So a mint
    // with no headroom does not have to answer its first turn blind — it hands the
    // recap to the other carrier, the same one the turn-time catch-up uses, wrapped
    // in the same banner (the phone strips it, the console folds it away).
    await setMemory(62_000)
    await seedConversation('conv-blind', [
      { user: 'EARLIER-QUESTION', assistant: 'EARLIER-ANSWER', engine: 'walnut-agent-fallback' },
    ])
    await getOrCreateLaneSession('general', 'conv-blind', { firstMessage: 'go on then' })
    expect(started).toHaveLength(1)
    // The profile genuinely has no room for it…
    expect(started[0].profile?.systemPrompt).not.toContain('## Conversation so far')
    // …so the message carries it, with the user's own text LAST.
    const message = started[0].message ?? ''
    expect(message).toContain('[Conversation context]')
    expect(message).toContain('[/Conversation context]')
    expect(message).toContain('EARLIER-QUESTION')
    expect(message).toContain('EARLIER-ANSWER')
    expect(message.endsWith('go on then')).toBe(true)
    expect(message.indexOf('[/Conversation context]')).toBeLessThan(message.indexOf('go on then'))
    // Delivered, so the mark latches — the first real send must not repeat it.
    const store = await storeOf('conv-blind')
    const laneSeen = store.laneSeen as Record<string, string>
    expect(Object.values(laneSeen)).toEqual([
      ((store.entries as Array<{ timestamp: string }>).at(-1))!.timestamp,
    ])
  })

  it('carries NOTHING on a read-driven mint, and latches nothing either', async () => {
    // The `ensure: true` mint the phone's model pill fires on mount passes no
    // message at all. There is nothing to prepend to, and inventing a turn would
    // put a bubble on screen the user never sent — so this lane stays uncaught-up
    // on purpose, and buildLaneCatchUp trigger B delivers the recap on its first
    // real send. That only works if NO mark is latched here.
    await setMemory(62_000)
    await seedConversation('conv-readonly', [
      { user: 'EARLIER-QUESTION', assistant: 'EARLIER-ANSWER', engine: 'walnut-agent-fallback' },
    ])
    await getOrCreateLaneSession('general', 'conv-readonly')
    expect(started).toHaveLength(1)
    expect(started[0].message ?? '').toBe('')
    expect(started[0].profile?.systemPrompt).not.toContain('## Conversation so far')
    expect((await storeOf('conv-readonly')).laneSeen ?? {}).toEqual({})
  })

  it('does NOT latch the mark when the seed could not be rendered at all', async () => {
    // Fault injection standing in for any throw inside the builder (an unreadable
    // store, a lock timeout, a tokenizer failure): an out-of-contract field the
    // renderer trips on. It lands in the same "no seed" state as the headroom miss,
    // and must reach the same conclusion — do not claim this lane was seeded.
    await seedConversation('conv-fault', [{ user: 'q', assistant: 'a', engine: 'x' }])
    const store = await storeOf('conv-fault')
    const entries = store.entries as Array<Record<string, unknown>>
    entries[0] = { tag: 'ai', role: 'user', content: [], displayText: 42, timestamp: entries[0].timestamp }
    await fsp.writeFile(conversationFile('general', 'conv-fault'), JSON.stringify(store), 'utf-8')

    await getOrCreateLaneSession('general', 'conv-fault', { firstMessage: 'go' })
    expect(started).toHaveLength(1)
    expect(started[0].profile?.systemPrompt).not.toContain('## Conversation so far')
    expect((await storeOf('conv-fault')).laneSeen ?? {}).toEqual({})
  })
})

describe('profile drift repair vs. the frozen seed', () => {
  it('leaves the record untouched when only the CONVERSATION grew', async () => {
    await seedConversation('conv-drift', [{ user: 'q1', assistant: 'a1', engine: 'x' }])
    const lane = await getOrCreateLaneSession('general', 'conv-drift', { firstMessage: 'go' })
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    const minted = (await getSessionByLane('chat:general:conv-drift'))!.profile!.systemPrompt!

    // The conversation keeps growing, as it does on every turn. Rebuilding the
    // seed here would rewrite the record on EVERY send and break the byte-exact
    // prompt a cold --resume re-emits.
    await seedConversation('conv-drift', [
      { user: 'q1', assistant: 'a1', engine: 'x' },
      { user: 'q2', assistant: 'a2', engine: 'x' },
    ])
    const again = await getOrCreateLaneSession('general', 'conv-drift')
    expect(again.sessionId).toBe(lane.sessionId)
    expect((await getSessionByLane('chat:general:conv-drift'))!.profile!.systemPrompt).toBe(minted)
  })

  it('does not REWRITE the record when nothing changed', async () => {
    // The previous test proves the stored string is equal; this one proves no write
    // happened at all, by leaving a fingerprint only a write can erase: whitespace
    // that the persona comparison normalizes away (splitLanePrompt trims the
    // persona half). A repair that compared WHOLE prompts would see a difference,
    // rewrite the record, and drop it — which is the sqlite-write-per-send this
    // split exists to avoid.
    await seedConversation('conv-nowrite', [{ user: 'q1', assistant: 'a1', engine: 'x' }])
    await getOrCreateLaneSession('general', 'conv-nowrite', { firstMessage: 'go' })
    const { getSessionByLane, updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const minted = (await getSessionByLane('chat:general:conv-nowrite'))!
    const seedAt = minted.profile!.systemPrompt!.indexOf('## Conversation so far')
    const FINGERPRINT = '\n   \n'
    const marked = minted.profile!.systemPrompt!.slice(0, seedAt).trimEnd()
      + FINGERPRINT + minted.profile!.systemPrompt!.slice(seedAt)
    await updateSessionRecord(minted.claudeSessionId, { profile: { ...minted.profile!, systemPrompt: marked } })

    await getOrCreateLaneSession('general', 'conv-nowrite')
    const after = (await getSessionByLane('chat:general:conv-nowrite'))!.profile!.systemPrompt!
    expect(after).toContain(FINGERPRINT + '## Conversation so far')
  })

  it('clamps the repaired record to the provider ceiling when the PERSONA grew', async () => {
    // The mint clamps; the repair used to concatenate blind. Since the seed fills
    // the headroom the mint left, ANY persona growth beyond the reserve pushes the
    // record over the provider's 64KB argv limit — measured at 66,729 B from a
    // 60,729 B mint plus 6 KB of standing memory. Nothing notices at write time:
    // the next COLD RESUME throws inside the provider and the lane never comes
    // back, which is the same dead chat this whole change exists to prevent.
    await setMemory(20_000)
    await seedWhale('conv-repair')
    await getOrCreateLaneSession('general', 'conv-repair', { firstMessage: 'go' })
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    const minted = (await getSessionByLane('chat:general:conv-repair'))!.profile!.systemPrompt!
    expect(Buffer.byteLength(minted, 'utf-8')).toBeLessThanOrEqual(65536)

    await setMemory(20_000 + 8_000) // > LANE_SEED_RESERVE_BYTES, so it must clamp
    await getOrCreateLaneSession('general', 'conv-repair')
    const repaired = (await getSessionByLane('chat:general:conv-repair'))!.profile!.systemPrompt!
    expect(Buffer.byteLength(repaired, 'utf-8')).toBeLessThanOrEqual(65536)
    // The fresh persona landed, and the seed was SHRUNK rather than dropped: its
    // newest turns and the omission notice are still there.
    expect(Buffer.byteLength(repaired, 'utf-8')).toBeGreaterThan(Buffer.byteLength(minted, 'utf-8') / 2)
    expect(repaired).toContain('## Conversation so far')
    expect(repaired).toContain('answer 299')
    expect(repaired).toContain('earlier turns omitted')
  })

  it('drops the seed rather than write an unspawnable record when the persona alone eats the budget', async () => {
    await setMemory(20_000)
    await seedWhale('conv-crowded')
    await getOrCreateLaneSession('general', 'conv-crowded', { firstMessage: 'go' })
    // Standing memory balloons until the persona still fits but leaves less room
    // than a recap can say anything in. (A persona that ALONE exceeds the ceiling
    // is a pre-existing condition of its own — the mint cannot spawn that lane
    // either — and no amount of seed clamping fixes it.)
    await setMemory(56_000)
    await getOrCreateLaneSession('general', 'conv-crowded')
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    const repaired = (await getSessionByLane('chat:general:conv-crowded'))!.profile!.systemPrompt!
    expect(Buffer.byteLength(repaired, 'utf-8')).toBeLessThanOrEqual(65536)
    expect(repaired).not.toContain('## Conversation so far')
    // Survivable precisely because the record's seed only matters on a cold
    // resume, and a resumed CLI restores its own transcript.
    expect(repaired).toContain('m'.repeat(100))
  })

  it('splits at the seed WE appended, not at a header the persona happens to quote', async () => {
    // Standing memory or a skill can legitimately contain the header string. Split
    // at the FIRST occurrence and the whole persona is classified as "seed": the
    // persona half then never changes again, the repair silently stops repairing,
    // and the lane keeps a stale persona for life.
    await fsp.mkdir(`${WALNUT_HOME}/memory`, { recursive: true })
    await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`,
      '## Notes\n\nWalnut injects "## Conversation so far (injected by Walnut)" at mint. FIRST-MEMORY\n', 'utf-8')
    await seedConversation('conv-quote', [{ user: 'q', assistant: 'SEED-MARKER', engine: 'x' }])
    await getOrCreateLaneSession('general', 'conv-quote', { firstMessage: 'go' })
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')

    await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`,
      '## Notes\n\nWalnut injects "## Conversation so far (injected by Walnut)" at mint. SECOND-MEMORY\n', 'utf-8')
    await getOrCreateLaneSession('general', 'conv-quote')
    const after = (await getSessionByLane('chat:general:conv-quote'))!.profile!.systemPrompt!
    expect(after).toContain('SECOND-MEMORY')      // the repair still fires
    expect(after).not.toContain('FIRST-MEMORY')
    expect(after).toContain('SEED-MARKER')        // and the frozen seed survived
  })

  it('refreshes the PERSONA half while keeping the seed half byte-identical', async () => {
    await seedConversation('conv-persona', [
      { user: 'keep me', assistant: 'KEEP-THIS-SEED-MARKER', engine: 'x' },
    ])
    await getOrCreateLaneSession('general', 'conv-persona', { firstMessage: 'go' })
    const { getSessionByLane } = await import('../../src/core/session-tracker.js')
    const before = (await getSessionByLane('chat:general:conv-persona'))!.profile!.systemPrompt!
    const seedHalf = before.slice(before.indexOf('## Conversation so far'))

    // Standing memory changed — the persona bundle must be rebuilt.
    await fsp.mkdir(`${WALNUT_HOME}/memory`, { recursive: true })
    await fsp.writeFile(`${WALNUT_HOME}/memory/MEMORY.md`, '## New rule NEW-PERSONA-MARKER\n', 'utf-8')
    await getOrCreateLaneSession('general', 'conv-persona')

    const after = (await getSessionByLane('chat:general:conv-persona'))!.profile!.systemPrompt!
    expect(after).toContain('NEW-PERSONA-MARKER')
    expect(after.slice(after.indexOf('## Conversation so far'))).toBe(seedHalf)
    expect(after).toContain('KEEP-THIS-SEED-MARKER')
  })
})

describe('an ACP lane', () => {
  // DECISION REVERSED (2026-09-08): this used to pin "the user's message rides the
  // spawn UNCHANGED", on the grounds that splicing a recap into it would rewrite
  // the user's own first bubble. It would not: the store keeps the clean copy (both
  // senders persist before the mint), the phone strips the banner and the console
  // folds it into a collapsed row. So an ACP lane no longer answers its first turn
  // blind — the invariant has no exception for a transport. Do not reinstate.
  it('gets the recap in its FIRST MESSAGE — the message is its only carrier', async () => {
    // handleAcpStart takes no profile, so unlike a claude lane the message is not a
    // fallback here, it is the whole channel.
    await seedConversation('conv-acp', [
      { user: 'EARLIER-QUESTION', assistant: 'EARLIER-ANSWER', engine: 'walnut-agent-fallback' },
    ])
    const started0 = started.length
    const pending = getOrCreateLaneSession('general', 'conv-acp', { firstMessage: 'hello acp', engine: 'codex' })
    await new Promise((r) => setTimeout(r, 50))
    expect(started.length).toBe(started0 + 1)
    const ev = started[started0]
    expect(ev.profile).toBeUndefined()   // still no system-prompt channel
    const message = ev.message ?? ''
    expect(message).toContain('[Conversation context]')
    expect(message).toContain('[/Conversation context]')
    expect(message).toContain('EARLIER-ANSWER')
    expect(message.endsWith('hello acp')).toBe(true)

    // Nothing is latched until the worker establishes: an ACP session id is minted
    // by the provider, so the mint waits for the record before it can name the lane
    // — and a session that never establishes delivered nothing.
    expect((await storeOf('conv-acp')).laneSeen).toBeUndefined()

    // Stand in for handleAcpStart adopting the worker's own session id.
    const ACP_SID = 'acp-1111-2222-3333'
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    await createSessionRecord(ACP_SID, '', '', WALNUT_HOME, {
      lane: 'chat:general:conv-acp', engine: 'codex' as never,
    })
    expect((await pending).sessionId).toBe(ACP_SID)
    // Delivered → latched, so the first real send does not repeat it.
    const laneSeen = (await storeOf('conv-acp')).laneSeen as Record<string, string>
    expect(Object.keys(laneSeen)).toEqual([`lane:${ACP_SID}`])
  })

  it('carries NOTHING on a message-less ACP mint, and latches nothing either', async () => {
    // Same guard as the claude branch: no message to ride means no splice, and no
    // latch — buildLaneCatchUp trigger B owns that lane's first real send.
    await seedConversation('conv-acp-quiet', [
      { user: 'EARLIER-QUESTION', assistant: 'EARLIER-ANSWER', engine: 'walnut-agent-fallback' },
    ])
    const started0 = started.length
    void getOrCreateLaneSession('general', 'conv-acp-quiet', { engine: 'codex' })
    await new Promise((r) => setTimeout(r, 50))
    expect(started.length).toBe(started0 + 1)
    expect(started[started0].message ?? '').toBe('')
    expect((await storeOf('conv-acp-quiet')).laneSeen).toBeUndefined()
  })
})

describe('retired managed CLAUDE.md', () => {
  it('is removed across naming versions, never a user-authored one', async () => {
    const { cleanupLaneClaudeMd } = await import('../../src/core/sessions/personal-ai-lane.js')
    const markers = [
      '<!-- walnut:personal-ai-lane-context v1 -->',
      `<!-- walnut:${String.fromCharCode(98, 117, 116, 108, 101, 114)}-lane-context v1 -->`,
    ]
    for (const marker of markers) {
      await fsp.writeFile(`${WALNUT_HOME}/CLAUDE.md`, `${marker}\nold imports\n`, 'utf-8')
      await cleanupLaneClaudeMd()
      await expect(fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')).rejects.toThrow()
    }

    const userFile = '# My own instructions\ndo not touch\n'
    await fsp.writeFile(`${WALNUT_HOME}/CLAUDE.md`, userFile, 'utf-8')
    await cleanupLaneClaudeMd()
    expect(await fsp.readFile(`${WALNUT_HOME}/CLAUDE.md`, 'utf-8')).toBe(userFile)
  })
})
