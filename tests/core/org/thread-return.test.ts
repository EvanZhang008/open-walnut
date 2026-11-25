/**
 * A thread he wrote in comes back to him only starting from his words, and a new decision is its
 * own card (src/core/org/thread-return.ts; 2026-11-21, the user: "I already replied, why is it
 * still there?").
 *
 * The shape of the case, with invented garden data: a decision letter asked him to approve
 * turning a sprinkler timer back on with the shared garden key; its thread showed the letter's buttons. He
 * wrote back three times, each a question ("is it a bug, or is there no way back? check first").
 * Each time the task answered and put the thread back in needs with ANOTHER decision (open the
 * valve from the garden panel instead), under the letter's old buttons, the answer below it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { emptyThreads, fileMessage, openThread, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { returnedReply, returnLack, returnLacks } from '../../../src/core/org/thread-return.js'
import { otherAsksRefusal, ownNeedsThreads, supersededAsks } from '../../../src/core/org/thread-supersede.js'

const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 21, h, m)).toISOString()
const TASK = 'task:triage-1'
const KIND = { user_kind: 'permissions', user_kind_why: 'It uses the shared garden key, which needs his approval' }
// His words and the task's, as test data (escaped): "Wait, you said the sprinkler is off: is it a bug,
// or is there no way back? Those are two things. Check first."
const HIS_QUESTION = '\u7b49\u4e00\u4e0b\uff0c\u4f60\u8bf4 sprinkler \u5173\u4e86\uff0c\u662f bug \u8fd8\u662f\u6ca1\u6709 way back\uff1f\u5148\u7ed9\u6211\u67e5\u4e00\u4e0b\u3002'
const NEW_DECISION = 'Open the valve fully from the garden panel so the timer turns the sprinkler back on? I recommend it.'

function letterThread(): { file: ThreadsFile; id: string } {
  // The letter's thread: opened in needs with the letter's choice (letter-thread-model.ts).
  const r = openThread(emptyThreads('triage-1'), {
    title: 'The sprinkler has been off 5 days: turn it on with the shared garden key?', text: 'Approve running start_sprinkler with the shared garden key? I recommend it.',
    from: 'letter', ref: 'lt-abcd1234-000001', ...KIND,
    options: [{ label: 'Approve, run this one', recommended: true }, { label: 'Do not run it' }],
  }, TASK, at(3, 3))
  const file = { ...r.file, threads: r.file.threads.map((t) => ({ ...t, letter: { id: 'lt-abcd1234-000001', task: 'triage-1', options: t.options!.map((o) => ({ id: o.id, label: o.label })), done: false } })) } as ThreadsFile
  return { file, id: r.thread.id }
}

const refused = (fn: () => unknown): ThreadError => {
  try { fn() } catch (e) { if (e instanceof ThreadError) return e; throw e }
  throw new Error('not refused')
}

describe('his words take the card off Needs you, and it comes back only from them', () => {
  it('his question moves it out of needs at once', () => {
    const { file, id } = letterThread()
    const r = fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) })
    expect(r.thread.state).toBe('working')
  })

  it('back to needs with no word on his message, or no word on which decision, is refused', () => {
    const { file, id } = letterThread()
    const after = fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) }).file
    // What the task did that day: the new decision on top, his answer below, no word on either.
    const e = refused(() => updateThread(after, id, { state: 'needs', reply: NEW_DECISION, ...KIND }, TASK, at(20, 7)))
    expect(e.code).toBe('returned_ask')
    expect(e.status).toBe(409)
    expect(e.message).toMatch(/they wrote in this thread since it last waited on them .*since_you_wrote/)
    expect(refused(() => updateThread(after, id, { state: 'needs', reply: NEW_DECISION, since_you_wrote: 'It is a bug: the timer gave up after 2 minutes.', ...KIND }, TASK, at(20, 7))).message)
      .toMatch(/Pass decision "same"/)
  })

  it('a new decision is never a rewrite of the card: it is refused, naming the letter to replace', () => {
    const { file, id } = letterThread()
    const after = fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) }).file
    const e = refused(() => updateThread(after, id, { state: 'needs', reply: NEW_DECISION, since_you_wrote: 'It is a bug: the timer gave up after 2 minutes.', decision: 'new', ...KIND }, TASK, at(20, 7)))
    expect(e.message).toMatch(/a new decision is its own card.*thread_create.*supersedes.*lt-abcd1234-000001/)
    // Answering him here is fine: answered, no decision asked.
    expect(updateThread(after, id, { state: 'answered', reply: 'It is a bug, not a missing way back: the timer gave up after 2 minutes.' }, TASK, at(20, 7)).thread.state).toBe('answered')
  })

  it('the same decision again opens with the decision and what was done since he wrote, never his words', () => {
    const { file, id } = letterThread()
    const after = fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) }).file
    const t = updateThread(after, id, { state: 'needs', reply: 'Approve running start_sprinkler with the shared garden key? I recommend it.', since_you_wrote: 'It is a bug: the timer gave up after 2 minutes and never retried.', decision: 'same', ...KIND }, TASK, at(20, 7)).thread
    expect(t.state).toBe('needs')
    expect(t.reply!.split('\n')[0]).toBe('Approve running start_sprinkler with the shared garden key? I recommend it.')
    expect(t.reply).not.toContain(HIS_QUESTION.slice(0, 20))
    expect(t.reply).toMatch(/^Approve running[\s\S]*\n\n\*\*\u4f60 \d\d:\d\d \u7559\u8a00\u4e4b\u540e\uff1a\*\* It is a bug: the timer gave up after 2 minutes/)
    expect(t.needsAt).toBe(at(20, 7))
    // Asked again with no new word of his: no since line needed.
    expect(updateThread(t.state === 'needs' ? { ...after, threads: after.threads.map((x) => (x.id === id ? t : x)) } : after, id, { reply: t.reply! + ' ' }, TASK, at(20, 8)).thread.state).toBe('needs')
  })

  it('a new summary on a letter\'s card, under the letter\'s buttons, says same or new', () => {
    const { file, id } = letterThread()
    expect(refused(() => updateThread(file, id, { reply: NEW_DECISION }, TASK, at(4, 0))).message).toMatch(/Pass decision "same"/)
    expect(refused(() => updateThread(file, id, { reply: NEW_DECISION, decision: 'new' }, TASK, at(4, 0))).message).toMatch(/its own card/)
    expect(updateThread(file, id, { reply: 'Approve running start_sprinkler with the shared garden key? The beds stay dry meanwhile.', decision: 'same' }, TASK, at(4, 0)).thread.state).toBe('needs')
  })

  it('new choices while it waits on him say same or new', () => {
    const { file, id } = letterThread()
    expect(refused(() => updateThread(file, id, { options: [{ label: 'Open it from the panel' }, { label: 'Leave it off' }] }, TASK, at(4, 0))).message).toMatch(/Pass decision "same"/)
    expect(updateThread(file, id, { options: [{ label: 'Approve, run it now' }, { label: 'Do not run it' }], decision: 'same' }, TASK, at(4, 0)).thread.options).toHaveLength(2)
  })

  it('his own writes and a first ask with no words of his are never asked', () => {
    const r = openThread(emptyThreads('triage-1'), { title: 'Store passkeys in the password extension?', text: 'Store passkeys beside passwords? I recommend yes.', reply: 'Store passkeys in the password extension? I recommend yes.', from: 'node', ...KIND, options: [{ label: 'Store passkeys' }, { label: 'Passwords only' }] }, TASK, at(1, 0))
    expect(r.thread.state).toBe('needs')
    const filed = fileMessage(emptyThreads('triage-1'), { text: 'Turn the sprinkler back on', via: 'chat', at: at(1, 0) })
    expect(updateThread(filed.file, filed.thread.id, { state: 'needs' }, 'human', at(1, 1)).thread.state).toBe('needs')
  })

  it('the card starts with the decision, then what was done since he wrote, and never repeats his words', () => {
    const cur = { messages: [{ id: 'tm-aaaaaa01', at: at(20, 11), text: 'Did you not answer me? '.repeat(5), via: 'chat' as const }] }
    const card = returnedReply(cur, 'Answered above: it is a bug.', 'Approve it?')
    expect(card).toBe('Approve it?\n\n**Since your message at 20:11 UTC:** Answered above: it is a bug.')
    expect(card).not.toContain('Did you not answer me')
  })
})

// A card line has one send-back a turn: every rule it meets is named at once (reply-card-decision.ts).
describe('every rule a write meets, in one go', () => {
  const after = () => { const { file, id } = letterThread(); return { cur: fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) }).thread, id } }
  const SINCE = 'It is a bug: the timer gave up after 2 minutes.'

  it('back to needs after his words with nothing said: since and decision both, in that order', () => {
    const { cur } = after()
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION }, TASK, true)).toEqual(['since', 'decision'])
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION, since_you_wrote: SINCE }, TASK, true)).toEqual(['decision'])
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION, decision: 'same' }, TASK, true)).toEqual(['since'])
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION, since_you_wrote: SINCE, decision: 'same' }, TASK, true)).toEqual([])
    // A new decision is the rule's own answer, named last: its own card.
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION, decision: 'new' }, TASK, true)).toEqual(['since', 'new'])
    expect(returnLacks(cur, { state: 'needs', reply: NEW_DECISION, since_you_wrote: SINCE, decision: 'new' }, TASK, true)).toEqual(['new'])
  })

  it('the op refuses on exactly the first of them, in its own words', () => {
    const { file, id } = letterThread()
    const later = fileMessage(file, { text: HIS_QUESTION, via: 'follow-up', threadId: id, at: at(20, 6) })
    for (const [patch, first] of [
      [{ state: 'needs', reply: NEW_DECISION, ...KIND }, /since_you_wrote/],
      [{ state: 'needs', reply: NEW_DECISION, since_you_wrote: SINCE, ...KIND }, /Pass decision "same"/],
      [{ state: 'needs', reply: NEW_DECISION, since_you_wrote: SINCE, decision: 'new', ...KIND }, /its own card/],
    ] as const) {
      expect(returnLack(later.thread, patch, TASK, true)).toBe(returnLacks(later.thread, patch, TASK, true)[0])
      expect(refused(() => updateThread(later.file, id, patch, TASK, at(20, 7))).message).toMatch(first)
    }
    expect(returnLacks(later.thread, { state: 'needs' }, 'human', true)).toEqual([])
  })
})

describe('one matter is asked in one place', () => {
  it('a second needs thread of the task names what it replaces, or why both stay', () => {
    const { file, id } = letterThread()
    const others = ownNeedsThreads(file, 'triage-1', 'th-new000001')
    expect(others.map((o) => o.id)).toEqual([id])
    expect(otherAsksRefusal(others, {})).toMatch(/your task still asks them this too: th-.* One matter is asked in one place\. Pass supersedes/)
    expect(otherAsksRefusal(others, { supersedes: [id] })).toBeNull()
    expect(supersededAsks(others, [id, 'th-notmine01'])).toEqual(others)
    expect(otherAsksRefusal(others, { separate_reason: 'short' })).not.toBeNull()
    expect(otherAsksRefusal(others, { separate_reason: 'That one is the prod approval; this is the test account' })).toBeNull()
    // Another task's threads and his own are not this task's.
    expect(ownNeedsThreads(file, 'other-task')).toEqual([])
    // A letter's thread counts whatever outside item the new one points at.
    expect(ownNeedsThreads(file, 'triage-1', 'th-new000001', undefined, 'Mail: orchard invoice').map((o) => o.id)).toEqual([id])
  })

  it('threads that each point at their own outside item (one per mail) are separate matters; one without a ref still counts', () => {
    const lead = 'task:lead-7' as const
    const a = openThread(emptyThreads('lead-7'), { title: 'Reply to the orchard invoice mail?', text: 'Please decide', from: 'mail', ref: 'Mail: orchard invoice', ...KIND }, lead, at(3, 0))
    expect(ownNeedsThreads(a.file, 'lead-7', undefined, undefined, 'Mail: barn repair quote')).toEqual([])
    expect(ownNeedsThreads(a.file, 'lead-7', undefined, undefined, 'Mail: orchard invoice').map((o) => o.id)).toEqual([a.thread.id])
    expect(ownNeedsThreads(a.file, 'lead-7').map((o) => o.id)).toEqual([a.thread.id])
  })
})

describe('class guard: every way a thread is put before him runs both checks', () => {
  const SRC = path.resolve(__dirname, '../../../src')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
  const all = files(SRC).map((f) => ({ f: path.relative(SRC, f).split(path.sep).join('/'), s: fs.readFileSync(f, 'utf8') }))

  it('only the store (and his own Acknowledge) calls the model\'s open or update; the store runs the one-matter check on both', () => {
    const direct = all.filter(({ f, s }) => f !== 'core/org/threads-model.ts' && /\b(?:openThread|updateThread)\(/.test(s)).map((a) => a.f).sort()
    expect(direct).toEqual(['core/org/thread-ack.ts', 'core/org/threads-store.ts'])
    const store = all.find((a) => a.f === 'core/org/threads-store.ts')!.s
    const body = (name: string) => store.slice(store.indexOf(`export async function ${name}(`), store.indexOf('\nexport ', store.indexOf(`export async function ${name}(`) + 10))
    expect(body('openNodeThread')).toMatch(/refuseOtherOpenAsks\(/)
    expect(body('openNodeThread')).toMatch(/applySupersedes\(/)
    expect(body('patchThread')).toMatch(/refuseOtherOpenAsks\(/)
    expect(body('patchThread')).toMatch(/applySupersedes\(/)
    const model = all.find((a) => a.f === 'core/org/threads-model.ts')!.s
    const update = model.slice(model.indexOf('export function updateThread('), model.indexOf('\nexport ', model.indexOf('export function updateThread(') + 10))
    expect(update).toMatch(/returnRefusal\(cur, patch, by, handing\)/)
  })

  it('the thread ops take the new fields', async () => {
    const { getOp } = await import('../../../src/ops/index.js')
    expect(Object.keys(getOp('thread_update')!.input)).toEqual(expect.arrayContaining(['since_you_wrote', 'decision', 'supersedes', 'separate_reason']))
    expect(Object.keys(getOp('thread_create')!.input)).toEqual(expect.arrayContaining(['supersedes', 'separate_reason']))
  })
})

describe('review of 2026-11-21: ordinary writes still go', () => {
  it('answering him or stepping aside on a letter\'s card never asks same or new', () => {
    const { file, id } = letterThread()
    expect(updateThread(file, id, { state: 'answered', reply: 'Done it myself: the switch is back on.' }, TASK, at(4, 0)).thread.state).toBe('answered')
    expect(updateThread(file, id, { state: 'pending', reply: 'Asked now in another thread.' }, TASK, at(4, 0)).thread.state).toBe('pending')
  })

  it('a button he clicked is his answer, not words to start the next card from', () => {
    const { file, id } = letterThread()
    const clicked = fileMessage(file, { text: 'Approve, run this one', via: 'follow-up', threadId: id, at: at(5, 0) }).file
    const t = updateThread(clicked, id, { state: 'needs', reply: 'Approve running it on the second region too? I recommend it.', decision: 'same', ...KIND }, TASK, at(5, 5)).thread
    expect(t.state).toBe('needs')
    expect(t.reply).not.toMatch(/You wrote/)
  })

  it('a lead\'s own threads on other matters are not this one\'s: only what the task opened or its letters count', () => {
    const lead = 'task:lead-9'
    let f = openThread(emptyThreads('lead-9'), { title: 'Keep notes in the vault?', text: 'Keep notes in the vault? I recommend it.', reply: 'Keep notes in the vault? I recommend it.', from: 'node', ...KIND, options: [{ label: 'Use the vault' }, { label: 'Use the repo' }] }, lead, at(1, 0)).file
    const his = fileMessage(f, { text: 'Pick my reading for the week', via: 'chat', at: at(1, 1) })
    f = updateThread(his.file, his.thread.id, { state: 'needs', reply: 'Read the three design chapters this week? I recommend it.', ...KIND }, lead, at(1, 2)).file
    // His own ask, summarised by the lead, is not counted as the lead's other ask.
    expect(ownNeedsThreads(f, 'lead-9', 'th-new000001').map((o) => o.title)).toEqual(['Keep notes in the vault?'])
  })
})
