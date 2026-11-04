/**
 * What the popup's detail view of one item shows, made in the background from the opened item.
 * Secrets stay out of it: a password, a one-time code, a card's number and code, and a hidden
 * field are only said to exist, and come one at a time through `secretField` on the person's
 * click (reveal or copy). Everything else an item holds is shown as it is.
 */
import type { VaultItem } from '../../../src/core/vault/types'
import { displayHost } from '../../../src/core/vault/url-match'
import { identityParts } from './bg-wallet'

/** One line of the detail view. `secret` names what to ask for to reveal or copy it. */
export interface DetailField { label: string; value?: string; secret?: string; mono?: boolean; url?: string; multiline?: boolean }
export interface ItemDetail { id: string; type: string; title: string; site?: string; hasTotp: boolean; fields: DetailField[] }

const IDENTITY_LABELS: Array<[string, string]> = [
  ['name', 'Name'], ['email', 'Email'], ['tel', 'Phone'], ['organization', 'Company'], ['street-address', 'Address'],
  ['city', 'City'], ['region', 'State'], ['postal-code', 'ZIP'], ['country', 'Country'],
]

function expiry(month?: string, year?: string): string {
  const m = (month ?? '').trim()
  const y = (year ?? '').trim()
  if (!m && !y) return ''
  return `${m ? m.padStart(2, '0') : '--'}/${y.length === 4 ? y.slice(2) : y || '--'}`
}

/** `raw` without its match rule, when it is an http(s) address; else undefined. */
export function webUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.replace(/#.*$/, ''))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch { return undefined }
}

const digits = (s?: string) => (s ?? '').replace(/\D/g, '')

export function itemDetail(item: VaultItem): ItemDetail {
  const fields: DetailField[] = []
  const add = (f: DetailField) => { if (f.value || f.secret) fields.push(f) }
  if (item.type === 'card') {
    const c = item.card ?? {}
    add({ label: 'Cardholder', value: c.holder })
    if (c.number) add({ label: 'Number', value: digits(c.number).length >= 4 ? `•••• ${digits(c.number).slice(-4)}` : '••••', secret: 'number', mono: true })
    add({ label: 'Expires', value: expiry(c.expMonth, c.expYear), mono: true })
    if (c.code) add({ label: 'Security code', value: '•••', secret: 'code', mono: true })
  } else if (item.type === 'identity') {
    const parts = identityParts(item) as Record<string, string | undefined>
    for (const [part, label] of IDENTITY_LABELS) add({ label, value: parts[part] })
  } else {
    add({ label: item.type === 'api_key' ? 'Name' : 'Username', value: item.username })
    if (item.password) add({ label: item.type === 'api_key' ? 'Key' : 'Password', value: '••••••••', secret: 'password', mono: true })
    if (item.totp) add({ label: 'One-time code', secret: 'totp', mono: true })
    // Only a web address opens; any other (javascript:, file:, an app's scheme) is shown, never opened.
    for (const url of item.urls ?? []) add({ label: 'Website', value: displayHost(url), ...(webUrl(url) ? { url: webUrl(url) } : {}) })
  }
  ;(item.fields ?? []).forEach((f, i) => {
    // An identity's own parts are shown above by name; its other fields follow.
    if (item.type === 'identity' && !f.hidden && Object.keys(identityParts({ ...item, fields: [f] })).length) return
    add(f.hidden ? { label: f.name, value: '••••••••', secret: `field:${i}`, mono: true } : { label: f.name, value: f.value })
  })
  if (item.notes) add({ label: 'Notes', value: item.notes, multiline: true })
  return {
    id: item.id, type: item.type, title: item.title, hasTotp: !!item.totp,
    ...(item.urls?.[0] ? { site: displayHost(item.urls[0]) } : {}),
    fields,
  }
}

/** The one secret `field` names (`password`, `number`, `code`, `field:<n>`), or undefined. */
export function secretField(item: VaultItem, field: string): string | undefined {
  if (field === 'username') return item.username
  if (field === 'password') return item.password
  if (field === 'number') return item.card?.number
  if (field === 'code') return item.card?.code
  const m = /^field:(\d+)$/.exec(field)
  return m ? item.fields?.[Number(m[1])]?.value : undefined
}
