/**
 * A filter rule's `moveTo` and `fromContains` in the rules file: validation (sort-rules-schema.ts),
 * the YAML round trip (sort-rules-file.ts), and what compileRules (sort-classify.ts) hands the
 * mover: `skipInbox: true` plus the folder, and a `fromContains` that matches the sender's address
 * or display name, case-insensitively.
 */
import { describe, expect, it } from 'vitest'
import { compileRules } from '../../src/integrations/mail/sort-classify.js'
import { dumpRulesDoc, parseRulesYaml } from '../../src/integrations/mail/sort-rules-file.js'
import { MOVE_TO_NEEDS_GROUP, THEN_REQUIRED, moveToProblem, validateRulesDoc } from '../../src/integrations/mail/sort-rules-schema.js'
import { folderNameProblem } from '../../src/integrations/mail/folder-name.js'
import type { SortFeatures } from '../../src/integrations/mail/sort-types.js'

const doc = (rules: unknown[], groups: string[] = []) => ({ version: 1, groups, rules })
const errorsOf = (raw: unknown) => {
  const result = validateRulesDoc(raw)
  return result.ok ? [] : result.errors
}

function features(over: Partial<SortFeatures> = {}): SortFeatures {
  return {
    accountId: 'acct-1',
    rfcMessageId: '<m1@ferry-ci.example.invalid>',
    fromAddr: 'ci-bot@ferry-ci.example.invalid',
    fromName: 'Ferry CI',
    subject: '[acme/ferry] Run failed: Build - main (1a2b3c)',
    hasListUnsubscribe: false,
    addressedToMe: 'unknown',
    onlyCc: 'unknown',
    senderKind: 'bulk',
    correspondent: false,
    ...over,
  }
}

describe('moveTo validation', () => {
  it('a moveTo with a real group in then is valid, and the folder is trimmed', () => {
    const result = validateRulesDoc(doc([{ id: 'r-ci', when: { fromContains: 'ci-bot' }, then: 'CI Runs', moveTo: '  Projects/CI Runs  ' }], ['CI Runs']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.rules[0]).toMatchObject({ id: 'r-ci', then: 'CI Runs', moveTo: 'Projects/CI Runs' })
    expect(result.doc.rules[0]!.skipInbox).toBeUndefined()
  })

  it('a group named only in then (not listed in groups) is enough', () => {
    expect(validateRulesDoc(doc([{ when: { subject: 'Run failed' }, then: 'Builds', moveTo: 'Builds' }])).ok).toBe(true)
  })

  it('moveTo with then Important or Not important is refused: the mail needs a group to show in', () => {
    for (const then of ['Important', 'Not important', 'important']) {
      expect(errorsOf(doc([{ id: 'r-1', when: { fromContains: 'x' }, then, moveTo: 'Receipts' }]))).toEqual([
        { index: 0, field: 'moveTo', message: MOVE_TO_NEEDS_GROUP, id: 'r-1' },
      ])
    }
  })

  it('moveTo with no then is refused as a missing then (one error, not two)', () => {
    expect(errorsOf(doc([{ when: { fromContains: 'x' }, moveTo: 'Receipts' }]))).toEqual([
      { index: 0, field: 'then', message: THEN_REQUIRED },
    ])
  })

  it('bad folder names are refused with their own sentence', () => {
    const cases: Array<[unknown, string]> = [
      ['', 'moveTo must name a folder.'],
      ['   ', 'moveTo must name a folder.'],
      [42, 'moveTo must name a folder.'],
      [null, 'moveTo must name a folder.'],
      ['INBOX', 'Mail cannot be filed into the Inbox it leaves.'],
      [' inbox ', 'Mail cannot be filed into the Inbox it leaves.'],
      ['Two\nLines', 'A folder name cannot hold control characters, * or %.'],
      ['Builds*', 'A folder name cannot hold control characters, * or %.'],
      ['[Gmail]/Spam', 'Gmail keeps its own [Gmail] folders; name a folder of your own.'],
      ['Projects//CI', 'A folder name cannot have an empty level (two "/" in a row, or one at an end).'],
      ['Projects/Trash', '"Trash" is a folder your mail server keeps for itself (Trash, Junk, Sent and the like). Name a folder of your own.'],
      ['x'.repeat(201), 'A folder name is at most 200 characters.'],
    ]
    for (const [moveTo, message] of cases) {
      expect(moveToProblem(moveTo), JSON.stringify(moveTo)).toBe(message)
      expect(errorsOf(doc([{ when: { fromContains: 'x' }, then: 'Receipts', moveTo }])), JSON.stringify(moveTo)).toEqual([
        { index: 0, field: 'moveTo', message },
      ])
    }
  })

  it('past the type check, the schema reads the one shared folder rule (folder-name.ts)', () => {
    for (const name of ['Receipts', 'Projects/CI Runs', 'Builds*', 'Half%', '[Gmail]/Spam', 'Sent', 'a//b', 'x'.repeat(200), 'x'.repeat(201), ' Inbox ']) {
      expect(moveToProblem(name), name).toBe(folderNameProblem(name))
    }
  })
})

describe('fromContains validation', () => {
  it('a text up to 320 characters is valid', () => {
    expect(validateRulesDoc(doc([{ when: { fromContains: 'Ferry CI' }, then: 'CI Runs' }])).ok).toBe(true)
    expect(validateRulesDoc(doc([{ when: { fromContains: 'a'.repeat(320) }, then: 'CI Runs' }])).ok).toBe(true)
  })

  it('empty, blank, too long or not a text is refused', () => {
    for (const fromContains of ['', '  ', 'a'.repeat(321), 7, ['ci-bot'], null]) {
      expect(errorsOf(doc([{ when: { fromContains }, then: 'CI Runs' }])), JSON.stringify(fromContains)).toEqual([
        { index: 0, field: 'when.fromContains', message: 'fromContains must be a text (at most 320 characters).' },
      ])
    }
  })
})

describe('round trip through the YAML file', () => {
  it('moveTo and fromContains survive dump, parse and validate unchanged', () => {
    const first = validateRulesDoc(doc([
      { id: 'r-ci', when: { fromContains: 'ci-bot@ferry-ci.example.invalid', subject: '[acme/ferry] Run failed' }, then: 'CI Runs', moveTo: 'Projects/CI Runs', source: 'user', created: '2026-11-09' },
      { id: 'r-keep', when: { from: 'wren@ferry-ci.example.invalid' }, then: 'Important', source: 'user' },
    ], ['CI Runs']))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const text = dumpRulesDoc(first.doc)
    expect(text).toContain('moveTo: Projects/CI Runs')
    expect(text).toContain('fromContains: ci-bot@ferry-ci.example.invalid')
    const again = validateRulesDoc(parseRulesYaml(text))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.doc).toEqual(first.doc)
    expect(again.doc.rules[0]).toMatchObject({ moveTo: 'Projects/CI Runs', when: { fromContains: 'ci-bot@ferry-ci.example.invalid' } })
    expect(again.doc.rules[1]!.moveTo).toBeUndefined()
    // The dump is stable: a second pass writes the same bytes.
    expect(dumpRulesDoc(again.doc)).toBe(text)
  })

  it('a folder name YAML would read as another type stays a text', () => {
    for (const moveTo of ['2026', 'true', 'null', 'Builds: nightly', '#tag']) {
      const first = validateRulesDoc(doc([{ id: 'r-y', when: { fromContains: 'x' }, then: 'Odd', moveTo }]))
      expect(first.ok, moveTo).toBe(true)
      if (!first.ok) continue
      const again = validateRulesDoc(parseRulesYaml(dumpRulesDoc(first.doc)))
      expect(again.ok, moveTo).toBe(true)
      if (again.ok) expect(again.doc.rules[0]!.moveTo, moveTo).toBe(moveTo)
    }
  })
})

describe('compileRules', () => {
  const compiled = (rules: unknown[]) => {
    const result = validateRulesDoc(doc(rules))
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return compileRules(result.doc.rules)
  }

  it('a moveTo rule keeps its mail out of the inbox and names the folder', () => {
    const [rule] = compiled([{ id: 'r-ci', when: { fromContains: 'ci-bot' }, then: 'CI Runs', moveTo: 'Projects/CI Runs' }])
    expect(rule).toMatchObject({ id: 'r-ci', label: 'CI Runs', skipInbox: true, moveTo: 'Projects/CI Runs' })
  })

  it('a plain rule has neither; a skipInbox rule has skipInbox only', () => {
    const [plain, skip] = compiled([
      { id: 'r-a', when: { fromContains: 'a' }, then: 'Alpha' },
      { id: 'r-b', when: { fromContains: 'b' }, then: 'Beta', skipInbox: true },
    ])
    expect(plain!.skipInbox).toBeUndefined()
    expect(plain!.moveTo).toBeUndefined()
    expect(skip!.skipInbox).toBe(true)
    expect(skip!.moveTo).toBeUndefined()
  })

  it('a switched-off moveTo rule is not compiled', () => {
    expect(compiled([{ id: 'r-off', when: { fromContains: 'x' }, then: 'Off', moveTo: 'Off', enabled: false }])).toEqual([])
  })

  it('fromContains matches the address or the display name, case-insensitively', () => {
    const [byAddress] = compiled([{ when: { fromContains: 'CI-BOT@Ferry' }, then: 'CI Runs' }])
    const [byName] = compiled([{ when: { fromContains: ' ferry ci ' }, then: 'CI Runs' }])
    expect(byAddress!.match(features())).toBe(true)
    expect(byName!.match(features())).toBe(true)
    expect(byName!.match(features({ fromAddr: 'other@post.example.invalid', fromName: 'FERRY CI Robot' }))).toBe(true)
    expect(byAddress!.match(features({ fromAddr: 'wren@ferry-ci.example.invalid', fromName: 'Wren Ash' }))).toBe(false)
    expect(byName!.match(features({ fromAddr: 'wren@ferry-ci.example.invalid', fromName: 'Wren Ash' }))).toBe(false)
    // A display-name-only row (empty address) still matches on the name.
    expect(byName!.match(features({ fromAddr: '', fromName: 'Ferry CI' }))).toBe(true)
  })

  it('fromContains and subject together must both hold', () => {
    const [rule] = compiled([{ when: { fromContains: 'ci-bot', subject: 'run FAILED' }, then: 'CI Runs', moveTo: 'CI Runs' }])
    expect(rule!.match(features())).toBe(true)
    expect(rule!.match(features({ subject: '[acme/ferry] Run passed' }))).toBe(false)
    expect(rule!.match(features({ fromAddr: 'wren@ferry-ci.example.invalid', fromName: 'Wren Ash' }))).toBe(false)
  })
})
