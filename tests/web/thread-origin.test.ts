/**
 * Guard: every Threads card says where its thread came from (web/src/components/org/thread-origin.ts;
 * 2026-11-23, the user, on a leader's Threads holding the threads of the tasks below it: each thread
 * must say whether it is this task's own or which task it came from, "those are two different
 * things"). The card he looked at read "Opened by <its own title>", and one filed from his own
 * message said nothing at all.
 *
 *  - The words: this task's own reads "You asked this task" (his message) or "Opened by this task"
 *    (its agent's first post), never the node's name, which a task below could share in look; a
 *    thread of a task below reads "From <that task>", however deep that task is.
 *  - The filter by origin (ThreadOriginFilter.tsx; the user: "there can be a filter by ... by
 *    default, at least all"): All, This task, then each task below with a thread in the list, each
 *    counting what the view lists for him; none when every thread is the node's own; a kept pick
 *    whose task left the list reads All.
 *  - The class: every web file that draws a thread card's head or its ask card (found from the
 *    source, as thread-badge.test.ts finds them) reads its line through threadOrigin and draws it as
 *    the one `org-thread-from` piece, so a new kind of card cannot come without one.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FROM_BELOW, ORIGIN_ALL, ORIGIN_OWN, fromOrigin, originChoices, shownOrigin, threadOrigin } from '../../web/src/components/org/thread-origin'

const ORG = join(__dirname, '..', '..', 'web', 'src', 'components', 'org')
const AT = '2026-11-23T10:00:00.000Z'

describe('where a thread came from', () => {
  it('a thread filed from his message is this task\'s own, asked by him', () => {
    const o = threadOrigin({}, 'Garden plan')
    expect(o).toMatchObject({ from: 'own', opened: 'you', words: 'You asked this task' })
    // The node's name only in the hover, never as the line itself.
    expect(o.words).not.toContain('Garden plan')
    expect(o.hover).toContain('Garden plan')
  })

  it('a thread its agent opened is this task\'s own, opened by it', () => {
    const o = threadOrigin({ opener: { text: 'The vendor wrote', at: AT, from: 'mail', by: 'task:t-1' } }, 'Garden plan')
    expect(o).toMatchObject({ from: 'own', opened: 'task', words: 'Opened by this task' })
    expect(o.hover).toMatch(/^Opened by this task .*Garden plan/)
    // An opener he wrote himself reads as his.
    expect(threadOrigin({ opener: { text: 'x', at: AT, from: 'node', by: 'human' } }, 'Garden plan').words).toBe('You asked this task')
    // Moved here from another node: neither his ask to this task nor this task's own post.
    expect(threadOrigin({ movedFrom: { task: 'vp-1', title: 'Home VP', at: AT, by: 'task:vp-1' } }, 'Garden plan').words).toBe('Moved here from Home VP')
  })

  it('a thread of a task below names that task, whoever opened it there', () => {
    for (const opener of [undefined, { text: 'x', at: AT, from: 'node', by: 'task:child' }]) {
      const o = threadOrigin({ owner: { task_id: 'child', title: 'Soil test' }, ...(opener ? { opener } : {}) }, 'Garden plan')
      expect(o).toMatchObject({ from: 'below', taskId: 'child', title: 'Soil test', words: `${FROM_BELOW} Soil test` })
      expect(o.hover).toContain('Garden plan')
    }
  })

  it('a task two levels down is named as itself (the task holding the thread)', () => {
    const o = threadOrigin({ owner: { task_id: 'grandchild', title: 'Order seeds' } }, 'Garden plan')
    expect(o).toMatchObject({ from: 'below', taskId: 'grandchild', words: 'From Order seeds' })
  })

  it('a task below with a blank title still reads as below', () => {
    expect(threadOrigin({ owner: { task_id: 'child', title: '  ' } }, 'Garden plan')).toMatchObject({ from: 'below', words: 'From a task below' })
  })

  it('the filter offers All, This task and each task below, counting what the view lists for him', () => {
    const threads = [
      { id: 'a', owner: { task_id: 'child', title: 'Soil test' } },
      { id: 'b' },
      { id: 'c', owner: { task_id: 'grandchild', title: 'Order seeds' } },
      { id: 'd', owner: { task_id: 'child', title: 'Soil test' } },
      { id: 'e', opener: { text: 'x', at: AT, from: 'mail', by: 'task:t-1' } },
    ]
    const listed = new Set(['a', 'b', 'c', 'd'])
    const choices = originChoices(threads, listed)!
    expect(choices.map((c) => [c.id, c.label, c.count])).toEqual([
      [ORIGIN_ALL, 'All', 4], [ORIGIN_OWN, 'This task', 1], ['child', 'Soil test', 2], ['grandchild', 'Order seeds', 1],
    ])
    expect(threads.filter((t) => fromOrigin(t, 'child')).map((t) => t.id)).toEqual(['a', 'd'])
    expect(threads.filter((t) => fromOrigin(t, ORIGIN_OWN)).map((t) => t.id)).toEqual(['b', 'e'])
    expect(threads.filter((t) => fromOrigin(t, ORIGIN_ALL))).toHaveLength(5)
  })

  it('no filter when every thread is the node\'s own; a pick no longer offered reads All', () => {
    expect(originChoices([{ id: 'b' }, { id: 'e', opener: { text: 'x', at: AT, from: 'node', by: 'agent' } }], new Set(['b']))).toBeNull()
    const choices = originChoices([{ id: 'a', owner: { task_id: 'child', title: 'Soil test' } }], new Set(['a']))
    expect(shownOrigin('child', choices)).toBe('child')
    expect(shownOrigin(ORIGIN_OWN, choices)).toBe(ORIGIN_OWN)
    expect(shownOrigin('gone-task', choices)).toBe(ORIGIN_ALL)
    expect(shownOrigin('child', null)).toBe(ORIGIN_ALL)
  })

  it('every card file draws its origin line through threadOrigin', () => {
    const cards = readdirSync(ORG).filter((f) => f.endsWith('.tsx')).map((f) => ({ f, src: readFileSync(join(ORG, f), 'utf8') }))
      // The class: a component that draws a thread card's head or its ask card (found from the source).
      .filter(({ src }) => /data-testid="org-thread-head"|testId="org-thread-popped"/.test(src))
    expect(cards.map((c) => c.f).sort()).toEqual(['OrgThreads.tsx', 'PoppedThreadCard.tsx'])
    for (const { f, src } of cards) {
      expect(src, `${f}: reads its origin through threadOrigin`).toMatch(/threadOrigin\(t, name\)/)
      expect(src, `${f}: draws the one origin piece`).toMatch(/data-testid="org-thread-from" data-origin=\{origin\.from\} title=\{origin\.hover\}/)
      expect(src, `${f}: an origin wording of its own`).not.toMatch(/Opened by \{name\}|`Opened by \$\{name\}`/)
    }
  })
})
