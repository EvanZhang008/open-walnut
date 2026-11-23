/**
 * Guard: a Threads card says the group it is drawn in, from the one rule (src/core/org/thread-groups.ts
 * threadGroupOf), never from a mapping of its own (web/src/components/org/thread-badge.ts; 2026-11-21,
 * a review on his data: a card in Working kept the orange needs dot and an Answer box, one in
 * Waiting read "Pending", one in Closed read "Moved").
 *
 *  - For every thread shape (tests/core/org/thread-shapes.ts), as the node's own and as a task's
 *    below: the badge's word is THREAD_GROUP_LABELS[threadGroupOf(t)], its group is that group, and
 *    groupThreads draws it under that same group. Only Needs you has the needs colour.
 *  - The class: every web file that draws a thread card reads its state through threadBadge and
 *    draws it with the one ThreadState piece (its dot and its word), so no kind of card shows a dot
 *    of its own or no word (2026-11-21: a card of a task below sat in Working with a grey dot and no
 *    word); none keeps a state-to-word or state-to-dot table, or calls threadGroupOf for a word of
 *    its own.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { THREAD_GROUPS, THREAD_GROUP_LABELS, groupThreads, threadGroupOf } from '../../src/core/org/thread-groups.js'
import { listedForHim } from '../../src/core/org/thread-view.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { GROUP_DOT, threadBadge } from '../../web/src/components/org/thread-badge'
import { NOW, threadShapes } from '../core/org/thread-shapes'

const ROOT = join(__dirname, '..', '..')
const ORG = join(ROOT, 'web', 'src', 'components', 'org')

/** Every shape, as the node's own thread and as one of a task below (a popped card). */
function everyShape(): Array<{ t: OrgThread; listed: boolean; name: string }> {
  return threadShapes().flatMap((x) => [x, { ...x, t: { ...x.t, owner: { task_id: 'task-below', title: 'Trays' } } as OrgThread, name: `${x.name} owner` }])
}

describe('a card says the group it is drawn in', () => {
  it('the badge is THREAD_GROUP_LABELS[threadGroupOf(t)] for every thread shape', () => {
    const all = everyShape()
    expect(all.length).toBeGreaterThan(1000)
    const seen = new Set<string>()
    for (const { t, listed, name } of all) {
      const g = threadGroupOf(t, listed, NOW)
      const badge = threadBadge(t, listed, NOW)
      expect(badge.group, name).toBe(g)
      expect(badge.label, name).toBe(THREAD_GROUP_LABELS[g])
      expect(badge.dot === GROUP_DOT.needs, name).toBe(g === 'needs')
      seen.add(g)
    }
    // The shapes reach every group, so the check covers every word.
    expect([...seen].sort()).toEqual([...THREAD_GROUPS].sort())
  })

  it('the group a card says is the group groupThreads draws it under', () => {
    const ts = everyShape().filter((x) => !x.listed).map((x, i) => ({ ...x.t, id: `th-${i.toString(16).padStart(12, '0')}` }))
    const listed = new Set(listedForHim(ts, NOW))
    const groups = groupThreads(ts, NOW)
    for (const g of THREAD_GROUPS) for (const t of groups[g]) expect(threadBadge(t, listed.has(t), NOW).label, t.id).toBe(THREAD_GROUP_LABELS[g])
  })

  it('every card file reads its state word through threadBadge, with no table of its own', () => {
    const cards = readdirSync(ORG).filter((f) => f.endsWith('.tsx')).map((f) => ({ f, src: readFileSync(join(ORG, f), 'utf8') }))
      // The class: a component that draws a thread card's head or its ask card (found from the source).
      .filter(({ src }) => /data-testid="org-thread-(state|head)"|testId="org-thread-popped"/.test(src))
    expect(cards.map((c) => c.f).sort()).toEqual(['OrgThreads.tsx', 'PoppedThreadCard.tsx', 'ThreadState.tsx'])
    // The state word and dot are drawn in one place only.
    expect(cards.filter((c) => c.src.includes('data-testid="org-thread-state"')).map((c) => c.f)).toEqual(['ThreadState.tsx'])
    for (const { f, src } of cards.filter((c) => c.f !== 'ThreadState.tsx')) {
      expect(src, f).toMatch(/threadBadge\(/)
      expect(src, `${f}: draws its state with ThreadState`).toMatch(/<ThreadState badge=\{badge\}/)
      expect(src, `${f}: a state word table`).not.toMatch(/STATE_LABEL|STATE_DOT|stateLabel\(/)
      expect(src, `${f}: its own group call`).not.toMatch(/threadGroupOf\(/)
      expect(src, `${f}: a word by state`).not.toMatch(/'Pending'|'Moved'|'Asked in a task'/)
    }
  })
})
