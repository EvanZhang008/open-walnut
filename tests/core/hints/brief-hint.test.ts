/**
 * The `brief` message hint (hint-registry.ts, sessions/brief-hint.ts): Main and every lead are
 * reminded to keep their Brief current themselves (2026-10-31, the user: "每三轮提示他一下 ... 这就是
 * 一个 file"). Every 3 messages, at start and after a compaction, and when its team moved since it
 * was written; a node that keeps no Brief hears to write one; a worker never hears it.
 */
import { describe, expect, it } from 'vitest'
import type { SessionHintState, Task } from '../../../src/core/types.js'
import { effectiveHints } from '../../../src/core/hints/hint-registry.js'
import { advanceHintState, hintTargetOf, planHints } from '../../../src/core/hints/hint-send.js'
import { briefHintStateOf, briefHintText } from '../../../src/core/sessions/brief-hint.js'
import { briefSnapshot } from '../../../src/core/sessions/brief-fresh.js'

const NOW = Date.parse('2026-10-31T18:00:00Z')
const LETTER = '### Needs you\n- <task-ref id="a" label="A"/>: review section 3.\n### Working\n- None\n### Waiting / snoozed\n- None'
const worker = (s: NonNullable<Task['user_status']>): Task => ({ id: 'a', title: 'A', phase: s.state === 'needs' ? 'NEED_ACTION' : 'WAITING', status: 'in_progress', project: 'Marina', parent_task_id: 'lead', user_status: s }) as Task
const asking = worker({ state: 'needs', source: 'session', ask: 'Review section 3' })
const lead = (brief?: Task['brief']): Task => ({ id: 'lead', title: 'Marina lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Marina', ...(brief ? { brief } : {}) }) as Task
const written = (tasks: Task[]) => lead({ text: LETTER, at: new Date(NOW - 2 * 3_600_000).toISOString(), ...briefSnapshot(LETTER, lead(), tasks) })

type Rec = { claudeSessionId: string; output_mode: 'markdown'; hintState?: SessionHintState }
function send(rec: Rec, owner: Task, tasks: Task[]): string[] {
  const config = { session: {} } as never
  const plan = planHints({ hints: effectiveHints(config), target: hintTargetOf(rec.claudeSessionId, owner), record: rec, config, brief: briefHintStateOf(owner, tasks) })
  rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: Date.now(), sentBy: 'agent' })
  return plan.carried.filter((h) => h.kind === 'brief').map((h) => h.text)
}

describe('the brief hint', () => {
  it('a current Brief: reminded at start, then every 3 messages', () => {
    const rec: Rec = { claudeSessionId: 's1', output_mode: 'markdown' }
    const owner = written([asking])
    const sent = Array.from({ length: 7 }, () => send(rec, owner, [asking]).length)
    expect(sent).toEqual([1, 0, 0, 1, 0, 0, 1])
  })

  it('its team moved since it was written: told at once, with what moved; a rewrite ends it', () => {
    const rec: Rec = { claudeSessionId: 's2', output_mode: 'markdown' }
    const owner = written([asking])
    send(rec, owner, [asking])
    const answered = worker({ state: 'waiting', kind: 'task', waitingOn: 'The reviewer' })
    const [text] = send(rec, owner, [answered])
    expect(text).toContain('is behind (1 line moved since)')
    expect(text).toContain('brief_write')
    // Its own rewrite: nothing more until the next reminder.
    const rewritten = lead({ text: LETTER.replace('### Needs you\n- <task-ref id="a" label="A"/>: review section 3.\n', '### Needs you\n- None\n').replace('### Waiting / snoozed\n- None', '### Waiting / snoozed\n- <task-ref id="a" label="A"/>: on the reviewer.'), at: new Date(NOW).toISOString(), ...briefSnapshot(LETTER, lead(), [answered]) })
    expect(send(rec, rewritten, [answered])).toEqual([])
  })

  it('a node with no Brief hears to write one; a worker never hears it', () => {
    const rec: Rec = { claudeSessionId: 's3', output_mode: 'markdown' }
    expect(send(rec, lead(), [asking])[0]).toContain('you keep no Brief yet')
    const w: Rec = { claudeSessionId: 's4', output_mode: 'markdown' }
    expect(Array.from({ length: 4 }, () => send(w, asking, [asking])).flat()).toEqual([])
  })

  it('says how old the letter is', () => {
    const s = briefHintStateOf(written([asking]), [asking])!
    expect(briefHintText(s, NOW)).toMatch(/written 2 hours ago/)
  })
})
