/**
 * The web side of a quiet hold with a scope (web/src/contexts/notifications/quiet-model.ts and
 * system-notice.ts): a focus block on one task lets that task's toasts and system notices
 * through, holds everything else, and a second hold without a scope still holds it all. The
 * same rule as the server's push gate (src/core/focus-spaces/scope.ts).
 */
import { describe, expect, it } from 'vitest'
import { normalizeQuiet, quietAllowsToast, quietLetsTaskThrough } from '../../web/src/contexts/notifications/quiet-model'
import { systemNoticeAllowed } from '../../web/src/contexts/notifications/system-notice'

const rows: Record<string, { id: string; project?: string; parent_task_id?: string }> = {
  interview: { id: 'interview', project: 'Personal' },
  mock: { id: 'mock', project: 'Personal', parent_task_id: 'interview' },
  other: { id: 'other', project: 'Acme' },
}
const lookup = (id: string) => rows[id]
const future = Date.now() + 60_000

describe('a quiet hold with a scope, in the browser', () => {
  const scoped = normalizeQuiet({
    active: true, allowPermissions: true,
    holds: [{ source: 'plugin:walnut-rhythm', since: 1, until: future, scope: { tasks: ['interview', ''], junk: 1 } }],
  })

  it('keeps the scope from the wire, cleaned', () => {
    expect(scoped.holds[0]!.scope).toEqual({ tasks: ['interview'] })
  })

  it('lets a toast about the task or its subtask through and holds the rest', () => {
    expect(quietAllowsToast(scoped, 'letter', Date.now(), { taskId: 'mock', lookup })).toBe(true)
    expect(quietAllowsToast(scoped, 'letter', Date.now(), { taskId: 'other', lookup })).toBe(false)
    expect(quietAllowsToast(scoped, 'cron')).toBe(false)
  })

  it('a second hold without a scope holds the task too', () => {
    const both = normalizeQuiet({ ...scoped, holds: [...scoped.holds, { source: 'user', since: 2 }] })
    expect(quietLetsTaskThrough(both, 'interview', lookup)).toBe(false)
  })

  it('a system notice about the task goes out; one without a task waits', () => {
    expect(systemNoticeAllowed(scoped, Date.now(), { taskId: 'interview', lookup })).toBe(true)
    expect(systemNoticeAllowed(scoped)).toBe(false)
    expect(systemNoticeAllowed({ ...scoped, unknown: true }, Date.now(), { taskId: 'interview', lookup })).toBe(false)
  })

  it('an older server sends no scope: quiet holds everything, as before', () => {
    const old = normalizeQuiet({ active: true, allowPermissions: true, holds: [{ source: 'user', since: 1 }] })
    expect(quietAllowsToast(old, 'letter', Date.now(), { taskId: 'interview', lookup })).toBe(false)
    expect(quietAllowsToast(old, 'permission')).toBe(true)
  })
})
