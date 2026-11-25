/**
 * The thread check's rules (src/core/org/thread-audit-rules.ts, experiment threads_audit): each
 * finding kind on and off, the candidate pairs and their caps, what the judge reads and how its
 * answer is read, the note's text and size, and which findings are told again. Invented orchard
 * and fence data.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIT_KINDS, MAX_FINDINGS, RIDE_HEAD, STALE_NEEDS_MS, STALE_WORKING_MS, TELL_AGAIN_MS, auditNote, cardText, findingLine,
  judgeInput, pickToTell, readJudgement, repeatCandidates, repeatFinding, ruleFindings, staleFinding, thinFinding, unaskedFinding, wakesNode,
  type AuditFinding,
} from '../../../src/core/org/thread-audit-rules.js'
import type { TreeThreads } from '../../../src/core/org/thread-same-subject.js'
import { firstSentence } from '../../../src/core/org/ask-clarity.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const H = 3_600_000
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const thread = (id: string, title: string, extra: Partial<OrgThread> = {}): OrgThread => ({
  id, title, state: 'answered', messages: [], createdAt: at(10 * H), updatedAt: at(H),
  reply: 'The east fence is mended with cedar posts and the gate latches again.', ...extra,
} as OrgThread)
const NODE = 'node-1'

describe('stale', () => {
  it('a new or working card with nothing written for a day, or one in needs for three days', () => {
    expect(staleFinding(thread('th-a1', 'Fence', { state: 'working', updatedAt: at(STALE_WORKING_MS + H) }), NODE, NOW)?.kind).toBe('stale')
    expect(staleFinding(thread('th-a2', 'Fence', { state: 'new', updatedAt: at(STALE_WORKING_MS) }), NODE, NOW)?.why).toMatch(/^new, nothing written since 24 hours ago/)
    expect(staleFinding(thread('th-a3', 'Fence', { state: 'needs', updatedAt: at(STALE_NEEDS_MS + H) }), NODE, NOW)?.key).toBe('stale:th-a3')
  })
  it('not before its time, never answered or pending, closed, moved or snoozed', () => {
    expect(staleFinding(thread('th-b1', 'Fence', { state: 'working', updatedAt: at(STALE_WORKING_MS - H) }), NODE, NOW)).toBeNull()
    expect(staleFinding(thread('th-b2', 'Fence', { state: 'needs', updatedAt: at(STALE_WORKING_MS + H) }), NODE, NOW)).toBeNull()
    expect(staleFinding(thread('th-b3', 'Fence', { state: 'answered', updatedAt: at(30 * 24 * H) }), NODE, NOW)).toBeNull()
    expect(staleFinding(thread('th-b4', 'Fence', { state: 'pending', updatedAt: at(30 * 24 * H) }), NODE, NOW)).toBeNull()
    expect(staleFinding(thread('th-b5', 'Fence', { state: 'working', updatedAt: at(48 * H), closed: { at: at(H), by: 'human', how: 'acked' } as OrgThread['closed'] }), NODE, NOW)).toBeNull()
    expect(staleFinding(thread('th-b6', 'Fence', { state: 'working', updatedAt: at(48 * H), snoozed: { until: at(-24 * H), at: at(48 * H), by: 'human' } as OrgThread['snoozed'] }), NODE, NOW)).toBeNull()
  })
})

describe('thin', () => {
  it('no summary on a card that shows him a result, one that only points elsewhere, or a few words', () => {
    expect(thinFinding(thread('th-c1', 'Orchard', { reply: '' }), NODE)?.why).toBe('no summary')
    expect(thinFinding(thread('th-c2', 'Orchard', { state: 'needs', reply: undefined }), NODE)?.why).toBe('no summary')
    expect(thinFinding(thread('th-c3', 'Orchard', { reply: 'Already told you.' }), NODE)?.why).toMatch(/points elsewhere/)
    expect(thinFinding(thread('th-c4', 'Orchard', { reply: 'Done, live.' }), NODE)?.why).toMatch(/^its summary is \d+ characters$/)
  })
  it('a summary that says the result, a working card with none yet, or a card the node does not word', () => {
    expect(thinFinding(thread('th-d1', 'Orchard'), NODE)).toBeNull()
    expect(thinFinding(thread('th-d2', 'Orchard', { state: 'working', reply: '' }), NODE)).toBeNull()
    expect(thinFinding(thread('th-d3', 'Orchard', { reply: '', reportAsk: { id: 'd1', at: at(H) } }), NODE)).toBeNull()
    // Two CJK characters read as about four Latin ones: a short Chinese line is not cut as short as its length says.
    expect(thinFinding(thread('th-d4', 'Orchard', { reply: '\u679c\u56ed\u7684\u4e1c\u8fb9\u7bf1\u7b06\u4fee\u597d\u4e86\uff0c\u95e8\u4e5f\u80fd\u5173\u4e0a\u4e86' }), NODE)).toBeNull()
  })
})

describe('unasked', () => {
  it('a summary that asks him to decide on a card out of his Needs you', () => {
    const f = unaskedFinding(thread('th-e1', 'Paint', { reply: 'The fence is ready. Please pick a paint color.' }), NODE)
    expect(f).toMatchObject({ kind: 'unasked', key: 'unasked:th-e1' })
    expect(f?.why).toMatch(/but it is answered/)
  })
  it('never one in needs, one with a result only, or one whose ask lives on another task', () => {
    expect(unaskedFinding(thread('th-e2', 'Paint', { state: 'needs', reply: 'Please pick a paint color.' }), NODE)).toBeNull()
    expect(unaskedFinding(thread('th-e3', 'Paint', { reply: 'Painted white, your pick is live.' }), NODE)).toBeNull()
    expect(unaskedFinding(thread('th-e4', 'Paint', { state: 'pending', reply: 'Please pick a paint color.', askOwner: { task: 't', at: at(H), by: 'agent' } }), NODE)).toBeNull()
  })
  it('ruleFindings lists unasked, then stale, then thin', () => {
    const found = ruleFindings([
      thread('th-f1', 'Thin', { reply: '' }),
      thread('th-f2', 'Stale', { state: 'working', updatedAt: at(48 * H) }),
      thread('th-f3', 'Asks', { reply: 'Please pick a paint color for the gate.' }),
    ], NODE, NOW)
    expect(found.map((f) => f.kind)).toEqual(['unasked', 'stale', 'thin'])
  })
})

const tree = (own: OrgThread[], ...others: Array<{ id: string; threads: OrgThread[]; below?: boolean }>): TreeThreads[] => [
  { task: { id: NODE, title: 'Orchard lead' }, threads: own },
  ...others.map((o) => ({ task: { id: o.id, title: `Task ${o.id}` }, threads: o.threads, ...(o.below ? { below: true } : {}) })),
]

describe('repeat candidates', () => {
  it('pairs two of the node\'s cards sharing telling words, and a card naming the other first', () => {
    const own = [
      thread('th-g1', 'Pear orchard irrigation timer drifts at night'),
      thread('th-g2', 'Irrigation timer drift in the pear orchard'),
      thread('th-g3', 'Barn roof quote'),
      thread('th-g4', 'Hay delivery', { reply: 'Same as th-g3: waiting for the roofer before the hay goes in.' }),
    ]
    const c = repeatCandidates(NODE, tree(own), NOW)
    expect(c[0]).toMatchObject({ key: 'repeat:th-g3+th-g4', why: 'named' })
    expect(c.map((x) => x.key)).toContain('repeat:th-g1+th-g2')
    expect(c.find((x) => x.key === 'repeat:th-g1+th-g2')?.why).toBe('words')
    expect(c.every((x) => x.a.taskId === NODE)).toBe(true)
  })
  it('pairs with a task below or one its card names; never a task above, never two cards of other tasks, never closed', () => {
    const own = [thread('th-h1', 'Apple cider press repair parts', { tasks: ['named-1'] })]
    const below = { id: 'below-1', below: true, threads: [thread('th-h2', 'Cider press repair parts ordered')] }
    const above = { id: 'above-1', threads: [thread('th-h3', 'Cider press repair parts budget')] }
    const named = { id: 'named-1', threads: [thread('th-h4', 'Gasket for the press')] }
    const closed = { id: 'below-2', below: true, threads: [thread('th-h5', 'Cider press repair parts', { closed: { at: at(H), by: 'human', how: 'acked' } as OrgThread['closed'] })] }
    const keys = repeatCandidates(NODE, tree(own, below, above, named, closed), NOW).map((x) => x.key)
    expect(keys).toContain('repeat:th-h1+th-h2')
    // The named task keeps a single open card: its likely copy, whatever its words.
    expect(keys).toContain('repeat:th-h1+th-h4')
    expect(keys).not.toContain('repeat:th-h1+th-h3')
    expect(keys.some((k) => k.includes('th-h5'))).toBe(false)
    expect(keys.some((k) => k.includes('th-h2') && k.includes('th-h4'))).toBe(false)
  })
  it('a node with no open card has no pairs; unrelated titles none', () => {
    expect(repeatCandidates(NODE, tree([]), NOW)).toEqual([])
    expect(repeatCandidates(NODE, tree([thread('th-i1', 'Barn roof quote'), thread('th-i2', 'Goat vaccination dates')]), NOW)).toEqual([])
  })
})

describe('the judge', () => {
  const pair = repeatCandidates(NODE, tree([
    thread('th-j1', 'Pear orchard irrigation timer drifts at night', { ask: 'Fix the timer', reply: 'The timer loses ten minutes a night. A new battery is ordered.' }),
    thread('th-j2', 'Irrigation timer drift in the pear orchard'),
  ]), NOW)
  it('reads titles, asks and the first summary sentence only, with the markers stripped from the cards', () => {
    expect(firstSentence('The timer loses ten minutes a night. A new battery is ordered.')).toBe('The timer loses ten minutes a night.')
    expect(firstSentence('\u5b9a\u65f6\u5668\u6bcf\u665a\u6162\u5341\u5206\u949f\u3002\u65b0\u7535\u6c60\u5df2\u8ba2\u3002')).toBe('\u5b9a\u65f6\u5668\u6bcf\u665a\u6162\u5341\u5206\u949f\u3002')
    const text = judgeInput(pair, '<<mk>>')
    expect(text).toContain('1. A: Title: ')
    expect(text).toContain('Ask: Fix the timer')
    expect(text).toContain('Summary: The timer loses ten minutes a night.')
    expect(text).not.toContain('A new battery')
    expect(cardText(thread('th-j3', 'Gate <<mk>> latch'), '<<mk>>')).toBe('Title: Gate latch | Summary: The east fence is mended with cedar posts and the gate latches again.')
  })
  it('reads one verdict per numbered line, first one wins, a missing one is null', () => {
    const v = readJudgement('1 SAME: one timer, told twice\n**2. DIFFERENT** - two gates\n2 SAME: again\nnoise', 3)
    expect(v).toEqual([{ verdict: 'same', reason: 'one timer, told twice' }, { verdict: 'different', reason: 'two gates' }, null])
  })
  it('across tasks the node\'s card merges into the task\'s, unless only the node\'s waits on him: then the task\'s moves, named by its task', () => {
    const cross = repeatCandidates(NODE, tree([thread('th-k1', 'Cider press repair parts list')], { id: 'below-1', below: true, threads: [thread('th-k2', 'Cider press repair parts list ordered')] }), NOW)[0]
    const plain = repeatFinding(cross, 'one press')
    expect(plain).toMatchObject({ thread: { id: 'th-k1' }, other: { id: 'th-k2' } })
    expect(plain.onTask).toBeUndefined()
    expect(findingLine(plain, false)).toContain('thread_update {"id":"th-k1","merge_into":"th-k2"}')
    const asks = repeatFinding({ ...cross, a: { ...cross.a, thread: { ...cross.a.thread, state: 'needs' } } }, 'one press')
    expect(asks).toMatchObject({ thread: { id: 'th-k2' }, other: { id: 'th-k1' }, onTask: 'below-1' })
    expect(findingLine(asks, false)).toContain('thread_update {"task":"below-1","id":"th-k2","merge_into":"th-k1"}')
    expect(findingLine(asks, false)).toMatch(/^- repeat: th-k2 "[^"]+" on task below-1 and th-k1 /)
  })
  it('a repeat merges the node\'s card into a task\'s card, and of two own the one in needs stays', () => {
    const own = repeatFinding(pair[0], 'one timer')
    expect(own.kind).toBe('repeat')
    const n = repeatFinding({ ...pair[0], a: { ...pair[0].a, thread: { ...pair[0].a.thread, state: 'needs' } } }, '')
    expect(n.other?.id).toBe(pair[0].a.thread.id)
    expect(n.why).toBe('one subject')
  })
})

const finding = (kind: AuditFinding['kind'], id: string): AuditFinding =>
  ({ kind, key: `${kind}:${id}`, thread: { id, title: `Card ${id}`, state: 'answered', taskId: NODE }, ...(kind === 'repeat' ? { other: { id: `${id}x`, title: 'Other', state: 'answered', taskId: 'below-1', taskTitle: 'Fence crew' } } : {}), why: 'test' })

describe('what is told', () => {
  it('most important first, at most MAX_FINDINGS, and a key told within TELL_AGAIN_MS is not told again', () => {
    const found = [
      ...Array.from({ length: 6 }, (_, i) => finding('thin', `th-t${i}`)),
      finding('stale', 'th-s1'), finding('repeat', 'th-r1'), finding('unasked', 'th-u1'), finding('unasked', 'th-u2'),
    ]
    const told = { 'unasked:th-u2': { at: at(TELL_AGAIN_MS - H) }, 'thin:th-t0': { at: at(TELL_AGAIN_MS + H) } }
    const pick = pickToTell(found, told, NOW)
    expect(pick).toHaveLength(MAX_FINDINGS)
    expect(pick.map((f) => f.kind).slice(0, 3)).toEqual(['repeat', 'unasked', 'stale'])
    expect(pick.map((f) => f.key)).not.toContain('unasked:th-u2')
    // Told more than 14 days ago and still found: told again.
    expect(pick.map((f) => f.key)).toContain('thin:th-t0')
  })
  it('wakes the node only for a repeat or an unasked decision', () => {
    expect(wakesNode([finding('stale', 'a'), finding('thin', 'b')])).toBe(false)
    expect(wakesNode([finding('thin', 'b'), finding('unasked', 'c')])).toBe(true)
    expect(wakesNode([finding('repeat', 'd')])).toBe(true)
  })
  it('each line names the thread ids and the one call that fixes it; the kept mode points at the status question', () => {
    expect(findingLine(finding('repeat', 'th-r1'), false)).toMatch(/^- repeat: th-r1 "Card th-r1" and th-r1x "Other" on task below-1 .*thread_update \{"id":"th-r1","merge_into":"th-r1x"\}/)
    expect(findingLine(finding('unasked', 'th-u1'), false)).toContain('thread_update {"id":"th-u1","state":"needs","options":[...]')
    expect(findingLine(finding('stale', 'th-s1'), false)).toContain('thread_update {"id":"th-s1",...}')
    expect(findingLine(finding('stale', 'th-s1'), true)).toContain('give it a line in Walnut\'s status question')
    expect(findingLine(finding('thin', 'th-t1'), false)).toContain('thread_update {"id":"th-t1","reply":"..."}')
    // A thin card that waits on him is asked for the decision, never for a result.
    expect(findingLine(finding('thin', 'th-t1'), false)).toContain('Write the result itself')
    const waiting = { ...finding('thin', 'th-t2'), thread: { ...finding('thin', 'th-t2').thread, state: 'needs' } }
    expect(findingLine(waiting, false)).toContain('Write what he decides and your pick')
    expect(findingLine(waiting, false)).not.toContain('result itself')
    const note = auditNote([finding('repeat', 'th-r1'), finding('thin', 'th-t1')], false)
    expect(note.split('\n')).toHaveLength(3)
    expect(note).toMatch(/^Walnut's thread check .* It changed nothing/)
    // A riding note says nothing is urgent, as the status wrapper it rides in says.
    expect(auditNote([finding('thin', 'th-t1')], false, true).startsWith(RIDE_HEAD)).toBe(true)
    expect(RIDE_HEAD).toMatch(/none is urgent/)
  })
  it('a full note of the longest titles and reasons stays under 4 KB, titles cut to 48 characters', () => {
    const long = (kind: AuditFinding['kind'], i: number): AuditFinding => {
      const f = finding(kind, `th-${'0'.repeat(10)}${i}`)
      return { ...f, thread: { ...f.thread, title: '\u679c'.repeat(120) }, ...(f.other ? { other: { ...f.other, title: '\u679c'.repeat(120), taskTitle: '\u679c'.repeat(120) } } : {}), why: 'w'.repeat(120) }
    }
    const note = auditNote(AUDIT_KINDS.flatMap((k, i) => [long(k, i), long(k, i + 4)]), false)
    expect(note.split('\n')).toHaveLength(9)
    expect(note).not.toContain('\u679c'.repeat(46))
    expect(Buffer.byteLength(note)).toBeLessThan(4_000)
  })
})
