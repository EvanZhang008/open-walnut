/**
 * Which of the user's kinds a close hold is (src/core/sessions/owed-kind.ts; 2026-11-19: a lead could
 * answer a held spend or delete for the user with no words of his, since a hold carried no kind).
 * Chinese test data is written as \u escapes; each line says what it means.
 */
import { describe, expect, it } from 'vitest'
import { holdKind, holdNeedsUsersWords, keptHoldKind, kindFromWords, newHoldKind } from '../../src/core/sessions/owed-kind.js'
import { APPROVAL_KINDS } from '../../src/core/approval-kinds.js'

describe('the words that name a kind only the user decides', () => {
  it('names each approval kind in English and Chinese', () => {
    const cases: Array<[string, string]> = [
      ['Who deletes the DNS record?', 'cloud_delete'],
      ['谁来删 DNS 记录？', 'cloud_delete'], // "Who deletes the DNS record?"
      ['Pay the $45 invoice?', 'spending'],
      ['要不要续费？', 'spending'], // "Renew the subscription?"
      ['Rotate the API key?', 'credentials'],
      ['Grant the bot admin access?', 'permissions'],
      ['Send the reply to the vendor?', 'outward'],
      ['要不要回复他？', 'outward'], // "Reply to him?"
      ['This step cannot be undone: go?', 'irreversible'],
      // Other forms of the same words (2026-11-19 review: fixed endings missed them).
      ['Removed staging already?', 'cloud_delete'],
      ['Order the 2 replacement drives?', 'spending'],
      ['Rotate the API keys?', 'credentials'],
      ['Update the passwords?', 'credentials'],
      ['Granted the bot write?', 'permissions'],
      ['Merge the PR upstream?', 'outward'],
      ['Posted the notes yet?', 'outward'],
    ]
    for (const [text, kind] of cases) expect(kindFromWords(text), text).toBe(kind)
    // Every approval kind has words (a new approval kind with none fails here).
    expect(new Set(cases.map(([, k]) => k))).toEqual(new Set(APPROVAL_KINDS))
  })

  it('names none for a plain choice', () => {
    for (const t of ['Which of the two zone lists is final?', 'Keep the name or rename it?', '选哪个方案？']) {
      expect(kindFromWords(t), t).toBeNull()
    }
  })
})

describe('a hold\'s kind', () => {
  it('a new hold: its own ask\'s kind first, else its words, else none, always with why', () => {
    expect(newHoldKind(['Ship it?'], { ask: 'Ship it?', kind: 'outward' })).toMatchObject({ kind: 'outward' })
    expect(newHoldKind(['[WAIT] You: pay the invoice'])).toMatchObject({ kind: 'spending' })
    // Another kind of his on its own ask never hides an item that names one only he approves.
    expect(newHoldKind(['Which card?', 'Pay the $300 invoice'], { ask: 'Which card?', kind: 'user_own' })).toMatchObject({ kind: 'spending' })
    expect(newHoldKind(['Which card?'], { ask: 'Which card?', kind: 'user_own' })).toMatchObject({ kind: 'user_own' })
    const none = newHoldKind(['[WAIT] You: pick the final list'])
    expect(none.kind).toBe('none')
    expect(none.why.length).toBeGreaterThan(10)
  })

  it('an older hold with no kind reads it from its words once, and is unknown when they name none', () => {
    expect(holdKind({ items: ['Delete the old bucket?'], ask: 'Delete the old bucket?' })).toBe('cloud_delete')
    expect(holdKind({ items: ['Pick the final list'], ask: 'Pick the final list' })).toBe('unknown')
    expect(holdKind({ items: ['Pick the final list'], ask: 'x', kind: 'none' })).toBe('none')
  })

  it('a hold written again keeps its kind, unless a kind only he approves is found now', () => {
    expect(keptHoldKind({ kind: 'none', kind_why: 'x' }, { kind: 'spending', why: 'y' })).toEqual({ kind: 'spending', kind_why: 'y' })
    expect(keptHoldKind({ kind: 'spending', kind_why: 'x' }, { kind: 'none', why: 'y' })).toEqual({ kind: 'spending', kind_why: 'x' })
    expect(keptHoldKind({}, { kind: 'none', why: 'y' })).toEqual({ kind: 'none', kind_why: 'y' })
  })

  it('needs his words for an approval kind or unknown, not for none or a fact only he has', () => {
    expect(holdNeedsUsersWords({ items: ['Pay it?'], ask: 'Pay it?' }, false)).toBe(true)
    expect(holdNeedsUsersWords({ items: ['Pick one'], ask: 'Pick one' }, false)).toBe(true)
    expect(holdNeedsUsersWords({ items: ['Pick one'], ask: 'Pick one', kind: 'none' }, false)).toBe(false)
    expect(holdNeedsUsersWords({ items: ['x'], ask: 'x', kind: 'user_info' }, false)).toBe(false)
  })
})
