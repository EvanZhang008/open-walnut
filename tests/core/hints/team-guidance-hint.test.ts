/**
 * The `team-guidance` message hint (hint-registry.ts, core/org/reflection/team-guidance-hint.ts): the
 * lines a node's reflection wrote reach the sessions it manages when they start, after a compaction
 * and when the lines change, never every turn; a session whose manager has none hears nothing.
 * Which node manages a task is team.ts managerOf: a VP's projects' tasks, the CEO's VPs and the
 * tasks no VP leads.
 */
import { describe, expect, it } from 'vitest'
import type { SessionHintState, Task } from '../../../src/core/types.js'
import { effectiveHints, findHint } from '../../../src/core/hints/hint-registry.js'
import { advanceHintState, hintTargetOf, planHints } from '../../../src/core/hints/hint-send.js'
import { teamGuidanceIdentity, teamGuidanceText, type TeamGuidanceState } from '../../../src/core/org/reflection/team-guidance-hint.js'
import { managerOf } from '../../../src/core/org/reflection/team.js'

type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: SessionHintState; lastCompactUuid?: string }
const task = (t: Partial<Task>): Task => ({ id: 'x', title: 'X', phase: 'IN_PROGRESS', status: 'in_progress', project: 'Marina', ...t }) as Task
const WORKER = task({ id: 'w' })
const guidance = (lines: string[]): TeamGuidanceState => ({ node: 'Marina VP', lines, file: '/tmp/knowledge/nodes/vp/guidance.md' })

function send(rec: Rec, g: TeamGuidanceState | null, opts: { afterCompaction?: boolean } = {}): string[] {
  const config = { session: {} } as never
  const plan = planHints({ hints: effectiveHints(config), target: hintTargetOf(rec.claudeSessionId, WORKER), record: rec, config, teamGuidance: g, ...(opts.afterCompaction ? { afterCompaction: true } : {}) })
  rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: Date.now(), ...(opts.afterCompaction ? { byHook: true, count: false } : {}) })
  return plan.carried.filter((h) => h.kind === 'team-guidance').map((h) => h.text)
}

describe('the team-guidance hint', () => {
  it('is a built-in at start, after a compaction and on change, for every role', () => {
    const h = findHint({ session: {} }, 'team-guidance')!
    expect(h).toMatchObject({ enabled: true, placement: 'after' })
    expect(h.triggers).toEqual(['session_start', 'after_compaction', 'on_change'])
    expect(h.audience.roles).toEqual([])
  })

  it('says the lines once at start, again after a compaction and when they change, never every turn', () => {
    const rec: Rec = { claudeSessionId: 's1', output_mode: 'markdown' }
    const g = guidance(['Open a clean new major version and move the dependents.'])
    const first = send(rec, g)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('Team guidance from Marina VP')
    expect(first[0]).toContain('- Open a clean new major version and move the dependents.')
    expect(Array.from({ length: 5 }, () => send(rec, g)).flat()).toEqual([])
    // A new line is told with the next message.
    const more = guidance([...g.lines, 'On a real account of the user, try once and stop on a failure.'])
    expect(send(rec, more)[0]).toContain('try once and stop')
    expect(send(rec, more)).toEqual([])
    // After a compaction, the hook says it again.
    rec.lastCompactUuid = 'compact-1'
    expect(send(rec, more, { afterCompaction: true })).toHaveLength(1)
  })

  it('says nothing when the manager wrote no guidance', () => {
    const rec: Rec = { claudeSessionId: 's2', output_mode: 'markdown' }
    expect(Array.from({ length: 4 }, () => send(rec, null)).flat()).toEqual([])
  })

  it('keeps within the hint\'s room, pointing at the file for the rest', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Rule ${i}: ${'a careful sentence about the work '.repeat(3)}`)
    const text = teamGuidanceText(guidance(lines))
    expect(text.length).toBeLessThanOrEqual(1900)
    expect(text).toMatch(/- \.\.\. \d+ more in \/tmp\/knowledge\/nodes\/vp\/guidance\.md$/)
  })

  it('names the org\'s skills to a worker, beside the guidance or alone, and is told again when one is added', () => {
    const skills = [{ name: 'try-once-on-real-accounts', description: 'Before automating a real account of the user' }]
    const both = teamGuidanceText({ ...guidance(['Keep names true to what they hold.']), skills })
    expect(both).toContain('Team guidance from Marina VP')
    expect(both).toContain('Org skills:')
    expect(both).toContain('- try-once-on-real-accounts: Before automating a real account of the user')
    const alone = teamGuidanceText({ lines: [], skills })
    expect(alone).not.toContain('Team guidance')
    expect(alone.startsWith('Org skills:')).toBe(true)
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: 'a way of working the org wrote down '.repeat(2) }))
    const full = teamGuidanceText({ ...guidance(Array.from({ length: 30 }, (_, i) => `Rule ${i}: ${'a careful sentence '.repeat(4)}`)), skills: many })
    expect(full.length).toBeLessThanOrEqual(1900)
    expect(full).toMatch(/more in \/tmp\/knowledge\/nodes\/vp\/guidance\.md/)
    expect(full).toMatch(/- \.\.\. \d+ more: agent_skill_read with no name lists them\.$/)
    expect(teamGuidanceIdentity({ lines: [], skills })).not.toBe(teamGuidanceIdentity({ lines: [], skills: [...skills, { name: 'b', description: 'c' }] }))
  })

  it('reads the guidance of the node that manages the task', () => {
    const main = task({ id: 'main', org_role: 'main', project: 'Ask Walnut' })
    const vp = task({ id: 'vp', org_role: 'lead', project: 'Marina' })
    const all = [main, vp, task({ id: 'w', project: 'Marina' }), task({ id: 'loose', project: 'Garden' })]
    expect(managerOf(all[2], all)?.id).toBe('vp')
    // A project no VP leads is no one's team, as the Brief counts it.
    expect(managerOf(all[3], all)).toBeUndefined()
    expect(managerOf(vp, all)?.id).toBe('main')
    expect(managerOf(main, all)).toBeUndefined()
    expect(managerOf(task({ id: 'agent', walnut_agent: true }), all)).toBeUndefined()
    // A task of an incoming-item area reads no lesson taken from outside it (router/same-area.ts).
    expect(managerOf(task({ id: 'in-area', project: 'Marina', router_area_id: 'area-a' }), all)).toBeUndefined()
  })
})
