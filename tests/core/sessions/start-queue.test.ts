/**
 * The start queue's pure rules (core/sessions/start-queue.ts) and a guard on its words.
 *
 * Why the guard: 2026-11-03 a VP at a full slot read "do this part with your own tools" in
 * the refusal and did the work itself. A full slot means "queued"; no refusal of a full host
 * and no queued answer may tell the caller to do the work itself. The guard scans every place
 * in src/ that throws the full-host refusal or catches an older server's cap, plus the queue
 * and admission modules, so a NEW site with those words fails too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { heldByTeamStop, queueOrder } from '../../../src/core/sessions/start-queue.js'
import { queuedOutcome } from '../../../src/ops/task-execution.js'

const DO_IT_YOURSELF = /own tools|do (it|this part|that part|the work) yourself/i

type Row = { id: string; priority?: 'immediate' | 'important' | 'backlog'; start_queue?: { at: string; parent_id: string; caller_sid: string; params: object } }
const row = (id: string, at: string, priority?: Row['priority']): Row => ({
  id, ...(priority ? { priority } : {}), start_queue: { at, parent_id: 'p', caller_sid: 's', params: {} },
})

describe('queue order', () => {
  it('takes priority first (immediate, important, unset, backlog), then the oldest queued', () => {
    const rows = [
      row('backlog-old', '2026-11-03T00:00:00Z', 'backlog'),
      row('none-new', '2026-11-03T00:05:00Z'),
      row('none-old', '2026-11-03T00:01:00Z'),
      row('important', '2026-11-03T00:09:00Z', 'important'),
      row('immediate', '2026-11-03T00:10:00Z', 'immediate'),
    ]
    expect([...rows].sort(queueOrder as never).map((r) => r.id))
      .toEqual(['immediate', 'important', 'none-old', 'none-new', 'backlog-old'])
  })
})

describe('team stop hold', () => {
  it('holds a task whose own task or any ancestor carries a team stop, and survives a parent loop', () => {
    const stop = { at: 'x', by: 'human', when: 'now' as const, members: [] }
    const byId = new Map<string, any>([
      ['root', { id: 'root', team_stop: stop }],
      ['mid', { id: 'mid', parent_task_id: 'root' }],
      ['leaf', { id: 'leaf', parent_task_id: 'mid' }],
      ['free', { id: 'free', parent_task_id: 'other' }],
      ['other', { id: 'other' }],
      ['a', { id: 'a', parent_task_id: 'b' }],
      ['b', { id: 'b', parent_task_id: 'a' }],
    ])
    expect(heldByTeamStop(byId.get('leaf'), byId)).toBe(true)
    expect(heldByTeamStop(byId.get('root'), byId)).toBe(true)
    expect(heldByTeamStop(byId.get('free'), byId)).toBe(false)
    expect(heldByTeamStop(byId.get('a'), byId)).toBe(false)
  })
})

describe('words: a full slot never says "do it yourself"', () => {
  it('the op\'s queued answer', () => {
    for (const q of [
      { position: 2, host: 'clouddev', reason: 'all 24 slots taken', running: ['a'], cap: 24 },
      { position: 1, host: '__local__', reason: 'load past 6 per CPU', running: [] },
      // An older server's answer (2026-11-03 to 11-05): its running subtasks against its cap.
      { position: 1, running: ['a', 'b'], cap: 8 }, {},
    ]) {
      const [outcome, next] = queuedOutcome('t1', q)
      expect(outcome).toContain('queued')
      expect(`${outcome} ${next}`).not.toMatch(DO_IT_YOURSELF)
    }
    const [outcome, next] = queuedOutcome('t1', { position: 2, host: '__local__', reason: 'all 7 slots taken', running: [], cap: 7 })
    expect(outcome).toBe('An older server queued task t1 (number 2 in its host\'s queue): this Mac has no room (all 7 slots taken). Walnut handles that stored queue when a host that can run it has room, '
      + 'highest priority first. New automatic starts fail with 409 hosts_full instead.')
    expect(next).toMatch(/waiting_for and waits_for_host/)
  })

  it('every site in src/ that throws the full-host refusal or catches an older cap, and the queue and admission modules', () => {
    const root = path.resolve(__dirname, '../../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    const code = (line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line)
    const site = /new HostsFullError\(|includes\('\(too_many_running_subtasks\)'\)/
    let sites = 0
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      const rel = path.relative(root, file)
      if (rel === path.join('core', 'sessions', 'start-queue.ts') || rel === path.join('core', 'sessions', 'host-admission.ts')) {
        for (const [i, l] of lines.entries()) if (code(l)) expect(l, `${rel}:${i + 1}`).not.toMatch(DO_IT_YOURSELF)
        continue
      }
      lines.forEach((l, i) => {
        if (!site.test(l)) return
        sites++
        // The text a throw or a catch builds sits in the lines around it.
        for (let j = Math.max(0, i - 12); j < Math.min(lines.length, i + 16); j++) {
          if (code(lines[j])) expect(lines[j], `${rel}:${j + 1}`).not.toMatch(DO_IT_YOURSELF)
        }
      })
    }
    // host-admission.ts throws it (scanned whole above); ops/tasks.ts catches an older server's cap.
    expect(sites).toBeGreaterThanOrEqual(1)
    expect(fs.readFileSync(path.join(root, 'core', 'sessions', 'host-admission.ts'), 'utf8')).toMatch(/new HostsFullError\(/)
  })
})
