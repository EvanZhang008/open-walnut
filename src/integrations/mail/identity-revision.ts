/**
 * A provider retiring the IDENTITY of everything the base cached from it.
 *
 * The base keys its cache by `messageId`. That is the right call while a provider's handles are
 * stable, and the wrong one the day the provider changes what a handle means: a thread id that
 * becomes a thread-in-folder id, a display name that becomes a server id. From then on every row
 * written under the old scheme is a ghost. No poll ever hands its id over again, so it is never
 * updated and never removed, and it sits in the list next to the row that replaced it.
 *
 * `MailProviderSpec.identityRevision` says so declaratively, and this sweep is the base's half: a
 * revision the meta row has not seen deletes every cached message of that provider's accounts (the
 * rows, the body files, the search index) and forgets every mailbox cursor, once, so the next poll
 * lists each mailbox from the top under the new handles. Heavier than `bodyRevision`, which keeps
 * the envelopes, because an envelope whose id changed has nothing left to keep.
 *
 * Three shapes are load bearing, and they are the body sweep's:
 *
 * - The meta row is written LAST. A crash part way through leaves the OLD revision stored, so the
 *   next registration finishes the wipe instead of declaring it done with half the ghosts alive.
 * - Rows go a PAGE at a time. An account with 50,000 cached rows is a loop of small statements, the
 *   same shape retention deletes in, never one statement that pins the worker.
 * - The FILE goes before the row. The other order leaves bytes on disk that no row names any more.
 *
 * What is NOT touched: accounts, mailboxes (their names and counts come from the provider on every
 * tick anyway), drafts and the approval ledger. A draft's `inReplyTo` is a provider handle the
 * provider must keep honouring across its own revision, and the base has no way to rewrite it.
 */

/** How many rows one statement answers with. The same batch size retention deletes in. */
const PAGE = 200

export interface IdentityRevisionDeps {
  store: {
    listAccounts(): Promise<Array<{ account_id: string }>>
    rowsForAccount(accountId: string, limit: number): Promise<Array<{ rowid: number; body_ref: string | null }>>
    deleteMessages(rowids: number[]): Promise<void>
    listMailboxes(accountId: string): Promise<Array<{ mailbox_id: string }>>
    setMailboxCursor(accountId: string, mailboxId: string, cursor: string | null, lastSyncAt: number): Promise<void>
    tasks: {
      getMeta(key: string): Promise<string | undefined>
      setMeta(key: string, value: string): Promise<void>
    }
  }
  bodies: { remove(ref: string): Promise<void> }
  log?: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
}

export interface IdentityRevisionResult {
  /** False when there was nothing to do: no revision declared, or the stored one already matches. */
  swept: boolean
  accounts: number
  messages: number
  mailboxes: number
}

/** One row per provider, so two providers can never read each other's revision. */
export function identityRevisionMetaKey(providerId: string): string {
  return `identity_revision:${providerId}`
}

export async function reconcileIdentityRevision(
  deps: IdentityRevisionDeps,
  providerId: string,
  revision: string | undefined,
): Promise<IdentityRevisionResult> {
  const idle: IdentityRevisionResult = { swept: false, accounts: 0, messages: 0, mailboxes: 0 }
  if (revision === undefined) return idle
  const key = identityRevisionMetaKey(providerId)
  const stored = await deps.store.tasks.getMeta(key)
  if (stored === revision) return idle

  // An account id is `<providerId>:<providerAccountId>`, so the prefix is the whole test for "is
  // this account this provider's". Everything after that first colon is opaque to the base.
  const prefix = `${providerId}:`
  const accountIds = (await deps.store.listAccounts())
    .map((row) => row.account_id)
    .filter((accountId) => accountId.startsWith(prefix))

  let messages = 0
  let mailboxes = 0
  for (const accountId of accountIds) {
    messages += await wipeAccountMessages(deps, accountId)
    for (const mailbox of await deps.store.listMailboxes(accountId)) {
      await deps.store.setMailboxCursor(accountId, mailbox.mailbox_id, null, 0)
      mailboxes += 1
    }
  }

  await deps.store.tasks.setMeta(key, revision)
  deps.log?.info('mail dropped the cache a provider re-keyed and will list it again', {
    providerId, revision, previous: stored ?? '', accounts: accountIds.length, messages, mailboxes,
  })
  return { swept: true, accounts: accountIds.length, messages, mailboxes }
}

async function wipeAccountMessages(deps: IdentityRevisionDeps, accountId: string): Promise<number> {
  let deleted = 0
  let firstOfPreviousPage: number | undefined
  for (;;) {
    const page = await deps.store.rowsForAccount(accountId, PAGE)
    if (page.length === 0) return deleted
    // A page that opens on the row the last one opened on means no progress was made: a delete that
    // did not stick. The loop would never end, so it stops and says so.
    if (page[0]!.rowid === firstOfPreviousPage) {
      deps.log?.warn('mail stopped wiping a re-keyed cache because a page repeated', { accountId, deleted })
      return deleted
    }
    firstOfPreviousPage = page[0]!.rowid
    for (const row of page) if (row.body_ref) await deps.bodies.remove(row.body_ref)
    await deps.store.deleteMessages(page.map((row) => row.rowid))
    deleted += page.length
    if (page.length < PAGE) return deleted
  }
}
