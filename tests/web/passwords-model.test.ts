/** The Passwords page model (web/src/components/passwords/passwords-model.ts). */
import { describe, it, expect } from 'vitest'
import { inSection, matchesQuery, sectionCounts, siteTile, sortItems, SECTIONS } from '../../web/src/components/passwords/passwords-model'
import type { VaultItemSummary } from '../../src/core/vault/types'

const at = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString()
const item = (p: Partial<VaultItemSummary> & { id: string; title: string }): VaultItemSummary => ({
  type: 'login', hasPassword: true, hasTotp: false, agentAccess: 'ask', createdAt: at(1), updatedAt: at(1), ...p,
})

const items = [
  item({ id: 'a', title: 'GitHub', username: 'alice', urls: ['https://github.com'], favorite: true, hasTotp: true, updatedAt: at(5) }),
  item({ id: 'b', title: 'Café Wi-Fi', type: 'note', hasPassword: false, tags: ['home'], updatedAt: at(9) }),
  item({ id: 'c', title: 'Stripe', type: 'api_key', usedAt: at(20) }),
  item({ id: 'd', title: 'Old', trashedAt: at(3) }),
  item({ id: 'e', title: 'Visa', type: 'card', hasPassword: false }),
]

describe('passwords model', () => {
  it('puts each item in its sections, and a trashed one only in the trash', () => {
    const c = sectionCounts(items)
    expect(c).toMatchObject({ all: 4, favorites: 1, logins: 1, codes: 1, api_keys: 1, notes: 1, cards: 1, trash: 1 })
    expect(SECTIONS.filter((s) => inSection(items[3], s.id)).map((s) => s.id)).toEqual(['trash'])
  })

  it('searches title, site host, username and tags, folding case and accents', () => {
    expect(items.filter((i) => matchesQuery(i, 'cafe')).map((i) => i.id)).toEqual(['b'])
    expect(items.filter((i) => matchesQuery(i, 'github.com alice')).map((i) => i.id)).toEqual(['a'])
    expect(items.filter((i) => matchesQuery(i, 'HOME')).map((i) => i.id)).toEqual(['b'])
    expect(items.filter((i) => matchesQuery(i, '')).length).toBe(5)
  })

  it('sorts by name, last change or last use', () => {
    expect(sortItems(items, 'title').map((i) => i.id)).toEqual(['b', 'a', 'd', 'c', 'e'])
    expect(sortItems(items, 'updated')[0].id).toBe('b')
    expect(sortItems(items, 'used')[0].id).toBe('c')
  })

  it('gives a stable letter tile per site', () => {
    expect(siteTile(items[0])).toEqual(siteTile({ title: 'GitHub', urls: ['https://github.com/login'] }))
    expect(siteTile(items[0]).letter).toBe('G')
  })
})
