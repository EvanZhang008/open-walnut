/**
 * The thread a chat row belongs to, read off the `threads` hint his message carried
 * (src/core/org/reply-thread.ts), and the answer that goes with it.
 *
 * The round trip covers every way thread-capture.ts threadHintText can word the hint, so a new
 * wording that the reader does not follow fails here (the branches are listed from the writer).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { answerThreads, answerTasks, threadOfHints, threadOfHintText } from '../../../src/core/org/reply-thread.js'

const base: ThreadHintState = { threadId: 'th-0a1b2c3d4e5f', title: 'Notes and "artifacts" in one place', created: false, followUp: false, duplicate: false, open: [], closed: [] }

const CASES: Array<{ name: string; state: ThreadHintState; title: boolean; node?: string }> = [
  { name: 'filed under', state: base, title: true },
  { name: 'new thread (no title in the words)', state: { ...base, created: true, open: [{ id: 'th-999999999999', title: 'Other', state: 'new' }] }, title: false },
  { name: 'new thread asking about a closed one', state: { ...base, created: true, follows: { id: 'th-888888888888', title: 'Old' } }, title: false },
  { name: 'already filed', state: { ...base, duplicate: true }, title: true },
  { name: 'follow-up', state: { ...base, followUp: true }, title: true },
  { name: 'follow-up that reopened', state: { ...base, followUp: true, joined: 'reopened' }, title: true },
  { name: 'joined the recent conversation', state: { ...base, joined: 'recent' }, title: true },
  { name: 'moved with its work', state: { ...base, followUp: true, movedTo: { task: 'mvm0n3bu-6910', title: 'Research (the bot)' } }, title: true, node: 'mvm0n3bu-6910' },
  { name: 'a reply on a task below', state: { ...base, followUp: true, movedTo: { task: 'mvm0n3bu-6911', title: 'Parser' }, popped: true }, title: true, node: 'mvm0n3bu-6911' },
  { name: 'with closes told', state: { ...base, closed: [{ id: 'th-777777777777', title: 'Done', how: 'acked', by: 'human' }] }, title: true },
]

describe('the thread a threads hint names', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const got = threadOfHintText(threadHintText(c.state))
      expect(got).toEqual({ id: base.threadId, ...(c.title ? { title: base.title } : {}), ...(c.node ? { node: c.node } : {}) })
    })
  }

  it('a title in another script reads back as it was', () => {
    // Test data: a Chinese title, written as escapes.
    const title = '\u65b0\u4efb\u52a1\u6309 project \u5f00'
    expect(threadOfHintText(threadHintText({ ...base, title }))?.title).toBe(title)
  })

  it('a cleanup joined to the line does not change it', () => {
    expect(threadOfHintText(`${threadHintText(base)} Also threads to tidy: th-1 (needs a title).`)?.id).toBe(base.threadId)
  })

  it('only the threads hint counts; no hint, no thread', () => {
    expect(threadOfHints([{ kind: 'user-away', text: 'he is back' }])).toBeNull()
    expect(threadOfHints(undefined)).toBeNull()
    expect(threadOfHints([{ kind: 'threads', text: threadHintText(base) }])?.id).toBe(base.threadId)
  })

  it('every way the writer begins is one the reader knows (a new wording fails here)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/core/org/thread-capture.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function threadHintText'), src.indexOf('/** A thread the node should look at again'))
    const heads = new Set([...body.matchAll(/`([a-z][a-z -]*? thread) \$\{s\.threadId\}/g)].map((m) => m[1]!))
    expect(heads.size).toBeGreaterThanOrEqual(5)
    for (const head of heads) expect(threadOfHintText(`${head} th-abc123 "T".`)?.id, head).toBe('th-abc123')
  })
})

describe('the answer goes with the message it answers', () => {
  const rows = [
    { role: 'user', text: 'first ask', t: 'A' },
    { role: 'assistant', text: 'Looking.' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'Here is the answer.' },
    { role: 'user', text: '<walnut-message from-task="x">a peer note</walnut-message>' },
    { role: 'assistant', text: 'Noted.' },
    { role: 'user', text: 'second', t: 'B' },
    { role: 'user', text: 'third', t: 'C' },
    { role: 'user', text: 'skill text', injected: true },
    { role: 'assistant', text: 'One answer to both.' },
    { role: 'assistant', text: 'Claude Code: Prompt is too long', cliError: true },
  ] as Array<{ role: string; text: string; t?: string; injected?: boolean; cliError?: true }>

  it('the last words of the stretch after his message, never a peer note\'s answer; two messages before one answer: the later one', () => {
    const got = answerThreads(rows, (r) => r.t)
    expect([...got.entries()]).toEqual([[3, 'A'], [9, 'C']])
  })

  it('the task part leaves out the chat\'s own task', () => {
    expect(answerTasks(['own-1', 'task-2'], 'own-1')).toEqual(['task-2'])
    expect(answerTasks(undefined, 'own-1')).toEqual([])
  })
})
