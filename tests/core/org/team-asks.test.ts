/** Who asked a lead's team task something (src/core/org/team-asks.ts), pure parts. */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import { peerNoteSender, teamOf } from '../../../src/core/org/team-asks.js'

const task = (id: string, project: string, extra: Partial<Task> = {}): Task =>
  ({ id, title: `${id} title`, project, phase: 'TODO', created_at: '2026-10-26T00:00:00Z', ...extra }) as Task

describe('team asks', () => {
  it('reads a peer note\'s sender from its envelope, and nothing from a reply or a notice', () => {
    const note = '<walnut-message kind="peer-note" from="Main [3ea08ceb]" from-session="s" from-task="main-1" host="local" title="Fix the chart" note="x">\nbody\n</walnut-message>'
    expect(peerNoteSender(note)).toEqual({ taskId: 'main-1', from: 'Main', title: 'Fix the chart' })
    expect(peerNoteSender('<walnut-message kind="reply" from="Main [3ea08ceb]" from-task="main-1">x</walnut-message>')).toBeNull()
    expect(peerNoteSender('<walnut-message kind="notification" from="Walnut">x</walnut-message>')).toBeNull()
    expect(peerNoteSender('plain text')).toBeNull()
    // The envelope escapes its attributes; the note shows them as written.
    const quoted = '<walnut-message kind="peer-note" from="Tom &amp; Ann [3ea08ceb]" from-task="t-1" title="Fix the &quot;chart&quot;">x</walnut-message>'
    expect(peerNoteSender(quoted)).toEqual({ taskId: 't-1', from: 'Tom & Ann', title: 'Fix the "chart"' })
  })

  it('finds the lead whose team holds a task, its other projects included', () => {
    const lead = task('lead', 'Garden', { org_role: 'lead', title: 'Garden lead', org_leads: ['Seeds'] })
    const tasks = [lead, task('g1', 'Garden'), task('g2', 'Garden', { parent_task_id: 'g1' }), task('s1', 'Seeds'), task('o1', 'Other')]
    const g2 = teamOf(tasks, tasks[2]!)!
    expect(g2.lead.id).toBe('lead')
    expect([...g2.team].sort()).toEqual(['g1', 'g2', 'lead', 's1'])
    expect(teamOf(tasks, tasks[3]!)?.lead.id).toBe('lead')
    expect(teamOf(tasks, tasks[4]!)).toBeNull()
    // A completed lead keeps no team.
    expect(teamOf([{ ...lead, phase: 'COMPLETE' }, ...tasks.slice(1)], tasks[1]!)).toBeNull()
  })
})
