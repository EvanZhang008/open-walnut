/**
 * His message goes to the thread he is on (2026-11-10, the user: "I send but u don't know which
 * thread", "this is crazy"). A Follow up a moment after he acknowledged the thread opens it again
 * instead of a new thread; a chat message right after his last one joins that thread instead of
 * one thread per sentence; the Follow up box on every surface names the thread it goes to.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  emptyThreads, fileMessage, FOLLOW_UP_REOPENS_MS, openThread, SAME_CONVERSATION_MS, updateThread, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'

const T0 = Date.UTC(2026, 10, 10, 18, 0)
const at = (ms: number) => new Date(T0 + ms).toISOString()
const MIN = 60_000

function one(text: string, ms = 0): { f: ThreadsFile; id: string } {
  const r = fileMessage(emptyThreads('vp'), { text, via: 'chat', at: at(ms) })
  return { f: r.file, id: r.thread.id }
}

describe('a Follow up on a thread he just closed', () => {
  it('opens that thread again with his words, a moment after his acknowledge', () => {
    const { f, id } = one('remove the dictation button on the Mac')
    const acked = updateThread(f, id, { close: 'acked' }, 'human', at(10 * MIN)).file
    const r = fileMessage(acked, { text: 'that was fast, why not before?', via: 'follow-up', threadId: id, at: at(10 * MIN + 22_000) })
    expect(r.created).toBe(false)
    expect(r.joined).toBe('reopened')
    expect(r.thread.id).toBe(id)
    expect(r.thread.closed).toBeUndefined()
    expect(r.thread.state).toBe('working')
    expect(r.file.threads).toHaveLength(1)
  })

  it('a thread closed longer ago, or closed by the node, gets a new thread that follows it', () => {
    const { f, id } = one('fix the labels')
    const acked = updateThread(f, id, { close: 'acked' }, 'human', at(MIN)).file
    const late = fileMessage(acked, { text: 'wrong again', via: 'follow-up', threadId: id, at: at(MIN + FOLLOW_UP_REOPENS_MS + 1000) })
    expect(late.created).toBe(true)
    expect(late.thread.follows).toBe(id)
    // The node's close is never undone by Walnut's guess.
    const nodeClosed: ThreadsFile = { ...f, threads: f.threads.map((t) => ({ ...t, closed: { how: 'acked' as const, at: at(3 * MIN), by: 'task:vp' as const } })) }
    const r = fileMessage(nodeClosed, { text: 'one more thing', via: 'follow-up', threadId: id, at: at(4 * MIN) })
    expect(r.created).toBe(true)
    expect(r.thread.follows).toBe(id)
  })
})

describe('a chat message right after his last one', () => {
  it('joins the open thread his last message went to', () => {
    const { f, id } = one('Fable 5.2 everywhere')
    const r = fileMessage(f, { text: 'look', via: 'chat', joinRecent: SAME_CONVERSATION_MS, at: at(40_000) })
    expect(r.created).toBe(false)
    expect(r.joined).toBe('recent')
    expect(r.thread.id).toBe(id)
    expect(r.thread.messages.map((m) => m.text)).toEqual(['Fable 5.2 everywhere', 'look'])
  })

  it('the thread of a Follow up counts as the one he is on', () => {
    const a = one('first subject')
    const b = fileMessage(a.f, { text: 'second subject', via: 'chat', at: at(10 * MIN) })
    const fu = fileMessage(b.file, { text: 'Thanks!', via: 'follow-up', threadId: a.id, at: at(20 * MIN) })
    const r = fileMessage(fu.file, { text: 'OMG', via: 'chat', joinRecent: SAME_CONVERSATION_MS, at: at(20 * MIN + 30_000) })
    expect(r.thread.id).toBe(a.id)
  })

  it('opens a new thread when his last message is older, its thread is closed, or the caller did not ask', () => {
    const { f, id } = one('subject one')
    expect(fileMessage(f, { text: 'later', via: 'chat', joinRecent: SAME_CONVERSATION_MS, at: at(SAME_CONVERSATION_MS + 1000) }).created).toBe(true)
    const closed = updateThread(f, id, { close: 'acked' }, 'human', at(10_000)).file
    expect(fileMessage(closed, { text: 'new ask', via: 'chat', joinRecent: SAME_CONVERSATION_MS, at: at(20_000) }).created).toBe(true)
    expect(fileMessage(f, { text: 'raw store call', via: 'chat', at: at(20_000) }).created).toBe(true)
    // A letter's note keeps its own way.
    expect(fileMessage(f, { text: 'note', via: 'letter', joinRecent: SAME_CONVERSATION_MS, at: at(20_000) }).created).toBe(true)
  })

  it('a thread the node opened after his last message ends that conversation', () => {
    const { f } = one('subject one')
    const opened = openThread(f, { title: 'Learning budget', text: 'Decide: let it lapse?', from: 'node', user_kind: 'user_own', user_kind_why: 'His own benefit and his own call' }, 'task:vp', at(30_000)).file
    expect(fileMessage(opened, { text: 'close this thread', via: 'chat', joinRecent: SAME_CONVERSATION_MS, at: at(60_000) }).created).toBe(true)
  })

  it('the node is told where it went and how to split it out', () => {
    const base: ThreadHintState = { threadId: 'th-aaaaaa', title: 'Dictation button', created: false, followUp: false, duplicate: false, open: [], closed: [] }
    expect(threadHintText({ ...base, joined: 'recent' })).toMatch(/filed under thread th-aaaaaa "Dictation button": it came right after his last message there.*thread_split/)
    expect(threadHintText({ ...base, followUp: true, joined: 'reopened' })).toMatch(/follow-up in thread th-aaaaaa "Dictation button", which he had closed a moment ago.*open again/)
  })
})

describe('every Follow up box names its thread', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  /** Each surface's Follow up composer and the line that shows the thread's title in it. */
  const SURFACES: Record<string, RegExp> = {
    // Web and the Mac app (one SPA).
    'web/src/components/org/OrgThreads.tsx': /data-testid="org-thread-follow-to">Follow up on \{'\\u201c'\}\{title\}/,
    // The phone: the sheet's header line.
    'ios-native/Walnut/Views/Org/OrgThreadsView.swift': /struct OrgThreadFollowUpSheet: View \{\s*let title: String[\s\S]*?Text\(title\)/,
  }
  it.each(Object.entries(SURFACES))('%s', (file, re) => { expect(read(file)).toMatch(re) })

  it('the web box is given the card\'s own thread', () => {
    expect(read('web/src/components/org/OrgThreads.tsx')).toMatch(/<FollowUp title=\{t\.title\} onSend=\{\(text, images\) => onFollowUp\(t\.id, text, images\)\}/)
  })

  it('no other Follow up composer exists unlisted', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (/\.(tsx|swift)$/.test(e.name) && /Follow up on this request|Write your follow up/.test(read(p))) hits.push(p)
      }
    }
    walk('web/src'); walk('ios-native/Walnut')
    expect(hits.sort()).toEqual(Object.keys(SURFACES).sort())
  })
})
