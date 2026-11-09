/**
 * 2026-11-08 (Operations VP's reflection): an ask read in 10 s was told "not taken" 55 minutes into
 * the turn working on it, and its resend was told the same while the target answered the first.
 * The facts that decide it must survive a server restart and a dropped daemon link:
 *
 *   - every delivery that writes an ask into a CLI stamps its request `reachedAt` (the server's
 *     queue through session:messages-delivered, every host delivery path in offline-host-core.ts);
 *   - the host daemon's fold is read as at work only for a turn or work of its own;
 *   - a start refused with session_exists says what to do instead, never a dead end.
 *
 * The ratchets enumerate the members from the source: a new host delivery of an ask, or a new
 * place that tells an asker its target has not taken the work, fails until it keeps the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hostWorkFrom } from '../../../src/core/sessions/host-work.js'
import { sessionExistsHintFor } from '../../../src/core/sessions/session-exists-hint.js'
import type { SessionRequest } from '../../../src/core/session-requests.js'
import type { SessionSnapshot } from '../../../src/providers/daemon-fold.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  v: 1000, cliState: 'idle', turnActive: false, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
  teamActive: false, cronActive: false, wakeupAt: null, lastResult: null, pid: 42, exitCode: null, ...over,
})

describe('hostWorkFrom: the host daemon\'s fold read as at work', () => {
  const NOW = Date.parse('2026-11-08T04:57:25Z')
  it('a turn, background work, a team or an armed wakeup is work', () => {
    for (const over of [{ turnActive: true, cliState: 'running' as const }, { gatingBgCount: 1 }, { detachedBgCount: 2 }, { teamActive: true }, { wakeupAt: NOW + 60_000 }]) {
      expect(hostWorkFrom({ ok: true, exists: true, alive: true, snapshot: snap(over) }, NOW), JSON.stringify(over)).toEqual({ alive: true, working: true })
    }
  })
  it('idle between turns, a past wakeup, a /loop alone or a permission prompt is not', () => {
    for (const over of [{}, { wakeupAt: NOW - 1 }, { cronActive: true }, { turnActive: true, pendingPermission: { requestId: 'p1', toolName: 'Bash' } }]) {
      expect(hostWorkFrom({ ok: true, exists: true, alive: true, snapshot: snap(over) }, NOW), JSON.stringify(over)).toEqual({ alive: true, working: false })
    }
  })
  it('a dead process is stopped; no answer, an error or no record says nothing', () => {
    expect(hostWorkFrom({ ok: true, exists: true, alive: false, snapshot: snap({ turnActive: true }) }, NOW)).toEqual({ alive: false, working: false })
    expect(hostWorkFrom({ ok: true, exists: true, alive: true, snapshot: snap({ cliState: 'dead' }) }, NOW)).toEqual({ alive: false, working: false })
    expect(hostWorkFrom({ ok: true, exists: true, alive: false, snapshot: null }, NOW)).toEqual({ alive: false, working: false })
    expect(hostWorkFrom(null, NOW)).toBeNull()
    expect(hostWorkFrom({ ok: false }, NOW)).toBeNull()
    expect(hostWorkFrom({ ok: true, exists: false }, NOW)).toBeNull()
    expect(hostWorkFrom({ ok: true, exists: true, snapshot: snap({ v: 0 }) }, NOW)).toBeNull()
  })
})

describe('session_exists says what to do instead', () => {
  const row = (over: Partial<SessionRequest>): SessionRequest => ({
    id: 'rq-20eca396c5e9', fromSessionId: 'asker', toTaskId: 'task-1', preview: '', status: 'pending',
    createdAt: '2026-11-08T04:02:13.587Z', deadlineAt: 0, ...over,
  } as SessionRequest)
  it('with no open ask of the caller: send it, it reaches the session in any state', () => {
    const hint = sessionExistsHintFor('task-1', [])
    expect(hint.line).toContain('task_send {"to":"task-1"')
    expect(hint.line).toMatch(/stopped/)
    expect(hint.openRequest).toBeUndefined()
  })
  it('with one: it names it, whether the session has it, and says not to send it again', () => {
    const reached = sessionExistsHintFor('task-1', [row({ reachedAt: '2026-11-08T04:02:16.633Z' })])
    expect(reached.line).toContain('rq-20eca396c5e9')
    expect(reached.line).toContain('since 2026-11-08T04:02:16.633Z')
    expect(reached.line).toContain('do not send it again')
    expect(reached.openRequest).toEqual({ id: 'rq-20eca396c5e9', askedAt: '2026-11-08T04:02:13.587Z', reachedAt: '2026-11-08T04:02:16.633Z' })
    const queued = sessionExistsHintFor('task-1', [row({})])
    expect(queued.line).toMatch(/queued for its session/)
  })
  it('a delivery the queue took back (its process died unread) is not "has had it"', () => {
    const hint = sessionExistsHintFor('task-1', [row({ reachedAt: '2026-11-08T04:02:16.633Z', messageId: 'qm-1' })], new Set(['qm-1']))
    expect(hint.line).toMatch(/queued for its session/)
    expect(hint.openRequest?.reachedAt).toBeUndefined()
  })
  it('the newest of several is named', () => {
    const hint = sessionExistsHintFor('task-1', [row({ id: 'rq-old' }), row({ id: 'rq-new', createdAt: '2026-11-08T04:58:50Z' })])
    expect(hint.openRequest?.id).toBe('rq-new')
  })
  it('the start route adds the hint to every session_exists it answers', () => {
    const src = read('src/web/routes/task-v1.ts')
    const start = src.slice(src.indexOf("'/tasks/:id/start'"), src.indexOf("'/tasks/:id/start-queue'"))
    expect(start).toContain('sessionExistsHint(')
    expect(start).not.toMatch(/'session_exists', err\.message, \{ existing_session_id: err\.existingSessionId \}\)/)
  })
})

describe('ratchet: every host delivery of an ask stamps its request reached', () => {
  it('each journaled delivery of a new ask (not a reply) sets row.reachedAt just before it', () => {
    const src = read('src/providers/offline-host-core.ts').split('\n')
    const sites: number[] = []
    src.forEach((line, i) => {
      // A delivery record that carries a new ask's request: `...(row ? { requestId: row.id } : {})`.
      if (/kind: 'delivery'/.test(line) && /\(row \? \{ requestId: row\.id \} : \{\}\)/.test(line)) sites.push(i)
    })
    // localSend, the offline send and the leader's peer delivery (2026-11-08).
    expect(sites.length).toBeGreaterThanOrEqual(3)
    for (const i of sites) {
      const before = src.slice(Math.max(0, i - 4), i).join('\n')
      expect(before, `offline-host-core.ts:${i + 1}`).toMatch(/row\.reachedAt = /)
    }
  })

  it('the server stamps through the delivered event itself, so every emitter is covered', () => {
    const watch = read('src/core/sessions/request-reached.ts')
    expect(watch).toContain('EventNames.SESSION_MESSAGES_DELIVERED')
    expect(watch).toContain('markRequestsReached')
    expect(read('src/web/server.ts')).toContain('startRequestReachedWatch()')
    // The request names its queue row from the start, so a fast delivery is never missed.
    const send = read('src/core/sessions/session-send-core.ts')
    expect(send).toMatch(/createSessionRequest\(\{[\s\S]*?messageId: rowId,[\s\S]*?\}\)/)
  })

  it('only the silent-target notice tells an asker "not taken up", and it asks the host first', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name) && /has not taken up the work/.test(read(rel))) hits.push(rel)
      }
    }
    walk('src')
    expect(hits).toEqual(['src/core/sessions/session-request-notify.ts'])
    const notify = read(hits[0])
    const body = notify.slice(notify.indexOf('export async function remindSilent'), notify.indexOf('export async function remindOverdue'))
    expect(body.indexOf('probeHost(')).toBeGreaterThan(-1)
    expect(body.indexOf('probeHost(')).toBeLessThan(body.indexOf('claimSilentNotice('))
  })
})
