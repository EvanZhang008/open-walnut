/**
 * Who sent a mail, in the three ways sorting needs: its kind (spec 5.3), its key (one row per
 * sender in a group view) and a short label a person recognises.
 *
 * Only generic English words live here. This is a public repository, so no word list may name a
 * company, a product or an internal system (the public-repo guard also refuses a few ordinary
 * words that collide with internal names; `invoices` and `payments` stand in for one of them).
 */
import type { SenderKind } from './sort-types.js'

/** 1a: marketing local parts. A trailing `*` is a prefix match. */
const MARKETING_LOCALS = [
  'hello', 'news', 'newsletter*', 'marketing', 'promo*', 'offers', 'deals', 'info', 'digest', 'updates',
]

/** 1b: automated-notice local parts. Any local part containing `noreply` also counts. */
const TRANSACTIONAL_LOCALS = [
  'no-reply', 'noreply', 'no.reply', 'donotreply', 'do-not-reply', 'do_not_reply', 'notifications',
  'notification', 'notify', 'alerts', 'alert', 'mailer-daemon', 'postmaster', 'bounce*', 'issues',
  'tickets', 'invoices', 'payments', 'statements', 'receipts', 'orders', 'calendar', 'invites',
  'security', 'support', 'help', 'service', 'team', 'admin', 'account', 'accounts', 'survey', 'feedback',
]

/** 2: the FIRST label of a domain with at least three labels. */
const MARKETING_SUBDOMAINS = new Set([
  'digital', 'email', 'e', 'em', 'mail', 'mkt', 'news', 'info', 'hello', 'mailer', 'reply', 'bounce',
])
const TRANSACTIONAL_SUBDOMAINS = new Set(['notifications', 'notify', 'alerts'])

/** 4: display-name words, matched as whole words (a plural `s` allowed). */
const BULK_NAME_WORDS = /\b(newsletters?|digests?|offers|deals)\b/i
const TRANSACTIONAL_NAME_WORDS =
  /\b(no reply|noreply|notifications?|alerts?|surveys?|do not reply|automated|system|bots?)\b/i

/** 5: `Last, First` (each side one or two capitalised words). */
const LAST_FIRST = /^\p{Lu}[\p{L}'-]*( \p{Lu}[\p{L}'-]*)?, \p{Lu}[\p{L}'-]*( \p{Lu}[\p{L}'-]*)?$/u

/** 6: `first.last` / `first_last` / `first-m-last`: two or three purely alphabetic segments. */
const FIRST_LAST_LOCAL = /^[a-z]+([._-][a-z]+){1,2}$/i

function wordHit(value: string, words: string[]): boolean {
  const lower = value.toLowerCase()
  return words.some((word) => (word.endsWith('*') ? lower.startsWith(word.slice(0, -1)) : lower === word))
}

export function splitAddress(address: string): { local: string; domain: string } {
  const at = address.lastIndexOf('@')
  if (at < 0) return { local: address.toLowerCase(), domain: '' }
  return { local: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() }
}

export function isMarketingLocal(local: string): boolean {
  return wordHit(local, MARKETING_LOCALS)
}

/**
 * 1b. Also true when one `.`/`_`/`-` segment is a notice word (`calendar-notification`,
 * `orders.alerts` style): a machine local part names its function, a person's names a person.
 */
export function isTransactionalLocal(local: string): boolean {
  if (local.includes('noreply') || wordHit(local, TRANSACTIONAL_LOCALS)) return true
  const segments = local.split(/[._-]+/).filter(Boolean)
  return segments.length > 1 && segments.some((segment) => wordHit(segment, TRANSACTIONAL_LOCALS))
}

/** Whitespace trimmed and collapsed, lowercased: how names are compared everywhere. */
export function normalizeName(name: string | undefined | null): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface SenderKindInput {
  fromAddr: string
  fromName: string
  precedence?: string
  autoSubmitted?: string
  gmailCategory?: 'promotions' | 'social'
}

/** Spec 5.3, first rule that holds wins. */
export function senderKindOf(input: SenderKindInput): SenderKind {
  if (input.gmailCategory === 'promotions') return 'bulk'
  if (input.gmailCategory === 'social') return 'transactional'
  const addr = input.fromAddr.trim().toLowerCase()
  const name = input.fromName.trim().replace(/\s+/g, ' ')
  const { local, domain } = splitAddress(addr)
  if (addr) {
    if (isMarketingLocal(local)) return 'bulk'
    if (isTransactionalLocal(local)) return 'transactional'
    const labels = domain.split('.').filter(Boolean)
    if (labels.length >= 3) {
      if (MARKETING_SUBDOMAINS.has(labels[0]!)) return 'bulk'
      if (TRANSACTIONAL_SUBDOMAINS.has(labels[0]!)) return 'transactional'
    }
  }
  const precedence = (input.precedence ?? '').trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'bulk'
  const auto = (input.autoSubmitted ?? '').trim().toLowerCase()
  if (auto && auto !== 'no') return 'transactional'
  if (!addr && name) {
    if (BULK_NAME_WORDS.test(name)) return 'bulk'
    if (!/\s/.test(name) && name === name.toLowerCase() && /\p{L}/u.test(name)) return 'transactional'
    if (TRANSACTIONAL_NAME_WORDS.test(name)) return 'transactional'
  }
  if (name && LAST_FIRST.test(name)) return 'person'
  if (addr && FIRST_LAST_LOCAL.test(local)) return 'person'
  return 'unknown'
}

// ── key and label ──

/** Lowercased address; else `name:<normalized name>`; else `unknown`. */
export function senderKey(fromAddr: string | undefined | null, fromName: string | undefined | null): string {
  const addr = (fromAddr ?? '').trim().toLowerCase()
  if (addr) return addr
  const name = normalizeName(fromName)
  return name ? `name:${name}` : 'unknown'
}

/** The label of the brand a machine address belongs to: its first non-generic domain label. */
function brandOf(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  const body = labels.length > 2 ? labels.slice(0, -2) : labels.slice(0, 1)
  const brand = body.find((label) => !MARKETING_SUBDOMAINS.has(label) && !TRANSACTIONAL_SUBDOMAINS.has(label))
  return brand ?? labels[0] ?? domain
}

/**
 * A short name for one sender: the display name when there is one, `review (no-reply)` for a
 * machine address (brand, then the local part), else the address.
 */
export function senderLabel(fromAddr: string | undefined | null, fromName: string | undefined | null): string {
  const addr = (fromAddr ?? '').trim().toLowerCase()
  const name = (fromName ?? '').trim().replace(/\s+/g, ' ')
  if (name && name.toLowerCase() !== addr) return name
  if (!addr) return 'Unknown sender'
  const { local, domain } = splitAddress(addr)
  if (domain && (isTransactionalLocal(local) || isMarketingLocal(local))) return `${brandOf(domain)} (${local})`
  return addr
}

/**
 * Two senders in one list with the same label get ` · <domain>` so a person can tell them apart
 * (two `Support` desks from different companies). Returns labels in input order.
 */
export function disambiguateLabels(items: ReadonlyArray<{ label: string; key: string }>): string[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.label.toLowerCase(), (counts.get(item.label.toLowerCase()) ?? 0) + 1)
  return items.map((item) => {
    if ((counts.get(item.label.toLowerCase()) ?? 0) < 2) return item.label
    const domain = item.key.includes('@') ? splitAddress(item.key).domain : ''
    return domain ? `${item.label} · ${domain}` : item.label
  })
}
