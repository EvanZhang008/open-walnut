/**
 * The `hand-on` message hint (hint-registry.ts, core/org/core-instructions.ts orgHandOnHint): Main and
 * every VP are reminded of their first rule, never do the work yourself, at the moments they would
 * forget it (2026-11-03, the user: "walnut probally shoudo't stoop it, it shudo use prompt and in
 * correct time to avoid forget, some instruction eaach compation or at start some ever xround").
 * At session start, after a compaction (the next message, and the post-compaction hook), and every
 * 3 messages; a worker, an ask and a plain task never hear it. The reminder inside a turn, at the
 * 3rd command, is the org work hook's (tests/providers/org-work-guard-hook.test.ts).
 */
import { describe, expect, it } from 'vitest'
import type { SessionHintState, Task } from '../../../src/core/types.js'
import { effectiveHints, findHint, validateHintSettings } from '../../../src/core/hints/hint-registry.js'
import { advanceHintState, hintTargetOf, planHints } from '../../../src/core/hints/hint-send.js'
import { orgHandOnHint } from '../../../src/core/org/core-instructions.js'

type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: SessionHintState; lastCompactUuid?: string }
const task = (t: Partial<Task>): Task => ({ id: 'x', title: 'X', phase: 'IN_PROGRESS', status: 'in_progress', project: 'Marina', ...t }) as Task
const VP = task({ id: 'vp', org_role: 'lead' })
const MAIN = task({ id: 'main', org_role: 'main', project: 'Main' })

function send(rec: Rec, owner: Task, opts: { afterCompaction?: boolean; config?: unknown } = {}): string[] {
  const config = (opts.config ?? { session: {} }) as never
  const plan = planHints({ hints: effectiveHints(config), target: hintTargetOf(rec.claudeSessionId, owner), record: rec, config, ...(opts.afterCompaction ? { afterCompaction: true } : {}) })
  rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: Date.now(), sentBy: 'agent', ...(opts.afterCompaction ? { byHook: true, count: false } : {}) })
  return plan.carried.filter((h) => h.kind === 'hand-on').map((h) => h.text)
}

describe('the hand-on hint', () => {
  it('is a built-in for Main and the leads, at start, after a compaction and every 3 messages', () => {
    const h = findHint({ session: {} }, 'hand-on')!
    expect(h).toMatchObject({ enabled: true, everyTurns: 3, placement: 'after' })
    expect(h.triggers).toEqual(['session_start', 'after_compaction', 'every_n_turns'])
    expect(h.audience.roles).toEqual(['main', 'lead'])
  })

  it('session_start, then every_n_turns: a VP hears it on messages 1, 4 and 7', () => {
    const rec: Rec = { claudeSessionId: 's1', output_mode: 'markdown' }
    const sent = Array.from({ length: 7 }, () => send(rec, VP))
    expect(sent.map((s) => s.length)).toEqual([1, 0, 0, 1, 0, 0, 1])
    expect(sent[0][0]).toBe(orgHandOnHint('lead'))
    expect(sent[0][0]).toMatch(/^you are a VP: never do the work yourself\. Run at most 3 commands of your own in a turn/)
  })

  it('after_compaction: the message after a compaction carries it again, and so does the hook', () => {
    const rec: Rec = { claudeSessionId: 's2', output_mode: 'markdown' }
    send(rec, MAIN)
    expect(send(rec, MAIN)).toEqual([])
    rec.lastCompactUuid = 'compact-1'
    const [text] = send(rec, MAIN)
    expect(text).toBe(orgHandOnHint('main'))
    expect(text).toMatch(/org_send to the VP of its project/)
    // The post-compaction hook states it at once.
    const hooked: Rec = { claudeSessionId: 's3', output_mode: 'markdown', lastCompactUuid: 'compact-2' }
    send(hooked, VP)
    expect(send(hooked, VP, { afterCompaction: true })).toEqual([orgHandOnHint('lead')])
  })

  it('a worker, an ask and a plain task never hear it', () => {
    for (const owner of [task({ parent_task_id: 'vp' }), task({ walnut_agent: true }), task({})]) {
      const rec: Rec = { claudeSessionId: `w-${owner.parent_task_id ?? owner.walnut_agent ?? 'p'}`, output_mode: 'markdown' }
      expect(Array.from({ length: 7 }, () => send(rec, owner)).flat()).toEqual([])
      expect(send(rec, owner, { afterCompaction: true })).toEqual([])
    }
  })

  it('turned off in Settings, it is not sent; a widened audience still never tells a worker it is a VP', () => {
    const off = { session: { hints: { 'hand-on': validateHintSettings('hand-on', { enabled: false }) } } }
    const rec: Rec = { claudeSessionId: 's4', output_mode: 'markdown' }
    expect(send(rec, VP, { config: off })).toEqual([])
    const everyone = { session: { hints: { 'hand-on': validateHintSettings('hand-on', { audience: {} }) } } }
    const w: Rec = { claudeSessionId: 's5', output_mode: 'markdown' }
    expect(send(w, task({ parent_task_id: 'vp' }), { config: everyone })).toEqual([])
  })
})
