/**
 * The related-open-tasks ranking (src/core/sessions/related-open-rank.ts) on a dense
 * board: 130 open tasks in one project, every title leaning on "Fix", "iOS" and "test".
 *
 * The line it must hold: a new task that shares only a busy project's common words
 * never blocks; one that names the same subject (a near-duplicate title, the subject
 * in its brief, the same CJK words) does. Calibrated against these cases and against
 * a copy of a real 110-open-task board (6 of 94 open tasks blocked leave-one-out, each
 * a real duplicate or a fork of one).
 */
import { describe, it, expect } from 'vitest'
import { denseBoard, productBoard, LEAD_BOILERPLATE } from './related-open-fixture.js'
import {
  rankRelatedOpenTasks, relatedTerms, RELATED_MAX_CANDIDATES, scoreRelatedOpenTasks, withoutNamedPartners, blockingOnly,
} from '../../../src/core/sessions/related-open-rank.js'
import {
  familyMap, inFamilies, descriptionSentences, boilerplateOf, withoutBoilerplate,
} from '../../../src/core/sessions/related-open-terms.js'

const board = denseBoard()
const where = { project: 'marina', groupId: 'g_mobile' }
const rank = (title: string, description?: string, open = board) =>
  rankRelatedOpenTasks({ title, ...(description ? { description } : {}) }, open, where)

describe('terms', () => {
  it('drops stopwords and words under 3 letters, folds short plurals, reads CJK as pairs', () => {
    expect([...relatedTerms('Fix the UI of an app for tests').keys()]).toEqual(['fix', 'app', 'test'])
    // "notification delay" in Chinese: four characters, three ordered pairs.
    expect([...relatedTerms('\u901a\u77e5\u5ef6\u8fdf').keys()])
      .toEqual(['\u901a\u77e5', '\u77e5\u5ef6', '\u5ef6\u8fdf'])
    expect(relatedTerms('').size).toBe(0)
  })

  it('folds a root and its inflections into one family: remind/reminder, expires/expiry', () => {
    const a = relatedTerms('Remind once when a login expires')
    const b = relatedTerms('Login expiry reminder')
    const fam = familyMap([a, b])
    expect([...inFamilies(b, fam).keys()].sort()).toEqual([...inFamilies(a, fam).keys()].filter((k) => k !== 'once').sort())
    const c = relatedTerms('Expire the reminders')
    const d = relatedTerms('expiry remind')
    const fam2 = familyMap([c, d])
    expect([...inFamilies(c, fam2).keys()].sort()).toEqual([...inFamilies(d, fam2).keys()].sort())
    // Four letters never form a family: "test" and "testbed" stay apart.
    expect(familyMap([relatedTerms('test testbed')]).size).toBe(0)
  })

  it('a longer word that only begins with another, or a joined name, stays apart', () => {
    const pairs = [
      'check checkout', 'state statement', 'direct director', 'prior priority', 'companion company',
      'compute computer', 'reply replica', 'cluster ClusterLens', 'ledger LedgerService LedgersCrd Ledgeroperator',
      'cloud CloudWatch clouddev', 'local localDaemon', 'agent agentClientProtocol', 'model modelcontextprotocol',
    ]
    for (const text of pairs) expect({ text, families: [...familyMap([relatedTerms(text)])] }).toEqual({ text, families: [] })
  })

  it('drops the sentences three or more descriptions share, keeps the rest', () => {
    const shared = 'Run the tests on the build box before landing.'
    const descs = [`Menu page. ${shared}`, `Order form. ${shared}`, `Opening hours. ${shared}`, 'Logo refresh.']
    const boiler = boilerplateOf(descs.map((d) => new Set(descriptionSentences(d))))
    expect([...boiler]).toEqual([shared.toLowerCase()])
    expect(withoutBoilerplate(descs[0], boiler).trim()).toBe('Menu page.')
    expect(withoutBoilerplate(descs[3], boiler)).toBe('Logo refresh.')
  })
})

describe('a busy project\'s common words never block', () => {
  const unrelated = [
    'Fix iOS widget timezone label',
    'Test plan for release notes',
    'iOS share extension login',
    'Fix iOS crash on launch',
    'iOS layout test',
    'Write the iOS test plan',
    'Fix flaky test retries in CI',
    'iOS 18 test matrix',
    'Fix test fixture cleanup',
    'iOS app icon refresh',
  ]
  for (const title of unrelated) {
    it(`"${title}"`, () => { expect(rank(title)).toEqual([]) })
  }

  it('a two-word title read in a long brief does not block on its own', () => {
    const open = [...board, { id: 'w-1', title: 'Weekly digest', project: 'marina', phase: 'TODO' }]
    expect(rank('Board labels cleanup', 'The weekly digest and the board labels are noisy', open)).toEqual([])
  })
})

describe('the same subject blocks', () => {
  it('an exact or reworded duplicate title, the right task first', () => {
    expect(rank('Fix iOS keyboard layout')[0]?.task.id).toBe('t-000')
    expect(rank('Keyboard layout broken on iOS')[0]?.task.id).toBe('t-000')
    expect(rank('Fix the iOS keyboard layout bug')[0]?.task.id).toBe('t-000')
    expect(rank('Search bar is slow on first load')[0]?.task.id).toBe('t-069')
    expect(rank('Photo picker crash')[0]?.task.id).toBe('t-061')
  })

  it('the subject named only in the description (a vague title)', () => {
    const hits = rank('Release checklist', 'The photo picker crash keeps coming back on the release build')
    expect(hits[0]?.task.id).toBe('t-061')
    expect(hits[0]?.matched).toEqual(expect.arrayContaining(['photo', 'picker', 'crash']))
  })

  it('CJK titles match on the words they share, and not on one common word', () => {
    const open = [
      ...board,
      { id: 'c-1', title: '\u4fee\u590d\u901a\u77e5\u5ef6\u8fdf', project: 'marina', phase: 'TODO' },
      { id: 'c-2', title: 'iOS \u8bed\u97f3\u8f93\u5165\u5d29\u6e83', project: 'marina', phase: 'TODO' },
    ]
    // "notification delay problem" vs "fix notification delay"
    expect(rank('\u901a\u77e5\u5ef6\u8fdf\u95ee\u9898', undefined, open)[0]?.task.id).toBe('c-1')
    // "iOS voice input quits" vs "iOS voice input crash"
    expect(rank('iOS \u8bed\u97f3\u8f93\u5165\u95ea\u9000', undefined, open)[0]?.task.id).toBe('c-2')
    // Mixed script: an English title naming the Chinese subject.
    expect(rank('Fix iOS \u901a\u77e5\u5ef6\u8fdf', undefined, open)[0]?.task.id).toBe('c-1')
    // "fix login problem": shares only "fix" with c-1.
    expect(rank('\u4fee\u590d\u767b\u5f55\u95ee\u9898', undefined, open)).toEqual([])
  })

  it('reports the shared words that carried the match, as the new task wrote them', () => {
    // "ios" is on most of this board's rows: it carries no weight and is not listed.
    expect(rank('Keyboard layout broken on iOS')[0]?.matched).toEqual(['keyboard', 'layout'])
  })
})

/**
 * Real pairs from a copy of a real board (2026-10-26), renamed. The first group are
 * near-duplicates the first version let through (a short title inside a longer open
 * one, CJK and English); the second must keep passing.
 */
describe('regression pairs from a real board', () => {
  const board = productBoard()
  const onBoard = (title: string, description?: string) =>
    rankRelatedOpenTasks({ title, ...(description ? { description } : {}) }, board, { project: 'app' })
  const top = (title: string, description?: string) => onBoard(title, description)[0]?.task.title

  it('a short CJK title inside a longer open one: "login expiry reminder"', () => {
    // vs "remind the user once when a host login expires" (was 0.557, under the line)
    expect(top('\u767b\u5f55\u8fc7\u671f\u63d0\u9192')).toBe('host \u767b\u5f55\u8fc7\u671f\u65f6\u63d0\u9192\u7528\u6237\u4e00\u6b21')
  })

  it('a short CJK title inside a longer open one: "inbox long thread"', () => {
    // was 0.431
    expect(top('\u6536\u4ef6\u7bb1\u957f\u5bf9\u8bdd')).toMatch(/^\u6536\u4ef6\u7bb1\u957f\u5bf9\u8bdd\u6eda/)
  })

  it('a CJK pair that only spans two words does not count against containment: "restart recovery"', () => {
    // "restart" + "recover" read as pairs leaves "start-re" unmatched (was 0.31)
    expect(top('\u91cd\u542f\u6062\u590d')).toBe('\u91cd\u542f\u540e\u81ea\u52a8\u6062\u590d\u88ab\u6253\u65ad\u4efb\u52a1')
  })

  it('an English rewording that only shares word stems: reminder/remind, expiry/expires', () => {
    // was 0.38
    expect(top('Host login expiry reminder')).toBe('Remind the user once when a host login expires')
  })

  it('a short mixed title inside a long one, and a fork of a task with a " \u00b7 Suffix"', () => {
    expect(top('\u72b6\u6001\u548c Board')).toMatch(/Board \u91cd\u65b0\u8bbe\u8ba1/)
    expect(top('Image check - fork of Shop chat channel catch-up \u00b7 Weekly')).toBe('Shop chat channel catch-up \u00b7 Weekly')
    expect(top('Routine: Weekly LLM cost breakdown')).toBe('Routine: Weekly and monthly LLM cost')
  })

  it('a brief that names an open task by its title lists it (the description path)', () => {
    // A team sibling the brief names: related work, so it is listed; the session confirms.
    expect(top('Growth: newsletter', 'Write the launch newsletter; the trend scout and listings feed it.')).toBe('Growth: trend scout')
  })

  it('a lead\'s standard paragraph is boilerplate, not a match', () => {
    // The paragraph names "Mac App"; before it was dropped this scored 0.35 to 0.42
    // against "App npm update notification design \u00b7 Mac App" on every lead brief.
    expect(onBoard('Config backup restore', LEAD_BOILERPLATE)).toEqual([])
    expect(onBoard('Default instructions reach running sessions', LEAD_BOILERPLATE)).toEqual([])
  })

  it('two practice rounds that share only their series name do not block', () => {
    expect(onBoard('Practice round (all problems)')).toEqual([])
  })

  it('a pair with no shared words is out of reach (documented limit)', () => {
    // "standalone Apps page: move plugins out of Settings" vs "plugins appear in the
    // sidebar as they are built": one shared word, the rest is meaning, not text.
    expect(onBoard('\u72ec\u7acb\u7684 Apps \u9875\u9762\uff1a\u63d2\u4ef6\u79fb\u51fa\u8bbe\u7f6e', LEAD_BOILERPLATE)).toEqual([])
  })
})

/**
 * Look-alikes from a real board (renamed): words that only share a beginning, and joined
 * service names. A prefix rule once read each pair as one word and blocked unrelated
 * work; two shared words while each title keeps a word of its own are a topic, not a
 * duplicate.
 */
describe('look-alike words never block', () => {
  const open = [...productBoard(), ...[
    'Orphan LedgersCrd cleanup: delete via a job, with sandbox tests',
    'Release pipeline watch leader (skydev): LedgerService, LedgerOperator, ClusterLens',
    'LedgerService/ClusterLens skill lock',
    'Company holiday calendar import',
    'SkyWatch alarm dashboard cleanup',
    'Checkout button state on iOS',
    'Director weekly report',
    'Statement export for the bank account',
    'Priority inbox ranking',
    'Ledger service canary failure',
    'Dentist appointment reminder',
    'Stale invite expiry',
  ].map((title, i) => ({ id: `n-${i}`, title, project: 'app', phase: 'TODO' }))]
  const onBoard = (title: string) => rankRelatedOpenTasks({ title }, open, { project: 'app' })
  for (const title of [
    'Sandbox tests for LedgerService', 'SkyWatch pipeline watch', 'Cluster ledger watcher', 'Companion holiday sync',
    'Skydev alarm dashboard', 'Check button state', 'Direct report weekly', 'State export', 'Prior inbox ranking',
    'Ledgeroperator canary failure',
  ]) {
    it(`"${title}"`, () => { expect(onBoard(title)).toEqual([]) })
  }

  it('an inflection still meets its root: remind/reminder, expire/expiry', () => {
    expect(onBoard('Remind me of the dentist appointment')[0]?.task.title).toBe('Dentist appointment reminder')
    expect(onBoard('Expire stale invites')[0]?.task.title).toBe('Stale invite expiry')
  })
})

describe('a task the new brief names by id', () => {
  const pb = productBoard()
  const kept = (title: string, description: string, open = pb, ctx: { project: string; groupId?: string } = { project: 'app' }) =>
    blockingOnly(withoutNamedPartners({ title, description }, scoreRelatedOpenTasks({ title, description }, open, ctx))).map((r) => r.task.id)

  it('as other work ("coordinate with X", another title) is not listed back', () => {
    expect(kept('Growth: newsletter', 'Write the launch newsletter; the trend scout and listings feed it.')).toEqual(['p-04'])
    expect(kept('Growth: newsletter', 'Write the launch newsletter; the trend scout (p-04) and listings feed it.')).toEqual([])
  })

  it('under its own title ("take over X", "redo X") is still listed', () => {
    expect(kept('Routine: Weekly LLM cost breakdown', 'Take over p-14; its session stopped mid-run.')).toEqual(['p-14'])
    expect(kept('Keyboard layout broken on iOS', 'Redo t-000 from scratch: the first fix did not hold.', board, where)[0]).toBe('t-000')
  })
})

describe('boilerplate counts the open tasks only', () => {
  it('a user quote the new brief shares with two open tasks is a match', () => {
    const quote = 'The user said: the photo picker crashes when the app resumes from the background.'
    const open = [...productBoard(),
      { id: 'q-1', title: 'Photo picker crash on resume', description: quote, project: 'app', phase: 'TODO' },
      { id: 'q-2', title: 'Crash report triage', description: `Collect the reports. ${quote}`, project: 'app', phase: 'TODO' }]
    const hits = rankRelatedOpenTasks({ title: 'Customer report follow-up', description: `Look into this. ${quote}` }, open, { project: 'app' })
    expect(hits[0]?.task.id).toBe('q-1')
  })
})

describe('ordering and the cap', () => {
  it('at most five, best first', () => {
    const open = Array.from({ length: 8 }, (_, i) => ({
      id: `k-${i}`, title: `Rotate signing keys step ${i + 1}`, project: 'marina', phase: 'TODO',
    }))
    const hits = rank('Rotate signing keys', undefined, [...board, ...open])
    expect(hits).toHaveLength(RELATED_MAX_CANDIDATES)
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
  })

  it('the same folder wins a tie, and the boost alone never blocks', () => {
    const open = [
      { id: 'a', title: 'Ledger export totals', project: 'other', phase: 'TODO' },
      { id: 'b', title: 'Ledger export totals', project: 'marina', group_id: 'g_mobile', phase: 'TODO' },
      { id: 'c', title: 'Ledger import', project: 'marina', group_id: 'g_mobile', phase: 'TODO' },
    ]
    const hits = rank('Ledger export totals', undefined, open)
    expect(hits.map((h) => h.task.id)).toEqual(['b', 'a'])
    expect(hits[0].sameFolder).toBe(true)
    // Only a one-word match ("ledger") with c: the folder does not make it a duplicate.
    expect(rank('Ledger reconcile job', undefined, open)).toEqual([])
  })

  it('an empty or all-stopword title has nothing to match', () => {
    expect(rank('Do it')).toEqual([])
  })
})
