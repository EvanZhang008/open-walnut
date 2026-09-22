/**
 * Side-thread forks — the LAUNCH SHAPE of a hidden aside session.
 *
 * Four properties the feature rests on, all asserted from the record + the
 * SESSION_START payload (nothing is ever spawned: the 'session-runner'
 * subscriber here is a FAKE that only records events, and being registered under
 * the same name it would displace a real runner rather than race it):
 *
 *   1. TASKLESS + HIDDEN — taskId '', lane `side:<parent>:<thread>`.
 *   2. VERBATIM MODEL — the parent's `cliModel` ([1m] marker intact), never the
 *      reported `model`.
 *   3. WALK-UP — a parent that never ran a turn has no transcript to resume, so
 *      the fork targets ITS ancestor instead.
 *   4. ENGINE VETO — an engine without --fork-session is refused before anything
 *      is created.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-side-fork'))

/** The daemon's answer to `status {includeArgs}` for the parent: null = no live
 *  argv (old daemon / dead process / not connected). Set per test. */
let liveArgs: string[] | null = null
vi.mock('../../src/providers/daemon-connection.js', () => ({
  probeDaemonSessionArgs: async () => liveArgs,
}))

import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import {
  forkSideThreadSession, parseSideLaneKey, sideThreadLaneKey, isSideThreadLane,
  cachedSettingsReader, STANDBY_THREAD_ID, type LiveSettingsSource,
} from '../../src/core/sessions/side-thread-fork.js'
import { SessionControlError } from '../../src/core/sessions/session-controls.js'
import type { SessionStartEvent } from '../../src/core/event-types.js'

const PARENT = '11111111-1111-4111-8111-111111111111'
let started: SessionStartEvent[] = []

beforeEach(async () => {
  bus.clear()
  started = []
  liveArgs = null
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) started.push(event.data as SessionStartEvent)
  })
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

/** A parent that HAS a transcript: outputFile proves its CLI ran. */
async function seedParent(extra: Record<string, unknown> = {}) {
  return createSessionRecord(PARENT, 'task-77', 'proj', '/repo/walnut', {
    title: 'Fix the FIFO stall',
    host: 'clouddev',
    cliModel: 'opus[1m]',
    outputFile: '/tmp/streams/parent.jsonl',
    ...extra,
  })
}

describe('side lane keys', () => {
  it('round-trips parent + thread id', () => {
    expect(parseSideLaneKey(sideThreadLaneKey(PARENT, 'sth-1'))).toEqual({
      parentSid: PARENT, threadId: 'sth-1',
    })
    expect(sideThreadLaneKey(PARENT, STANDBY_THREAD_ID)).toBe(`side:${PARENT}:standby`)
  })

  it('returns null for anything that is not a side lane', () => {
    expect(parseSideLaneKey(undefined)).toBeNull()
    expect(parseSideLaneKey('')).toBeNull()
    expect(parseSideLaneKey('chat:general:conv-1')).toBeNull()
    expect(parseSideLaneKey('side:')).toBeNull()
    expect(parseSideLaneKey('side::thread')).toBeNull()
    expect(parseSideLaneKey(`side:${PARENT}:`)).toBeNull()
    expect(isSideThreadLane('chat:general:c1')).toBe(false)
    expect(isSideThreadLane(`side:${PARENT}:sth-1`)).toBe(true)
  })
})

describe('cachedSettingsReader', () => {
  // The whole point: a fork's critical path never waits on get_settings, which
  // answers serially on the CLI's stdin loop (measured queuing 16s+ behind a
  // heavy get_context_usage).
  it('answers from the snapshot even while refreshAppliedSettings hangs FOREVER', async () => {
    const refresh = vi.fn(() => new Promise(() => {})) // never resolves
    const source: LiveSettingsSource = {
      cachedAppliedSettings: () => ({ model: 'global.anthropic.claude-fable-5-1[1m]', effort: 'medium', atMs: Date.now() }),
      refreshAppliedSettings: refresh,
    }
    const read = cachedSettingsReader(() => source)
    const got = await read(PARENT) // must resolve immediately, not in 5s, not never
    expect(got).toMatchObject({ model: 'global.anthropic.claude-fable-5-1[1m]', effort: 'medium' })
    expect(got?.atMs).toBeTypeOf('number') // snapshot age rides into the fork telemetry
    expect(refresh).toHaveBeenCalledWith('fork-prefix') // background, for the NEXT fork
  })

  it('returns null before the first read-back (fresh attach) but still kicks the refresh', async () => {
    const refresh = vi.fn(async () => null)
    const read = cachedSettingsReader(() => ({
      cachedAppliedSettings: () => null,
      refreshAppliedSettings: refresh,
    }))
    expect(await read(PARENT)).toBeNull() // → record, which every switch persists first
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('returns null when no live session exists', async () => {
    expect(await cachedSettingsReader(() => undefined)(PARENT)).toBeNull()
  })

  it('a stale snapshot self-heals: the refresh each fork kicks off feeds the NEXT fork', async () => {
    // The staleness window is real (a mid-turn refusal fallback lands in the
    // snapshot only at turn-end) — the contract is that one fork may copy the
    // old value, and the background refresh it triggered corrects the next.
    let snapshot = { model: 'global.anthropic.claude-fable-5[1m]', effort: 'max' as const, atMs: Date.now() }
    const source: LiveSettingsSource = {
      cachedAppliedSettings: () => ({ ...snapshot }),
      refreshAppliedSettings: async () => {
        snapshot = { model: 'global.anthropic.claude-fable-5-1[1m]', effort: 'medium' as never, atMs: Date.now() }
        return null
      },
    }
    const read = cachedSettingsReader(() => source)
    expect((await read(PARENT))?.model).toBe('global.anthropic.claude-fable-5[1m]') // stale copy, tolerated
    await new Promise((r) => setImmediate(r)) // let the background refresh land
    expect((await read(PARENT))?.model).toBe('global.anthropic.claude-fable-5-1[1m]') // healed
  })

  it('a synchronously-throwing refresh cannot break the reader or leak a rejection', async () => {
    const read = cachedSettingsReader(() => ({
      cachedAppliedSettings: () => ({ model: 'opus[1m]', effort: null, atMs: Date.now() }),
      refreshAppliedSettings: () => { throw new Error('transport gone') },
    }))
    expect(await read(PARENT)).toMatchObject({ model: 'opus[1m]', effort: null })
    await new Promise((r) => setImmediate(r)) // an unhandled rejection would fail the file
  })
})

describe('forkSideThreadSession', () => {
  it('creates a taskless, lane-hidden record and emits the fork spawn', async () => {
    await seedParent()
    const { sessionId, resumeFromSessionId } = await forkSideThreadSession(PARENT, 'sth-a', {
      message: 'why does hasPipe go stale?',
    })

    const record = await getSessionByClaudeId(sessionId)
    expect(record?.taskId).toBe('')
    expect(record?.lane).toBe(`side:${PARENT}:sth-a`)
    expect(record?.forkedFromSessionId).toBe(PARENT)
    expect(record?.cwd).toBe('/repo/walnut')
    expect(record?.host).toBe('clouddev')
    expect(record?.project).toBe('proj')
    expect(resumeFromSessionId).toBe(PARENT)

    expect(started).toHaveLength(1)
    const ev = started[0]!
    expect(ev.preassignedSessionId).toBe(sessionId)
    expect(ev.taskId).toBe('')
    expect(ev.lane).toBe(`side:${PARENT}:sth-a`)
    expect(ev.forkedFromSessionId).toBe(PARENT)
    expect(ev.message).toBe('why does hasPipe go stale?')
    expect(ev.cwd).toBe('/repo/walnut')
    expect(ev.host).toBe('clouddev')
  })

  it('resumes on the parent\'s verbatim --model arg, not the reported model', async () => {
    // cliModel keeps the [1m] marker; `model` is the resolved id that lost it.
    await seedParent()
    await import('../../src/core/session-tracker.js').then(({ updateSessionRecord }) =>
      updateSessionRecord(PARENT, { model: 'global.anthropic.claude-opus-4-8-v1' }))
    await forkSideThreadSession(PARENT, 'sth-model')
    expect(started[0]!.model).toBe('opus[1m]')
  })

  it('spawns init-only (empty message) when no question rides along', async () => {
    await seedParent()
    await forkSideThreadSession(PARENT, STANDBY_THREAD_ID)
    expect(started[0]!.message).toBe('')
  })

  it('inherits the parent launch bundle (profile + effort)', async () => {
    await seedParent({ effort: 'high', profile: { systemPrompt: 'be terse' } })
    await forkSideThreadSession(PARENT, 'sth-bundle')
    expect(started[0]!.effort).toBe('high')
    expect(started[0]!.profile).toEqual({ systemPrompt: 'be terse' })
  })

  it('copies the append prompt from argv but the model/effort the parent runs NOW', async () => {
    // The 2026-09-21 "btw is slow" regression, pinned. argv is frozen at spawn
    // while model/effort are switchable mid-session (apply_flag_settings, no
    // respawn), and both are prompt-cache keys — so a fork built from argv asks
    // for the launch model at the launch effort, pays a full prefix write, and
    // has the history's signed thinking stripped as another model's.
    // The append prompt is the opposite: immutable, so argv stays its truth.
    await seedParent({ effort: 'high' })
    liveArgs = [
      'claude', '-p', '--model', 'global.anthropic.claude-fable-5[1m]', '--effort', 'max',
      '--append-system-prompt', 'the parent exact bytes', '--resume', PARENT,
    ]
    await forkSideThreadSession(PARENT, 'sth-live')
    const start = started[0]!
    expect(start.appendSystemPromptExact).toBe('the parent exact bytes')
    expect(start.model).toBe('opus[1m]')
    expect(start.effort).toBe('high')
    const thread = await getSessionByClaudeId(start.preassignedSessionId!)
    expect(thread?.appliedAppendSystemPrompt).toBe('the parent exact bytes')
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect((await getSessionByClaudeId(PARENT))?.appliedAppendSystemPrompt).toBe('the parent exact bytes')
  })

  it('spawns WITHOUT an append prompt when the parent live process has none', async () => {
    // A parent cold-resumed by an older server remembers a prompt its process
    // no longer runs with; copying the record would bust the cache.
    await seedParent({ appliedAppendSystemPrompt: 'stale' })
    await (await import('../../src/core/session-tracker.js')).updateSessionRecord(PARENT, { appliedAppendSystemPrompt: 'stale' })
    liveArgs = ['claude', '-p', '--model', 'opus[1m]', '--resume', PARENT]
    await forkSideThreadSession(PARENT, 'sth-none')
    expect(started[0]!.appendSystemPromptExact).toBeNull()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect((await getSessionByClaudeId(PARENT))?.appliedAppendSystemPrompt).toBe('')
  })

  it('falls back to the record prompt when the daemon has no live argv', async () => {
    await seedParent()
    await (await import('../../src/core/session-tracker.js')).updateSessionRecord(PARENT, { appliedAppendSystemPrompt: 'from record' })
    await forkSideThreadSession(PARENT, 'sth-record')
    expect(started[0]!.appendSystemPromptExact).toBe('from record')
    expect(started[0]!.model).toBe('opus[1m]')
  })

  it('an explicit model/effort pick OVERRIDES the copied prefix (record + spawn)', async () => {
    await seedParent({ effort: 'high' })
    liveArgs = [
      'claude', '-p', '--model', 'global.anthropic.claude-fable-5[1m]', '--effort', 'max',
      '--append-system-prompt', 'the parent exact bytes', '--resume', PARENT,
    ]
    const { sessionId } = await forkSideThreadSession(PARENT, 'sth-override', {
      message: 'answer this one cheaply',
      model: 'global.anthropic.claude-haiku-5',
      effort: 'low',
    })

    const start = started[0]!
    expect(start.model).toBe('global.anthropic.claude-haiku-5')
    expect(start.effort).toBe('low')
    // Only the two picked flags move: the append prompt is still the parent's
    // verbatim bytes (rebuilding it would bust the prefix for no reason).
    expect(start.appendSystemPromptExact).toBe('the parent exact bytes')
    const record = await getSessionByClaudeId(sessionId)
    expect(record?.cliModel).toBe('global.anthropic.claude-haiku-5')
    expect(record?.effort).toBe('low')
  })

  it('ignores a blank model pick and keeps inheriting the parent settings', async () => {
    await seedParent({ effort: 'high' })
    liveArgs = ['claude', '-p', '--model', 'opus[1m]', '--effort', 'max', '--resume', PARENT]
    await forkSideThreadSession(PARENT, 'sth-blank', { model: '   ' })
    expect(started[0]!.model).toBe('opus[1m]')
    expect(started[0]!.effort).toBe('high')
  })

  it('uses argv model/effort only when the record has neither (unreachable parent)', async () => {
    await seedParent()
    await (await import('../../src/core/session-tracker.js')).updateSessionRecord(
      PARENT, { cliModel: '', effort: undefined },
    )
    liveArgs = ['claude', '-p', '--model', 'global.anthropic.claude-fable-5[1m]', '--effort', 'max', '--resume', PARENT]
    await forkSideThreadSession(PARENT, 'sth-argv-last')
    // Dropping argv here would spawn with no --model and land the thread on the
    // CLI's default model — a worse miss than a stale one.
    expect(started[0]!.model).toBe('global.anthropic.claude-fable-5[1m]')
    expect(started[0]!.effort).toBe('max')
  })

  it('seeds output_mode from the pick and NEVER inherits the parent\'s injected marker', async () => {
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await seedParent()
    // The parent's CLI has already been told about rich mode; the fork's has not.
    await updateSessionRecord(PARENT, { output_mode: 'rich', output_mode_injected: 'rich' })

    const { sessionId } = await forkSideThreadSession(PARENT, 'sth-mode', { outputMode: 'markdown' })
    const record = await getSessionByClaudeId(sessionId)
    expect(record?.output_mode).toBe('markdown')
    // Inheriting the marker would make the thread's first send skip the
    // instruction — a brand-new CLI process owes the full one.
    expect(record?.output_mode_injected).toBeUndefined()
  })

  it('inherits the parent output_mode when no pick rides along', async () => {
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await seedParent()
    await updateSessionRecord(PARENT, { output_mode: 'rich', output_mode_injected: 'rich' })

    const { sessionId } = await forkSideThreadSession(PARENT, 'sth-inherit')
    const record = await getSessionByClaudeId(sessionId)
    expect(record?.output_mode).toBe('rich')
    expect(record?.output_mode_injected).toBeUndefined()
  })

  it('leaves output_mode unset when the parent follows the config default', async () => {
    await seedParent()
    const { sessionId } = await forkSideThreadSession(PARENT, 'sth-unset')
    // Unset = follow the LIVE config preference, which is not a value to freeze.
    expect((await getSessionByClaudeId(sessionId))?.output_mode).toBeUndefined()
  })

  it('walks ONE hop up when the parent never ran a turn', async () => {
    const ancestor = '22222222-2222-4222-8222-222222222222'
    // A seeded-but-never-spawned fork: its own id is in no JSONL yet.
    await createSessionRecord(PARENT, '', 'proj', '/repo/walnut', {
      forkedFromSessionId: ancestor,
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    })
    const { resumeFromSessionId } = await forkSideThreadSession(PARENT, 'sth-up')
    expect(resumeFromSessionId).toBe(ancestor)
    expect(started[0]!.forkedFromSessionId).toBe(ancestor)
  })

  it('refuses a never-turned parent with no ancestor to walk up to', async () => {
    await createSessionRecord(PARENT, '', 'proj', '/repo/walnut', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    })
    await expect(forkSideThreadSession(PARENT, 'sth-nope')).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(started).toHaveLength(0)
  })

  it('refuses an engine without --fork-session, before creating anything', async () => {
    await seedParent({ engine: 'codex' })
    const err = await forkSideThreadSession(PARENT, 'sth-codex').catch((e) => e)
    expect(err).toBeInstanceOf(SessionControlError)
    expect((err as SessionControlError).statusCode).toBe(409)
    expect((err as SessionControlError).extra?.code).toBe('ACP_FORK_UNSUPPORTED')
    expect(started).toHaveLength(0)
  })

  it('refuses a parent with no working directory', async () => {
    await createSessionRecord(PARENT, 'task-77', 'proj', undefined, {
      outputFile: '/tmp/streams/parent.jsonl',
    })
    await expect(forkSideThreadSession(PARENT, 'sth-nocwd')).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('404s on an unknown parent', async () => {
    await expect(forkSideThreadSession('does-not-exist', 'sth-x')).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
