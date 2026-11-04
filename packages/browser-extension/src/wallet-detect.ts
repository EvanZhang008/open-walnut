/**
 * Payment card and address forms: which inputs and selects ask for a card's number, name,
 * expiry and security code, or a person's name, email, phone and address. Read like browsers
 * do: the `autocomplete` token first (cc-number, address-line1 ...), then name / id / label
 * words. A form is a card form with a card number field, an identity form with two or more
 * address fields. Pure DOM reading, and the fill that writes values the way typing would.
 */
import { setValue, usable } from './form-detect'

export type WalletKind = 'card' | 'identity'
/** The parts a card or identity fills; `cc-exp` is month and year in one field. */
export type WalletPart =
  | 'cc-name' | 'cc-number' | 'cc-exp' | 'cc-exp-month' | 'cc-exp-year' | 'cc-csc'
  | 'name' | 'given-name' | 'family-name' | 'email' | 'tel' | 'organization'
  | 'address-line1' | 'address-line2' | 'address-line3' | 'street-address'
  | 'city' | 'region' | 'postal-code' | 'country'

export type WalletField = HTMLInputElement | HTMLSelectElement
export interface WalletGroup { kind: WalletKind; root: Element; fields: Array<{ el: WalletField; part: WalletPart }> }

const CARD_PARTS = new Set<WalletPart>(['cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc'])

const TOKEN: Record<string, WalletPart> = {
  'cc-name': 'cc-name', 'cc-number': 'cc-number', 'cc-exp': 'cc-exp', 'cc-exp-month': 'cc-exp-month', 'cc-exp-year': 'cc-exp-year', 'cc-csc': 'cc-csc',
  name: 'name', 'given-name': 'given-name', 'family-name': 'family-name', email: 'email', tel: 'tel', 'tel-national': 'tel', organization: 'organization',
  'address-line1': 'address-line1', 'address-line2': 'address-line2', 'address-line3': 'address-line3', 'street-address': 'street-address',
  'address-level2': 'city', 'address-level1': 'region', 'postal-code': 'postal-code', country: 'country', 'country-name': 'country',
}

/** Words in a field's name, id, placeholder or label, in order: the first that fits wins. */
const WORDS: Array<[RegExp, WalletPart]> = [
  [/card.?number|cc.?num|cardnum|credit.?card|\bpan\b/i, 'cc-number'],
  [/cvv|cvc|csc|security.?code|card.?code|card.?verification/i, 'cc-csc'],
  // "MM / YY" in one field before a month or a year alone.
  [/mm\s*\/\s*y{2,4}|valid.?thru/i, 'cc-exp'],
  [/exp.{0,8}(month|mm\b)|card.?month|cc.?month/i, 'cc-exp-month'],
  [/exp.{0,8}(year|yy)|card.?year|cc.?year/i, 'cc-exp-year'],
  [/expir|\bexp\b/i, 'cc-exp'],
  [/name.?on.?card|card.?holder|cardholder|cc.?name/i, 'cc-name'],
  [/first.?name|given.?name|\bfname\b/i, 'given-name'],
  [/last.?name|family.?name|surname|\blname\b/i, 'family-name'],
  [/full.?name|^name$|your.?name/i, 'name'],
  [/e-?mail/i, 'email'],
  [/phone|mobile|\btel\b/i, 'tel'],
  [/company|organi[sz]ation/i, 'organization'],
  [/address.?(line)?.?2|apt|suite|unit\b/i, 'address-line2'],
  [/address.?(line)?.?1|street|address/i, 'address-line1'],
  [/city|town|locality/i, 'city'],
  [/state|province|region|county/i, 'region'],
  [/zip|postal|post.?code|postcode/i, 'postal-code'],
  [/country/i, 'country'],
]

function wordsOf(el: WalletField): string {
  const label = el.labels?.[0]?.textContent ?? ''
  return [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), label].filter(Boolean).join(' ')
}

/** What one field asks for, or null. */
export function partOf(el: WalletField): WalletPart | null {
  const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  // The last token is the field name ("shipping address-line1", "section-x cc-number").
  for (let i = tokens.length - 1; i >= 0; i--) if (TOKEN[tokens[i]]) return TOKEN[tokens[i]]
  // Another token the page meant (username, one-time-code ...): not a card or address field.
  if (tokens.some((t) => !/^(section-.*|shipping|billing|home|work|mobile|on|off)$/.test(t))) return null
  if (el instanceof HTMLInputElement && (el.type === 'password' || el.type === 'search' || el.type === 'hidden')) return null
  const w = wordsOf(el)
  if (!w) return null
  if (/search|coupon|promo|captcha|user.?name|login|password/i.test(w)) return null
  for (const [re, part] of WORDS) if (re.test(w)) return part
  return null
}

function usableField(el: WalletField): boolean {
  if (el instanceof HTMLInputElement) return usable(el)
  if (el.disabled) return false
  const r = el.getBoundingClientRect()
  return r.width >= 8 && r.height >= 8
}

/** Card and identity groups on a page: one per form (or the whole page when there is no form). */
export function findWalletGroups(doc: Document): WalletGroup[] {
  const els = Array.from(doc.querySelectorAll<WalletField>('input, select')).filter(usableField)
  const byRoot = new Map<Element, Array<{ el: WalletField; part: WalletPart }>>()
  for (const el of els) {
    const part = partOf(el)
    if (!part) continue
    const root = el.form ?? doc.body
    byRoot.set(root, [...(byRoot.get(root) ?? []), { el, part }])
  }
  const out: WalletGroup[] = []
  for (const [root, fields] of byRoot) {
    const card = fields.filter((f) => CARD_PARTS.has(f.part))
    const who = fields.filter((f) => !CARD_PARTS.has(f.part))
    if (card.some((f) => f.part === 'cc-number')) out.push({ kind: 'card', root, fields: card })
    // An address form asks for more than one thing (an email box alone is a sign in or a newsletter).
    const addressy = who.filter((f) => f.part !== 'email' && f.part !== 'name')
    if (who.length >= 2 && addressy.length >= 1) out.push({ kind: 'identity', root, fields: who })
  }
  return out
}

export function walletGroupOf(groups: WalletGroup[], el: Element): WalletGroup | null {
  return groups.find((g) => g.fields.some((f) => f.el === el)) ?? null
}

/** A select set to the option whose value or text fits: "03", "3", "March", "Mar", "US", "United States". */
function pickOption(sel: HTMLSelectElement, value: string, part: WalletPart): boolean {
  const v = value.trim().toLowerCase()
  if (!v) return false
  const n = Number(v)
  const options = Array.from(sel.options)
  const fits = (o: HTMLOptionElement) => {
    const ov = o.value.trim().toLowerCase()
    const ot = o.text.trim().toLowerCase()
    if (ov === v || ot === v) return true
    if ((part === 'cc-exp-month' || part === 'cc-exp-year') && Number.isFinite(n)) {
      const on = Number(ov || ot)
      if (on === n || (part === 'cc-exp-year' && on % 100 === n % 100 && on >= 0)) return true
      if (part === 'cc-exp-month' && ot.slice(0, 3) === new Date(2000, n - 1, 1).toLocaleString('en', { month: 'short' }).toLowerCase()) return true
    }
    return part === 'country' && v.length > 2 && ot.startsWith(v)
  }
  const hit = options.find(fits)
  if (!hit) return false
  sel.focus()
  sel.value = hit.value
  sel.dispatchEvent(new Event('input', { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

/** The value an item has for one field of a form, shaped the way that field asks for it. */
function valueFor(el: WalletField, part: WalletPart, values: Partial<Record<WalletPart, string>>): string | undefined {
  let v = values[part]
  // A field that takes month and year as "MM/YY", sized by what it allows.
  if (part === 'cc-exp' && !v && values['cc-exp-month'] && values['cc-exp-year']) {
    const mm = values['cc-exp-month'].padStart(2, '0')
    // "MM/YY", the way card forms ask for it; "MM/YYYY" only where the field says it is that long.
    const yy = values['cc-exp-year']
    v = `${mm}/${el instanceof HTMLInputElement && el.maxLength >= 7 && /yyyy/i.test(el.placeholder) ? yy : yy.slice(-2)}`
  }
  if (part === 'cc-exp-year' && v && el instanceof HTMLInputElement && el.maxLength === 2) v = v.slice(-2)
  if (part === 'cc-exp-month' && v && el instanceof HTMLInputElement) v = v.padStart(2, '0')
  return v || undefined
}

/**
 * Fill a group from part values: a field the item has nothing for stays as it is. `filled` counts
 * the fields that hold the item's value now (one that already did counts); `missing` names the
 * parts the form asks for that the item has no value for, or a list with no option that fits.
 */
export function fillWallet(g: WalletGroup, values: Partial<Record<WalletPart, string>>): { filled: number; missing: WalletPart[] } {
  let filled = 0
  const missing: WalletPart[] = []
  for (const { el, part } of g.fields) {
    const v = valueFor(el, part, values)
    if (!v) { missing.push(part); continue }
    if (el instanceof HTMLSelectElement) { if (pickOption(el, v, part)) filled++; else missing.push(part) }
    else { if (el.value !== v) setValue(el, v); filled++ }
  }
  return { filled, missing }
}

const PART_WORDS: Record<WalletPart, string> = {
  'cc-name': 'name on card', 'cc-number': 'card number', 'cc-exp': 'expiry date', 'cc-exp-month': 'expiry date', 'cc-exp-year': 'expiry date', 'cc-csc': 'security code',
  name: 'name', 'given-name': 'name', 'family-name': 'name', email: 'email', tel: 'phone', organization: 'company',
  'address-line1': 'address', 'address-line2': 'address line 2', 'address-line3': 'address line 3', 'street-address': 'address',
  city: 'city', region: 'state or region', 'postal-code': 'ZIP or postal code', country: 'country',
}

const OPTIONAL = new Set<WalletPart>(['address-line2', 'address-line3', 'organization'])

/**
 * What a person reads after a card or address fill that left fields empty: what was filled, and
 * what this item has no value for. Nothing when every field got its value.
 */
export function fillNote(kind: WalletKind, r: { filled: number; missing: WalletPart[] }): string {
  // Parts most people leave empty (a second address line, a company) are not worth a note.
  const lacking = [...new Set(r.missing.filter((p) => !OPTIONAL.has(p)).map((p) => PART_WORDS[p]))]
  if (!lacking.length) return ''
  const what = kind === 'card' ? 'This card' : 'This identity'
  const list = lacking.length > 1 ? `${lacking.slice(0, -1).join(', ')} or ${lacking[lacking.length - 1]}` : lacking[0]
  return r.filled ? `Filled ${r.filled} ${r.filled === 1 ? 'field' : 'fields'}. ${what} has no ${list} saved in Walnut.`
    : `Nothing filled: ${what.toLowerCase()} has no ${list} saved in Walnut.`
}
