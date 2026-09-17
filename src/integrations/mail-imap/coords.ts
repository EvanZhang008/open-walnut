/**
 * Fetch coordinates: the cursor, the message handle, and the mailbox role.
 *
 * All three are places where an IMAP concept meets a transport-free contract, and all three
 * have the same trap in them: a mailbox NAME is nearly arbitrary text. "Projects/2026",
 * "INBOX.Sent" and "Notes: 2026" are all legal, so nothing here may assume a mailbox contains
 * no colon and no slash.
 *
 * - The cursor is `<uidvalidity>:<lastUid>:<floorUid>` and stays opaque to the base, which stores
 *   the string and never parses it. UIDVALIDITY is in it because that is exactly what makes a UID
 *   meaningful: when the server changes it, every UID we hold is void and the container has to
 *   be resynced, which is what `reset: true` says. The floor is the newest-first window's other
 *   end; a two-part cursor from before it existed still reads.
 * - The message handle is `<mailbox>:<uidvalidity>:<uid>`, parsed from the RIGHT. The two
 *   numeric tails are the coordinates and everything before them is the mailbox name, colons
 *   and all.
 */
import type { MailboxRole } from '../mail/api.js'

export interface Cursor {
  uidValidity: string
  lastUid: number
  /**
   * The lowest UID this container still WANTS below `lastUid`, or 0 for "nothing below".
   *
   * A ceiling alone can only describe a container that was filled from the oldest message upward,
   * which is what the poll used to do, and what made a cold Gmail INBOX hand back mail from a
   * decade ago as its first page. Newest-first paging needs the other end of the window too: see
   * poll-range.ts for how the floor walks down and where it stops.
   */
  floorUid: number
}

export function encodeCursor(uidValidity: string, lastUid: number, floorUid = 0): string {
  return `${uidValidity}:${lastUid}:${floorUid}`
}

/**
 * `undefined` for anything that is not a cursor we wrote, which forces a full resync.
 *
 * A TWO-part cursor is one this provider wrote before the floor existed, and it reads as floor 0
 * on purpose: those containers were filled upward from UID 1, so everything below the ceiling is
 * already in the cache and there is no history left to want.
 */
export function decodeCursor(cursor: string | undefined): Cursor | undefined {
  if (!cursor) return undefined
  const parts = cursor.split(':')
  if (parts.length !== 2 && parts.length !== 3) return undefined
  // Every part is matched as digits rather than run through Number: `Number('')` is 0, so a
  // truncated `9001:` would otherwise read as a perfectly good cursor at position zero.
  if (!parts.every((one) => /^\d+$/.test(one))) return undefined
  const [uidValidity, lastUid, floorUid] = parts
  return { uidValidity, lastUid: Number(lastUid), floorUid: floorUid === undefined ? 0 : Number(floorUid) }
}

export interface MessageCoord {
  mailbox: string
  uidValidity: string
  uid: number
}

export function encodeMessageId(mailbox: string, uidValidity: string, uid: number): string {
  return `${mailbox}:${uidValidity}:${uid}`
}

/** Parsed from the right, so a mailbox name containing colons survives the round trip. */
export function decodeMessageId(messageId: string): MessageCoord | undefined {
  const lastColon = messageId.lastIndexOf(':')
  if (lastColon <= 0) return undefined
  const prevColon = messageId.lastIndexOf(':', lastColon - 1)
  if (prevColon <= 0) return undefined
  const mailbox = messageId.slice(0, prevColon)
  const uidValidity = messageId.slice(prevColon + 1, lastColon)
  const uid = Number(messageId.slice(lastColon + 1))
  if (!mailbox || !/^\d+$/.test(uidValidity) || !Number.isInteger(uid) || uid <= 0) return undefined
  return { mailbox, uidValidity, uid }
}

/** SPECIAL-USE (RFC 6154) flag to role. The reliable half of the mapping. */
const BY_SPECIAL_USE: Record<string, MailboxRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'spam',
  '\\archive': 'archive',
  '\\all': 'archive',
}

/**
 * Name fallbacks, for servers that advertise no SPECIAL-USE.
 *
 * English only, on purpose: guessing at localized folder names is how a Spanish "Borradores"
 * becomes an archive and a user's drafts vanish from the console. A wrong role is worse than
 * `other`, and the config override exists for exactly the cases this list cannot know.
 */
const BY_NAME: Array<[RegExp, MailboxRole]> = [
  [/^inbox$/i, 'inbox'],
  [/^(sent|sent items|sent mail|sent messages)$/i, 'sent'],
  [/^(drafts|draft)$/i, 'drafts'],
  [/^(trash|deleted|deleted items|deleted messages|bin)$/i, 'trash'],
  [/^(junk|spam|junk e-?mail|bulk mail)$/i, 'spam'],
  [/^(archive|archives|all mail)$/i, 'archive'],
]

/**
 * The role of one listed mailbox.
 *
 * Order is the point: an explicit config override wins over the server, the server's
 * SPECIAL-USE flag wins over a name guess, and an unrecognised mailbox is `other` rather than
 * something plausible.
 */
export function mailboxRole(
  input: { path: string; name?: string; specialUse?: string; flags?: Iterable<string> },
  overrides: Record<string, string> = {},
): MailboxRole {
  const override = overrides[input.path]
  if (override && isRole(override)) return override

  const flags = [
    ...(input.specialUse ? [input.specialUse] : []),
    ...(input.flags ? [...input.flags] : []),
  ].map((flag) => flag.toLowerCase())
  for (const flag of flags) {
    const role = BY_SPECIAL_USE[flag]
    if (role) return role
  }

  // INBOX is special-cased before the name table because it is the one mailbox name RFC 3501
  // reserves, case-insensitively, whatever the delimiter or hierarchy looks like.
  if (/^inbox$/i.test(input.path)) return 'inbox'
  const leaf = input.name ?? input.path.split(/[/.]/).pop() ?? input.path
  for (const [pattern, role] of BY_NAME) {
    if (pattern.test(leaf)) return role
  }
  return 'other'
}

const ROLES = new Set<MailboxRole>(['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'other'])

function isRole(value: string): value is MailboxRole {
  return ROLES.has(value as MailboxRole)
}
