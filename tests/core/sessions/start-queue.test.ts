/**
 * The start queue's pure rules (core/sessions/start-queue.ts) and a guard on its words.
 *
 * Why the guard: 2026-11-03 a VP at the running-subtask cap read "do this part with your own
 * tools" in the refusal and did the work itself. A full slot means "queued"; no refusal of the
 * cap and no queued answer may tell the caller to do the work itself. The guard scans every
 * place in src/ that throws the cap's refusal or catches it, plus the queue module, so a NEW
 * site with those words fails too.
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
    for (const q of [{ position: 1, running: ['a', 'b'], cap: 8 }, { position: 3, running: [], cap: 16 }, {}]) {
      const [outcome, next] = queuedOutcome('t1', q)
      expect(outcome).toContain('queued')
      expect(`${outcome} ${next}`).not.toMatch(DO_IT_YOURSELF)
    }
  })

  it('every site in src/ that throws or catches the running-cap refusal, and the queue module', () => {
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
    const site = /SubtaskLimitError\(\s*'too_many_running_subtasks'|includes\('\(too_many_running_subtasks\)'\)/
    let sites = 0
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      const rel = path.relative(root, file)
      if (rel === path.join('core', 'sessions', 'start-queue.ts')) {
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
    // subtask-limits.ts throws it; ops/tasks.ts catches an older server's.
    expect(sites).toBeGreaterThanOrEqual(2)
  })
})
