/**
 * A thread waiting on him to pick among choices carries them as options he clicks
 * (src/core/org/thread-options.ts, src/core/ask-options.ts; 2026-11-20, the user, on a VP thread
 * whose summary listed A (recommended) and B under only Acknowledge: "if you recommend this, why
 * can I not just click it?").
 *
 * The one reader of a choice's options (the report's ask_options too), the thread's own rules
 * (2 to 5, only in needs, gone when it leaves needs), and the guard: an agent's needs write whose
 * words list lettered or numbered choices with no options is refused 409 needs_options.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AskOptionsError, readAskOptions, recommendedFirst } from '../../../src/core/ask-options.js'
import { listsChoices, threadOptionsOf } from '../../../src/core/org/thread-options.js'
import { THREADS_OPTIONS_RULE } from '../../../src/core/org/thread-rules.js'
import { THREADS_LINE, TASK_THREADS_LINE } from '../../../src/core/sessions/session-context.js'
import { getOp } from '../../../src/ops/index.js'
import { setOneCard } from '../../../src/core/org/one-card.js'
import { emptyThreads, fileMessage, normalizeThreads, openThread, ThreadError, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 6, min)).toISOString()
const KIND = { user_kind: 'user_own', user_kind_why: 'It is his own notes and how he keeps them' }
const AB = [{ label: 'Keep notes in the vault', detail: 'One place, searchable', recommended: true }, { label: 'Keep notes beside the code' }]

function base(): { file: ThreadsFile; id: string } {
  const f = fileMessage(emptyThreads('lead-1'), { text: 'Where should the notes and artifacts live?', via: 'chat', at: at(0) })
  return { file: f.file, id: f.thread.id }
}
const refused = (fn: () => unknown): ThreadError => {
  try { fn() } catch (err) { if (err instanceof ThreadError) return err; throw err }
  throw new Error('not refused')
}

describe('the one reader of a choice\'s options', () => {
  it('reads labels and objects, with ids, a line of detail and the recommended one', () => {
    expect(readAskOptions(['Yes, ship it', { id: 'later', label: '  Not  yet ', detail: 'After the review', recommended: true }], 'options')).toEqual([
      { id: 'o1', label: 'Yes, ship it' },
      { id: 'later', label: 'Not yet', detail: 'After the review', recommended: true },
    ])
    expect(readAskOptions(undefined, 'options')).toEqual([])
  })

  it('refuses what it cannot show as a button', () => {
    for (const bad of ['A', [{ label: '' }], [{ label: 'x'.repeat(81) }], [{ id: 'a', label: 'One' }, { id: 'a', label: 'Two' }]]) {
      expect(() => readAskOptions(bad, 'options'), JSON.stringify(bad)).toThrow(AskOptionsError)
    }
  })

  it('a line of detail is cut to 200, and one that is no string is dropped (a report took none before)', () => {
    expect(readAskOptions([{ label: 'One', detail: 'y'.repeat(201) }], 'options')[0].detail).toHaveLength(200)
    expect(readAskOptions([{ label: 'One', detail: 3 }], 'options')).toEqual([{ id: 'o1', label: 'One' }])
  })

  it('a thread takes 2 to 5, or none', () => {
    expect(threadOptionsOf([])).toEqual([])
    expect(() => threadOptionsOf(['Only one'])).toThrow(/2 to 5/)
    expect(() => threadOptionsOf(['1', '2', '3', '4', '5', '6'])).toThrow(/2 to 5/)
    expect(threadOptionsOf(AB)).toHaveLength(2)
  })

  it('the recommended one first, each group in the writer\'s order', () => {
    expect(recommendedFirst([{ id: 'a' }, { id: 'b', recommended: true }, { id: 'c' }]).map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('which words list choices', () => {
  // The full-width colon (U+FF1A) as test data, escaped.
  it('lettered and numbered choices, the full-width colon too', () => {
    for (const text of [
      'Pick one.\nA: keep the notes in the vault\nB: keep them beside the code',
      'Pick one. Option A (recommended): the vault. Option B: beside the code.',
      'Which one? **A**: the vault; **B**: the repo',
      'Choose:\nA\uff1a the vault\nB\uff1a the repo',
      'Options:\n1. Keep the vault\n2. Move to the repo',
      'I recommend the first.\n- 1) the vault\n- 2) the repo',
      'Which would you like?\n1\uff1a the vault\n2\uff1a the repo',
    ]) expect(listsChoices(text), text).toBe(true)
  })

  it('not a label, one letter alone, numbers inside a line, or plain words', () => {
    for (const text of [
      'Note: the build is green.',
      'A: only one choice is named here',
      'The build 1.2 replaced 2.0 yesterday.',
      'Step 1. then step 2. on one line',
      'Pick the vault or the repo?',
      '',
      // Status lists and named things, no choice in them (the review's cases).
      'Done so far:\n1. Built the page\n2. Tested it\nApprove the deploy?',
      '- 1) clone\n- 2) build',
      'Two issues. A: build red. B: tests flake.',
      'Plan A: done. Plan B: done.',
      'Server A (us-east): up; server B (eu): down',
    ]) expect(listsChoices(text), text).toBe(false)
  })
})

describe('a thread\'s options', () => {
  // The 409 guard is the one-card experiment's (threads_one_card): on here, off in its own case below.
  beforeEach(() => setOneCard(true))
  afterEach(() => setOneCard(false))

  it('with the one-card setting off, a needs write listing choices without options goes as before', () => {
    setOneCard(false)
    const { file, id } = base()
    const reply = 'Notes and artifacts: pick A or B.\nA (recommended): the vault.\nB: beside the code.'
    expect(updateThread(file, id, { state: 'needs', reply, ...KIND }, 'task:lead-1', at(1)).thread.state).toBe('needs')
    const input = { title: 'Notes and artifacts', text: 'Pick one.\nA: the vault\nB: the repo', from: 'node' as const, ...KIND }
    expect(openThread(emptyThreads('lead-1'), input, 'task:lead-1', at(0)).thread.state).toBe('needs')
    // Options a node passes are still stored (additive), whatever the setting.
    expect(updateThread(file, id, { state: 'needs', reply, options: AB, ...KIND }, 'task:lead-1', at(1)).thread.options).toHaveLength(2)
  })

  it('an agent\'s needs write listing choices with no options is refused 409; with options it goes', () => {
    const { file, id } = base()
    const reply = 'Notes and artifacts: pick A or B.\nA (recommended): the vault.\nB: beside the code.'
    const e = refused(() => updateThread(file, id, { state: 'needs', reply, ...KIND }, 'task:lead-1', at(1)))
    expect(e.code).toBe('needs_options')
    expect(e.status).toBe(409)
    expect(e.message).toContain('pass them as options')
    const ok = updateThread(file, id, { state: 'needs', reply, options: AB, ...KIND }, 'task:lead-1', at(1)).thread
    expect(ok.options?.map((o) => o.label)).toEqual(['Keep notes in the vault', 'Keep notes beside the code'])
    // His own writes are never asked.
    expect(updateThread(file, id, { state: 'needs', reply }, 'human', at(1)).thread.state).toBe('needs')
    // A later summary listing choices while it stays in needs is checked too.
    const plain = updateThread(file, id, { state: 'needs', reply: 'Where should they live?', ...KIND }, 'task:lead-1', at(1)).file
    expect(refused(() => updateThread(plain, id, { reply }, 'task:lead-1', at(2))).code).toBe('needs_options')
    // His own request listing choices is his words: a summary that lists none goes.
    const asked = fileMessage(emptyThreads('lead-1'), { text: 'Pick one: A: the vault, B: the repo', via: 'chat', at: at(0) })
    expect(updateThread(asked.file, asked.thread.id, { ask: 'Pick one: A: the vault, B: the repo', state: 'needs', reply: 'Which place do you want for the notes?', ...KIND }, 'task:lead-1', at(1)).thread.state).toBe('needs')
  })

  it('a thread the node opens in needs is held to the same rule', () => {
    const input = { title: 'Notes and artifacts', text: 'Pick one.\nA: the vault\nB: the repo', from: 'node' as const, ...KIND }
    expect(refused(() => openThread(emptyThreads('lead-1'), input, 'task:lead-1', at(0))).code).toBe('needs_options')
    const t = openThread(emptyThreads('lead-1'), { ...input, options: AB }, 'task:lead-1', at(0)).thread
    expect(t.options).toHaveLength(2)
    expect(refused(() => openThread(emptyThreads('lead-1'), { ...input, state: 'answered', options: AB }, 'task:lead-1', at(0))).status).toBe(400)
  })

  it('options go only with needs, and leave with it: a state move, his message, a close', () => {
    const { file, id } = base()
    expect(refused(() => updateThread(file, id, { state: 'answered', options: AB }, 'task:lead-1', at(1))).status).toBe(400)
    const needs = updateThread(file, id, { state: 'needs', reply: 'Where?', options: AB, ...KIND }, 'task:lead-1', at(1)).file
    expect(updateThread(needs, id, { state: 'working' }, 'task:lead-1', at(2)).thread.options).toBeUndefined()
    expect(updateThread(needs, id, { options: [] }, 'task:lead-1', at(2)).thread.options).toBeUndefined()
    // His answer (the clicked label, filed as his words) ends its needs and its options.
    const answered = fileMessage(needs, { text: 'Keep notes in the vault', via: 'follow-up', threadId: id, at: at(3) })
    expect(answered.thread).toMatchObject({ state: 'working' })
    expect(answered.thread.options).toBeUndefined()
    expect(updateThread(needs, id, { close: 'acked' }, 'human', at(3)).thread.options).toBeUndefined()
  })

  it('stored options read back leniently: a broken list, or one on a thread not in needs, is dropped', () => {
    const { file, id } = base()
    const needs = updateThread(file, id, { state: 'needs', reply: 'Where?', options: AB, ...KIND }, 'task:lead-1', at(1)).file
    const raw = JSON.parse(JSON.stringify(needs)) as ThreadsFile
    expect(normalizeThreads(raw, 'lead-1').threads[0].options).toHaveLength(2)
    raw.threads[0].options = [{ id: 'x', label: '' }] as never
    expect(normalizeThreads(raw, 'lead-1').threads[0].options).toBeUndefined()
    const off = JSON.parse(JSON.stringify(needs)) as ThreadsFile
    off.threads[0].state = 'answered'
    expect(normalizeThreads(off, 'lead-1').threads[0].options).toBeUndefined()
  })
})

describe('every place a node reads the rule carries it', () => {
  it('the thread ops (whole) and their options field; the always-loaded prompt stays within its budget without it', () => {
    expect(THREADS_LINE).not.toContain(THREADS_OPTIONS_RULE)
    expect(TASK_THREADS_LINE).not.toContain(THREADS_OPTIONS_RULE)
    for (const name of ['thread_update', 'thread_create']) {
      const op = getOp(name)!
      expect(op.description, name).toContain(THREADS_OPTIONS_RULE)
      expect(op.input.options?.description, name).toContain('needs_options')
    }
  })
})
