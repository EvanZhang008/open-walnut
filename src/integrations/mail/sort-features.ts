/**
 * From one cached row to the features it is classified on (spec 5.1, 5.2). Pure: the engine
 * hands in the parsed payload, the late-fetched hints and the account's identity.
 *
 * The one rule this file exists to keep: a fact the cache does not hold is `unknown`, never
 * `false`. Most old Outlook-shaped rows carry no recipients at all, and treating that as "not
 * addressed to me" would file every colleague's mail under Group mail.
 */
import type { MessagePayload } from './service-dto.js'
import { normalizeName, senderKey, senderKindOf } from './sort-sender.js'
import type { SortFeatures, Tri } from './sort-types.js'
import type { MailAddress, MailListHeaders } from './types.js'

/** Who "me" is on one account. */
export interface AccountIdentity {
  /** Lowercased; may be empty. */
  address: string
  /** Normalized (trimmed, collapsed, lowercased); may be empty. */
  displayName: string
  /**
   * True when this account's provider reports Cc apart from To. Outlook-shaped providers merge
   * them, and there "only in Cc" is unknowable.
   */
  separatesCc: boolean
}

export interface SortHints {
  gmailCategory?: 'promotions' | 'social'
  listHeaders?: MailListHeaders
}

/** The columns and blob one row contributes. */
export interface FeatureRow {
  account_id: string
  rfc_message_id: string
  from_addr: string
  subject: string
}

export function identityOf(account: { address?: string; displayName?: string }, separatesCc: boolean): AccountIdentity {
  return {
    address: (account.address ?? '').trim().toLowerCase(),
    displayName: normalizeName(account.displayName),
    separatesCc,
  }
}

/** Does one recipient entry name me? Entries ending in `@` or with no `@` are only compared. */
export function isMe(entry: MailAddress | undefined, me: AccountIdentity): boolean {
  if (!entry) return false
  const address = (entry.address ?? '').trim().toLowerCase()
  if (me.address && address && address === me.address) return true
  const name = normalizeName(entry.name)
  if (me.displayName && name && name === me.displayName) return true
  // A bare display name sometimes arrives in the address slot (`{ address: 'Harbour, Robin' }`).
  if (me.displayName && address && !address.includes('@') && normalizeName(address) === me.displayName) return true
  return false
}

/** Spec 5.2: `unknown` when the row carries no recipients at all. */
export function addressedToMeOf(to: MailAddress[] | undefined, cc: MailAddress[] | undefined, me: AccountIdentity): Tri {
  const all = [...(to ?? []), ...(cc ?? [])]
  if (all.length === 0) return 'unknown'
  if (!me.address && !me.displayName) return 'unknown'
  return all.some((entry) => isMe(entry, me)) ? true : false
}

/** I am in Cc and not in To. Unknown without recipients, or where the provider merges the two. */
export function onlyCcOf(to: MailAddress[] | undefined, cc: MailAddress[] | undefined, me: AccountIdentity): Tri {
  if ((to ?? []).length === 0 && (cc ?? []).length === 0) return 'unknown'
  if (!me.separatesCc && cc === undefined) return 'unknown'
  const inCc = (cc ?? []).some((entry) => isMe(entry, me))
  const inTo = (to ?? []).some((entry) => isMe(entry, me))
  return inCc && !inTo
}

function lower(value: string | undefined): string | undefined {
  const out = (value ?? '').trim().toLowerCase()
  return out || undefined
}

/** Everything classify reads, from the row, its payload and its hints. */
export function featuresOf(
  row: FeatureRow,
  payload: MessagePayload,
  hints: SortHints | undefined,
  me: AccountIdentity,
  correspondents: ReadonlySet<string> | undefined,
): SortFeatures {
  const fromAddr = (row.from_addr || payload.from?.address || '').trim().toLowerCase()
  const fromName = (payload.from?.name ?? '').trim()
  const stored = payload.listUnsubscribe
  const late = hints?.listHeaders
  const listId = lower(stored?.listId) ?? lower(late?.listId) ?? lower(late?.listUnsubscribe?.listId)
  const offers = (held: { https?: string[]; mailto?: string[] } | undefined): boolean =>
    !!(held && ((held.https?.length ?? 0) > 0 || (held.mailto?.length ?? 0) > 0))
  const precedence = lower(payload.bulkHeaders?.precedence) ?? lower(late?.precedence)
  const autoRaw = lower(payload.bulkHeaders?.autoSubmitted) ?? lower(late?.autoSubmitted)
  const autoSubmitted = autoRaw === 'no' ? undefined : autoRaw
  const gmailCategory = hints?.gmailCategory
  const features: SortFeatures = {
    accountId: row.account_id,
    rfcMessageId: row.rfc_message_id ?? '',
    fromAddr,
    fromName,
    subject: row.subject ?? '',
    hasListUnsubscribe: offers(stored) || offers(late?.listUnsubscribe),
    addressedToMe: addressedToMeOf(payload.to, payload.cc, me),
    onlyCc: onlyCcOf(payload.to, payload.cc, me),
    senderKind: senderKindOf({
      fromAddr, fromName,
      ...(precedence ? { precedence } : {}),
      ...(autoSubmitted ? { autoSubmitted } : {}),
      ...(gmailCategory ? { gmailCategory } : {}),
    }),
    correspondent: !!correspondents && correspondents.has(senderKey(fromAddr, fromName)),
    ...(listId ? { listId } : {}),
    ...(precedence ? { precedence } : {}),
    ...(autoSubmitted ? { autoSubmitted } : {}),
    ...(gmailCategory ? { gmailCategory } : {}),
  }
  const recipients = [...(payload.to ?? []), ...(payload.cc ?? [])]
  if (payload.to !== undefined || payload.cc !== undefined) features.recipients = recipients
  return features
}

/** The keys one Sent row adds to its account's correspondents (addresses, then names). */
export function correspondentKeysOf(payload: MessagePayload): string[] {
  const keys: string[] = []
  for (const entry of [...(payload.to ?? []), ...(payload.cc ?? [])]) {
    const key = senderKey(entry.address && entry.address.includes('@') ? entry.address : '', entry.name)
    if (key !== 'unknown') keys.push(key)
    if (entry.address && entry.name) keys.push(senderKey('', entry.name))
  }
  return keys
}
