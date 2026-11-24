/**
 * One subject is one thread (org/thread-same-subject.ts). The first pair is shaped like a duplicate
 * across a task and its own subtask (invented garden data): each opened a thread on one spike, one
 * naming the place, the other its short code, sharing one word.
 * Chinese test data is written with \u escapes.
 */
import { describe, expect, it } from 'vitest'
import { copyRefusal, reasonCoversTask, sameSubjectCandidates, sameSubjectRefusal, strongMatch, subjectWords, type TreeThreads } from '../../../src/core/org/thread-same-subject.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const thread = (id: string, title: string, extra: Partial<OrgThread> = {}): OrgThread => ({
  id, title, state: 'needs', messages: [], createdAt: '2026-11-22T22:00:00Z', updatedAt: '2026-11-22T22:00:00Z', ...extra,
} as OrgThread)

// A place name plus "irrigation errors spike (11-18)" on the subtask; its short code plus "spike to check: needs your confirmation" on its parent.
const CHILD_TITLE = '\u7801\u5934 Acme \u704c\u6e89\u62a5\u9519\u5c16\u5cf0\uff0811-18\uff09'
const PARENT_TITLE = 'MRN SeedRun \u5c16\u5cf0\u8981\u67e5\uff1a\u9700\u8981\u4f60\u786e\u8ba4'

describe('one subject is one thread', () => {
  it('finds the open thread of a subtask that shares a word, and names its task', () => {
    const tree: TreeThreads[] = [
      { task: { id: 'parent-1', title: 'Ticket triage' }, threads: [thread('th-aaa111', 'Weekly report sent')] },
      { task: { id: 'child-1', title: 'Ops review' }, threads: [thread('th-bbb222', CHILD_TITLE)] },
    ]
    const found = sameSubjectCandidates(PARENT_TITLE, tree, NOW)
    expect(found.map((c) => c.id)).toEqual(['th-bbb222'])
    const text = sameSubjectRefusal(found, 'parent-1')
    expect(text).toContain('th-bbb222')
    expect(text).toContain('on task "Ops review", child-1')
    expect(text).toContain('separate_reason')
  })

  it('leaves out closed, old and unrelated threads, and words that say nothing', () => {
    const tree: TreeThreads[] = [{ task: { id: 'n', title: 'Node' }, threads: [
      thread('th-c1', CHILD_TITLE, { closed: { at: '2026-11-22T23:00:00Z', by: 'human', how: 'acked' } as OrgThread['closed'] }),
      thread('th-c2', CHILD_TITLE, { updatedAt: '2026-10-01T00:00:00Z' }),
      thread('th-c3', '\u7ad9\u4f1a\u603b\u7ed3\uff1a\u6628\u5929\u548c\u4eca\u5929'),
    ] }]
    expect(sameSubjectCandidates(PARENT_TITLE, tree, NOW)).toEqual([])
    // Words that say nothing about a subject are no subject words.
    expect([...subjectWords('\u9700\u8981 the and with this')]).toEqual([])
  })

  it('a title that clearly repeats an open one is a strong match; one shared word is not', () => {
    const tree: TreeThreads[] = [{ task: { id: 'n', title: 'Node' }, threads: [thread('th-d1', 'Gamma auto failover switch for acme-west-1')] }]
    expect(strongMatch(sameSubjectCandidates('Acme-west-1 gamma failover switch', tree, NOW))?.id).toBe('th-d1')
    expect(strongMatch(sameSubjectCandidates('Gamma dashboard colors', tree, NOW))).toBeUndefined()
  })

  // Review 2026-11-23: three shared words of short titles called other subjects the same.
  it('a short title needs four shared words', () => {
    const tree: TreeThreads[] = [{ task: { id: 'n', title: 'Node' }, threads: [
      thread('th-g1', 'Mac app build fails'),
      thread('th-g2', '\u5b9e\u65f6\u804a\u5929\u5361\u987f'),
    ] }]
    expect(strongMatch(sameSubjectCandidates('iOS app build fails', tree, NOW))).toBeUndefined()
    expect(strongMatch(sameSubjectCandidates('Mac app build icon missing', tree, NOW))).toBeUndefined()
    expect(strongMatch(sameSubjectCandidates('Mac app build fails again on CI', tree, NOW))?.id).toBe('th-g1')
    // "live chat order wrong" against "live chat lags": three shared pairs of short titles are not enough.
    expect(strongMatch(sameSubjectCandidates('\u5b9e\u65f6\u804a\u5929\u987a\u5e8f\u9519', tree, NOW))).toBeUndefined()
  })

  // One error told by a place name, then by its short code in a longer title.
  it('half of the new title is enough, however long the open one is', () => {
    const tree: TreeThreads[] = [{ task: { id: 'n', title: 'Node' }, threads: [thread('th-h1', 'MRN \u6c34\u6cf5\u5207\u6362\u704c\u6e89\u62a5\u9519\u4e00\u6b21\uff0811-18\uff09')] }]
    expect(strongMatch(sameSubjectCandidates('\u7801\u5934 SeedRun \u704c\u6e89\u62a5\u9519\u5c16\u5cf0\uff0811-18\uff09', tree, NOW))?.id).toBe('th-h1')
  })

  it('a word in many of the open threads (a date, the product) does not make two subjects one', () => {
    const regions = ['north', 'south', 'east', 'west', 'central']
    const tree: TreeThreads[] = [{ task: { id: 'n', title: 'Node' }, threads: regions.map((r, i) => thread(`th-e${i}`, `Acme latency spike (11-18) in ${r}`)) }]
    const found = sameSubjectCandidates('Acme latency spike (11-18) in midtown', tree, NOW)
    expect(strongMatch(found)).toBeUndefined()
  })

  it('a thread naming a task below that keeps its own threads is told where the subject lives', () => {
    const text = copyRefusal({ id: 'child-1', title: 'Ops review' }, [thread('th-f1', 'Delivery failed twice: a security test'), thread('th-f2', 'Leader change throttled')])
    expect(text).toContain('"Ops review" (child-1) keeps its own Threads')
    expect(text).toContain('th-f1')
    expect(text).toContain('separate_reason that names child-1')
  })

  it('a separate_reason lets a thread naming a task below through only when it is about that task (11-23 [copy])', () => {
    const id = 'f00dcafe-1234-5678-9abc-def012345678'
    // The lead's reason was about another card of its own, not the subtask's threads.
    expect(reasonCoversTask('A review of the gate change only; the latch decision is a separate card', id)).toBe(false)
    expect(reasonCoversTask(`Not the subject of ${id}: it asks about the budget, which that task does not hold`, id)).toBe(true)
    expect(reasonCoversTask('f00dcafe holds the build; this asks about the release date', id)).toBe(true)
    expect(reasonCoversTask('f00dcafe', id)).toBe(false)
    expect(reasonCoversTask(undefined, id)).toBe(false)
  })

  it('two titles that each name another item (a review id, a ticket number) are two matters, whatever else they share (the thread monitor, 2026-11-24)', () => {
    // "PR-4821 waiting on your review: orchard new platform plug-in scales with busy slots" and
    // "Orchard new platform dashboard waiting on your review: PR-4977" (Chinese, escaped).
    const a = 'PR-4821 \u7b49\u4f60\u5ba1\uff1aOrchard \u65b0\u5e73\u53f0\u63d2\u4ef6\u6309\u5fd9\u7684\u69fd\u4f4d\u6269\u7f29'
    const b = 'Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1\uff1aPR-4977'
    const tree = (title: string): TreeThreads[] => [{ task: { id: 'n', title: 'Node' }, threads: [thread('th-a', title)] }]
    expect(strongMatch(sameSubjectCandidates(b, tree(a), NOW))).toBeUndefined()
    // The same item named again is still a repeat, and a title naming none is judged by its words as before.
    expect(strongMatch(sameSubjectCandidates(b.replace('PR-4977', 'PR-4821'), tree(a), NOW))?.id).toBe('th-a')
    expect(strongMatch(sameSubjectCandidates(b.replace('\uff1aPR-4977', ''), tree(a), NOW))?.id).toBe('th-a')
    // A long number is an item too; a date or a version is not.
    expect(strongMatch(sameSubjectCandidates('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 1002345', tree('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 1002399'), NOW))).toBeUndefined()
    expect(strongMatch(sameSubjectCandidates('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 v1.35', tree('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 v1.36'), NOW))?.id).toBe('th-a')
    expect(strongMatch(sameSubjectCandidates('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 20261124', tree('Orchard \u65b0\u5e73\u53f0 dashboard \u7b49\u4f60\u5ba1 20261125'), NOW))?.id).toBe('th-a')
  })
})
