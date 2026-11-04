/**
 * A task a usage limit holds reads the same in every Home view (limit-row-words.ts): the Flat
 * view's status rows and the By project / In one list rows. 2026-11-07: By project became the
 * default view and drew a limited task like any other, with no tag and no reset.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../src/core/types'
import { limitRowLine } from '../../web/src/components/tasks/limit-row-words'

const ROOT = path.resolve(__dirname, '../..')
const T0 = Date.parse('2026-11-07T10:00:00Z')
const HOUR = 3_600_000
const task = (limit: Record<string, unknown>, ask = 'Limited: Walnut continues it at the reset'): Task => ({
  id: 't1', title: 'Refactor', phase: 'IN_PROGRESS',
  user_status: { state: 'waiting', ask, limit: { engine: 'claude', window: 'five_hour', resetsAt: new Date(T0 + 2 * HOUR).toISOString(), dueAt: new Date(T0 + 2 * HOUR + 60_000).toISOString(), auto: true, ...limit } },
} as unknown as Task)

describe('the words of a limited task row', () => {
  it('auto-continue on: Limited, and when it resets', () => {
    const l = limitRowLine(task({}), '', T0, undefined)!
    expect(l.tag).toBe('Limited')
    expect(l.text).toMatch(/^resets \d{1,2}:\d{2}\s[AP]M$/)
    expect(l.tone).toBeUndefined()
  })

  it('a reset read from the words is said as about', () => {
    expect(limitRowLine(task({ estimate: true }), '', T0, undefined)!.text).toMatch(/^resets about /)
  })

  it('off: grey Auto-continue off, and when it resets; refused again: amber', () => {
    expect(limitRowLine(task({ auto: false }), '', T0, undefined)).toMatchObject({ tag: 'Auto-continue off', tone: 'off' })
    expect(limitRowLine(task({ auto: false }), 'Limited, still refusing after 3 tries', T0, undefined)).toMatchObject({ tag: 'Refused again', tone: 'refused' })
    expect(limitRowLine(task({ auto: false }), '', T0 + 3 * HOUR, undefined)).toMatchObject({ tag: 'Reset' })
  })

  it('the live state wins over the stored one: off at once, back on at once, continuing at once', () => {
    expect(limitRowLine(task({}), '', T0, 'off')).toMatchObject({ tag: 'Auto-continue off', tone: 'off' })
    expect(limitRowLine(task({ auto: false }), '', T0, 'waiting')).toMatchObject({ tag: 'Limited' })
    expect(limitRowLine(task({}), '', T0, 'resumed')).toEqual({ tag: 'Continuing', text: 'now' })
    expect(limitRowLine(task({}), '', T0, 'gone')).toEqual({ tag: 'Continuing', text: 'now' })
  })

  it('no limit, no line', () => {
    expect(limitRowLine({ id: 't', title: 'x', phase: 'TODO' } as unknown as Task, '', T0, undefined)).toBeNull()
  })
})

describe('every Home row view draws the limit', () => {
  // The files that draw a Home task row, and how each shows a limit. A new row renderer joins
  // this list: a limited task drawn without its tag reads as any other task.
  const RENDERERS: Record<string, RegExp> = {
    'web/src/components/tasks/TodoPanel.tsx': /<TaskLimitPill task=\{task\} \/>/,
    'web/src/components/tasks/StatusSections.tsx': /limitOwnWords\(|<LimitTag /,
    'web/src/components/tasks/FocusSatelliteCards.tsx': /<TaskLimitPill task=\{task\} \/>/,
  }
  it('each one shows it', () => {
    for (const [file, shows] of Object.entries(RENDERERS)) {
      expect(shows.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), file).toBe(true)
    }
  })
  it('the list holds every file that draws a task row title on Home', () => {
    const dir = path.join(ROOT, 'web/src/components/tasks')
    const drawers = fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f))
      .filter((f) => /className=\{?[`"'](?:todo-item-title|todo-pinned-title|todo-pinned-card status-section-card)\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
      .map((f) => `web/src/components/tasks/${f}`)
    expect(drawers.filter((f) => !(f in RENDERERS)), 'a new Home row renderer: show the limit there (limit-row.tsx) and list it').toEqual([])
  })
})
