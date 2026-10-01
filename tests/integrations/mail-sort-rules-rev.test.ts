/**
 * `rulesRev` hashes ONLY what changes a verdict (C64): the built-in revision, the enabled rules'
 * `when` and resolved target group in order, and each account's identity. Group order, notes, ids, dates,
 * labels and disabled rules do not move it, so reordering or re-saving never triggers a re-sort and
 * never turns an already drawn `Mark N read` into a 409.
 */
import { describe, expect, it } from 'vitest'
import { groupIdForName } from '../../src/integrations/mail/sort-classify.js'
import { computeRulesRev } from '../../src/integrations/mail/sort-engine.js'
import { identityOf, type AccountIdentity } from '../../src/integrations/mail/sort-features.js'
import type { Rule } from '../../src/integrations/mail/sort-types.js'

const people = new Map<string, AccountIdentity>([
  ['imap:marina', identityOf({ address: 'robin@marina.example.invalid', displayName: 'Harbour, Robin' }, true)],
  ['outlook:ferry', identityOf({ address: '', displayName: 'Harbour, Robin' }, false)],
])

const base: Rule[] = [
  { id: 'r-111111', when: { from: ['issues@*'] }, then: 'On-call & tickets', source: 'learned', note: 'Pages', created: '2026-09-28' },
  { id: 'r-222222', when: { from: 'payroll', account: 'outlook:ferry' }, then: 'Notifications', source: 'user' },
]

const rev = (rules: Rule[], ids: Map<string, AccountIdentity> = people) => computeRulesRev(rules, ids)

describe('rulesRev', () => {
  it('is 12 hex characters and stable', () => {
    expect(rev(base)).toMatch(/^[0-9a-f]{12}$/)
    expect(rev(base)).toBe(rev(structuredClone(base)))
  })
  it('ignores note, id, created, label and source', () => {
    const edited = base.map((rule, index) => ({
      ...rule, id: `r-99999${index}`, note: 'something else', created: '2027-01-01', label: 'x', source: 'user' as const,
    }))
    expect(rev(edited)).toBe(rev(base))
  })
  it('ignores disabled rules entirely', () => {
    const withDisabled: Rule[] = [...base, { when: { from: 'x@*' }, then: 'Important', source: 'user', enabled: false }]
    expect(rev(withDisabled)).toBe(rev(base))
  })
  it('treats two spellings of the same group as the same target', () => {
    const respelled = base.map((rule) => ({ ...rule, then: rule.then === 'Notifications' ? 'notifications' : rule.then }))
    expect(rev(respelled)).toBe(rev(base))
  })
  it('resolves targets the way the rules do: a renamed group\'s new name is that group', () => {
    const renamed = (name: string) => (name === 'CI runs' ? 'u:build-results' : groupIdForName(name))
    const byOldName: Rule[] = [{ ...base[0]!, then: 'Build results' }, base[1]!]
    const byNewName: Rule[] = [{ ...base[0]!, then: 'CI runs' }, base[1]!]
    expect(computeRulesRev(byNewName, people, renamed)).toBe(rev(byOldName))
    expect(rev(byNewName)).not.toBe(rev(byOldName))
  })
  it('changes when a condition, a target or the order changes', () => {
    expect(rev([{ ...base[0]!, when: { from: ['issues@*', 'tickets@*'] } }, base[1]!])).not.toBe(rev(base))
    expect(rev([{ ...base[0]!, then: 'Important' }, base[1]!])).not.toBe(rev(base))
    expect(rev([base[1]!, base[0]!])).not.toBe(rev(base))
    expect(rev([base[0]!])).not.toBe(rev(base))
  })
  it('changes when an account identity changes', () => {
    const renamed = new Map(people)
    renamed.set('outlook:ferry', identityOf({ address: '', displayName: 'Harbour, R.' }, false))
    expect(rev(base, renamed)).not.toBe(rev(base))
  })
})
