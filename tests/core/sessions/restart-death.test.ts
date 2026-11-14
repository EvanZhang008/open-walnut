/**
 * When a daemon reports a CLI dead, which deaths restart recovery takes on
 * before the death is written (src/core/sessions/restart-death.ts), and a
 * ratchet over every place that writes a dead CLI's status.
 *
 * 2026-11-04: a remote host rebooted with 8 running sessions; the reconnect
 * pull wrote each death and handed the task back before restart recovery was
 * asked, so none was resumed. tests/e2e/restart-recovery-remote-host.test.ts
 * runs that drill end to end.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { restartWitness } from '../../../src/core/sessions/restart-death.js'
import type { SessionRecord } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-04T20:28:00.000Z')
const rec = (over: Partial<SessionRecord>): SessionRecord => ({
  claudeSessionId: 's1', taskId: 't1', host: 'devbox', process_status: 'running',
  lastActiveAt: '2026-11-04T20:20:00.000Z', last_status_change: '2026-11-04T20:20:00.000Z',
  ...over,
} as SessionRecord)

describe('restartWitness', () => {
  it('a live session found dead across a reconnect is a restart\'s', () => {
    expect(restartWitness(rec({}), 'reconnect', null, NOW)).toBe('reconnect')
    expect(restartWitness(rec({ process_status: 'idle' }), 'reconnect', null, NOW)).toBe('reconnect')
    // A record stuck at running for days is no work in flight.
    expect(restartWitness(rec({ lastActiveAt: '2026-11-01T00:00:00Z' }), 'reconnect', null, NOW)).toBeNull()
  })

  it('a live session found dead by a pull or push needs a daemon that started after it was last seen', () => {
    expect(restartWitness(rec({}), 'report', Date.parse('2026-11-04T20:26:00Z'), NOW)).toBe('daemon_restarted')
    // A crash or an idle reap on a daemon that has run all along: no restart.
    expect(restartWitness(rec({}), 'report', Date.parse('2026-11-04T08:00:00Z'), NOW)).toBeNull()
    expect(restartWitness(rec({}), 'report', null, NOW)).toBeNull()
    // A daemon swapped an hour ago left its CLIs alive: a death now is not its doing.
    const seenEarly = rec({ lastActiveAt: '2026-11-04T19:00:00Z' })
    expect(restartWitness(seenEarly, 'report', Date.parse('2026-11-04T19:28:00Z'), NOW)).toBeNull()
    // Within the host clock's margin: no proof the daemon came after.
    expect(restartWitness(rec({}), 'report', Date.parse('2026-11-04T20:20:30Z'), NOW)).toBeNull()
  })

  it('a death the record already shows counts when it is an infrastructure one and recent', () => {
    const lost = rec({ process_status: 'error', status_reason: 'remote_unreachable', last_status_change: '2026-11-04T20:25:00Z' })
    expect(restartWitness(lost, 'report', null, NOW)).toBe('connection_lost')
    // A host that took an hour to boot: its reconnect is still the first contact.
    const longAgo = { ...lost, last_status_change: '2026-11-04T19:20:00Z' }
    expect(restartWitness(longAgo, 'reconnect', null, NOW)).toBe('connection_lost')
    expect(restartWitness(longAgo, 'report', null, NOW)).toBeNull()
    expect(restartWitness({ ...lost, last_status_change: '2026-11-02T00:00:00Z' }, 'reconnect', null, NOW)).toBeNull()
    // A crash written on a working link is no restart's, whoever re-applies it.
    const crash = rec({ process_status: 'error', status_reason: 'daemon_reported_exit', last_status_change: '2026-11-04T20:27:00Z' })
    expect(restartWitness(crash, 'report', null, NOW)).toBeNull()
    expect(restartWitness(crash, 'reconnect', null, NOW)).toBeNull()
    // A settled stop is no loss.
    expect(restartWitness(rec({ process_status: 'stopped', status_reason: 'snapshot_projection', last_status_change: '2026-11-04T20:27:00Z' }), 'reconnect', null, NOW)).toBeNull()
  })

  it('never a stop someone meant', () => {
    expect(restartWitness(rec({ status_changed_by: 'user' }), 'reconnect', null, NOW)).toBeNull()
    expect(restartWitness(rec({ process_status: 'stopped', status_reason: 'expected_teardown', status_changed_by: 'system' }), 'reconnect', null, NOW)).toBeNull()
    expect(restartWitness(rec({ process_status: 'stopped', status_reason: 'idle_timeout' }), 'reconnect', null, NOW)).toBeNull()
    expect(restartWitness(rec({ stopRequest: { id: 'r1', requestedAt: '2026-11-04T20:20:00Z', state: 'pending' } }), 'reconnect', null, NOW)).toBeNull()
    expect(restartWitness(rec({ archived: true }), 'reconnect', null, NOW)).toBeNull()
  })
})

// ── Ratchet: every place that writes a dead CLI's status ──────────────────────

const ROOT = path.resolve(__dirname, '../../..')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * file → how many writers of a dead CLI's status it holds, and how each one lets
 * restart recovery speak first. A new writer fails here until it is listed.
 */
const DEATH_WRITERS: Record<string, { count: number; why: string }> = {
  'src/core/session-snapshot-apply.ts': { count: 1, why: 'applySnapshot notes a dead snapshot through noteRestartDeath before its write (every snapshot source: reconnect, the 30 s pull, a push, a recheck)' },
  'src/providers/daemon-connection.ts': { count: 2, why: 'the legacy reconnect relabel calls noteRestartDeath first; the ACP worker-gone relabel is an ACP engine, which restart recovery does not resume' },
  'src/providers/claude-code-session.ts': { count: 1, why: 'a live runner saw its remote CLI exit over a working link: no restart; its phase edge still passes the applySessionPhase gate' },
}

describe('dead CLI status writers', () => {
  it('each one is listed with how restart recovery speaks first', () => {
    const found: Record<string, number> = {}
    for (const file of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      const n = (text.match(/status_reason:[^,\n]*'daemon_reported_exit'/g) ?? []).length
      if (n) found[path.relative(ROOT, file)] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(DEATH_WRITERS).map(([f, v]) => [f, v.count])))
  })

  it('the snapshot apply and the legacy relabel note the death before they write it', () => {
    const apply = fs.readFileSync(path.join(ROOT, 'src/core/session-snapshot-apply.ts'), 'utf8')
    expect(apply.indexOf('noteRestartDeath(')).toBeGreaterThan(0)
    expect(apply.indexOf('noteRestartDeath(')).toBeLessThan(apply.indexOf("'daemon_reported_exit' : 'snapshot_projection'"))
    const conn = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-connection.ts'), 'utf8')
    const legacy = conn.indexOf("'daemon-reconnect:legacy'")
    expect(legacy).toBeGreaterThan(0)
    expect(conn.indexOf("status_reason: 'daemon_reported_exit'", legacy)).toBeGreaterThan(legacy)
  })

  it('applySessionPhase asks the turn\'s retriers (restart recovery among them) before any death edge hands a task back', () => {
    const phase = fs.readFileSync(path.join(ROOT, 'src/core/phase.ts'), 'utf8')
    const gate = phase.indexOf('turnRetryHoldsHandBack(opts.sessionId, opts.processAlive === false)')
    expect(gate).toBeGreaterThan(phase.indexOf('export async function applySessionPhase('))
    // After the send and error bookkeeping (a death still ends an interrupted wait), before any wait restore or write.
    expect(gate).toBeGreaterThan(phase.indexOf("if (trigger === 'session:input') {\n    noteTurnSend("))
    expect(gate).toBeLessThan(phase.indexOf('let resume: { waitUntil: string | null } | null = null'))
  })
})
