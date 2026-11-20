/**
 * The approval rule for a task answering a letter in the user's place
 * (src/core/human-inbox/answer-approval.ts) and the report-letter rule for a task answering
 * another task's request (src/core/human-inbox/reply-instead.ts). Pure.
 */
import { describe, it, expect } from 'vitest'
import { checkTaskAnswer, isBareYes, namesOption, stepsIn } from '../../src/core/human-inbox/answer-approval.js'
import { ANSWERED_RECENTLY_MS, OPEN_REQUEST_MS, replyInsteadOf } from '../../src/core/human-inbox/reply-instead.js'
import { completionSettleReason, isLeftBehindDecision, letterActivityAt } from '../../src/core/human-inbox/decision-settle.js'
import type { SessionRequest } from '../../src/core/session-requests.js'
import type { LetterRecord } from '../../src/core/human-inbox/types.js'

describe('a task answering for the user', () => {
  it('needs the user\'s own words', () => {
    expect(checkTaskAnswer({ action: { id: 'a', label: 'Plan A' } })).toMatchObject({ ok: false, code: 'user_words' })
    expect(checkTaskAnswer({ text: 'Go', userWords: ' ' })).toMatchObject({ ok: false, code: 'user_words' })
    // Words a task only quotes keep the strict rule: one letter is never enough, a yes picks nothing.
    const release = { id: 'release', label: '\u53d1\u65b0\u7248', recommended: true }
    expect(checkTaskAnswer({ action: release, userWords: 'K' })).toMatchObject({ ok: false, code: 'user_words' })
    expect(checkTaskAnswer({ action: release, userWords: '\u53d1' })).toMatchObject({ ok: false, code: 'user_words' })
  })

  it('his own words read from the card: a yes picks only the recommended option, a name only its option', () => {
    // 2026-11-20: "K" on a card recommending a release. Test data: \u53d1\u65b0\u7248 is "release it", \u53d1 its verb.
    const release = { id: 'release', label: '\u53d1\u65b0\u7248', recommended: true }
    const hold = { id: 'hold', label: 'Not yet' }
    // Verified on that card, the yes picks the option it recommends, a release (outward) included.
    expect(checkTaskAnswer({ action: release, userWords: 'K', verified: true })).toEqual({ ok: true })
    expect(checkTaskAnswer({ action: { id: 'r', label: 'Release it', recommended: true }, userWords: 'ok', verified: true })).toEqual({ ok: true })
    // ...and no other option; with none recommended it picks nothing, and says to ask him.
    const other = checkTaskAnswer({ action: hold, userWords: 'K', verified: true })
    expect(other).toMatchObject({ ok: false, code: 'user_words' })
    expect((other as { message: string }).message).toMatch(/recommended/)
    expect(checkTaskAnswer({ action: { id: 'r', label: 'Release it' }, userWords: 'y', verified: true })).toMatchObject({ ok: false, code: 'user_words' })
    // A name picks its option: the first Chinese character, a whole word, the whole label.
    expect(checkTaskAnswer({ action: release, userWords: '\u53d1', verified: true })).toEqual({ ok: true })
    expect(checkTaskAnswer({ action: { id: 'h', label: 'Hold the build' }, userWords: 'hold', verified: true })).toEqual({ ok: true })
    // Never a piece of a Latin word: "n" (no) is not "Release now".
    expect(checkTaskAnswer({ action: { id: 'r', label: 'Release now' }, userWords: 'n', verified: true })).toMatchObject({ ok: false, code: 'user_words' })
    expect(namesOption('n', 'Release now')).toBe(false)
    expect(namesOption('now', 'Release now')).toBe(true)
    expect(namesOption('\u65b0', '\u53d1\u65b0\u7248')).toBe(false)
    // A one-letter yes never approves a risky step on an option it does not pick.
    expect(checkTaskAnswer({ action: { id: 'del', label: 'Delete the old branch' }, userWords: 'K', verified: true })).toMatchObject({ ok: false })
  })

  it('a release, a deploy or a ship is a step that leaves Walnut, and "ship it" is no bare yes', () => {
    expect(stepsIn('Release the Mac app').map((s) => s.id)).toContain('outward')
    expect(stepsIn('deploy to prod').map((s) => s.id)).toContain('outward')
    expect(stepsIn('ship the build').map((s) => s.id)).toContain('outward')
    expect(stepsIn('\u53d1\u65b0\u7248').map((s) => s.id)).toContain('outward')
    expect(stepsIn('\u4eca\u5929\u4e0a\u7ebf').map((s) => s.id)).toContain('outward')
    expect(isBareYes('ship it')).toBe(false)
    // Words a task only quotes never pick a release: they must ask for it by name.
    expect(checkTaskAnswer({ action: { id: 'r', label: 'Release it', recommended: true }, userWords: 'ok' })).toMatchObject({ ok: false, code: 'human_approval' })
    expect(checkTaskAnswer({ action: { id: 'r', label: 'Release it', recommended: true }, userWords: 'ok, release it' })).toEqual({ ok: true })
    expect(checkTaskAnswer({ action: { id: 'a', label: 'Plan A' }, userWords: 'A please' })).toEqual({ ok: true })
  })

  it('the 10-29 replay: "clear everything" approves no rewrite, unpublish or delete', () => {
    // Main's text replies on the two letters, in the user's place.
    const first = checkTaskAnswer({
      text: 'The user \u53e3\u5934\u56de\u590d\uff1a\u6539\u5199\u5386\u53f2\uff0c\u80fd\u64a4\u56de\u7684 npm \u7248\u672c\u5c31\u64a4\u56de\uff0c\u65e7\u90e8\u7f72\u5220\u9664',
      userWords: '\u6240\u6709\u5173\u4e8e\u4ed6\u7684\u4e1c\u897f\u90fd\u8981\u6e05\u6389',
    })
    expect(first).toMatchObject({ ok: false, code: 'human_approval', steps: ['history', 'unpublish', 'delete'] })
    expect(checkTaskAnswer({ text: 'Clear it. The history rewrite goes to the Walnut VP.', userWords: 'clear it' }))
      .toMatchObject({ ok: false, steps: ['history'] })
    // His correction names both steps, so the corrected answer goes through.
    expect(checkTaskAnswer({
      text: '\u4e0d\u6539\u5199\u5386\u53f2\uff0cnpm \u4e0d\u64a4\u56de',
      userWords: '\u6ca1\u6709\u5fc5\u8981\u6539\u5199\u5386\u53f2\uff0c\u4e5f\u6ca1\u6709\u5fc5\u8981\u6536\u56de',
    })).toEqual({ ok: true })
  })

  it('a risky option needs words asking for its step; a plain one only the words', () => {
    const rewrite = { id: 'rewrite-plan', label: 'Rewrite history, plan first' }
    expect(checkTaskAnswer({ action: rewrite, userWords: 'clear it' })).toMatchObject({ ok: false, code: 'human_approval' })
    expect(checkTaskAnswer({ action: rewrite, userWords: 'ok rewrite it, plan first' })).toEqual({ ok: true })
    // The user said no to the step: that is no approval of it.
    expect(checkTaskAnswer({ action: rewrite, userWords: "don't rewrite history" })).toMatchObject({ ok: false, steps: ['history'] })
    const keep = { id: 'keep', label: 'Keep as is (recommended)' }
    expect(checkTaskAnswer({ action: keep, userWords: 'whatever you think' })).toEqual({ ok: true })
    // An option whose description holds risky steps: naming the option does not name them.
    const all = { id: 'all_recommended', label: '\u5168\u6309\u63a8\u8350', description: 'A \u4e0d\u6539\u5199, B \u5220\u622a\u56fe, E \u6807 deprecate' }
    expect(checkTaskAnswer({ action: all, userWords: '\u5168\u6309\u63a8\u8350' })).toMatchObject({ ok: false, steps: ['unpublish', 'delete'] })
    expect(checkTaskAnswer({ action: all, userWords: '\u5168\u6309\u63a8\u8350\uff0c\u622a\u56fe\u5220\u6389\uff0cE deprecate \u4e5f\u884c' })).toEqual({ ok: true })
    // The note beside a harmless pick is part of the answer.
    expect(checkTaskAnswer({ action: keep, text: 'and force-push main afterwards', userWords: 'keep it' })).toMatchObject({ ok: false, steps: ['history'] })
  })

  it('a bare yes is read with what the letter asks', () => {
    const letter = { subject: 'Rewrite public history and unpublish 0.6.20?', preview: 'Two steps, both public.' }
    const yes = { id: 'yes', label: 'Yes' }
    expect(checkTaskAnswer({ action: yes, userWords: 'yes clear everything', letter })).toMatchObject({ ok: false, steps: ['history', 'unpublish'] })
    expect(checkTaskAnswer({ text: 'Yes, go ahead with both', userWords: 'go ahead', letter })).toMatchObject({ ok: false })
    expect(checkTaskAnswer({ action: yes, userWords: 'yes, rewrite it and unpublish 0.6.20', letter })).toEqual({ ok: true })
    // A specific answer is judged on its own words, not the subject.
    expect(checkTaskAnswer({ action: { id: 'keep', label: 'Keep as is' }, userWords: 'keep it', letter })).toEqual({ ok: true })
    expect(isBareYes('Yes, go ahead with both')).toBe(true)
    expect(isBareYes('\u540c\u610f')).toBe(true)
    expect(isBareYes('Keep as is')).toBe(false)
  })

  it('an answer that points away is read with the letter; an urging "negation" still asks', () => {
    const letter = { subject: 'Option A: rewrite public history', preview: 'B keeps it.' }
    expect(checkTaskAnswer({ action: { id: 'a', label: 'Option A (recommended)' }, userWords: 'clear everything', letter })).toMatchObject({ ok: false, steps: ['history'] })
    expect(checkTaskAnswer({ text: '\u6309\u4f60\u7684\u5efa\u8bae\u6765', userWords: '\u90fd\u6e05\u6389', letter: { subject: '\u8981\u6539\u5199\u5386\u53f2\u5417' } })).toMatchObject({ ok: false, steps: ['history'] })
    expect(checkTaskAnswer({ action: { id: 'yes', label: 'Yes' }, text: 'thanks', userWords: 'yes', letter })).toMatchObject({ ok: false })
    expect(checkTaskAnswer({ action: { id: 'b', label: 'Keep it as it is' }, userWords: 'keep it', letter })).toEqual({ ok: true })
    expect(stepsIn("Don't forget to delete the old tag").map((s) => s.id)).toEqual(['delete'])
    expect(stepsIn('\u522b\u5fd8\u4e86\u5220\u6389\u65e7\u90e8\u7f72').map((s) => s.id)).toEqual(['delete'])
    expect(stepsIn('Push the fix to staging, then rm -f the cache')).toEqual([])
    expect(stepsIn('Squash and merge the PR')).toEqual([])
  })

  it('finds the step kinds in English and Chinese, and leaves a negated one out', () => {
    expect(stepsIn('force-push main').map((s) => s.id)).toEqual(['history'])
    expect(stepsIn('git push --force origin main').map((s) => s.id)).toEqual(['history'])
    expect(stepsIn('push -f').map((s) => s.id)).toEqual(['history'])
    expect(stepsIn('reset --hard and squash all commits').map((s) => s.id)).toEqual(['history'])
    expect(stepsIn('publish 0.6.20 to npm').map((s) => s.id)).toEqual(['outward'])
    expect(stepsIn('buy the domain').map((s) => s.id)).toEqual(['spend'])
    expect(stepsIn('rotate the API key').map((s) => s.id)).toEqual(['access'])
    expect(stepsIn('Use the wide layout')).toEqual([])
    expect(stepsIn('do not rewrite history; no need to unpublish')).toEqual([])
    expect(stepsIn('\u4e0d\u6539\u5199\u5386\u53f2\uff0c\u4e5f\u4e0d\u64a4\u56de')).toEqual([])
    expect(stepsIn('A \u4e0d\u6539\u5199\uff0cB \u5220\u622a\u56fe').map((s) => s.id)).toEqual(['delete'])
  })
})

describe('a report letter while another task asked for the work', () => {
  const NOW = Date.parse('2026-10-29T03:20:00Z')
  const rq = (over: Partial<SessionRequest>): SessionRequest => ({
    id: 'rq-1', fromSessionId: 's-main', toTaskId: 't-worker', preview: 'fix it', status: 'pending',
    createdAt: '2026-10-29T02:00:00Z', deadlineAt: NOW + 3_600_000, ...over,
  })
  const askers = (sid: string) => ({ 's-main': 't-main', 's-self': 't-worker' } as Record<string, string>)[sid]
  const base = { type: 'info' as const, senderTaskId: 't-worker', senderSessionId: 's-worker' }

  it('an open or just-answered request from another task makes it a duplicate', () => {
    expect(replyInsteadOf(base, [rq({})], askers, NOW)?.askerTaskId).toBe('t-main')
    expect(replyInsteadOf(base, [rq({ status: 'expired' })], askers, NOW)).not.toBeNull()
    expect(replyInsteadOf(base, [rq({ status: 'replied', settledAt: new Date(NOW - 60_000).toISOString() })], askers, NOW)).not.toBeNull()
    expect(replyInsteadOf(base, [rq({ status: 'replied', settledAt: new Date(NOW - ANSWERED_RECENTLY_MS - 1).toISOString() })], askers, NOW)).toBeNull()
    expect(replyInsteadOf(base, [rq({ status: 'withdrawn' })], askers, NOW)).toBeNull()
  })

  it('an open request stops counting a day after it was asked', () => {
    expect(replyInsteadOf(base, [rq({ createdAt: new Date(NOW - OPEN_REQUEST_MS - 1).toISOString() })], askers, NOW)).toBeNull()
  })

  it('a decision, a person\'s request, its own session, or another task\'s request do not count', () => {
    expect(replyInsteadOf({ ...base, type: 'action_required' }, [rq({})], askers, NOW)).toBeNull()
    expect(replyInsteadOf(base, [rq({ fromSessionId: 's-person' })], askers, NOW)).toBeNull()
    expect(replyInsteadOf(base, [rq({ fromSessionId: 's-self' })], askers, NOW)).toBeNull()
    expect(replyInsteadOf(base, [rq({ toTaskId: 't-other' })], askers, NOW)).toBeNull()
    expect(replyInsteadOf({ ...base, type: 'review' }, [rq({ toTaskId: undefined, toSessionId: 's-worker' })], askers, NOW)).not.toBeNull()
  })
})

describe('a completed task\'s decision letters', () => {
  const letter: LetterRecord = {
    id: 'lt-a-1', subject: 'Accept the agreement', type: 'action_required', bodyFormat: 'markdown', textPreview: '',
    createdAt: Date.parse('2026-10-29T03:42:00Z'), sender: { sessionId: 's', host: 'h', taskId: 't1' },
    read: false, pinned: false, archived: false, actions: [{ id: 'ok', label: 'Accepted' }],
    thread: [{ from: 'human', text: 'done try again', at: Date.parse('2026-10-29T05:31:00Z') }, { from: 'agent', text: 'Uploading', at: Date.parse('2026-10-29T06:43:00Z') }],
  }
  const task = { id: 't1', title: 'TestFlight 140', completed_at: '2026-10-29T06:50:00Z' }

  it('the 10-29 letter is settled, with the task and when it completed', () => {
    expect(isLeftBehindDecision(letter)).toBe(true)
    expect(letterActivityAt(letter)).toBe(Date.parse('2026-10-29T06:43:00Z'))
    expect(completionSettleReason(letter, task)).toBe('Its task "TestFlight 140" was completed on 2026-10-29 06:50 UTC with this unanswered, so nothing waits on the answer.')
  })

  it('keeps what still has a reason to stay', () => {
    expect(completionSettleReason({ ...letter, pinned: true }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, answered: { actionId: 'ok', label: 'Accepted', at: 1 } }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, sender: { ...letter.sender, pluginId: 'mail' } }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, archivedAt: 5 }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, thread: [letter.thread[0]] }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, createdAt: Date.parse('2026-10-29T07:00:00Z'), thread: [] }, task)).toBeNull()
    expect(completionSettleReason({ ...letter, type: 'info' }, task)).toBeNull()
    expect(completionSettleReason(letter, { ...task, id: 't2' })).toBeNull()
    // An Inbox Triage run completes at its end and leaves its decisions: an answer resumes it.
    expect(completionSettleReason(letter, { ...task, agent_id: 'triage' })).toBeNull()
  })
})
