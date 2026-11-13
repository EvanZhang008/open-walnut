/**
 * One answer per asker (2026-11-13, the org reflection: a task holding three requests from its lead
 * answered each with nearly the same words, at 08:59:24, :25 and :27; two others did it twice).
 * task_send takes in_reply_to as a list (session-send-core.ts performReplies), and every place
 * Walnut tells a session how to answer names that list when one asker holds several requests:
 *  - the reply line under a new request (envelope-kit.ts buildReplyTrailer, alsoOpen);
 *  - the Stop hook's reason (unanswered-at-stop.ts);
 *  - the open items read after a compaction (open-items-text.ts).
 * Guard for the class: a source scan finds every builder of an "in_reply_to" instruction in src/
 * and fails on one not listed here, so a new path cannot bring back one reply per request.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { unansweredStopReason } from '../../src/core/sessions/unanswered-at-stop.js'
import { createOpenItemsText } from '../../src/core/sessions/open-items-text.js'
import type { SessionRequest } from '../../src/core/session-requests.js'

const NOW = Date.parse('2026-11-13T08:59:00Z')
const req = (id: string, from: string): SessionRequest => ({
  id, fromSessionId: from, toSessionId: 'target', preview: `ask ${id}`, status: 'pending',
  createdAt: new Date(NOW - 60_000).toISOString(), deadlineAt: NOW + 3_600_000,
} as SessionRequest)

describe('every answer instruction names one call for one asker', () => {
  it('the reply line under a new request lists the asker\'s other open ones', () => {
    const kit = createEnvelopeKit()
    expect(kit.buildReplyTrailer({ id: 'rq-aaaaaa' })).toContain('"in_reply_to":"rq-aaaaaa"')
    const line = kit.buildReplyTrailer({ id: 'rq-cccccc' }, { alsoOpen: ['rq-aaaaaa', 'rq-bbbbbb'] })
    expect(line).toContain('"in_reply_to":["rq-cccccc","rq-aaaaaa","rq-bbbbbb"]')
    expect(line).toContain('one answer settles all')
    // Its hands_on stays the one request just asked.
    expect(line).toContain('"hands_on":"rq-cccccc"')
  })

  it('the Stop hook groups an asker\'s requests into one call; different askers stay one each', () => {
    const lead = 'lead-sid'
    const text = unansweredStopReason([
      { request: req('rq-111111', lead), from: 'Walnut VP' },
      { request: req('rq-222222', 'other-sid'), from: 'Ops VP' },
      { request: req('rq-333333', lead), from: 'Walnut VP' },
    ], NOW)
    expect(text).toContain('2 of them are from Walnut VP (rq-111111, rq-333333): answer them in ONE task_send')
    expect(text).toContain('"in_reply_to":["rq-111111","rq-333333"]')
    const single = unansweredStopReason([{ request: req('rq-111111', lead), from: 'Walnut VP' }, { request: req('rq-222222', 'other-sid'), from: 'Ops VP' }], NOW)
    expect(single).toContain('"in_reply_to":"rq-111111"')
    expect(single).not.toContain('ONE task_send')
  })

  it('the open items after a compaction say the same', () => {
    const { format } = createOpenItemsText()
    const text = format({
      task: { id: 't1', title: 'Fix it' }, subtasks: [], moreSubtasks: 0, waitingOn: [],
      askedOfYou: [
        { id: 'rq-111111', from: 'Walnut VP', preview: 'a', createdAt: new Date(NOW - 60_000).toISOString() },
        { id: 'rq-333333', from: 'Walnut VP', preview: 'b', createdAt: new Date(NOW - 30_000).toISOString() },
      ],
    } as never, NOW)
    expect(text).toContain('2 are from Walnut VP: answer them in ONE task_send, in_reply_to ["rq-111111","rq-333333"]')
  })

  it('every reply line Walnut builds under a new request is given the asker\'s other open requests', () => {
    // A call with the request alone (`buildReplyTrailer(row)`) tells the target to answer each one apart.
    const ROOT = path.resolve(__dirname, '../../src')
    const bare: string[] = []
    let calls = 0
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf8')
          calls += (src.match(/buildReplyTrailer\((?!request: )/g) ?? []).length
          for (const m of src.matchAll(/buildReplyTrailer\(\s*[\w.]+\s*\)/g)) bare.push(`${path.relative(ROOT, p)}: ${m[0]}`)
        }
      }
    }
    walk(ROOT)
    expect(bare).toEqual([])
    expect(calls).toBeGreaterThan(3)
  })

  it('no other builder of an answer instruction exists in src/ (add it here with its grouping)', () => {
    const ROOT = path.resolve(__dirname, '../../src')
    const KNOWN = new Set([
      'core/peers/envelope-kit.ts', // buildReplyTrailer: alsoOpen
      'core/sessions/unanswered-at-stop.ts', // grouped per asker
      'core/sessions/open-items-text.ts', // oneAnswerLines
      // A letter about a task's own request: it names the one request the letter would have answered.
      'core/human-inbox/reply-instead.ts',
      // A list answer that could not settle some: it names exactly those, in one list.
      'ops/work.ts',
      'providers/offline-host-core.ts',
    ])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && /in_reply_to\W{0,4}\$\{/.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(ROOT, p))
      }
    }
    walk(ROOT)
    expect(found.filter((f) => !KNOWN.has(f)), 'a new "in_reply_to" instruction: name the asker\'s other open requests in it').toEqual([])
    // The scan still sees the known ones (a pattern that finds nothing guards nothing).
    expect(found.sort()).toEqual([...KNOWN].sort())
  })
})
