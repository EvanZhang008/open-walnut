/**
 * Walnut wakes the tasks that wait on the machine once it is fixed (src/core/sessions/machine-wake.ts).
 * 2026-10-28: a full disk answered 507 to every write, and the tasks it stopped read Needs you.
 */
import { describe, it, expect } from 'vitest'
import { machineWaiters, machineWakeText } from '../../../src/core/sessions/machine-wake.js'
import type { Task } from '../../../src/core/types.js'

const NOW = Date.parse('2026-10-28T08:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

function task(id: string, extra: Partial<Task>): Task {
  return { id, title: id, phase: 'WAITING', status: 'todo', project: 'Walnut', created_at: ago(600), updated_at: ago(10), ...extra } as Task
}
const onDisk = { state: 'waiting' as const, waiting_kind: 'machine' as const, waiting_on: 'free disk', at: ago(20) }

describe('machine waiters', () => {
  it('picks the parked or handed-back tasks whose latest turn said they wait on the machine', () => {
    const tasks = [
      task('parked', { status_report: onDisk, phase_changed_at: ago(21) }),
      task('handed', { phase: 'NEED_ACTION', status_report: onDisk, phase_changed_at: ago(21) }),
      // Running now: it hears nothing extra.
      task('running', { phase: 'IN_PROGRESS', status_report: onDisk }),
      task('done', { phase: 'COMPLETE', status_report: onDisk }),
      // Its latest turn moved on (the phase moved long after the report).
      task('moved', { status_report: onDisk, phase_changed_at: ago(1) }),
      // Waiting on something else.
      task('other', { status_report: { ...onDisk, waiting_kind: 'task' } }),
      task('stale', { status_report: { ...onDisk, at: ago(8 * 24 * 60) } }),
      task('main', { org_role: 'main', status_report: onDisk }),
      task('none', {}),
    ]
    expect(machineWaiters(tasks, NOW).map((t) => t.id)).toEqual(['parked', 'handed'])
  })

  it('the wake says what was fixed and asks for a retry, as a Walnut trigger note', () => {
    const text = machineWakeText('disk')
    expect(text).toContain('<walnut-message kind="trigger"')
    expect(text).toContain('data disk has room again')
    expect(text).toContain('Retry what failed')
  })
})
