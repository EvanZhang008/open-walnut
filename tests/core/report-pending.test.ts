/**
 * The turn-end report still to come (src/core/sessions/report-pending.ts): the status sync hears
 * each change once, and reads it per task through the task's sessions.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { isReportPending, onReportPendingChange, setReportPending, REPORT_PENDING_MAX_MS, __resetReportPending } from '../../src/core/sessions/report-pending.js'
import { statusInputOf, type StatusFacts } from '../../src/core/user-status-sync.js'
import type { Task } from '../../src/core/types.js'

afterEach(() => { onReportPendingChange(null); __resetReportPending() })

describe('report pending', () => {
  it('tells its listener only when it moves', () => {
    const heard: string[] = []
    onReportPendingChange((sid) => heard.push(sid))
    setReportPending('s1', true)
    setReportPending('s1', true)
    expect(isReportPending('s1')).toBe(true)
    setReportPending('s1', false)
    setReportPending('s1', false)
    expect(isReportPending('s1')).toBe(false)
    expect(isReportPending(undefined)).toBe(false)
    expect(heard).toEqual(['s1', 's1'])
  })

  it('stops counting a report that has not come within its window, and a new turn end restarts the clock', () => {
    setReportPending('s2', true, 1_000)
    expect(isReportPending('s2', 1_000 + REPORT_PENDING_MAX_MS - 1)).toBe(true)
    expect(isReportPending('s2', 1_000 + REPORT_PENDING_MAX_MS)).toBe(false)
    setReportPending('s2', true, 1_000 + REPORT_PENDING_MAX_MS)
    expect(isReportPending('s2', 1_000 + REPORT_PENDING_MAX_MS + 10)).toBe(true)
  })

  it('reaches the status input through the task session', () => {
    const facts = {
      sessions: new Map(), letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(),
      schedules: new Map(), titles: new Map(), sessionsOf: new Map(),
    } as unknown as StatusFacts
    const task = { id: 't1', title: 'x', phase: 'NEED_ACTION', session_id: 'sid-a' } as unknown as Task
    expect(statusInputOf(task, facts).reportPending).toBe(false)
    setReportPending('sid-a', true)
    expect(statusInputOf(task, facts).reportPending).toBe(true)
  })
})
