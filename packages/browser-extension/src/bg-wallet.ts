/**
 * What a card or identity item fills, by form part (wallet-detect.ts). A card keeps its fields
 * in `card`; an identity's live in its custom fields by name ("First name", "Email", "Address
 * 1", "ZIP" ...), or in an `identity` object when Walnut stores one.
 */
import type { VaultItem } from '../../../src/core/vault/types'
import type { WalletPart } from './wallet-detect'

type Values = Partial<Record<WalletPart, string>>

/** Field names an identity may use, squashed (lower case, letters and digits only). */
const NAMES: Array<[WalletPart, string[]]> = [
  ['given-name', ['firstname', 'givenname', 'first']],
  ['family-name', ['lastname', 'familyname', 'surname', 'last']],
  ['name', ['name', 'fullname']],
  ['email', ['email', 'emailaddress', 'mail']],
  ['tel', ['phone', 'phonenumber', 'tel', 'telephone', 'mobile']],
  ['organization', ['company', 'organization', 'organisation']],
  ['address-line1', ['address1', 'addressline1', 'address', 'street', 'streetaddress']],
  ['address-line2', ['address2', 'addressline2', 'apt', 'suite']],
  ['address-line3', ['address3', 'addressline3']],
  ['city', ['city', 'town', 'locality']],
  ['region', ['state', 'region', 'province', 'county']],
  ['postal-code', ['postalcode', 'zip', 'zipcode', 'postcode']],
  ['country', ['country']],
]
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The identity parts of an item, read from its custom fields and an `identity` object if any. */
export function identityParts(item: VaultItem): Values {
  const out: Values = {}
  const byName = new Map((item.fields ?? []).map((f) => [squash(f.name), f.value] as const))
  for (const [part, names] of NAMES) {
    const v = names.map((n) => byName.get(n)).find((x) => x && x.trim())
    if (v) out[part] = v.trim()
  }
  const obj = (item as VaultItem & { identity?: Record<string, unknown> }).identity
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const hit = NAMES.find(([, names]) => names.includes(squash(k)))
      if (hit && typeof v === 'string' && v.trim() && !out[hit[0]]) out[hit[0]] = v.trim()
    }
  }
  if (!out.name && (out['given-name'] || out['family-name'])) out.name = [out['given-name'], out['family-name']].filter(Boolean).join(' ')
  if (out.name && !out['given-name'] && !out['family-name']) {
    const [first, ...rest] = out.name.split(/\s+/)
    out['given-name'] = first
    if (rest.length) out['family-name'] = rest.join(' ')
  }
  const lines = [out['address-line1'], out['address-line2'], out['address-line3']].filter(Boolean)
  if (lines.length) out['street-address'] = lines.join(', ')
  return out
}

export function walletValues(item: VaultItem): Values {
  if (item.type === 'card') {
    const c = item.card ?? {}
    const year = (c.expYear ?? '').trim()
    return {
      ...(c.holder ? { 'cc-name': c.holder } : {}),
      ...(c.number ? { 'cc-number': c.number.replace(/[\s-]/g, '') } : {}),
      ...(c.expMonth ? { 'cc-exp-month': String(Number(c.expMonth) || c.expMonth) } : {}),
      ...(year ? { 'cc-exp-year': year.length === 2 ? `20${year}` : year } : {}),
      ...(c.code ? { 'cc-csc': c.code } : {}),
    }
  }
  return item.type === 'identity' ? identityParts(item) : {}
}
