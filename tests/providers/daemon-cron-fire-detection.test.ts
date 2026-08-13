/**
 * L1 — Scheduled-task (CLI cron) fire detection (daemon-core.detectCronFires).
 *
 * Incident 2026-08-09: the Claude Code CLI scopes its cron scheduler lock to
 * the PROJECT DIRECTORY, not the session. Two Walnut sessions sharing a cwd
 * meant session B (lock holder) adopted and executed session A's recurring
 * cron as a bare user prompt — no marker, bypassPermissions, multi-hour
 * unattended job. The daemon detects the adoption from the on-disk
 * scheduled_tasks.json (lastFiredAt recent + we hold the lock).
 *
 * 2026-08-13 recurrence changed the RESPONSE: a foreign fire now EVICTS the
 * orphaned row from disk instead of injecting a provenance warning into the
 * model. The creator that hour was a bare CLI started outside Walnut, so no
 * Walnut death hook could ever clean it up and it hijacked a live session 22
 * times. These tests lock the pure decision functions.
 */
import { describe, it, expect } from 'vitest'
import {
  detectCronFires,
  cronFireMarkerText,
  stripCronTaskById,
  CRON_FIRE_RECENT_MS,
  hasDiskCronInterest,
  isDurableCronRequest,
  durableCronDenyMessage,
  durableCronCorrectionMessage,
  stripDurableTasksForSession,
} from '../../src/providers/daemon-core.js'

const SID_B = '97c874c5-1583-44b9-9de4-70d2ac083065'
const SID_A = '669f1798-c38a-44c1-a823-b2242c496a29'
const NOW = 1786246500000 // 2026-08-09T03:35:00Z-ish

function tasksJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tasks: [{
      id: '06481f0e',
      cron: '17 3 */1 * *',
      prompt: '使用 marina-sync skill 做一次全量数据同步,导出所有来源并上传…',
      createdAt: NOW - 76_000_000,
      lastFiredAt: NOW - 20_000, // fired 20s ago
      recurring: true,
      createdBySessionId: SID_A,
      ...overrides,
    }],
  })
}

function lockJson(sid: string): string {
  return JSON.stringify({ sessionId: sid, pid: 28148, procStart: '622632', acquiredAt: NOW - 1000 })
}

describe('detectCronFires', () => {
  it('detects a foreign adopted fire (the incident shape)', () => {
    const warned: Record<string, number> = {}
    const fires = detectCronFires({
      sid: SID_B, tasksJson: tasksJson(), lockJson: lockJson(SID_B), nowMs: NOW, warned,
    })
    expect(fires).toHaveLength(1)
    expect(fires[0].foreign).toBe(true)
    expect(fires[0].taskId).toBe('06481f0e')
    expect(fires[0].createdBySessionId).toBe(SID_A)
    expect(fires[0].promptPreview).toContain('marina-sync')
  })

  it('same-session fire is NOT foreign', () => {
    const fires = detectCronFires({
      sid: SID_A,
      tasksJson: tasksJson(),
      lockJson: lockJson(SID_A),
      nowMs: NOW,
      warned: {},
    })
    expect(fires).toHaveLength(1)
    expect(fires[0].foreign).toBe(false)
  })

  it('non-lock-holder sees nothing (only the holder executes fires)', () => {
    const fires = detectCronFires({
      sid: SID_A, tasksJson: tasksJson(), lockJson: lockJson(SID_B), nowMs: NOW, warned: {},
    })
    expect(fires).toHaveLength(0)
  })

  it('missing lock file sees nothing', () => {
    const fires = detectCronFires({
      sid: SID_B, tasksJson: tasksJson(), lockJson: null, nowMs: NOW, warned: {},
    })
    expect(fires).toHaveLength(0)
  })

  it('stale lastFiredAt (outside recentMs) is ignored', () => {
    const fires = detectCronFires({
      sid: SID_B,
      tasksJson: tasksJson({ lastFiredAt: NOW - CRON_FIRE_RECENT_MS - 1000 }),
      lockJson: lockJson(SID_B),
      nowMs: NOW,
      warned: {},
    })
    expect(fires).toHaveLength(0)
  })

  it('never-fired task (no lastFiredAt) is ignored', () => {
    const fires = detectCronFires({
      sid: SID_B,
      tasksJson: tasksJson({ lastFiredAt: undefined }),
      lockJson: lockJson(SID_B),
      nowMs: NOW,
      warned: {},
    })
    expect(fires).toHaveLength(0)
  })

  it('dedups by taskId:lastFiredAt across repeated checks, re-fires alert again', () => {
    const warned: Record<string, number> = {}
    const args = { sid: SID_B, tasksJson: tasksJson(), lockJson: lockJson(SID_B), nowMs: NOW, warned }
    expect(detectCronFires(args)).toHaveLength(1)
    expect(detectCronFires({ ...args, nowMs: NOW + 30_000 })).toHaveLength(0) // same fire, warned
    // Next day's fire = new lastFiredAt → new alert
    const nextFire = NOW + 86_400_000
    const fires = detectCronFires({
      sid: SID_B,
      tasksJson: tasksJson({ lastFiredAt: nextFire - 5000 }),
      lockJson: lockJson(SID_B),
      nowMs: nextFire,
      warned,
    })
    expect(fires).toHaveLength(1)
  })

  it('malformed JSON returns empty (never throws into the tailer)', () => {
    expect(detectCronFires({ sid: SID_B, tasksJson: '{oops', lockJson: '{worse', nowMs: NOW, warned: {} })).toHaveLength(0)
    expect(detectCronFires({ sid: SID_B, tasksJson: null, lockJson: null, nowMs: NOW, warned: {} })).toHaveLength(0)
    expect(detectCronFires({ sid: SID_B, tasksJson: '{}', lockJson: lockJson(SID_B), nowMs: NOW, warned: {} })).toHaveLength(0)
  })

  it('legacy task without createdBySessionId is reported but not foreign', () => {
    const fires = detectCronFires({
      sid: SID_B,
      tasksJson: tasksJson({ createdBySessionId: undefined }),
      lockJson: lockJson(SID_B),
      nowMs: NOW,
      warned: {},
    })
    expect(fires).toHaveLength(1)
    expect(fires[0].foreign).toBe(false)
  })
})

describe('cron fire messages', () => {
  const fire = {
    taskId: '06481f0e',
    lastFiredAt: NOW - 20_000,
    createdBySessionId: SID_A,
    foreign: true,
    promptPreview: '使用 marina-sync skill 做一次全量数据同步…',
  }
  it('marker text names the creator for foreign fires', () => {
    expect(cronFireMarkerText(fire)).toContain(SID_A)
    expect(cronFireMarkerText(fire)).toContain('another session')
    expect(cronFireMarkerText({ ...fire, foreign: false })).toContain('this session')
  })
  it('foreign marker tells the HUMAN what happened, and says it was removed', () => {
    // Design change 2026-08-13: a foreign fire no longer injects anything into
    // the model's input. The marker is a timeline row for the user only — the
    // hourly injected warning it replaced burned a turn + context every fire and
    // could not stop the loop (the model may rightly ignore an automated
    // message; one did on 2026-08-11). Eviction is what stops it.
    const m = cronFireMarkerText(fire)
    expect(m).toContain('Orphaned')
    expect(m).toContain(fire.taskId)
    expect(m).toContain(SID_A)
    expect(m).toContain('removed it')
  })
})

describe('hasDiskCronInterest (idle-reaper disk signal)', () => {
  const NOW2 = 1786246500000

  function disk(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      tasks: [{
        id: '06481f0e', cron: '17 3 */1 * *', prompt: 'daily sync', recurring: true,
        createdAt: NOW2 - 3600_000, lastFiredAt: NOW2 - 60_000,
        createdBySessionId: SID_A,
        ...over,
      }],
    })
  }

  it('creator of a live task is armed even WITHOUT the lock (lab P3: creators schedule their own tasks lock-free)', () => {
    const r = hasDiskCronInterest({ sid: SID_A, tasksJson: disk(), lockJson: lockJson(SID_B), nowMs: NOW2 })
    expect(r).toEqual({ armed: true, reason: 'creator', liveTasks: 1 })
  })

  it('lock holder is armed for a foreign live task (it will execute/adopt the next fire)', () => {
    const r = hasDiskCronInterest({ sid: SID_B, tasksJson: disk(), lockJson: lockJson(SID_B), nowMs: NOW2 })
    expect(r).toEqual({ armed: true, reason: 'lock_holder', liveTasks: 1 })
  })

  it('unrelated session (no lock, not creator) is NOT armed', () => {
    const r = hasDiskCronInterest({ sid: 'cccccccc-0000-0000-0000-000000000000', tasksJson: disk(), lockJson: lockJson(SID_B), nowMs: NOW2 })
    expect(r.armed).toBe(false)
    expect(r.liveTasks).toBe(1)
  })

  it('task past the 7-day auto-expiry does not arm anyone', () => {
    const old = NOW2 - 8 * 24 * 3600_000
    const r = hasDiskCronInterest({
      sid: SID_A,
      tasksJson: disk({ createdAt: old, lastFiredAt: old }),
      lockJson: lockJson(SID_A),
      nowMs: NOW2,
    })
    expect(r).toEqual({ armed: false, reason: null, liveTasks: 0 })
  })

  it('recent lastFiredAt keeps an old task live (fires reset the clock)', () => {
    const r = hasDiskCronInterest({
      sid: SID_A,
      tasksJson: disk({ createdAt: NOW2 - 8 * 24 * 3600_000, lastFiredAt: NOW2 - 3600_000 }),
      lockJson: null,
      nowMs: NOW2,
    })
    expect(r.armed).toBe(true)
  })

  it('missing/malformed files never throw and never arm', () => {
    expect(hasDiskCronInterest({ sid: SID_A, tasksJson: null, lockJson: null, nowMs: NOW2 }).armed).toBe(false)
    expect(hasDiskCronInterest({ sid: SID_A, tasksJson: '{bad', lockJson: '{worse', nowMs: NOW2 }).armed).toBe(false)
    expect(hasDiskCronInterest({ sid: SID_A, tasksJson: '{}', lockJson: null, nowMs: NOW2 }).armed).toBe(false)
  })
})

/**
 * INVARIANT: a Walnut-managed session may create crons, but never DURABLE ones.
 * durable:true persists to {cwd}/.claude/scheduled_tasks.json, and because the
 * CLI's scheduler lock is directory-scoped, the job outlives its session and is
 * adopted by whatever session shares the cwd (the 2026-08-09 incident).
 * durable:false is in-memory and can never be adopted.
 */
describe('isDurableCronRequest (durable-cron invariant)', () => {
  it('flags an explicit durable:true CronCreate', () => {
    expect(isDurableCronRequest('CronCreate', { cron: '17 3 * * *', prompt: 'x', durable: true })).toBe(true)
  })

  it('allows durable:false and the absent default (both session-scoped)', () => {
    expect(isDurableCronRequest('CronCreate', { cron: '* * * * *', prompt: 'x', durable: false })).toBe(false)
    expect(isDurableCronRequest('CronCreate', { cron: '* * * * *', prompt: 'x' })).toBe(false)
  })

  it('only truthy-ish strings/1 do NOT count — the CLI takes a real boolean', () => {
    expect(isDurableCronRequest('CronCreate', { durable: 'true' })).toBe(false)
    expect(isDurableCronRequest('CronCreate', { durable: 1 })).toBe(false)
  })

  it('ignores every other tool, even one carrying durable:true', () => {
    expect(isDurableCronRequest('Bash', { durable: true })).toBe(false)
    expect(isDurableCronRequest('CronDelete', { durable: true })).toBe(false)
    expect(isDurableCronRequest('CronList', { durable: true })).toBe(false)
    expect(isDurableCronRequest(undefined, { durable: true })).toBe(false)
  })

  it('never throws on malformed input', () => {
    expect(isDurableCronRequest('CronCreate', null)).toBe(false)
    expect(isDurableCronRequest('CronCreate', undefined)).toBe(false)
    expect(isDurableCronRequest('CronCreate', 'not-an-object')).toBe(false)
  })

  it('deny message tells the model exactly how to retry', () => {
    const m = durableCronDenyMessage()
    expect(m).toContain('durable:false')
    expect(m).toContain('scheduled_tasks.json')
    expect(m.toLowerCase()).toContain('project directory')
  })

  it('correction message orders CronDelete + non-durable recreate and disclaims human authorship', () => {
    const m = durableCronCorrectionMessage('06481f0e')
    expect(m).toContain('not from the user')
    expect(m).toContain('CronDelete')
    expect(m).toContain('06481f0e')
    expect(m).toContain('durable:false')
    // Without a task id the sentence must still read correctly (no "()" stub).
    expect(durableCronCorrectionMessage(undefined)).not.toContain('()')
  })
})

/**
 * Regression guard on the wire shape, captured from a REAL CLI 2.1.224 stream in
 * the 2026-08-10 lab (evidence D1.jsonl). If the CLI ever renames the field or
 * changes its type, these break instead of the guard silently going blind.
 */
describe('isDurableCronRequest against real CLI stream inputs', () => {
  it('catches the exact durable input the CLI emitted in the lab', () => {
    const realDurable = {
      cron: '* * * * *',
      recurring: true,
      durable: true,
      prompt: 'Run this exact command and nothing else: echo fired-$(date +%s) >> ./fired.log',
    }
    expect(isDurableCronRequest('CronCreate', realDurable)).toBe(true)
  })

  it('leaves the CLI default alone — the safe run omitted `durable` entirely', () => {
    const realDefault = {
      cron: '* * * * *',
      prompt: 'Run this exact command and nothing else: echo fired-$(date +%s) >> ./fired.log — do not investigate, do not read files, just run it and stop.',
      recurring: true,
    }
    expect(isDurableCronRequest('CronCreate', realDefault)).toBe(false)
  })
})

/**
 * Enforcement point 3 — the deterministic one. Points 1 and 2 need the model to
 * cooperate, and point 2 was verifiably REFUSED by a live CLI on 2026-08-11
 * (it reasoned that an automated message is not user authorization — correct
 * reasoning, which is why the guarantee cannot live there). reapSession strips
 * the dying session's own durable rows so nothing adoptable is left behind.
 */
describe('stripDurableTasksForSession (death-funnel enforcement)', () => {
  const other = 'dddddddd-0000-0000-0000-000000000000'
  function file(tasks: Array<Record<string, unknown>>) {
    return JSON.stringify({ tasks })
  }
  const mine = { id: 'aaa11111', cron: '*/5 * * * *', prompt: 'echo hi', recurring: true, createdBySessionId: SID_A }
  const theirs = { id: 'bbb22222', cron: '23 8 * * *', prompt: 'digest', recurring: true, createdBySessionId: other }

  it('removes only the dying session own rows', () => {
    const r = stripDurableTasksForSession(file([mine, theirs]), SID_A)
    expect(r.changed).toBe(true)
    expect(r.removed).toEqual(['aaa11111'])
    const kept = JSON.parse(r.text!).tasks
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('bbb22222')
  })

  it('a live sibling task is untouched — no change, no write', () => {
    const r = stripDurableTasksForSession(file([theirs]), SID_A)
    expect(r).toEqual({ changed: false, text: null, removed: [] })
  })

  it('a task with no createdBySessionId is not ours to delete', () => {
    const legacy = { id: 'ccc33333', cron: '0 0 * * *', prompt: 'legacy' }
    const r = stripDurableTasksForSession(file([legacy]), SID_A)
    expect(r.changed).toBe(false)
  })

  it('removing every task leaves a valid empty envelope (not a deleted file)', () => {
    const r = stripDurableTasksForSession(file([mine]), SID_A)
    expect(r.changed).toBe(true)
    expect(JSON.parse(r.text!)).toEqual({ tasks: [] })
  })

  it('preserves unknown envelope keys the CLI may add', () => {
    const raw = JSON.stringify({ version: 3, tasks: [mine, theirs], note: 'keep me' })
    const parsed = JSON.parse(stripDurableTasksForSession(raw, SID_A).text!)
    expect(parsed.version).toBe(3)
    expect(parsed.note).toBe('keep me')
    expect(parsed.tasks).toHaveLength(1)
  })

  it('writes trailing-newline pretty JSON (matches what the CLI writes)', () => {
    const t = stripDurableTasksForSession(file([mine, theirs]), SID_A).text!
    expect(t.endsWith('\n')).toBe(true)
    expect(t).toContain('\n  "tasks"')
  })

  it('missing / malformed / non-array input never throws and never writes', () => {
    for (const bad of [null, '{oops', '{}', JSON.stringify({ tasks: 'nope' }), '[]']) {
      const r = stripDurableTasksForSession(bad as string | null, SID_A)
      expect(r.changed).toBe(false)
      expect(r.text).toBeNull()
    }
  })

  it('the real production row shape is matched by creator id', () => {
    // Captured from the live host 2026-08-11 (ids/prompt neutralized).
    const real = JSON.stringify({ tasks: [{
      id: 'a54bef93', cron: '23 8 * * *', prompt: 'daily digest run',
      createdAt: 1786492090247, recurring: true,
      createdBySessionId: SID_A, createdByPid: 22270, createdByProcStart: '24731812',
    }] })
    expect(stripDurableTasksForSession(real, SID_A).removed).toEqual(['a54bef93'])
    expect(stripDurableTasksForSession(real, other).changed).toBe(false)
  })
})

/**
 * Enforcement point 4 — evict the orphaned row on the fire that hijacked us.
 *
 * Point 3 (stripDurableTasksForSession, on death) only covers crons created by a
 * session Walnut reaps. The 2026-08-13 recurrence was the other case: creator
 * e32173e4 was a bare CLI outside Walnut, in a shared monorepo directory, so
 * Walnut never saw it live or die — its durable row hijacked a real session every
 * hour, 22 times, and the only thing Walnut did was inject a warning each time.
 * Now the fire itself removes the row.
 */
describe('stripCronTaskById (evict one orphaned cron)', () => {
  const orphan = { id: '5f9afa25', cron: '23 * * * *', prompt: 'monitor a deploy', recurring: true, createdBySessionId: 'e32173e4-3a5c-4bf3-bc40-f50660a9fa7c' }
  const mine = { id: 'keepme01', cron: '0 9 * * *', prompt: 'my own loop', recurring: true, createdBySessionId: SID_B }

  it('removes exactly the fired task and leaves the rest', () => {
    const r = stripCronTaskById(JSON.stringify({ tasks: [orphan, mine] }), '5f9afa25')
    expect(r.changed).toBe(true)
    const kept = JSON.parse(r.text!).tasks
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('keepme01')
  })

  it('an id that is not present is a no-op (no needless write)', () => {
    expect(stripCronTaskById(JSON.stringify({ tasks: [mine] }), '5f9afa25')).toEqual({ changed: false, text: null })
  })

  it('removing the only task leaves a valid empty envelope', () => {
    const r = stripCronTaskById(JSON.stringify({ tasks: [orphan] }), '5f9afa25')
    expect(JSON.parse(r.text!)).toEqual({ tasks: [] })
  })

  it('preserves unknown envelope keys', () => {
    const r = stripCronTaskById(JSON.stringify({ version: 2, tasks: [orphan, mine], note: 'keep' }), '5f9afa25')
    const p = JSON.parse(r.text!)
    expect(p.version).toBe(2)
    expect(p.note).toBe('keep')
  })

  it('empty id, missing file, and malformed JSON are all inert', () => {
    for (const [json, id] of [
      [JSON.stringify({ tasks: [orphan] }), ''],
      [null, '5f9afa25'],
      ['{oops', '5f9afa25'],
      ['{}', '5f9afa25'],
      [JSON.stringify({ tasks: 'nope' }), '5f9afa25'],
    ] as Array<[string | null, string]>) {
      const r = stripCronTaskById(json, id)
      expect(r.changed).toBe(false)
      expect(r.text).toBeNull()
    }
  })

  it('the real 2026-08-13 row shape evicts cleanly', () => {
    const real = JSON.stringify({ tasks: [{
      id: '5f9afa25', cron: '23 * * * *', prompt: 'Monitor deployment of commit bb79c6a4…',
      createdAt: 1786560911468, lastFiredAt: 1786631652385, recurring: true,
      createdBySessionId: 'e32173e4-3a5c-4bf3-bc40-f50660a9fa7c', createdByPid: 2870, createdByProcStart: '35301053',
    }] })
    expect(JSON.parse(stripCronTaskById(real, '5f9afa25').text!).tasks).toEqual([])
  })
})
