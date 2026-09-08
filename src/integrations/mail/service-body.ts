/**
 * Addresses a BODY can teach the cache, for a listing that could not name them.
 *
 * Split out of `service.ts` because it is pure: given what is stored and what the body said, these
 * functions decide what may be written, so every interesting rule here is checkable without a
 * database or a provider. Three rules, and all three are about not trusting this path too far:
 *
 * - GAP FILL ONLY. A field that already holds an address is never touched, so a body that names a
 *   different sender than the listing did cannot rewrite history, and a provider cannot use a body
 *   read to change who a stored message came from.
 * - A SHAPE CHECK FIRST. Every address goes through the base's `ADDRESS_SHAPE`, the same one the
 *   send path applies, because the value ends up in a `from` a reply is aimed at and in the FTS
 *   index a human searches. One that fails is dropped and named, never stored.
 * - THE LISTING KEEPS THE NAME. When the listing had a display name, it stays: it is the string the
 *   human has been reading in the list, and a body is not more authoritative about it than the
 *   thread's own participant list was.
 */
import { ADDRESS_SHAPE } from './agent-format.js'
import type { MessagePayload } from './service-dto.js'
import type { MailAddress, MailBody } from './types.js'

/** The address fields of one cached row: the column, and the blob the rest of them live in. */
export interface StoredAddresses {
  fromAddr: string
  payload: MessagePayload
}

export type AddressField = 'from' | 'to' | 'cc' | 'replyTo'

export interface BodyAddressFill {
  /** Set ONLY when the column was empty and the body named a usable sender. */
  fromAddr?: string
  /** The payload with the gaps filled, ready to be written back. */
  payload: MessagePayload
  /** Fields where at least one address failed the shape check, for one debug line. */
  dropped: AddressField[]
  /** Fields this fill actually wrote. Empty for every provider whose listing names addresses. */
  filled: AddressField[]
}

function usableAddress(one: MailAddress | undefined): MailAddress | undefined {
  const address = (one?.address ?? '').trim()
  if (!ADDRESS_SHAPE.test(address)) return undefined
  const name = (one?.name ?? '').trim()
  return name ? { name, address } : { address }
}

function usableList(list: MailAddress[]): MailAddress[] {
  const out: MailAddress[] = []
  for (const one of list) {
    const usable = usableAddress(one)
    if (usable) out.push(usable)
  }
  return out
}

/**
 * What a body read may add to a stored message, and nothing more.
 *
 * A conversation-shaped transport lists participants as display names with no address and only
 * reveals a real `from` on a read of the thread. Before this the stored envelope kept an empty
 * address forever: cache search could never match the sender, and Reply had nothing to prefill.
 */
export function fillAddressesFromBody(stored: StoredAddresses, body: MailBody): BodyAddressFill {
  const fill: BodyAddressFill = { payload: stored.payload, dropped: [], filled: [] }

  // Both halves have to be empty. The column is what search and the reply target read, the blob is
  // what the DTO prefers, and filling one while the other holds a name would answer two ways.
  if (body.from && !stored.fromAddr && !fill.payload.from?.address) {
    const named = usableAddress(body.from)
    if (!named) fill.dropped.push('from')
    else {
      // `||`, not `??`: a stored name of '' is a name nobody can read, so the body's wins.
      const name = fill.payload.from?.name || named.name
      fill.fromAddr = named.address
      fill.payload = {
        ...fill.payload,
        from: name ? { name, address: named.address } : { address: named.address },
      }
      fill.filled.push('from')
    }
  }

  for (const field of ['to', 'cc', 'replyTo'] as const) {
    const offered = body[field]
    if (!offered?.length || fill.payload[field]?.length) continue
    const usable = usableList(offered)
    if (usable.length < offered.length) fill.dropped.push(field)
    if (usable.length === 0) continue
    fill.payload = { ...fill.payload, [field]: usable }
    fill.filled.push(field)
  }

  return fill
}

/**
 * The sender to store for an envelope that STILL cannot name one, when a body already could.
 *
 * Every poll that changes anything about a message (a flag, an edited subject) rewrites `from` from
 * what the LISTING says, and for a conversation transport that is a display name with no address.
 * Without this, an unrelated flag change blanked the address a body had taught the cache, and since
 * the body was already stored nothing would ever fetch it again: the fill would be lost for good.
 *
 * The envelope's NAME still wins when it has one: that field belongs to the listing and may
 * legitimately have changed. Only the hole is filled, from what is already stored for this row.
 */
export function senderForUpdate(
  from: MailAddress | undefined,
  stored: MessagePayload,
): MailAddress | undefined {
  if (from?.address) return from
  const learned = stored.from?.address
  if (!learned) return from
  return from?.name ? { name: from.name, address: learned } : { address: learned }
}

/**
 * The DTO fields a fill wrote, so the read that FETCHED the body answers with them.
 *
 * Without this the console opens a thread, the sender is learned and written, and the very response
 * that learned it still says "no address": the row was read before the body arrived, and only the
 * next list would carry the fill. Empty for every provider whose listing names its addresses.
 */
export function filledAddresses(fill: BodyAddressFill): {
  from?: MailAddress
  to?: MailAddress[]
  cc?: MailAddress[]
  replyTo?: MailAddress[]
} {
  const out: { from?: MailAddress; to?: MailAddress[]; cc?: MailAddress[]; replyTo?: MailAddress[] } = {}
  for (const field of fill.filled) {
    if (field === 'from') {
      if (fill.payload.from) out.from = fill.payload.from
      continue
    }
    const list = fill.payload[field]
    if (list?.length) out[field] = list
  }
  return out
}
