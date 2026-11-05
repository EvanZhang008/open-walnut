/**
 * Import from other password managers. Pure: text in, items out, plus a report of
 * what was skipped and why. The store runs a dry run first and adds only on confirm.
 *
 * Formats (column names as each product exports them):
 *  - Bitwarden JSON (unencrypted): logins (URIs, TOTP, custom fields, passkeys kept),
 *    notes, cards, identities (as custom fields); folders become tags; `reprompt` becomes
 *    sensitive. parseBitwardenExport keeps each item's Bitwarden id (sources/bitwarden/sync.ts).
 *  - Bitwarden CSV: folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
 *  - 1Password CSV: Title,Website,Username,Password,One-time password,Favorite,Archived,Tags,Notes
 *  - Apple Passwords CSV: Title,URL,Username,Password,Notes,OTPAuth
 *  - Chrome CSV: name,url,username,password,note
 *  - Firefox CSV: url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged
 */
import type { VaultField, VaultItemInput } from './types.js'
import { normalizeUrl, displayHost } from './url-match.js'

export type ImportFormat = 'bitwarden_json' | 'bitwarden_csv' | '1password_csv' | 'apple_csv' | 'chrome_csv' | 'firefox_csv'

export const IMPORT_FORMATS: Record<ImportFormat, string> = {
  bitwarden_json: 'Bitwarden (.json)',
  bitwarden_csv: 'Bitwarden (.csv)',
  '1password_csv': '1Password (.csv)',
  apple_csv: 'Apple Passwords (.csv)',
  chrome_csv: 'Chrome (.csv)',
  firefox_csv: 'Firefox (.csv)',
}

export interface ImportResult {
  format: ImportFormat
  items: VaultItemInput[]
  skipped: Array<{ row: number; title?: string; reason: string }>
  passkeys: number
  /** Bitwarden JSON: each item's own id and revision, beside `items` (same order), for a later sync to adopt. */
  sources?: Array<{ id?: string; revisionDate?: string }>
}

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError' }
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const t = text.replace(/^﻿/, '')
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') { quoted = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      continue
    }
    field += c
  }
  if (quoted) throw new ImportError('The file ends inside a quoted field')
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function header(rows: string[][]): Map<string, number> {
  const m = new Map<string, number>()
  ;(rows[0] ?? []).forEach((h, i) => m.set(h.trim().toLowerCase(), i))
  return m
}

const has = (h: Map<string, number>, ...names: string[]) => names.every((n) => h.has(n))

export function detectFormat(text: string, fileName = ''): ImportFormat | null {
  const t = text.trimStart()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { items?: unknown; encrypted?: unknown }
      if (Array.isArray(j.items)) return 'bitwarden_json'
    } catch { /* not JSON */ }
    return null
  }
  let rows: string[][]
  try { rows = parseCsv(t.split(/\r?\n/, 1)[0] + '\n') } catch { return null }
  const h = header(rows)
  if (has(h, 'login_uri', 'login_username', 'login_password')) return 'bitwarden_csv'
  if (has(h, 'title', 'website', 'username', 'password')) return '1password_csv'
  if (has(h, 'title', 'url', 'username', 'password', 'otpauth')) return 'apple_csv'
  if (has(h, 'url', 'username', 'password', 'httprealm')) return 'firefox_csv'
  if (has(h, 'name', 'url', 'username', 'password')) return 'chrome_csv'
  if (has(h, 'title', 'url', 'username', 'password')) return 'apple_csv'
  void fileName
  return null
}

function clean(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined
  const t = s.trim()
  return t ? t : undefined
}

function urls(...raw: Array<string | undefined>): string[] | undefined {
  const out = [...new Set(raw.flatMap((r) => (r ?? '').split(/[\n,]\s*/)).map(normalizeUrl).filter(Boolean))]
  return out.length ? out : undefined
}

function titleFor(title: string | undefined, url: string[] | undefined, username: string | undefined): string {
  return title || (url?.[0] ? displayHost(url[0]) : undefined) || username || 'Untitled'
}

function login(p: { title?: string; username?: string; password?: string; url?: string[]; totp?: string; notes?: string; favorite?: boolean; tags?: string[]; fields?: VaultField[]; sensitive?: boolean }): VaultItemInput {
  return {
    type: 'login',
    title: titleFor(p.title, p.url, p.username).slice(0, 200),
    ...(p.username ? { username: p.username } : {}),
    ...(p.password ? { password: p.password } : {}),
    ...(p.url ? { urls: p.url } : {}),
    ...(p.totp ? { totp: p.totp } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
    ...(p.favorite ? { favorite: true } : {}),
    ...(p.tags?.length ? { tags: p.tags } : {}),
    ...(p.fields?.length ? { fields: p.fields } : {}),
    ...(p.sensitive ? { sensitive: true } : {}),
  }
}

function csvRows(text: string): { h: Map<string, number>; rows: string[][] } {
  const all = parseCsv(text)
  if (!all.length) throw new ImportError('The file is empty')
  return { h: header(all), rows: all.slice(1) }
}

function col(h: Map<string, number>, row: string[], name: string): string | undefined {
  const i = h.get(name)
  return i === undefined ? undefined : clean(row[i])
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes)$/i.test(v)

function fromCsv(format: Exclude<ImportFormat, 'bitwarden_json'>, text: string): ImportResult {
  const { h, rows } = csvRows(text)
  const items: VaultItemInput[] = []
  const skipped: ImportResult['skipped'] = []
  rows.forEach((row, idx) => {
    const n = idx + 2
    const c = (name: string) => col(h, row, name)
    let item: VaultItemInput | null = null
    if (format === 'bitwarden_csv') {
      const type = c('type') ?? 'login'
      const tags = c('folder') ? [c('folder')!] : undefined
      if (type === 'note') {
        item = { type: 'note', title: c('name') ?? 'Untitled note', ...(c('notes') ? { notes: c('notes') } : {}), ...(tags ? { tags } : {}), ...(truthy(c('favorite')) ? { favorite: true } : {}) }
      } else if (type === 'login') {
        const fields = (c('fields') ?? '').split('\n').map((l) => l.match(/^([^:]+):\s?(.*)$/)).filter(Boolean)
          .map((m) => ({ name: m![1].trim(), value: m![2] }))
        item = login({ title: c('name'), username: c('login_username'), password: c('login_password'), url: urls(c('login_uri')), totp: c('login_totp'), notes: c('notes'), favorite: truthy(c('favorite')), tags, fields, sensitive: c('reprompt') === '1' })
      } else {
        skipped.push({ row: n, title: c('name'), reason: `type "${type}" is not in a Bitwarden CSV export; use the JSON export` })
        return
      }
    } else if (format === '1password_csv') {
      if (truthy(c('archived'))) { skipped.push({ row: n, title: c('title'), reason: 'archived in 1Password' }); return }
      const tags = (c('tags') ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean)
      item = login({ title: c('title'), username: c('username'), password: c('password'), url: urls(c('website') ?? c('url')), totp: c('one-time password') ?? c('otpauth'), notes: c('notes'), favorite: truthy(c('favorite')), tags })
    } else if (format === 'apple_csv') {
      item = login({ title: c('title'), username: c('username'), password: c('password'), url: urls(c('url')), totp: c('otpauth'), notes: c('notes') })
    } else if (format === 'chrome_csv') {
      item = login({ title: c('name'), username: c('username'), password: c('password'), url: urls(c('url')), notes: c('note') })
    } else {
      item = login({ username: c('username'), password: c('password'), url: urls(c('url')) })
    }
    if (item.type === 'login' && !item.password && !item.username && !item.totp) {
      skipped.push({ row: n, title: item.title, reason: 'no username, password or one-time code' })
      return
    }
    items.push(item)
  })
  return { format, items, skipped, passkeys: 0 }
}

interface BwField { name?: string; value?: string; type?: number }
interface BwItem {
  id?: string; revisionDate?: string
  type?: number; name?: string; notes?: string; favorite?: boolean; folderId?: string | null; reprompt?: number
  fields?: BwField[]
  login?: { uris?: Array<{ uri?: string }>; username?: string; password?: string; totp?: string; fido2Credentials?: Array<Record<string, unknown>> }
  card?: { cardholderName?: string; brand?: string; number?: string; expMonth?: string; expYear?: string; code?: string }
  identity?: Record<string, string | null | undefined>
}

/** One item of a Bitwarden JSON export: its own id and revision (sync uses them), and what Walnut makes of it. */
export interface BitwardenEntry {
  row: number
  /** Bitwarden's item id (absent in a hand-made file). */
  id?: string
  revisionDate?: string
  title?: string
  item?: VaultItemInput
  /** Why it was not taken (an SSH key, an unknown type). */
  skip?: string
  passkeys: number
}

/** The identity fields Bitwarden exports, as Walnut custom fields, in this order. */
const IDENTITY_FIELDS: Array<[string, string]> = [
  ['title', 'Title'], ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'],
  ['username', 'Username'], ['company', 'Company'], ['email', 'Email'], ['phone', 'Phone'],
  ['address1', 'Address 1'], ['address2', 'Address 2'], ['address3', 'Address 3'], ['city', 'City'], ['state', 'State'],
  ['postalCode', 'Postal code'], ['country', 'Country'], ['ssn', 'Social security number'], ['passportNumber', 'Passport number'], ['licenseNumber', 'License number'],
]
const IDENTITY_HIDDEN = new Set(['ssn', 'passportNumber', 'licenseNumber'])

/** Parse an unencrypted Bitwarden JSON export into one entry per item (import and sync share it). */
export function parseBitwardenExport(text: string): BitwardenEntry[] {
  let j: { encrypted?: boolean; folders?: Array<{ id: string; name: string }>; items?: BwItem[] }
  try { j = JSON.parse(text) } catch { throw new ImportError('The file is not valid JSON') }
  if (!j || typeof j !== 'object') throw new ImportError('The file is not a Bitwarden export')
  if (j.encrypted) throw new ImportError('This is an encrypted Bitwarden export. Export again with "File format: .json" (not encrypted), import it, then delete the file.')
  if (!Array.isArray(j.items)) throw new ImportError('The file is not a Bitwarden export (no items)')
  const folders = new Map((j.folders ?? []).map((f) => [f.id, f.name]))
  return j.items.map((it, idx): BitwardenEntry => {
    const row = idx + 1
    const meta = { row, ...(typeof it?.id === 'string' && it.id ? { id: it.id } : {}), ...(typeof it?.revisionDate === 'string' ? { revisionDate: it.revisionDate } : {}), title: clean(it?.name) }
    if (!it || typeof it !== 'object') return { ...meta, skip: 'not an item', passkeys: 0 }
    const tags = it.folderId && folders.get(it.folderId) ? [folders.get(it.folderId)!] : undefined
    const fields = (it.fields ?? []).filter((f) => f.name && f.type !== 3).map((f) => ({ name: f.name!, value: f.value ?? '', ...(f.type === 1 ? { hidden: true } : {}) }))
    const base = { ...(clean(it.notes) ? { notes: it.notes!.trim() } : {}), ...(it.favorite ? { favorite: true } : {}), ...(tags ? { tags } : {}), ...(fields.length ? { fields } : {}), ...(it.reprompt === 1 ? { sensitive: true } : {}) }
    if (it.type === 1) {
      const l = it.login ?? {}
      const item = login({ title: clean(it.name), username: clean(l.username), password: l.password ?? undefined, url: urls(...(l.uris ?? []).map((u) => u.uri)), totp: clean(l.totp) })
      const pk = (l.fido2Credentials ?? []).filter((c) => c && typeof c === 'object')
      return { ...meta, item: { ...item, ...base, ...(pk.length ? { passkeys: pk } : {}) }, passkeys: pk.length }
    }
    if (it.type === 2) return { ...meta, item: { type: 'note', title: clean(it.name) ?? 'Untitled note', ...base }, passkeys: 0 }
    if (it.type === 3) {
      const c = it.card ?? {}
      return { ...meta, item: { type: 'card', title: clean(it.name) ?? 'Card', card: { holder: clean(c.cardholderName), brand: clean(c.brand), number: clean(c.number), expMonth: clean(c.expMonth), expYear: clean(c.expYear), code: clean(c.code) }, ...base }, passkeys: 0 }
    }
    if (it.type === 4) {
      const id = it.identity ?? {}
      const own = IDENTITY_FIELDS.map(([k, label]) => ({ name: label, value: clean(id[k] ?? undefined) ?? '', ...(IDENTITY_HIDDEN.has(k) ? { hidden: true } : {}) })).filter((f) => f.value)
      const all = [...own, ...(base.fields ?? [])]
      return { ...meta, item: { type: 'identity', title: clean(it.name) ?? 'Identity', ...base, ...(all.length ? { fields: all } : {}) }, passkeys: 0 }
    }
    return { ...meta, skip: it.type === 5 ? 'SSH keys come in a later version' : `unknown item type ${it.type}`, passkeys: 0 }
  })
}

function fromBitwardenJson(text: string): ImportResult {
  const entries = parseBitwardenExport(text)
  const items: VaultItemInput[] = []
  const skipped: ImportResult['skipped'] = []
  let passkeys = 0
  const sources: Array<{ id?: string; revisionDate?: string }> = []
  for (const e of entries) {
    if (e.item) { items.push(e.item); sources.push({ ...(e.id ? { id: e.id } : {}), ...(e.revisionDate ? { revisionDate: e.revisionDate } : {}) }); passkeys += e.passkeys }
    else skipped.push({ row: e.row, title: e.title, reason: e.skip ?? 'skipped' })
  }
  return { format: 'bitwarden_json', items, skipped, passkeys, sources }
}

export function parseImport(text: string, format?: ImportFormat, fileName?: string): ImportResult {
  const f = format ?? detectFormat(text, fileName)
  if (!f) throw new ImportError('Walnut cannot tell which app this file came from. Pick the format.')
  return f === 'bitwarden_json' ? fromBitwardenJson(text) : fromCsv(f, text)
}
