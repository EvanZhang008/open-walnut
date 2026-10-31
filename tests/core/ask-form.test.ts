/**
 * An ask in a one-click shape (2026-10-31, the user: "they can just yes and no, or single or multiple
 * choice, or text right, ideally prefer non text, and show the summary of the issue very clear, with
 * potentially a more section"): user_status.askForm from the task's current report
 * (user-status.ts askFormOf), the self-report lines that carry it (builtins.ts readStatusReport), a
 * change from outside its turn (sessions/report-set.ts), and the one answer message (askAnswerText).
 */
import { describe, expect, it } from 'vitest'
import { askAnswerText, askFormFrom, deriveUserStatus, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'
import { FOR_USER_PROMPT, readStatusReport } from '../../src/core/session-hooks/builtins.js'
import { ReportChangeError, reportOfChange } from '../../src/core/sessions/report-set.js'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const base: UserStatusInput = { hasSession: true, processStatus: 'stopped', hasLeader: true, phaseChangedAt: ago(120_000) }
const rep = (r: Partial<StatusReport>): StatusReport => ({ at: ago(60_000), ...r })
const needsOf = (r: Partial<StatusReport>) => deriveUserStatus({ ...base, phase: 'NEED_ACTION', report: rep({ state: 'needs', ...r }) }, NOW)

describe('askForm comes from the current needs report', () => {
  it('a single choice keeps its options and the recommended one; ask stays the plain text', () => {
    const s = needsOf({
      ask: 'Ship the fix today or wait for Monday?', ask_kind: 'single', ask_more: 'Today means a deploy at 6pm.',
      ask_options: [{ id: 'o1', label: 'Ship today', recommended: true }, { id: 'o2', label: 'Wait for Monday' }],
    })
    expect(s.ask).toBe('Ship the fix today or wait for Monday?')
    expect(s.askForm).toEqual({
      summary: 'Ship the fix today or wait for Monday?', kind: 'single', more: 'Today means a deploy at 6pm.',
      options: [{ id: 'o1', label: 'Ship today', recommended: true }, { id: 'o2', label: 'Wait for Monday' }],
    })
  })

  it('yes_no carries no options; an ask with no kind is text', () => {
    expect(needsOf({ ask: 'Approve the device test?', ask_kind: 'yes_no', ask_options: [{ id: 'a', label: 'x' }, { id: 'b', label: 'y' }] }).askForm)
      .toEqual({ summary: 'Approve the device test?', kind: 'yes_no' })
    expect(needsOf({ ask: 'Paste the error you saw' }).askForm).toEqual({ summary: 'Paste the error you saw', kind: 'text' })
  })

  it('a choice with fewer than 2 options is text; more than 5 are cut to 5', () => {
    expect(askFormFrom('Pick one', 'single', ['Only one']).kind).toBe('text')
    expect(askFormFrom('Pick', 'multi', ['a', 'b', 'c', 'd', 'e', 'f', 'g']).options).toHaveLength(5)
  })

  it('a single choice recommends one option at most', () => {
    const f = askFormFrom('Pick', 'single', [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }])
    expect(f.options).toEqual([{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }])
    expect(askFormFrom('Pick', 'multi', [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }]).options!.every((o) => o.recommended)).toBe(true)
  })

  it('a cut summary keeps the whole ask under More, and never splits a character', () => {
    const long = `Decide ${'which branch '.repeat(20)}to keep`
    expect(askFormFrom(long, 'yes_no').more).toBe(long)
    expect(askFormFrom(long, 'yes_no', [], 'Own detail').more).toBe('Own detail')
    const cjk = `${'\u4e2d'.repeat(118)}\u{1F600}\u6587\u6587`
    const f = askFormFrom(cjk, 'yes_no')
    expect(f.summary).not.toMatch(/[\uD800-\uDBFF]\u2026$/)
    expect(f.summary.endsWith('\u2026')).toBe(true)
  })

  it('a long summary is cut at a word to 120 characters with an ellipsis', () => {
    const long = `Decide ${'which branch '.repeat(20)}to keep`
    const f = askFormFrom(long, 'yes_no')
    expect(f.summary.length).toBeLessThanOrEqual(120)
    expect(f.summary.endsWith('…')).toBe(true)
    expect(f.summary).not.toMatch(/ …$/)
  })

  it('no askForm without a current needs report: a stale one, a handed-back task, a live prompt, a snooze', () => {
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', report: rep({ state: 'needs', ask: 'Old ask', ask_kind: 'yes_no', at: ago(30 * 60_000) }) }, NOW).askForm).toBeUndefined()
    expect(deriveUserStatus({ ...base, hasLeader: false, phase: 'NEED_ACTION' }, NOW).askForm).toBeUndefined()
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', pendingPermissionTool: 'AskUserQuestion', report: rep({ state: 'needs', ask: 'Pick', ask_kind: 'yes_no' }) }, NOW).askForm).toBeUndefined()
    const snoozed = deriveUserStatus({ ...base, phase: 'NEED_ACTION', snoozedUntil: '2026-11-13', report: rep({ state: 'needs', ask: 'Pick', ask_kind: 'yes_no' }) }, NOW)
    expect(snoozed.state).toBe('waiting')
    expect(snoozed.askForm).toBeUndefined()
  })
})

describe('the self-report lines', () => {
  it('reads kind, options with the recommended mark, and more', () => {
    const r = readStatusReport([
      'FOR_USER_STATE: needs-you',
      'FOR_USER_ASK: Which plan do we run first?',
      'FOR_USER_ASK_KIND: single',
      'FOR_USER_ASK_OPTIONS: Fix the sync first (recommended) | **Ship the new view** | 3 days of tests',
      'FOR_USER_ASK_MORE: The sync bug loses edits.',
      'The new view is ready but untested.',
      'FOR_USER_WAITING_ON: none',
      'FOR_USER_NOW: Both plans are written.',
      'FOR_USER_NEXT: You pick, I start.',
    ].join('\n'), new Date(NOW))
    expect(r).toMatchObject({
      state: 'needs', ask: 'Which plan do we run first?', ask_kind: 'single',
      ask_options: [
        { id: 'o1', label: 'Fix the sync first', recommended: true },
        { id: 'o2', label: 'Ship the new view' },
        { id: 'o3', label: '3 days of tests' },
      ],
      ask_more: 'The sync bug loses edits.\nThe new view is ready but untested.',
      now: 'Both plans are written.',
    })
    expect(r!.ask_options![1]).not.toHaveProperty('recommended')
  })

  it('options written one per line read the same; a bolded option is not recommended', () => {
    const r = readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: Pick a colour\nFOR_USER_ASK_KIND: multi\nFOR_USER_ASK_OPTIONS:\n- Red\n- **Blue**\nFOR_USER_NOW: Both drafted.', new Date(NOW))
    expect(r?.ask_options).toEqual([{ id: 'o1', label: 'Red' }, { id: 'o2', label: 'Blue' }])
    expect(r?.now).toBe('Both drafted.')
  })

  it('yes-no in any spelling, none fields, and an older report without the lines', () => {
    expect(readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: Approve?\nFOR_USER_ASK_KIND: Yes / No\nFOR_USER_ASK_OPTIONS: none\nFOR_USER_ASK_MORE: none', new Date(NOW)))
      .toEqual({ state: 'needs', ask: 'Approve?', ask_kind: 'yes_no', at: new Date(NOW).toISOString() })
    expect(readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: Approve?', new Date(NOW)))
      .toEqual({ state: 'needs', ask: 'Approve?', at: new Date(NOW).toISOString() })
  })

  it('the ask lines are kept only for needs-you, and FOR_USER_ASK does not swallow them', () => {
    const r = readStatusReport('FOR_USER_STATE: working\nFOR_USER_ASK: none\nFOR_USER_ASK_KIND: single\nFOR_USER_ASK_OPTIONS: a | b', new Date(NOW))
    expect(r).toEqual({ state: 'working', at: new Date(NOW).toISOString() })
    const n = readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: Pick a colour\nFOR_USER_ASK_KIND: single\nFOR_USER_ASK_OPTIONS: Red | Blue', new Date(NOW))
    expect(n?.ask).toBe('Pick a colour')
  })

  it('the prompt asks for a one-click answer over text, a few options, no filler, a summary and More', () => {
    expect(FOR_USER_PROMPT).toContain('FOR_USER_ASK_KIND: needs-you only')
    expect(FOR_USER_PROMPT).toMatch(/Prefer yes-no, then a choice/)
    expect(FOR_USER_PROMPT).toMatch(/2 to 5 options/)
    expect(FOR_USER_PROMPT).toMatch(/No filler options/)
    expect(FOR_USER_PROMPT).toContain('FOR_USER_ASK_MORE')
  })
})

describe('a change from its lead, VP, Main or a person', () => {
  it('keeps the shape for needs, drops it for another state', () => {
    const r = reportOfChange({ state: 'needs', ask: 'Pick a host', ask_kind: 'single', ask_options: ['Mac', { id: 'cd', label: 'Dev host', recommended: true }], ask_more: 'The Mac is busy.' }, 'human', undefined, NOW)
    expect(r).toMatchObject({ ask_kind: 'single', ask_options: [{ id: 'o1', label: 'Mac' }, { id: 'cd', label: 'Dev host', recommended: true }], ask_more: 'The Mac is busy.' })
    expect(reportOfChange({ state: 'waiting', waiting_on: 'CI', ask_kind: 'yes_no' }, 'human', undefined, NOW)).not.toHaveProperty('ask_kind')
  })

  it('refuses a bad kind, a choice without 2 to 5 options, options on yes_no, duplicate ids', () => {
    const bad = (c: Record<string, unknown>) => () => reportOfChange({ state: 'needs', ask: 'Pick one', ...c }, 'human', undefined, NOW)
    expect(bad({ ask_kind: 'maybe' })).toThrow(ReportChangeError)
    expect(bad({ ask_kind: 'single', ask_options: ['a'] })).toThrow(/2 to 5/)
    expect(bad({ ask_kind: 'multi', ask_options: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(/2 to 5/)
    expect(bad({ ask_kind: 'yes_no', ask_options: ['a', 'b'] })).toThrow(/only with ask_kind single or multi/)
    expect(bad({ ask_kind: 'single', ask_options: [{ id: 'x', label: 'a' }, { id: 'x', label: 'b' }] })).toThrow(/unique/)
    expect(bad({ ask_more: 'x'.repeat(2001) })).toThrow(/2000/)
  })
})

describe('the answer goes back as one message', () => {
  const form = askFormFrom('Which plan first?', 'multi', [{ id: 'o1', label: 'Sync fix' }, { id: 'o2', label: 'New view' }])
  it('names the summary, the options picked and the person\'s words', () => {
    expect(askAnswerText(form, { picked: ['o2', 'o1'] })).toBe('Answer to "Which plan first?": New view, Sync fix')
    expect(askAnswerText(form, { picked: ['o1'], words: 'but keep it small' })).toBe('Answer to "Which plan first?": Sync fix. but keep it small')
    expect(askAnswerText(askFormFrom('Approve?', 'yes_no'), { picked: ['no'] })).toBe('Answer to "Approve?": No')
    expect(askAnswerText(askFormFrom('Paste it', 'text'), { words: 'ENOENT' })).toBe('Answer to "Paste it": ENOENT')
  })
})
