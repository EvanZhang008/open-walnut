/**
 * A task-targeted routine run started on an always-on host while the Mac is away
 * (src/core/routines/offline-run.ts): which routines may run detached, and the
 * ClockStartSpec the host's daemon starts from.
 *
 * Why: the org reflections (each VP's "daily reflection" session routine, Main's
 * main-agent one) came due at 20:00/21:00 Pacific while the Mac slept, and nothing
 * ran. The run is a fresh routine-run task working for its owner through Walnut's
 * API, never a second conversation of the owner and never a file on the host that
 * only exists on the Mac. Fakes only: no config, no daemon, no model.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-offline-run'))

import { updateConfig } from '../../../src/core/config-manager.js'
import {
  OFFLINE_OWNER_INSTRUCTIONS_MAX, OFFLINE_OWNER_MEMORY_MAX, OWNER_SAMPLE_MAX_BYTES, __setOfflineRunDepsForTesting, defaultOfflineRunDeps, isOfflinePortable,
  offlineOwnerIdOf, ownerSection, sampleOwnerTranscript, type OwnerTranscript, offlinePortability, offlineRoutineStartOf, type OfflineOwner, type OfflineRunDeps,
} from '../../../src/core/routines/offline-run.js'
import { START_CONTEXT_MAX, START_TASK_TOKEN, validateClockStartSpec } from '../../../src/providers/trigger-clock-core.js'
import { validateTriggerDef } from '../../../src/providers/trigger-check-core.js'
import { frameAsWalnut } from '../../../src/core/sessions/send-frame.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const MAC_HOME = '/Users/me/.open-walnut'
const NOTES = `${MAC_HOME}/notes`
const USER_HOME = '/Users/me'
const HOST = 'cloudbox'
const REMOTE_ACCOUNT = '/home/me'
const BASE = Date.UTC(2026, 10, 13, 4, 0, 0)

/** The real Platform VP reflection's shape (2026-11-13 store), cut to what matters here. */
const VP_REFLECTION = [
  'Daily Platform VP reflection. Do it now, as the Platform VP, before 21:00 Pacific.',
  '1. Evidence, today\'s Pacific date only: what bothered the user (task_history rows with sentBy "person").',
  '2. Every item becomes one outcome: memory: your MEMORY.md and the project memory.',
  '   Read yesterday\'s file first (same path, yesterday\'s date).',
  `3. Write the result in Chinese to ${NOTES}/walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md (today's Pacific date).`,
  '4. The user: only a decision only they can make goes to them (one human_inbox_send letter).',
].join('\n')

/** The real Main reflection's shape: a folder with a trailing colon, and a vault-relative note. */
const MAIN_REFLECTION = [
  'Daily reflection for Main.',
  `0. Gather the VPs first. Read today's four VP reflections in ${NOTES}/walnut/reflections:`,
  '   Claude-Walnut-VP-reflection-<YYYY-MM-DD>.md (Walnut VP vp-walnut-1).',
  '5. Write the reflection in Chinese to the vault note walnut/reflections/Claude-Main-reflection-<YYYY-MM-DD>.md.',
].join('\n')

const sessionJob = (prompt: string, over: Partial<CronJob> & { config?: Record<string, unknown> } = {}): CronJob => {
  const { config, ...rest } = over
  return {
    id: 'job-vp-reflection', name: 'Platform VP daily reflection', enabled: true, wakeMode: 'now', createdAtMs: BASE, updatedAtMs: BASE,
    sessionTarget: 'isolated', payload: { kind: 'agentTurn', message: prompt },
    schedule: { kind: 'cron', expr: '0 20 * * *', tz: 'America/Los_Angeles' },
    executor: { type: 'session', config: { target: 'vp-platform', prompt, instructions: prompt, ...config } },
    state: {}, ...rest,
  } as unknown as CronJob
}

const mainJob = (prompt = MAIN_REFLECTION): CronJob => ({
  id: 'job-main-reflection', name: 'Main daily reflection', enabled: true, wakeMode: 'now', createdAtMs: BASE, updatedAtMs: BASE,
  sessionTarget: 'main', payload: { kind: 'systemEvent', text: prompt },
  schedule: { kind: 'cron', expr: '0 21 * * *', tz: 'America/Los_Angeles' },
  executor: { type: 'main-agent', config: { instructions: prompt } },
  state: {},
} as unknown as CronJob)

const VP: OfflineOwner = {
  id: 'vp-platform', title: 'Platform', project: 'Platform', phase: 'IN_PROGRESS', org_role: 'lead', org_name: 'Platform',
  org_instructions: { text: 'Answer the user in Chinese. Delegate code work to your teams.', at: '2026-11-10T00:00:00.000Z' },
  agent_memory: { text: '- CR 2 waits on the release watch go-ahead.', at: '2026-11-12T00:00:00.000Z' },
}
const MAIN: OfflineOwner = { id: 'main-1', title: 'Main agent', project: 'Ask Walnut', phase: 'IN_PROGRESS', org_role: 'main' }
const WORKER: OfflineOwner = { id: 'w-1', title: 'Promotion campaign', project: 'Walnut', phase: 'IN_PROGRESS' }

/** The owner's saved conversation: a person's long message (over the 4k a tail clips), the agent's answer, a tool row. */
const LONG_USER = `Please look at the release notes: ${'n'.repeat(6000)} END-OF-LONG`
const TRANSCRIPT: OwnerTranscript = {
  sessionId: 'sess-owner-1', savedAt: '2026-11-13T03:59:00.000Z', truncated: false,
  messages: [
    { role: 'user', text: 'Morning: fix the flaky deploy check.', timestamp: '2026-11-13T01:00:00.000Z' },
    { role: 'assistant', text: 'Done, the check is green.', timestamp: '2026-11-13T01:05:00.000Z' },
    { role: 'assistant', text: 'Bash: ls', timestamp: '2026-11-13T01:06:00.000Z', kind: 'tool' },
    { role: 'user', text: LONG_USER, timestamp: '2026-11-13T02:00:00.000Z' },
  ],
}

function deps(over: Partial<OfflineRunDeps> & { tasks?: OfflineOwner[] } = {}): OfflineRunDeps & { contextCalls: unknown[][] } {
  const { tasks = [VP, MAIN, WORKER], ...rest } = over
  const contextCalls: unknown[][] = []
  return {
    contextCalls,
    home: MAC_HOME,
    notesDir: NOTES,
    userHome: USER_HOME,
    getTask: async (id) => tasks.find((t) => t.id === id) ?? null,
    mainTask: async () => tasks.find((t) => t.org_role === 'main') ?? null,
    orgEnabled: async () => true,
    ownerSessions: async () => [{ process_status: 'idle', host: undefined, lastActiveAt: '2026-11-12T23:00:00.000Z' }],
    hostReady: async () => ({}),
    hostTags: async () => ['linux', 'always-on'],
    notesBlocker: async () => null,
    ownerTranscript: async () => TRANSCRIPT,
    remoteHome: async () => REMOTE_ACCOUNT,
    launchMode: async () => 'auto',
    sessionContext: async (...args) => {
      contextCalls.push(args)
      const task = args[0] as { id: string; title: string; project: string }
      return `You are working on the task "${task.title}" (id ${task.id}, project "${task.project}").\n\nUser rules as of now.`
    },
    ...rest,
  }
}

describe('offlinePortability: which routines a detached worker may run, item by item', () => {
  const env = { notesDir: NOTES, userHome: USER_HOME }

  it('an org lead\'s reflection: portable, its absolute Mac note path mapped to the notes API', () => {
    const r = offlinePortability(sessionJob(VP_REFLECTION), VP, env)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The whole name, its date placeholder included (the path reader stops at the "<").
    expect(r.notes).toEqual([{ named: `${NOTES}/walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md`, note: 'walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md' }])
    expect(isOfflinePortable(sessionJob(VP_REFLECTION), VP, env)).toBe(true)
  })

  it('Main\'s main-agent reflection: portable without an owner lookup; a folder named with a trailing colon maps to the folder', () => {
    const r = offlinePortability(mainJob(), undefined, env)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.notes).toEqual([{ named: `${NOTES}/walnut/reflections`, note: 'walnut/reflections' }])
  })

  it('a ~ path into the notes vault maps too', () => {
    const r = offlinePortability(sessionJob('Append a line to ~/.open-walnut/notes/journal/today.md'), VP, env)
    expect(r.ok && r.notes.map((n) => n.note)).toEqual(['journal/today.md'])
  })

  it('a session routine whose owner is not known yet (sync caller) is provisional, never a refusal; the owner decides later', () => {
    const r = offlinePortability(sessionJob(VP_REFLECTION), undefined, env)
    expect(r).toMatchObject({ ok: true, needsOrgOwner: true })
  })

  it('an explicit placement.portable on any target: portable whoever owns it', () => {
    const r = offlinePortability(sessionJob('Summarize today\'s open items for this task.', { config: { placement: { portable: true } } }), WORKER, env)
    expect(r).toMatchObject({ ok: true })
    expect(r.ok && r.needsOrgOwner).toBe(false)
  })

  it('refuses everything else, each with its reason', () => {
    const cases: Array<[string, CronJob, OfflineOwner | undefined, RegExp]> = [
      ['a plain worker task with no declaration', sessionJob('Summarize today.'), WORKER, /org main or lead|placement\.portable/],
      ['a disabled routine', sessionJob(VP_REFLECTION, { enabled: false }), VP, /disabled/],
      ['a trigger (check)', sessionJob(VP_REFLECTION, { check: { run: 'true', host: HOST } } as never), VP, /check/],
      ['a wake counter', sessionJob(VP_REFLECTION, { wake: { events: ['x'], threshold: 1 } } as never), VP, /wake|counter/],
      ['an init processor batch', sessionJob(VP_REFLECTION, { initProcessor: { kind: 'x' } } as never), VP, /batch|init/],
      ['a claude-code routine', { ...sessionJob(VP_REFLECTION), executor: { type: 'claude-code', config: { instructions: 'x', cwd: '/srv' } } } as never, undefined, /session or main/],
      ['a session routine with no target', sessionJob(VP_REFLECTION, { config: { target: '' } }), undefined, /target/],
      ['empty instructions', sessionJob('   '), VP, /instructions/],
      ['instructions too long to carry', sessionJob('x'.repeat(40 * 1024)), VP, /long/],
      ['a Mac tool', sessionJob('Use the browser-relay skill to read reddit.'), VP, /Mac's tools/],
      ['a file outside the notes vault', sessionJob('Read /Users/me/.claude/skills/walnut-promotion/SKILL.md and report.'), VP, /\/Users\/me\/\.claude\/skills/],
      ['a Walnut data file that is not a note', sessionJob(`Read ${MAC_HOME}/tasks/abc/brief.md`), VP, /tasks\/abc/],
      ['a task card pill the Mac expands', sessionJob('Look at <task-ref id="t1" label="x"/>'), VP, /card|pill|ref/],
      ['an invalid placement', sessionJob('Summarize.', { config: { placement: { portable: 'yes' } } }), WORKER, /placement/],
    ]
    for (const [what, job, owner, why] of cases) {
      const r = offlinePortability(job, owner, env)
      expect(r.ok, what).toBe(false)
      if (!r.ok) expect(r.why, what).toMatch(why)
    }
  })

  it('a completed owner is no owner', () => {
    expect(offlinePortability(sessionJob(VP_REFLECTION), { ...VP, phase: 'COMPLETE' }, env).ok).toBe(false)
  })
})

describe('offlineRoutineStartOf: the spec a host starts a detached run from', () => {
  it('an org lead\'s reflection: same instructions, a fresh routine-run task in the host\'s Walnut home, the owner context after the generic one', async () => {
    const d = deps()
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, d)
    expect(spec).not.toBeNull()
    expect(spec).toMatchObject({
      home: MAC_HOME, host: HOST, title: 'Routine: Platform VP daily reflection', project: 'Routines',
      cwd: `${REMOTE_ACCOUNT}/.open-walnut`, message: frameAsWalnut(VP_REFLECTION, 'routine', 'routine:job-vp-reflection:Platform VP daily reflection'), mode: 'auto', modeNamed: false,
    })
    // The generic context is built for the run's own task (the token), never as the owner, never with its role.
    expect(d.contextCalls).toHaveLength(1)
    expect(d.contextCalls[0][0]).toEqual({ id: START_TASK_TOKEN, title: 'Routine: Platform VP daily reflection', project: 'Routines' })
    expect(d.contextCalls[0][1]).toBe(`${REMOTE_ACCOUNT}/.open-walnut`)
    expect(d.contextCalls[0][2]).toBe(HOST)
    const ctx = spec!.context!
    expect(ctx.startsWith('You are working on the task "Routine: Platform VP daily reflection" (id __WALNUT_ROUTINE_TASK_ID__')).toBe(true)
    expect(ctx).toContain('User rules as of now.')
    // Who it works for, and how.
    expect(ctx).toContain('"Platform" (id vp-platform)')
    expect(ctx).toContain('"Platform" (id vp-platform), the "Platform" VP, the lead (VP) of project "Platform"')
    // Its conversation from the saved copy (no live read on a primary that is away), skimmed.
    expect(ctx).toContain('task_history id=vp-platform fresh=false compact=true')
    expect(ctx).toContain('agent_memory_read task=vp-platform')
    expect(ctx).toContain('agent_memory_write task=vp-platform')
    expect(ctx).toMatch(/task_send to=vp-platform[^\n]*expect_reply=false/)
    expect(ctx).toMatch(/do the work yourself/i)
    // The Mac path is a note on the notes API, not a file here.
    expect(ctx).toContain(`"${NOTES}/walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md" is the note path "walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md"`)
    expect(ctx).toMatch(/note_read[^\n]*note_write/)
    // A write that needs the server is not done.
    expect(ctx).toMatch(/needs the Walnut server[^\n]*not done/i)
    // Its standing words, quoted as reference, with the copy's date, and never as this run's role.
    expect(ctx).toContain('<owner_instructions at="2026-11-10T00:00:00.000Z">\nAnswer the user in Chinese. Delegate code work to your teams.\n</owner_instructions>')
    expect(ctx).toContain('<owner_memory at="2026-11-12T00:00:00.000Z">\n- CR 2 waits on the release watch go-ahead.\n</owner_memory>')
    expect(ctx).toMatch(/not your role/i)
    // Never the owner's powers.
    expect(ctx).toMatch(/never complete/i)
    expect(ctx).toMatch(/org role/i)
    expect(ctx).toMatch(/credentials/i)
    // It rides a def the daemon reads as it is.
    expect(validateClockStartSpec(spec).ok).toBe(true)
    const def = validateTriggerDef({ id: 'j', name: 'n', clock: { schedule: { kind: 'cron', expr: '0 20 * * *', tz: 'America/Los_Angeles' }, fromMs: BASE }, start: spec })
    expect(def.ok && def.def.start).toEqual(spec)
  })

  it('Main\'s reflection: the current Main is the owner, read at build time and never created', async () => {
    const mainTask = vi.fn(async () => MAIN)
    const spec = await offlineRoutineStartOf(mainJob(), HOST, deps({ mainTask }))
    expect(mainTask).toHaveBeenCalledTimes(1)
    expect(spec?.message).toBe(frameAsWalnut(MAIN_REFLECTION, 'routine', `routine:${mainJob().id}:${mainJob().name}`))
    expect(spec?.context).toContain('"Main agent" (id main-1), the user\'s main agent')
    expect(spec?.context).toContain('is the note path "walnut/reflections"')
    // Main's routing role ("route work, never do it") is not this run's: none of it rides along.
    expect(spec?.context).not.toMatch(/co-CEO/)
  })

  it('no Main yet: no run (the owner is never made here)', async () => {
    expect(await offlineRoutineStartOf(mainJob(), HOST, deps({ mainTask: async () => null }))).toBeNull()
  })

  it('a lead with no VP name reads as one clause; the instructions\' own asks (its instructions, a message to a task) are not forbidden', async () => {
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ tasks: [{ ...VP, org_name: undefined }] }))
    expect(spec?.context).toContain('"Platform" (id vp-platform), the lead (VP) of project "Platform"')
    const never = spec!.context!.split('\n').find((l) => l.startsWith('- Never complete'))
    expect(never).toBeDefined()
    expect(never).not.toMatch(/instructions/)
    expect(spec?.context).toMatch(/messages its instructions ask for still go out/)
  })

  it('the org switch: off, no run for a routine aimed at Main or a VP (declared or not); on, it runs; a plain task\'s declared routine is not the org\'s', async () => {
    const off = { orgEnabled: async () => false }
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps(off))).toBeNull()
    expect(await offlineRoutineStartOf(mainJob(), HOST, deps(off))).toBeNull()
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION, { config: { placement: { portable: true } } }), HOST, deps(off))).toBeNull()
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps())).not.toBeNull()
    expect(await offlineRoutineStartOf(mainJob(), HOST, deps())).not.toBeNull()
    const worker = sessionJob('Summarize today.', { config: { target: 'w-1', placement: { portable: true } } })
    const orgEnabled = vi.fn(async () => false)
    expect(await offlineRoutineStartOf(worker, HOST, deps({ orgEnabled }))).not.toBeNull()
    expect(orgEnabled).not.toHaveBeenCalled()
  })

  it('carries the owner\'s saved conversation: the newest visible messages whole (a >4k person message too), its session, time and truncation', async () => {
    const ctx = (await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps()))!.context!
    expect(ctx).toContain('<owner_conversation task="vp-platform" session="sess-owner-1" saved_at="2026-11-13T03:59:00.000Z" messages="3" older_not_here="0" left_out="0">')
    expect(ctx).toContain(`[2026-11-13T02:00:00.000Z] user:\n${LONG_USER}`)
    expect(ctx).toContain('[2026-11-13T01:05:00.000Z] agent:\nDone, the check is green.')
    expect(ctx).not.toContain('Bash: ls')
    expect(ctx).toMatch(/never its whole history/)
    expect(ctx).toMatch(/never say you read all of it/)
  })

  it('a person\'s message over the whole budget is never cut: left out whole and named; a transcript that was a tail says so', async () => {
    const huge = `HUGE-HEAD ${'h'.repeat(OWNER_SAMPLE_MAX_BYTES)} HUGE-TAIL`
    const t: OwnerTranscript = { ...TRANSCRIPT, truncated: true, messages: [...TRANSCRIPT.messages, { role: 'user', text: huge, timestamp: '2026-11-13T03:00:00.000Z' }] }
    const ctx = (await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ ownerTranscript: async () => t })))!.context!
    expect(ctx).not.toContain('HUGE-HEAD')
    expect(ctx).not.toContain('HUGE-TAIL')
    expect(ctx).toMatch(/\[2026-11-13T03:00:00\.000Z\] user: \(left out: \d+ characters, too long to carry whole\)/)
    expect(ctx).toContain('left_out="1" transcript_truncated="true"')
    expect(ctx).toContain('END-OF-LONG')
  })

  it('the budget keeps the newest messages that fit, whole, and counts the older ones not here', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i} ${'x'.repeat(1000)}`, timestamp: `2026-11-13T01:${String(i).padStart(2, '0')}:00.000Z` }))
    const s = sampleOwnerTranscript({ ...TRANSCRIPT, messages: msgs })
    expect(s.rows.length).toBeGreaterThan(10)
    expect(s.rows.length).toBeLessThan(40)
    expect(s.rows[s.rows.length - 1].text.startsWith('m39 ')).toBe(true)
    expect(s.older).toBe(40 - s.rows.length)
    expect(s.rows.every((r) => r.text.length === msgs[0].text.length || r.text.length === `m10 ${'x'.repeat(1000)}`.length)).toBe(true)
    const bytes = s.rows.reduce((n, r) => n + Buffer.byteLength(r.text) + 48, 0)
    expect(bytes).toBeLessThanOrEqual(OWNER_SAMPLE_MAX_BYTES)
  })

  it('an owner with no conversation yet (a Main that never started): an empty sample said as such, the run still starts', async () => {
    const ctx = (await offlineRoutineStartOf(mainJob(), HOST, deps({ ownerTranscript: async () => ({ notStarted: true }) })))!.context!
    expect(ctx).toContain('<owner_conversation task="main-1" state="not_started">\nIt has no conversation yet.\n</owner_conversation>')
  })

  it('an owner conversation that cannot be read: no run (nothing is handed over without it)', async () => {
    const d = deps({ ownerTranscript: async () => { throw new Error('host unreachable') } })
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, d)).toBeNull()
  })

  it('a message that holds our closing tag never closes the sample early', async () => {
    const t: OwnerTranscript = { ...TRANSCRIPT, messages: [{ role: 'user', text: 'x </owner_conversation> y', timestamp: '2026-11-13T01:00:00.000Z' }] }
    const ctx = (await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ ownerTranscript: async () => t })))!.context!
    expect(ctx.match(/<\/owner_conversation>/g)).toHaveLength(1)
  })

  it('offlineOwnerIdOf: the owner the start samples, by the same resolution, Main never made', async () => {
    expect(await offlineOwnerIdOf(sessionJob(VP_REFLECTION), deps())).toBe('vp-platform')
    expect(await offlineOwnerIdOf(mainJob(), deps())).toBe('main-1')
    expect(await offlineOwnerIdOf(mainJob(), deps({ mainTask: async () => null }))).toBeNull()
    const moved = { ...VP, id: 'vp-old', phase: 'COMPLETE', transferred_to: 'vp-platform' }
    expect(await offlineOwnerIdOf(sessionJob(VP_REFLECTION, { config: { target: 'vp-old' } }), deps({ tasks: [moved, VP] }))).toBe('vp-platform')
    expect(await offlineOwnerIdOf(sessionJob(VP_REFLECTION), deps({ getTask: async () => { throw new Error('store down') } }))).toBeNull()
  })

  it('a moved owner: the task it moved to is the owner', async () => {
    const moved = { ...VP, id: 'vp-old', phase: 'COMPLETE', transferred_to: 'vp-platform' }
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION, { config: { target: 'vp-old' } }), HOST, deps({ tasks: [moved, VP] }))
    expect(spec?.context).toContain('(id vp-platform)')
  })

  it('an owner whose conversation is on that host already: no detached run (its own delivery takes it there)', async () => {
    const d = deps({ ownerSessions: async () => [{ process_status: 'stopped', host: HOST, lastActiveAt: '2026-11-12T23:00:00.000Z' }] })
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, d)).toBeNull()
  })

  it('an owner whose conversation is on another host (the Mac, or a third box): the detached run goes on', async () => {
    const d = deps({ ownerSessions: async () => [{ process_status: 'idle', host: 'other-box' }] })
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, d)).not.toBeNull()
  })

  it('the owner\'s old repo folder never pins it: the run is in the host\'s Walnut home', async () => {
    const withCwd = { ...VP, cwd: '/Users/me/workplace/repo' } as OfflineOwner
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ tasks: [withCwd] }))
    expect(spec?.cwd).toBe(`${REMOTE_ACCOUNT}/.open-walnut`)
  })

  it('none when the host or its facts say no', async () => {
    const job = sessionJob(VP_REFLECTION)
    const cases: Array<[string, string, Partial<OfflineRunDeps>]> = [
      ['the Mac itself', '__local__', {}],
      ['no host', '', {}],
      ['host not ready (engine, config, session server)', HOST, { hostReady: async () => 'its engine is not Claude Code' }],
      ['Walnut home unknown', HOST, { remoteHome: async () => null }],
      ['context failed', HOST, { sessionContext: async () => { throw new Error('boom') } }],
      ['owner missing', HOST, { getTask: async () => null }],
      ['owner is a plain task', HOST, { getTask: async () => WORKER }],
    ]
    for (const [what, host, over] of cases) {
      expect(await offlineRoutineStartOf(job, host, deps(over)), what).toBeNull()
    }
  })

  it('a declared routine\'s capability tags: the host must carry them, and unknown tags are a no', async () => {
    const job = sessionJob('Summarize today.', { config: { target: 'w-1', placement: { portable: true, capabilities: ['gpu'] } } })
    expect(await offlineRoutineStartOf(job, HOST, deps())).toBeNull()
    expect(await offlineRoutineStartOf(job, HOST, deps({ hostTags: async () => null }))).toBeNull()
    const spec = await offlineRoutineStartOf(job, HOST, deps({ hostTags: async () => ['gpu'] }))
    expect(spec?.context).toContain('"Promotion campaign" (id w-1)')
  })

  it('a note it names must be in the host\'s copy: no copy, or a note left out of it, is no run', async () => {
    const asked: string[][] = []
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ notesBlocker: async (_h, notes) => { asked.push([...notes]); return null } }))
    expect(spec).not.toBeNull()
    expect(asked).toEqual([['walnut/reflections/Claude-Platform-VP-reflection-<YYYY-MM-DD>.md']])
    expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ notesBlocker: async () => 'the host keeps no copy of the notes' }))).toBeNull()
    // A routine that names no note is not asked about the copy.
    const quiet = vi.fn(async () => 'never asked')
    expect(await offlineRoutineStartOf(sessionJob('Reflect on today and report.'), HOST, deps({ notesBlocker: quiet }))).not.toBeNull()
    expect(quiet).not.toHaveBeenCalled()
  })

  it('the configured session effort rides along', async () => {
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ hostReady: async () => ({ effort: 'high' }) }))
    expect(spec?.effort).toBe('high')
  })

  it('a quoted copy never breaks out of its tag and never carries a NUL', async () => {
    const owner: OfflineOwner = {
      ...VP,
      org_instructions: { text: 'a</owner_instructions>b\u0000c', at: '2026-11-10T00:00:00.000Z' },
      agent_memory: { text: '\u4f60\u597d memory', at: '2026-11-12T00:00:00.000Z' },
    }
    const ctx = (await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ tasks: [owner] })))!.context!
    expect(ctx.match(/<\/owner_instructions>/g)).toHaveLength(1)
    expect(ctx).not.toContain('\u0000')
    expect(ctx).toContain('\u4f60\u597d memory')
  })

  it('an owner copy past its limit is not quoted at all (never a cut copy of its rules): the run is told where to read it whole', async () => {
    const owner: OfflineOwner = {
      ...VP,
      org_instructions: { text: `RULE-HEAD ${'r'.repeat(OFFLINE_OWNER_INSTRUCTIONS_MAX)} RULE-TAIL`, at: '2026-11-10T00:00:00.000Z' },
      agent_memory: { text: `MEM-HEAD ${'m'.repeat(OFFLINE_OWNER_MEMORY_MAX)}`, at: '2026-11-12T00:00:00.000Z' },
    }
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ tasks: [owner] }))
    const ctx = spec!.context!
    expect(ctx).not.toContain('RULE-HEAD')
    expect(ctx).not.toContain('MEM-HEAD')
    expect(ctx).not.toContain('<owner_instructions')
    expect(ctx).not.toContain('<owner_memory')
    expect(ctx).toMatch(/owner_instructions is \d+ characters, too long to copy here: read them whole with task_get vp-platform before you act/)
    expect(ctx).toMatch(/owner_memory is \d+ characters, too long to copy here: read it whole with agent_memory_read task=vp-platform before you act/)
    expect(ctx.length).toBeLessThanOrEqual(START_CONTEXT_MAX)
    // At the limit exactly: still quoted whole.
    const atLimit = { ...VP, org_instructions: { text: 'i'.repeat(OFFLINE_OWNER_INSTRUCTIONS_MAX), at: 'a' } }
    const whole = (await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ tasks: [atLimit] })))!.context!
    expect(whole).toContain(`<owner_instructions at="a">\n${'i'.repeat(OFFLINE_OWNER_INSTRUCTIONS_MAX)}\n</owner_instructions>`)
  })

  it('a generic context near the limit: the quoted copies go first, the rules and the conversation sample stay, the run still starts', async () => {
    // Room left for the rules and the sample of the real transcript, not for a 10k memory copy on top.
    const owner: OfflineOwner = { ...VP, agent_memory: { text: 'm'.repeat(10_000), at: '2026-11-12T00:00:00.000Z' } }
    const job = sessionJob(VP_REFLECTION)
    const verdict = offlinePortability(job, owner, { notesDir: NOTES, userHome: USER_HOME })
    if (!verdict.ok) throw new Error(verdict.why)
    const rules = ownerSection(job, owner, HOST, verdict.notes, { quotes: false, sample: sampleOwnerTranscript(TRANSCRIPT) })
    const big = 'x'.repeat(START_CONTEXT_MAX - rules.length - 100)
    const spec = await offlineRoutineStartOf(job, HOST, deps({ tasks: [owner], sessionContext: async () => big }))
    expect(spec).not.toBeNull()
    expect(spec!.context!.length).toBeLessThanOrEqual(START_CONTEXT_MAX)
    expect(spec!.context).toContain('agent_memory_read task=vp-platform')
    expect(spec!.context).toContain('<owner_conversation task="vp-platform" session="sess-owner-1"')
    expect(spec!.context).toContain('END-OF-LONG')
    expect(spec!.context).not.toContain('<owner_memory')
  })

  it('a generic context that leaves no room for the rules and the sample: no run, never a context past the limit', async () => {
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ sessionContext: async () => 'x'.repeat(START_CONTEXT_MAX - 5000) }))
    expect(spec).toBeNull()
  })

  it('a generic context over the limit on its own: no run', async () => {
    const spec = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps({ sessionContext: async () => 'x'.repeat(START_CONTEXT_MAX) }))
    expect(spec).toBeNull()
  })

  it('two builds of the same routine are the same spec (the set hash does not churn)', async () => {
    const a = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps())
    const b = await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST, deps())
    expect(a).toEqual(b)
  })
})

describe('the real wiring: the org switch read from config', () => {
  it('org.enabled false in config: no run for the VP reflection; back on: it runs', async () => {
    const { orgEnabled: _real, ...facts } = deps()
    __setOfflineRunDepsForTesting({ ...facts, notesBlocker: async () => null })
    const { _resetOrgEnabledForTesting } = await import('../../../src/core/org/org-enabled.js')
    try {
      await updateConfig({ hosts: { [HOST]: { hostname: 'cloudbox.example.test' } }, org: { enabled: false } } as never)
      _resetOrgEnabledForTesting()
      expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST)).toBeNull()
      await updateConfig({ org: { enabled: true } } as never)
      _resetOrgEnabledForTesting()
      expect(await offlineRoutineStartOf(sessionJob(VP_REFLECTION), HOST)).not.toBeNull()
    } finally {
      __setOfflineRunDepsForTesting(null)
      _resetOrgEnabledForTesting()
    }
  })
})

describe('the real wiring: test overrides on top, the host\'s notes copy read from config', () => {
  it('a host whose copy keeps no notes, or leaves the reflections folder out, is no run; one that keeps them is', async () => {
    const { notesBlocker: _real, home: _h, notesDir: _n, userHome: _u, ...facts } = deps()
    __setOfflineRunDepsForTesting({ ...facts, home: MAC_HOME, notesDir: NOTES, userHome: USER_HOME })
    try {
      const job = sessionJob(VP_REFLECTION)
      await updateConfig({ hosts: { [HOST]: { hostname: 'cloudbox.example.test' } } } as never)
      expect(await offlineRoutineStartOf(job, HOST)).not.toBeNull()
      await updateConfig({ hosts: { [HOST]: { hostname: 'cloudbox.example.test', keep: { notes: false } } } } as never)
      expect(await offlineRoutineStartOf(job, HOST)).toBeNull()
      await updateConfig({ hosts: { [HOST]: { hostname: 'cloudbox.example.test', keep: { notes: true, notes_exclude: ['walnut/reflections'] } } } } as never)
      expect(await defaultOfflineRunDeps().notesBlocker(HOST, ['walnut/reflections/a.md'])).toMatch(/left out/)
      expect(await offlineRoutineStartOf(job, HOST)).toBeNull()
    } finally {
      __setOfflineRunDepsForTesting(null)
    }
  })
})
