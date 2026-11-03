/**
 * Passwords page model: sections, counts, search, sort and the site tile. Pure, so
 * tests/web/passwords-model.test.ts pins it without a browser.
 */
import type { VaultItemSummary } from '@/api/vault'
import { displayHost } from '../../../../src/core/vault/url-match'

export type PasswordsSection = 'all' | 'favorites' | 'logins' | 'codes' | 'api_keys' | 'notes' | 'cards' | 'security' | 'agents' | 'trash'

export const SECTIONS: Array<{ id: PasswordsSection; label: string }> = [
  { id: 'all', label: 'All Items' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'logins', label: 'Logins' },
  { id: 'codes', label: 'Verification Codes' },
  { id: 'api_keys', label: 'API Keys' },
  { id: 'notes', label: 'Secure Notes' },
  { id: 'cards', label: 'Cards' },
  { id: 'security', label: 'Security' },
  { id: 'agents', label: 'Agent Activity' },
  { id: 'trash', label: 'Recently Deleted' },
]

export const isPasswordsSection = (v: unknown): v is PasswordsSection => SECTIONS.some((s) => s.id === v)

/** Sections that show a view of their own on the right instead of an item. */
export const isViewSection = (s: PasswordsSection): boolean => s === 'security' || s === 'agents'

export type PasswordsSort = 'title' | 'updated' | 'used'
export const isPasswordsSort = (v: unknown): v is PasswordsSort => v === 'title' || v === 'updated' || v === 'used'

export function inSection(i: VaultItemSummary, s: PasswordsSection): boolean {
  if (s === 'trash') return !!i.trashedAt
  if (i.trashedAt) return false
  switch (s) {
    case 'all': case 'security': case 'agents': return true
    case 'favorites': return !!i.favorite
    case 'logins': return i.type === 'login'
    case 'codes': return i.hasTotp
    case 'api_keys': return i.type === 'api_key'
    case 'notes': return i.type === 'note'
    case 'cards': return i.type === 'card'
  }
}

export function sectionCounts(items: VaultItemSummary[]): Record<PasswordsSection, number> {
  const out = Object.fromEntries(SECTIONS.map((s) => [s.id, 0])) as Record<PasswordsSection, number>
  for (const i of items) for (const s of SECTIONS) if (!isViewSection(s.id) && inSection(i, s.id)) out[s.id]++
  return out
}

/** Every word must hit the title, a site, the username or a tag (case and accents folded). */
export function matchesQuery(i: VaultItemSummary, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = fold([i.title, i.username ?? '', ...(i.urls ?? []).map(displayHost), ...(i.tags ?? [])].join(' '))
  return words.every((w) => hay.includes(w))
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

export function sortItems(items: VaultItemSummary[], sort: PasswordsSort): VaultItemSummary[] {
  const by = (k: (i: VaultItemSummary) => string) => [...items].sort((a, b) => k(b).localeCompare(k(a)) || a.title.localeCompare(b.title))
  if (sort === 'updated') return by((i) => i.updatedAt)
  if (sort === 'used') return by((i) => i.usedAt ?? '')
  return [...items].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}

const TILE_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c7cfa', '#495057', '#9c36b5']

/** The letter tile a site shows (no icon is ever fetched from the site). */
export function siteTile(i: { title: string; urls?: string[] }): { letter: string; color: string } {
  const host = i.urls?.[0] ? displayHost(i.urls[0]).replace(/^www\./, '') : ''
  const basis = host || i.title || '?'
  let h = 0
  for (const ch of basis.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const letter = (i.title.trim()[0] ?? host[0] ?? '?').toUpperCase()
  return { letter, color: TILE_COLORS[h % TILE_COLORS.length] }
}

export function typeLabel(t: VaultItemSummary['type']): string {
  return t === 'login' ? 'Login' : t === 'note' ? 'Secure Note' : t === 'card' ? 'Card' : t === 'api_key' ? 'API Key' : 'Identity'
}

/** A short "3 days ago" for a time. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}
