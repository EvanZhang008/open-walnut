/**
 * How an ask of the Org rail reads and answers (web/src/components/org/org-ask-form.ts). 2026-10-31,
 * the user, on the rail beside the chat: "show the summay of the issue veyr clear, with potentially
 * a more secino", answers "so user can just click ... yes and noe, or single or multiple choice, or
 * text right, ideally prefer non text"; and earlier "u need to show what are actually waiting": no
 * Needs you row without what it asks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  SUMMARY_MAX, answerMessage, askSummary, formOptions, inlineShape, lineSetBy, readAskForm, readStatusLine,
} from '../../web/src/components/org/org-ask-form'
import type { OrgAlertView } from '../../web/src/components/org/org-channels-model'
import { snoozeTakesOff, type UserStatus } from '../../src/core/user-status'

const alert = (over: Partial<OrgAlertView>): OrgAlertView => ({ taskId: 't1', title: 'Release notes', kind: 'needs', ...over })
const ROOT = path.resolve(import.meta.dirname, '../..')
/** The members of a string-literal union, read from the source, so a new one fails here. */
function unionMembers(file: string, re: RegExp): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const m = src.match(re)
  expect(m, `${file}: ${re}`).toBeTruthy()
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!)
}

describe('every Needs you row says what it asks', () => {
  const kinds = unionMembers('web/src/components/org/org-channels-model.ts', /kind: ((?:'[a-z]+'\s*\|\s*)+'[a-z]+');/)
  const sources = unionMembers('src/core/user-status.ts', /source\?: ((?:'[a-z]+'\s*\|\s*)+'[a-z]+');/)

  it('reads the unions it covers from the source', () => {
    expect(kinds).toEqual(expect.arrayContaining(['question', 'permission', 'error', 'needs']))
    expect(sources).toEqual(expect.arrayContaining(['prompt', 'letter', 'choice', 'error', 'session']))
  })

  it('gives every kind and source a summary and an answer, with no words of its own too', () => {
    for (const kind of kinds) {
      for (const source of [undefined, ...sources]) {
        const a = alert({ kind: kind as OrgAlertView['kind'], ...(source ? { source: source as OrgAlertView['source'] } : {}) })
        const { summary } = askSummary(a)
        expect(summary.trim(), `${kind}/${source ?? '-'}`).not.toBe('')
        expect(inlineShape(a), `${kind}/${source ?? '-'}`).toBeTruthy()
        // An ask with words of its own is summed up in those words, never in a kind word.
        const said = askSummary({ ...a, ask: `Approve the plan for ${kind} ${source ?? '-'}` }).summary
        expect(said, `${kind}/${source ?? '-'}`).toBe(`Approve the plan for ${kind} ${source ?? '-'}`)
      }
    }
  })

  it('offers Snooze only where a snooze takes the ask off the user', () => {
    for (const source of sources) {
      expect(snoozeTakesOff({ state: 'needs', source: source as UserStatus['source'] }), source).toBe(source !== 'prompt')
      expect(snoozeTakesOff({ state: 'needs', source: source as UserStatus['source'] }, true), `main ${source}`).toBe(false)
    }
  })
})

describe('the summary and More', () => {
  it('uses the form the task gave', () => {
    const a = alert({ ask: 'long words', form: { summary: 'Ship 0.6.22 on Saturday?', more: 'Notes are in the doc.', kind: 'yes_no' } })
    expect(askSummary(a)).toEqual({ summary: 'Ship 0.6.22 on Saturday?', more: 'Notes are in the doc.' })
  })

  it('keeps a short ask whole, and cuts a long one to its first sentence with the rest under More', () => {
    expect(askSummary(alert({ ask: 'Pick a date for the release.' }))).toEqual({ summary: 'Pick a date for the release.' })
    const long = 'Approve the release notes. They cover the Org rail, the snooze fix and the status line, and the date is Saturday unless you want Monday instead because of the review.'
    const { summary, more } = askSummary(alert({ ask: long }))
    expect(summary).toBe('Approve the release notes.')
    expect(more).toBe(long)
    const oneLine = 'x'.repeat(300)
    expect(askSummary(alert({ ask: oneLine })).summary.length).toBeLessThanOrEqual(SUMMARY_MAX)
    // Several lines: the first is the summary, all of it is More.
    expect(askSummary(alert({ ask: 'Pick one\n1. A\n2. B' }))).toEqual({ summary: 'Pick one', more: 'Pick one\n1. A\n2. B' })
    // Chinese sentences end in a full-width mark.
    expect(askSummary(alert({ ask: `三家报价都到了，选哪一家？${'最低价那家工期要 6 周，另外两家都是 3 周，'.repeat(6)}` })).summary).toBe('三家报价都到了，选哪一家？')
  })
})

describe('the answer', () => {
  it('follows where the ask lives first, then the form, then a line', () => {
    expect(inlineShape(alert({ kind: 'question' }))).toBe('prompt')
    expect(inlineShape(alert({ source: 'letter', form: { summary: 's', kind: 'yes_no' } }))).toBe('letter')
    expect(inlineShape(alert({ source: 'choice' }))).toBe('choice')
    expect(inlineShape(alert({ source: 'session', form: { summary: 's', kind: 'multi', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }))).toBe('multi')
    expect(inlineShape(alert({ source: 'session' }))).toBe('text')
    expect(inlineShape(alert({ kind: 'error' }))).toBe('text')
  })

  it('draws Yes / No for a yes_no and the task\'s own choices otherwise', () => {
    expect(formOptions({ summary: 's', kind: 'yes_no' })).toEqual([{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }])
    expect(formOptions({ summary: 's', kind: 'single', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }] }).map((o) => o.id)).toEqual(['a', 'b'])
    expect(formOptions({ summary: 's', kind: 'text' })).toEqual([])
  })

  it('sends one message the task reads as the answer, in the status foundation\'s words', () => {
    expect(answerMessage({ summary: 'Ship on Saturday?', kind: 'yes_no' }, 'Ship on Saturday?', { picked: ['yes'] })).toBe('Answer to "Ship on Saturday?": Yes')
    const hosts = { summary: 'Which hosts?', kind: 'multi' as const, options: [{ id: 'mac', label: 'Mac' }, { id: 'dev', label: 'clouddev' }] }
    expect(answerMessage(hosts, 'Which hosts?', { picked: ['mac', 'dev'] })).toBe('Answer to "Which hosts?": Mac, clouddev')
    // An ask with no form: its summary, then the words.
    expect(answerMessage(undefined, 'Why?', { words: '  because  ' })).toBe('Answer to "Why?": because')
  })
})

describe('reading the stored status', () => {
  it('takes a form it can draw and falls back on one it cannot', () => {
    expect(readAskForm({ askForm: { summary: ' Go? ', kind: 'yes_no' } })).toEqual({ summary: 'Go?', kind: 'yes_no' })
    expect(readAskForm({ askForm: { summary: 'Pick', kind: 'single', options: [{ id: 'a', label: 'A' }] } })).toEqual({ summary: 'Pick', kind: 'text' })
    expect(readAskForm({ askForm: { summary: '', kind: 'yes_no' } })).toBeUndefined()
    expect(readAskForm({ askForm: { summary: 'x', kind: 'ranking' } })).toBeUndefined()
    expect(readAskForm(undefined)).toBeUndefined()
    // A writer of another version: a More that is not text is left out, a repeated id kept once.
    expect(readAskForm({ askForm: { summary: 'Pick', more: { x: 1 }, kind: 'single', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A again' }] } })).toEqual({ summary: 'Pick', kind: 'text' })
    expect(readAskForm({ askForm: { summary: 'Pick', kind: 'multi', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'a', label: 'A2' }] } })?.options?.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('reads the task\'s own line and who set it', () => {
    const own = readStatusLine({ line: { text: 'Waits on the review', by: 'self', at: '2026-10-31T08:00:00Z' } })
    expect(own?.text).toBe('Waits on the review')
    expect(lineSetBy(own)).toBeNull()
    expect(lineSetBy(readStatusLine({ line: { text: 'x', by: 'task:abc', byName: 'Walnut VP', at: '' } }))).toBe('set by Walnut VP')
    expect(lineSetBy(readStatusLine({ line: { text: 'x', by: 'human', at: '' } }))).toBe('set by you')
    expect(readStatusLine({ line: { text: '  ', by: 'self' } })).toBeUndefined()
  })
})
