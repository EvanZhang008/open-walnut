/**
 * One subject is one thread (org/thread-same-subject.ts). The first pair is shaped like a duplicate
 * across a task and its own subtask (invented garden data): each opened a thread on one spike, one
 * naming the place, the other its short code, sharing one word.
 * Chinese test data is written with \u escapes.
 */
import { describe, expect, it } from 'vitest'
import { copyRefusal, headWords, reasonCoversTask, sameSubjectCandidates, sameSubjectRefusal, strongMatch, subjectWords, type TreeThreads } from '../../../src/core/org/thread-same-subject.js'
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

  it('a subject named before a colon that the other title does not hold is another matter, whatever state they share (the thread monitor, 2026-11-25)', () => {
    const tree = (title: string): TreeThreads[] => [{ task: { id: 'n', title: 'Node' }, threads: [thread('th-a', title)] }]
    const match = (fresh: string, open: string) => strongMatch(sameSubjectCandidates(fresh, tree(open), NOW))?.id
    // Two reports whose comments went to two design docs of one person.
    const report = 'Seed storage report: comments posted to Marta\'s design doc'
    const design = 'Marta\'s irrigation design: your two comments are posted to the doc'
    expect(match(report, design)).toBeUndefined()
    expect(match(design, report)).toBeUndefined()
    // The same shape in Chinese: "<report>: comments posted to Marta's design doc", "Marta's Irrigation design: your two comments are posted to the doc".
    expect(match('\u79cd\u5b50\u4ed3\u50a8\u62a5\u544a\uff1a\u8bc4\u8bba\u5df2\u53d1\u5230 Marta \u7684\u8bbe\u8ba1\u6587\u6863', 'Marta \u7684 Irrigation \u8bbe\u8ba1\uff1a\u4f60\u7684\u4e24\u6761\u8bc4\u8bba\u5df2\u53d1\u5230\u6587\u6863')).toBeUndefined()
    // One finding in two places, each named first; one state on two fixes, one title with no colon.
    expect(match('Northgate (plot-7): soil probe read rate fell to 98.5%', 'Southmoor (plot-9): soil probe read rate fell to 98.1%')).toBeUndefined()
    expect(match('Sidebar crash on a side question: fixed and live now', 'Third comment in the file preview cannot be added (fixed and live now)')).toBeUndefined()
    // Control: without the rule each pair above is a strong match (the words after the colon alone).
    expect(match(report.replace(':', ''), design.replace(':', ''))).toBe('th-a')
    // A head the other title holds is still a repeat, in either order and with one colon or two.
    expect(match('North field gamma: failover switch stays off, open it?', 'North field gamma failover switch stays off')).toBe('th-a')
    expect(match('North field gamma failover switch stays off', 'North field gamma: failover switch stays off, open it?')).toBe('th-a')
    expect(match('Soil probe review: read rate chart does not line up', 'Soil probe review: four charts do not line up (health, read rate)')).toBe('th-a')
    // A time or a link is no head.
    expect(headWords('Deploy at 14:05 failed')).toEqual([])
    expect(headWords('See https://example.test/x')).toEqual([])
    expect(headWords('Seed storage report: sent')).toEqual(['seed', 'storage', 'report'])
    expect(headWords('Trailing colon:')).toEqual([])
  })
  it('two titles that share only the place both open with, each going on about its own thing, are two matters (the thread monitor, 2026-11-25)', () => {
    const tree = (title: string): TreeThreads[] => [{ task: { id: 'n', title: 'Node' }, threads: [thread('th-a', title)] }]
    const match = (title: string, open: string) => strongMatch(sameSubjectCandidates(title, tree(open), NOW))
    // "Shed, in the list, the Ladder is too old" and "Shed, in the list, the names of those hose rows are too long".
    const ladder = 'Shed \u6e05\u5355\u91cc\u7684 Ladder \u592a\u65e7'
    const hose = 'Shed \u6e05\u5355\u91cc hose \u90a3\u51e0\u884c\u540d\u5b57\u592a\u957f'
    // The words are there (the refusal still names it as a candidate); it is no clear repeat.
    expect(sameSubjectCandidates(ladder, tree(hose), NOW)[0]).toMatchObject({ id: 'th-a', shared: 3, openingOnly: true })
    expect(match(ladder, hose)).toBeUndefined()
    expect(match(hose, ladder)).toBeUndefined()
    expect(match('Garden shed list ladder rungs worn', 'Garden shed list hose names long')).toBeUndefined()
    // Still a repeat: a title that only adds to the open one, one word of its own after the opening,
    // a word shared after a word of its own, and two that share the larger part and differ in where
    // the matter stands (invented: "<place> <stage>: the drip main valve switch stays shut, open it with
    // Lever or not" beside "<place> <stage> the drip main valve switch (the same matter is in <thread>)").
    expect(match('Pump (north-1) beta\uff1a\u6ef4\u704c\u603b\u9600\u5f00\u5173\u4e00\u76f4\u5173\u7740\uff0c\u8981\u4e0d\u8981\u7528 Lever \u6253\u5f00', 'Pump (north-1) beta \u6ef4\u704c\u603b\u9600\u5f00\u5173\uff08\u540c\u4e00\u4ef6\u4e8b\u5728 th-0a1b2c3d4e5f\uff09')?.id).toBe('th-a')
    expect(match(`${ladder}\uff0c\u6362\u4e00\u4e2a`, ladder)?.id).toBe('th-a')
    expect(match('Garden shed tool list ladder worn', 'Garden shed tool list ladder broken')?.id).toBe('th-a')
    expect(match('Shed list ladder is worn out', 'The ladder on the shed list looks worn')?.id).toBe('th-a')
  })

})
