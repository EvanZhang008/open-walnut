/**
 * Routine progress goes to a thread, never a letter (2026-11-20, the user: "we prefer the thread
 * instead of inbox"). Every letter type the inbox defines is decided in LETTER_TYPE_ROUTES
 * (core/human-inbox/letter-to-thread.ts): it goes to a thread for a task that keeps Threads, or it
 * stays a letter, with why. A new type fails here until it is listed. Also the pure rules: which
 * letters stay letters whoever sends them, and which open thread an update belongs to.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LETTER_TYPE_ROUTES, filesUpdatesAsThreads, letterOnlyReason, threadForUpdate, updateSummary,
} from '../../../src/core/human-inbox/letter-to-thread.js'
import { createLetterCheck } from '../../../src/core/human-inbox/letter-check.js'
import { letterThreadSkip } from '../../../src/core/human-inbox/letter-threads.js'
import { SIMILAR_SUBJECT_MIN, textSimilarity } from '../../../src/core/human-inbox/duplicate-letter.js'
import { keepsThreads } from '../../../src/core/org/keeps-threads.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8')
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()

describe('every letter type is routed', () => {
  it('the type union, the op and the store all list exactly the routed types', () => {
    const union = /export type LetterType\s*=([^;]+);/.exec(read('src/core/human-inbox/types.ts'))?.[1] ?? ''
    const op = /const LETTER_TYPE = z\.enum\(\[([^\]]+)\]\)/.exec(read('src/ops/human-inbox.ts'))?.[1] ?? ''
    const routed = Object.keys(LETTER_TYPE_ROUTES).sort()
    expect(quoted(union), 'a new LetterType: decide it in LETTER_TYPE_ROUTES (thread or letter, with why)').toEqual(routed)
    expect(quoted(op)).toEqual(routed)
    expect([...createLetterCheck().TYPES].sort()).toEqual(routed)
  })

  it('each type says why, and only the ones that inform go to a thread', () => {
    for (const [type, r] of Object.entries(LETTER_TYPE_ROUTES)) expect(r.why.length, type).toBeGreaterThan(20)
    const toThread = Object.entries(LETTER_TYPE_ROUTES).filter(([, r]) => r.to === 'thread').map(([t]) => t).sort()
    expect(toThread).toEqual(['completion', 'info'])
  })

  it('under letters_as_threads each type declares its route too, and only a decision waits on a thread', () => {
    for (const [type, r] of Object.entries(LETTER_TYPE_ROUTES)) {
      expect(['thread', 'needs_thread', 'letter'], type).toContain(r.lettersAsThreads.to)
      expect(r.lettersAsThreads.why.length, type).toBeGreaterThan(20)
      // An update stays an update: the experiment changes only what was a letter.
      if (r.to === 'thread') expect(r.lettersAsThreads.to, type).toBe('thread')
    }
    const needs = Object.entries(LETTER_TYPE_ROUTES).filter(([, r]) => r.lettersAsThreads.to === 'needs_thread').map(([t]) => t)
    expect(needs).toEqual(['action_required'])
  })

  it('a letter only its own pick settles never waits on a thread', () => {
    const base = { type: 'action_required' as const, sender: { sessionId: 's-1', taskId: 't-1' }, actions: [{ id: 'a', label: 'Yes' }] }
    expect(letterThreadSkip(base)).toBeNull()
    expect(letterThreadSkip({ ...base, type: 'review' })).toBe('type')
    expect(letterThreadSkip({ ...base, sender: { sessionId: 's-1' } })).toBe('no_task')
    expect(letterThreadSkip({ ...base, sender: { sessionId: 'external', taskId: 't-1', pluginId: 'p' } })).toBe('plugin')
    expect(letterThreadSkip({ ...base, items: [{}] as never })).toBe('items')
    expect(letterThreadSkip({ ...base, credentialAsk: { host: 'h' } as never })).toBe('credential')
    expect(letterThreadSkip({ ...base, actions: [] })).toBe('no_options')
  })
})

describe('what stays a letter whoever sends it', () => {
  const base = { subject: 'Seed trays ordered', markdown: 'Two flats of 72 cells.' }
  it('a decision and a review by type; an info letter the user asked for, pinned, with mail items, a credential or a document', () => {
    expect(letterOnlyReason({ ...base, type: 'action_required' })).toBe('type')
    expect(letterOnlyReason({ ...base, type: 'review' })).toBe('type')
    expect(letterOnlyReason({ ...base, type: 'info', user_asked: true })).toBe('user_asked')
    expect(letterOnlyReason({ ...base, type: 'completion', userAsked: true })).toBe('user_asked')
    expect(letterOnlyReason({ ...base, type: 'info', pin: true })).toBe('pinned')
    expect(letterOnlyReason({ ...base, type: 'info', items: [{}] as never })).toBe('items')
    // An update that asks him to decide ("the drafts wait for your nod") stays the letter it was sent as (2026-11-24).
    expect(letterOnlyReason({ ...base, type: 'info', markdown: '\u8349\u7a3f\u90fd\u597d\u4e86\uff0c\u7b49\u4f60\u70b9\u5934\u518d\u53d1' })).toBe('asks')
    expect(letterOnlyReason({ ...base, type: 'info', markdown: 'Shipped; nothing waits on you.' })).toBeNull()
    expect(letterOnlyReason({ ...base, type: 'info', credential_ask: { host: 'h', kind: 'login' } as never })).toBe('credential')
    expect(letterOnlyReason({ subject: 'Chart', type: 'info', html: '<p>x</p>' })).toBe('document')
    expect(letterOnlyReason({ ...base, type: 'info' })).toBeNull()
    expect(letterOnlyReason({ ...base, type: 'completion' })).toBeNull()
  })

  it('a task that keeps Threads files them, unless a routine made it or it is a triage run', () => {
    const keeps = (t: { org_role?: string; threads_on?: boolean }) => keepsThreads(t, false)
    expect(filesUpdatesAsThreads({ org_role: 'lead' }, false, keeps)).toBe(true)
    expect(filesUpdatesAsThreads({ threads_on: true }, false, keeps)).toBe(true)
    expect(filesUpdatesAsThreads({}, false, keeps)).toBe(false)
    expect(filesUpdatesAsThreads({ threads_on: true, routine_start: { job_id: 'j' } as never }, false, keeps)).toBe(false)
    expect(filesUpdatesAsThreads({ threads_on: true }, true, keeps)).toBe(false)
  })
})

describe('which thread an update belongs to', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString()
  const t = (id: string, title: string, extra: Partial<OrgThread> = {}): OrgThread =>
    ({ id, title, state: 'working', messages: [], createdAt: at(0), updatedAt: at(1), ...extra })
  const pick = (threads: OrgThread[], subject: string, named?: string) =>
    threadForUpdate(threads, subject, named, textSimilarity, SIMILAR_SUBJECT_MIN)?.id ?? null

  it('the thread it names when open, else the open one its subject reads like, else none', () => {
    const threads = [t('th-aaaaaa', 'Order the seed trays'), t('th-bbbbbb', 'Fix the greenhouse vent')]
    expect(pick(threads, 'Something else entirely', 'th-bbbbbb')).toBe('th-bbbbbb')
    expect(pick(threads, 'Order the seed trays: shipped')).toBe('th-aaaaaa')
    // A reworded subject about the same thing reads like it.
    expect(pick(threads, 'Greenhouse vent fixed')).toBe('th-bbbbbb')
    expect(pick(threads, 'Compost delivery booked')).toBeNull()
  })

  it('never a closed or moved thread, and the newest of two that read the same', () => {
    const closed = t('th-cccccc', 'Order the seed trays', { closed: { how: 'acked', by: 'human', at: at(2) } as never })
    const moved = t('th-dddddd', 'Order the seed trays', { movedTo: { task: 'x', title: 'X' } as never })
    expect(pick([closed, moved], 'Order the seed trays', 'th-cccccc')).toBeNull()
    const older = t('th-eeeeee', 'Order the seed trays')
    const newer = t('th-ffffff', 'Order the seed trays', { updatedAt: at(5) })
    expect(pick([older, newer], 'Order the seed trays')).toBe('th-ffffff')
  })

  it('the summary is the subject, then the words', () => {
    expect(updateSummary({ subject: 'Trays shipped', markdown: 'Arrive Friday.' })).toBe('**Trays shipped**\n\nArrive Friday.')
    expect(updateSummary({ subject: 'Trays shipped', text: 'Trays shipped' })).toBe('Trays shipped')
  })
})
