/**
 * A thread summary that only points at an answer given elsewhere is refused (org/thread-summary-content.ts).
 * The first case is the card the user showed on 2026-11-23 ("the stand-up summary for yesterday and
 * today was given to you"); the rest are the same class in other words, and summaries that carry
 * the answer, which must pass. Chinese test data is written with \u escapes.
 */
import { describe, expect, it } from 'vitest'
import { summaryPointsElsewhere } from '../../../src/core/org/thread-summary-content.js'

// "\u6628\u5929\u548c\u4eca\u5929\u7684\u7ad9\u4f1a\u603b\u7ed3\u5df2\u7ed9\u4f60\u3002": "the stand-up summary for yesterday and today was given to you."
const HIS_CARD = '\u6628\u5929\u548c\u4eca\u5929\u7684\u7ad9\u4f1a\u603b\u7ed3\u5df2\u7ed9\u4f60\u3002'

describe('a summary that only says it was given elsewhere', () => {
  it.each([
    ['the card he showed', HIS_CARD],
    ['"already told you where the task is"', '\u5df2\u544a\u8bc9\u4f60\u90a3\u4e2a\u4efb\u52a1\u5728\u54ea'],
    ['"see the chat"', '\u89c1\u804a\u5929'],
    ['"answered in the chat"', '\u5df2\u5728\u804a\u5929\u91cc\u56de\u590d'],
    ['"stand-up summary: sent to you"', '\u7ad9\u4f1a\u603b\u7ed3\uff1a\u5df2\u53d1\u7ed9\u4f60'],
    ['English: told you where, not where', 'Told you where the cluster update task is.'],
    ['English: answered in chat', 'Answered in the chat.'],
    ['English: see above', 'See above.'],
    ['English: bare answered', 'Answered'],
  ])('is refused: %s', (_name, summary) => {
    expect(summaryPointsElsewhere(summary)).toMatch(/write the answer itself/)
  })
})

describe('a summary that carries the answer', () => {
  it.each([
    ['names the task and its progress', 'The cluster update work is task "Cluster version upgrade": us-west-2 done, eu-west-1 next, about 2 days left.'],
    ['a pointer plus the content', 'Answered in the chat: the cluster update task is "Cluster version upgrade", 3 of 5 regions done.'],
    ['Chinese with content', '\u96c6\u7fa4\u5347\u7ea7\u4efb\u52a1\u662f\u300cCluster version upgrade\u300d\uff0c\u5df2\u5b8c\u6210 3 \u4e2a\u533a\u57df\uff0c\u8fd8\u5269 2 \u4e2a'],
    ['a pointer with a proof path', 'Sent you the video: /tmp/proof/strip-fold.mp4'],
    ['a pointer with a letter id', 'Told you in lt-abc123.'],
    ['a status word only, no pointer', 'Deploy done.'],
    ['a bare status with what it means', 'Done; live on prod, check the card'],
    ['a pointer beside a short fact', 'Sent you the fix, live on prod'],
    ['reported to you, and what', 'Reported to you that the migration lost 12 rows on Monday'],
    ['a colleague was told', 'Passed the review to them and they approved it'],
    ['release notes went to them', 'The fix shipped and I sent them the release notes'],
    ['the team was told what you must do', 'Told the team you need to approve the budget'],
    ['Chinese: deadlines on the three tasks given to you', '\u5df2\u7ecf\u7ed9\u4f60\u7684\u4e09\u4e2a\u4efb\u52a1\u90fd\u52a0\u4e0a\u4e86\u622a\u6b62\u65e5\u671f'],
    ['Chinese: mailed him, waiting on him', '\u5df2\u7ecf\u7ed9\u4ed6\u53d1\u4e86\u90ae\u4ef6\uff0c\u7b49\u4ed6\u56de\u590d'],
    ['Chinese: the CR sent to you is merged', '\u5df2\u53d1\u7ed9\u4f60\u5ba1\u7684 CR \u5df2\u5408\u5e76'],
    ['empty', ''],
  ])('passes: %s', (_name, summary) => {
    expect(summaryPointsElsewhere(summary)).toBeNull()
  })
})
