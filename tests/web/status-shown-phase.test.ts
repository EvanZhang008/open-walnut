/**
 * A status control shows ONE state: the icon and the picked option are the state its label names,
 * never the bare phase beside it. 2026-11-23, the user, on a task parked (phase WAITING) on its four
 * running workers whose menu read "Status: Working" with an hourglass and a lit Waiting option:
 * "Waiting 就是 waiting，working 就是 working。有 sub agent，它也就是 working 啊". Three surfaces
 * had it: the task menu's Status row and the detail badge (TaskStatusControl), the phone's status
 * sheet (PhonePhaseSheet) and StatusBadge.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { taskStatusLabel, taskStatusPhase } from '../../web/src/utils/session-status'
import { checksBackWords } from '../../web/src/components/common/date-time-pick'

type T = Pick<Task, 'phase' | 'status' | 'user_status'> & Partial<Pick<Task, 'session_id'>>
const task = (phase: Task['phase'], user_status?: Task['user_status'], extra: Partial<Task> = {}): T =>
  ({ phase, status: phase === 'COMPLETE' ? 'done' : 'todo', user_status, ...extra }) as T

describe('taskStatusPhase: the option a status control shows is the state its label names', () => {
  it.each([
    ['parked on its running workers', task('WAITING', { state: 'working', waitingOn: 'Its workers are working' } as never), 'IN_PROGRESS', 'Working'],
    ['parked on a watch of its own running work', task('WAITING', { state: 'working', carriesOn: 'watch' } as never), 'IN_PROGRESS', 'Working'],
    ['in progress with nothing running', task('IN_PROGRESS', { state: 'waiting', kind: 'outside' } as never), 'WAITING', undefined],
    ['a result to read', task('NEED_ACTION', { state: 'read', toRead: 'result' } as never), 'NEED_ACTION', undefined],
    ['an ask', task('NEED_ACTION', { state: 'needs', ask: 'Approve it?' } as never), 'NEED_ACTION', undefined],
    ['never started', task('TODO', { state: 'waiting', kind: 'not-started' } as never), 'TODO', undefined],
    ['parked, with a result to read', task('WAITING', { state: 'read', toRead: 'result' } as never), 'NEED_ACTION', undefined],
    ['snoozed', task('NEED_ACTION', { state: 'waiting', snoozed: true, kind: 'time' } as never), 'WAITING', undefined],
    ['held by a usage limit', task('IN_PROGRESS', { state: 'waiting', kind: 'time', limit: { engine: 'claude' } } as never), 'WAITING', undefined],
    ['completed', task('COMPLETE'), 'COMPLETE', undefined],
    ['no status derived yet, working', task('IN_PROGRESS'), 'IN_PROGRESS', undefined],
    ['no status derived yet, a TODO with no session', task('TODO'), 'TODO', undefined],
  ] as const)('%s', (_label, t, phase, label) => {
    expect(taskStatusPhase(t)).toBe(phase)
    if (label) expect(taskStatusLabel(t)).toBe(label)
  })
})

it('a parked task at work checks back, it never waits until', () => {
  expect(checksBackWords('Today 3:08 AM')).toBe('checks back today 3:08 AM')
})

describe('every surface that shows the status label picks its icon and option by taskStatusPhase', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'web/src'))
  // A file that draws the status label and also something keyed by phase (an option list, a phase
  // icon or symbol): the keyed thing must follow the label's state.
  const KEYED = /STATUS_OPTIONS|phaseSymbols|phasePickerChoices|ICON_PHASE_|phaseIcon\(/

  it('no such file reads the bare phase for what it shows', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8')
      if (!src.includes('taskStatusLabel(') || !KEYED.test(src) || f.endsWith('utils/session-status.ts')) continue
      if (!src.includes('taskStatusPhase(')) offenders.push(path.relative(ROOT, f))
    }
    expect(offenders, 'show what taskStatusPhase(task) names, the state the label reads').toEqual([])
  })

  it('no file anywhere shows a status from the bare phase', () => {
    // The shapes each member of this class had: an option, icon, symbol or word picked by
    // task.phase beside the one user status. Read taskStatusPhase(task) or taskUserState(task).
    const BARE = /o\.value === task\.phase|pressed=\{task\.phase|phaseSymbols\[phase\]|=== 'done' \? 'COMPLETE' : \(task\.phase|phaseIcon\(task\.phase|PHASE_ICON\[|task\.phase === 'WAITING' \? 'Waiting|phase === 'WAITING' \? 'Message: moves it to Working/g
    const offenders: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8')
      for (const m of src.matchAll(BARE)) offenders.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length}`)
    }
    expect(offenders, 'show what taskStatusPhase(task) names, the state the label reads').toEqual([])
  })
})
