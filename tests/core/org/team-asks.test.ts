/** Who asked a lead's team task something (src/core/org/team-asks.ts), pure parts. */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import { askKey, askWords, peerNoteSender, readAsk, teamOf } from '../../../src/core/org/team-asks.js'
import type { TeamAsk } from '../../../src/core/org/team-note.js'

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

  describe('what an ask says (2026-10-27: a note listed "[Question Q12]" six times)', () => {
    const banner = (n: number) => `[Question Q${n}]\nThis message is question ${n} of this conversation. Begin your reply with the line "[Q${n}]" (nothing else on that line) so the reply is filed under question ${n}.\n[/Question Q${n}]`

    it('reads a question\'s words, not its banner, and keeps the question\'s number', () => {
      expect(askWords(`${banner(12)}\n\nWho removes the finalizer at the last step?\nI am lost.`))
        .toEqual({ words: 'Who removes the finalizer at the last step?', question: 12 })
    })

    it('drops the composer\'s framing: the way back, the file and the passage it is about', () => {
      expect(askWords('(Back to the main conversation)\n\nsure, what else to decide?')).toEqual({ words: 'sure, what else to decide?' })
      expect(askWords(`${banner(3)}\n\n(Back to the earlier question about \u201cJob runner\u201d)\n\n> The job polls every minute.\n\nWhy poll at all?`))
        .toEqual({ words: 'Why poll at all?', question: 3 })
      expect(askWords('About `src/job.ts:42`:\n\n> const big = true\n\nIs this async?')).toEqual({ words: 'Is this async?' })
      // A message that is only the passage says the passage.
      expect(askWords('> The job polls every minute.')).toEqual({ words: 'The job polls every minute.' })
      // Only what leads the message is framing: the person's own lines keep their shape.
      expect(askWords('>= 3 replicas must stay up\nplease check')).toEqual({ words: '>= 3 replicas must stay up' })
      expect(askWords('Look at this:\n> quoted later')).toEqual({ words: 'Look at this:' })
    })

    it('drops Walnut\'s notes riding in front, and keeps a plain message as it is', () => {
      const rider = '<walnut-message kind="notification" from="Walnut" outcome="moved" note="x">\nYour task moved.\n</walnut-message>'
      expect(askWords(`${rider}\n\nPlease renew the permit.`)).toEqual({ words: 'Please renew the permit.' })
      expect(askWords('Please renew the permit.\nIt runs out in May.')).toEqual({ words: 'Please renew the permit.' })
      expect(askWords(`${banner(5)}\n\n`)).toEqual({ words: '', question: 5 })
      expect(askWords('x'.repeat(500)).words).toHaveLength(200)
    })

    const row = (extra: Partial<TeamAsk>): TeamAsk => ({ id: 'k', taskId: 't1', title: 'T', from: 'the user', gist: 'g', at: '2026-10-27T00:00:00Z', ...extra })

    it('an older row\'s placeholder line is a question with no words, never shown as words', () => {
      expect(readAsk(row({ gist: '[Question Q14]' }))).toMatchObject({ gist: '', question: 14 })
      expect(readAsk(row({ gist: '(Back to the main conversation)' }))).toMatchObject({ gist: '' })
      expect(readAsk(row({ gist: 'Who removes it?' })).gist).toBe('Who removes it?')
      // A row this Walnut wrote is read as written.
      expect(readAsk(row({ by: 'user', gist: '(Back to the main conversation)' })).gist).toBe('(Back to the main conversation)')
    })

    it('one ask: the same task, sender and question; a person\'s chat is one; a peer\'s subjects are not', () => {
      expect(askKey(row({ question: 14, gist: 'a' }))).toBe(askKey(row({ gist: '[Question Q14]' })))
      expect(askKey(row({ question: 14 }))).not.toBe(askKey(row({ question: 15 })))
      // Each session numbers its own questions.
      expect(askKey(row({ question: 3, sessionId: 's1', by: 'user' }))).not.toBe(askKey(row({ question: 3, sessionId: 's2', by: 'user' })))
      expect(askKey(row({ gist: 'one' }))).toBe(askKey(row({ gist: 'two', by: 'user' })))
      expect(askKey(row({ gist: 'one' }))).not.toBe(askKey(row({ gist: 'one', taskId: 't2' })))
      const main = (gist: string) => row({ from: 'Main', by: 'peer', gist })
      expect(askKey(main('Check the fence'))).toBe(askKey(main('check  the fence')))
      expect(askKey(main('Check the fence'))).not.toBe(askKey(main('Paint the gate')))
      expect(askKey(main('one'))).not.toBe(askKey(row({ gist: 'one' })))
    })
  })
})
