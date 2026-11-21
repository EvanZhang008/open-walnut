/**
 * The `user-focus` message hint (hint-registry.ts): while the user is in a focus space
 * (focus-spaces/active.ts, experiment focus_workspace), Main and the leads hear one line saying
 * so, once per focus, and one line when he leaves it. Every other session hears nothing.
 */
import { describe, expect, it } from 'vitest'
import type { SessionHintState, Task } from '../../../src/core/types.js'
import { effectiveHints, findHint, USER_FOCUS_ENDED_TEXT, userFocusText } from '../../../src/core/hints/hint-registry.js'
import { advanceHintState, hintTargetOf, planHints } from '../../../src/core/hints/hint-send.js'

type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: SessionHintState }
const task = (t: Partial<Task>): Task => ({ id: 'x', title: 'X', phase: 'IN_PROGRESS', status: 'in_progress', project: 'Marina', ...t }) as Task
const VP = task({ id: 'vp', org_role: 'lead' })

function send(rec: Rec, owner: Task, focus: { name: string; until?: number } | null | undefined): string[] {
  const config = { session: {} } as never
  const plan = planHints({ hints: effectiveHints(config), target: hintTargetOf(rec.claudeSessionId, owner), record: rec, config, ...(focus !== undefined ? { focus } : {}) })
  rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: Date.now() })
  return plan.carried.filter((h) => h.kind === 'user-focus').map((h) => h.text)
}

describe('the user-focus hint', () => {
  it('is a built-in, on, sent at start, on change and after a compaction', () => {
    expect(findHint({ session: {} }, 'user-focus')).toMatchObject({ enabled: true, placement: 'after' })
    expect(findHint({ session: {} }, 'user-focus')!.triggers).toEqual(['session_start', 'on_change', 'after_compaction'])
  })

  it('says the focus once, says nothing while it holds, and says once when it ends', () => {
    const rec: Rec = { claudeSessionId: 's1', output_mode: 'markdown' }
    expect(send(rec, VP, null)).toEqual([])
    const focus = { name: 'Walnut work', until: Date.parse('2026-11-21T15:30:00Z') }
    expect(send(rec, VP, focus)).toEqual([userFocusText(focus)])
    expect(userFocusText(focus)).toContain('"Walnut work" until 15:30Z')
    expect(send(rec, VP, focus)).toEqual([])
    expect(send(rec, VP, null)).toEqual([USER_FOCUS_ENDED_TEXT])
    expect(send(rec, VP, null)).toEqual([])
  })

  it('a session that is no Org node hears nothing (its focus reads as undefined)', () => {
    const rec: Rec = { claudeSessionId: 's2', output_mode: 'markdown' }
    expect(send(rec, task({ parent_task_id: 'vp' }), undefined)).toEqual([])
  })
})
