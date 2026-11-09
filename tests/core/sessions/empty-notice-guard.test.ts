/**
 * Empty status notices (2026-11-09, the org reflection): 8 of the 10 VP status notices Main read
 * overnight said "Its last message could not be read in time (or it wrote none)", most over a VP
 * turn that was only the agent-ack line. Pinned here, for every notice path:
 *  - a `stopped` edge whose turn was only an agent-ack sends nothing, to a leader or to the VP or
 *    Main that follows the task;
 *  - a transcript read that runs out of time is tried once more;
 *  - a notice with no quote says which it is: the read timed out, the read failed, the turn was an
 *    agent-ack, or the turn wrote no message. Never the old "or it wrote none".
 *  - the ratchet at the bottom: every call that builds or queues a subtask or org notice in src/
 *    hands on why the words are missing (`wordsUnread`), so a new path cannot fall back to silence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-empty-notice-guard'))

const buildSessionTranscript = vi.fn()
const readSessionTranscript = vi.fn()
vi.mock('../../../src/core/session-projection.js', () => ({
  buildSessionTranscript: (...a: unknown[]) => buildSessionTranscript(...a),
  readSessionTranscript: (...a: unknown[]) => readSessionTranscript(...a),
}))

import { ackOnlyStop, buildSubtaskNoticeText, type SubtaskNotice } from '../../../src/core/sessions/subtask-notices.js'
import { noteOrgEdge, orgNoticeText } from '../../../src/core/sessions/org-follow.js'
import {
  LAST_MESSAGE_READ_MS, lastTurnOf, noticeWordsOf, readLastTurn,
} from '../../../src/core/sessions/session-request-notify.js'
import type { SubtaskNoticeKind } from '../../../src/core/peers/envelope-kit.js'
import type { Task } from '../../../src/core/types.js'

const REPO = path.resolve(__dirname, '../../..')
const ACK = '<walnut-turn status="agent-ack"/>'
const KINDS: SubtaskNoticeKind[] = ['stopped', 'completed', 'error', 'blocked', 'waiting']

function notice(over: Partial<SubtaskNotice>): SubtaskNotice {
  return { parentTaskId: 'lead-1', child: { id: 'child-a', title: 'Build the page', sessionId: 'sid-a' }, kind: 'stopped', ...over }
}

describe('a turn that was only an agent-ack', () => {
  it('reads as an ack, from the final text and from the transcript', () => {
    expect(noticeWordsOf(ACK)).toEqual({ text: '', ack: true })
    expect(noticeWordsOf(`<walnut-about tasks="t1"/>\n${ACK}`)).toEqual({ text: '', ack: true })
    expect(noticeWordsOf('<walnut-turn status="no-action"/>')).toEqual({ text: '', ack: true })
    expect(noticeWordsOf(`Done: landed.\n${ACK}`)).toEqual({ text: 'Done: landed.' })
    expect(noticeWordsOf('')).toBeUndefined()
    const turn = lastTurnOf([
      { role: 'assistant', text: 'Earlier words.' },
      { role: 'user', text: '<walnut-message kind="notification">x</walnut-message>' },
      { role: 'assistant', text: ACK },
    ])
    expect(turn?.words).toEqual({ text: '', ack: true })
  })

  it('is no stop worth a notice; anything said or done is', () => {
    expect(ackOnlyStop('stopped', { text: '', ack: true })).toBe(true)
    expect(ackOnlyStop('stopped', { text: '', ack: true, actions: ['Bash: ls'] })).toBe(false)
    expect(ackOnlyStop('stopped', { text: 'news' })).toBe(false)
    expect(ackOnlyStop('stopped', undefined)).toBe(false)
    for (const k of KINDS.filter((k) => k !== 'stopped')) expect(ackOnlyStop(k, { text: '', ack: true })).toBe(false)
  })

  it('sends no notice to the VP or Main that follows the task', async () => {
    const vp = { id: 'vp-1', title: 'Walnut VP', org_role: 'lead', phase: 'IN_PROGRESS' } as Task
    // Returns before it looks anything up: no task list, no session read.
    expect(await noteOrgEdge(vp, { kind: 'stopped', sessionId: 'sid-vp', lastWords: { text: '', ack: true } })).toBe(false)
  })
})

describe('every notice says why it carries no quote', () => {
  const states: Array<[string, Partial<SubtaskNotice>, RegExp]> = [
    ['read timed out', { lastWords: undefined, wordsUnread: 'timed_out' }, /could not be read: the transcript read timed out twice\. Read it with task_history\./],
    ['read failed', { lastWords: undefined, wordsUnread: 'failed' }, /could not be read: the transcript read failed\. Read it with task_history\./],
    ['wrote nothing', { lastWords: undefined }, /Its last turn wrote no message\./],
    ['agent-ack', { lastWords: { text: '', ack: true } }, /Its last turn ended with only the agent-ack line \(no news\)\./],
    ['quoted', { lastWords: { text: 'The page renders.' } }, /Its last message is quoted below\./],
  ]
  for (const kind of KINDS) {
    for (const [label, over, expected] of states) {
      it(`${kind}, ${label}`, () => {
        for (const text of [buildSubtaskNoticeText(notice({ kind, ...over })), orgNoticeText(buildSubtaskNoticeText(notice({ kind, ...over })))]) {
          expect(text).not.toMatch(/or it wrote none|could not be read in time/)
          expect(text).toMatch(expected)
        }
      })
    }
  }

  it('a recent reply carried the content: no apology', () => {
    const text = buildSubtaskNoticeText(notice({ lastWords: undefined, wordsUnread: 'timed_out', repliedRecently: true }))
    expect(text).not.toMatch(/could not be read|wrote no message/)
  })
})

describe('readLastTurn tries a timed-out read once more', () => {
  const live = { messages: [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'Landed it.' }] }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    buildSessionTranscript.mockReset()
    readSessionTranscript.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('the second read answers', async () => {
    buildSessionTranscript.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(live)
    const p = readLastTurn('sid-a')
    await vi.advanceTimersByTimeAsync(LAST_MESSAGE_READ_MS + 5)
    expect((await p)?.words).toEqual({ text: 'Landed it.' })
    expect(buildSessionTranscript).toHaveBeenCalledTimes(2)
  })

  it('the first read fails after its window: the second still answers', async () => {
    let rejectFirst!: (e: Error) => void
    let resolveSecond!: (v: unknown) => void
    buildSessionTranscript
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej }))
      .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res }))
    const p = readLastTurn('sid-a')
    await vi.advanceTimersByTimeAsync(LAST_MESSAGE_READ_MS + 5)
    rejectFirst(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(5)
    resolveSecond(live)
    expect(await p).toMatchObject({ words: { text: 'Landed it.' } })
  })

  it('both time out and the cache has nothing: timed_out', async () => {
    buildSessionTranscript.mockImplementation(() => new Promise(() => {}))
    readSessionTranscript.mockResolvedValue(undefined)
    const p = readLastTurn('sid-a')
    await vi.advanceTimersByTimeAsync(2 * LAST_MESSAGE_READ_MS + 10)
    expect(await p).toMatchObject({ words: undefined, unread: 'timed_out' })
    expect(buildSessionTranscript).toHaveBeenCalledTimes(2)
  })

  it('both time out and the cache has words: the words', async () => {
    buildSessionTranscript.mockImplementation(() => new Promise(() => {}))
    readSessionTranscript.mockResolvedValue(live)
    const p = readLastTurn('sid-a')
    await vi.advanceTimersByTimeAsync(2 * LAST_MESSAGE_READ_MS + 10)
    expect((await p)?.words).toEqual({ text: 'Landed it.' })
    expect((await p)?.unread).toBeUndefined()
  })

  it('both time out and the cache holds an older agent-ack: timed_out, so the stop still speaks', async () => {
    buildSessionTranscript.mockImplementation(() => new Promise(() => {}))
    readSessionTranscript.mockResolvedValue({ messages: [{ role: 'user', text: 'note' }, { role: 'assistant', text: ACK }] })
    const p = readLastTurn('sid-a')
    await vi.advanceTimersByTimeAsync(2 * LAST_MESSAGE_READ_MS + 10)
    const r = await p
    expect(r).toMatchObject({ words: undefined, unread: 'timed_out' })
    expect(ackOnlyStop('stopped', r?.words)).toBe(false)
  })

  it('the read throws and the cache holds an older agent-ack: failed', async () => {
    buildSessionTranscript.mockRejectedValue(new Error('host gone'))
    readSessionTranscript.mockResolvedValue({ messages: [{ role: 'user', text: 'note' }, { role: 'assistant', text: ACK }] })
    expect(await readLastTurn('sid-a')).toMatchObject({ words: undefined, unread: 'failed' })
  })

  it('the read throws and the cache cannot be read: failed', async () => {
    buildSessionTranscript.mockRejectedValue(new Error('host gone'))
    readSessionTranscript.mockRejectedValue(new Error('no cache'))
    expect(await readLastTurn('sid-a')).toMatchObject({ words: undefined, unread: 'failed' })
  })

  it('the read answers with no words: the turn wrote none, nothing unread', async () => {
    buildSessionTranscript.mockResolvedValue({ messages: [{ role: 'user', text: 'go' }] })
    readSessionTranscript.mockResolvedValue(undefined)
    const r = await readLastTurn('sid-a')
    expect(r?.words).toBeUndefined()
    expect(r?.unread).toBeUndefined()
    expect(buildSessionTranscript).toHaveBeenCalledTimes(1)
  })
})

/**
 * Every call in src/ that builds or queues a subtask or org notice. Each must hand on `wordsUnread`
 * (or be the one place that forwards it), so no path sends a notice with no quote and no reason.
 */
const NOTICE_CALLS = /\b(queueSubtaskNotice|noteOrgEdge|buildSubtaskNoticeText|buildSubtaskNotification)\(/g
const FORWARDERS: Record<string, string> = {
  'src/core/sessions/subtask-notices.ts:buildSubtaskNotification': 'buildSubtaskNoticeText forwards n.wordsUnread',
  'src/core/sessions/org-follow.ts:buildSubtaskNoticeText': 'noteOrgEdge forwards edge.wordsUnread',
}

describe('ratchet: every notice call hands on why its words are missing', () => {
  it('finds each call and its wordsUnread', () => {
    const found: string[] = []
    const missing: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.ts')) continue
        const src = fs.readFileSync(full, 'utf-8')
        const rel = path.relative(REPO, full)
        for (const m of src.matchAll(NOTICE_CALLS)) {
          const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!))
          // Definitions, interface members and comments are not calls.
          if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*\w+\(input: SubtaskNoticeInput\): string;|^\s*\*|^\s*\/\//.test(line)) continue
          const key = `${rel}:${m[1]}`
          found.push(key)
          // The argument list, to its closing paren.
          let depth = 0
          let end = m.index! + m[0].length - 1
          for (; end < src.length; end++) {
            if (src[end] === '(') depth++
            else if (src[end] === ')' && --depth === 0) break
          }
          const args = src.slice(m.index!, end)
          if (!/\bwordsUnread\b/.test(args)) missing.push(`${key}: ${line.trim()}`)
        }
      }
    }
    walk(path.join(REPO, 'src'))
    expect([...new Set(found)].sort()).toEqual([
      'src/core/session-hooks/builtins.ts:noteOrgEdge',
      'src/core/session-hooks/builtins.ts:queueSubtaskNotice',
      'src/core/sessions/org-follow.ts:buildSubtaskNoticeText',
      'src/core/sessions/subtask-notices.ts:buildSubtaskNotification',
    ])
    expect(missing, Object.values(FORWARDERS).join('; ')).toEqual([])
  })
})
