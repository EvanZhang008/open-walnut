/**
 * `GET /messages?scope=role:inbox` and friends: one list across every account that has that role.
 *
 * A scope is a ROLE, never a mailbox id, because the same role has a different id in every account
 * (two providers here answer `INBOX` and `inbox` for the same thing) and a bare id list would also
 * collide across accounts. The role is resolved against the `mailboxes` table into
 * (account_id, mailbox_id) PAIRS, which is what the page predicate filters on.
 *
 * Parsing is deliberately three-valued. A request with no `scope` is an ordinary per-account page
 * (`undefined`), a recognised value is a scope page, and anything else is `'invalid'` so the route
 * can answer 400. Nothing degrades to `undefined`: a request with no `account` and no `mailbox`
 * returns EVERY account and EVERY folder, so a typo in the scope value silently answers the
 * "unified inbox" with spam and trash mixed in. The failure has to be loud.
 */

/** The roles a cross-account list can be asked for. Archive, spam and trash are per account only. */
export type MessageScopeRole = 'inbox' | 'sent' | 'drafts'

export interface MessageScope {
  role: MessageScopeRole
}

const SCOPES: Record<string, MessageScopeRole> = {
  'role:inbox': 'inbox',
  'role:sent': 'sent',
  'role:drafts': 'drafts',
}

/**
 * `undefined` = no scope asked for, `'invalid'` = asked for something this server does not have.
 *
 * Exact string match, no trimming and no case folding: the value is produced by this repo's own
 * client, so a value that needs repairing is a bug worth seeing rather than a request worth
 * guessing at.
 */
export function parseMessageScope(raw: string | undefined): MessageScope | 'invalid' | undefined {
  if (raw === undefined || raw === '') return undefined
  const role = SCOPES[raw]
  return role ? { role } : 'invalid'
}

/** Every scope value this server accepts, for an error message that names them. */
export function messageScopeValues(): string[] {
  return Object.keys(SCOPES)
}
