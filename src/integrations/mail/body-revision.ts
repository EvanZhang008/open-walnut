/**
 * A provider retiring the bodies the base cached from it.
 *
 * The base writes every fetched body to disk and serves it forever, which is the right call for
 * bytes that cannot change. What CAN change is the provider's own reading of those bytes: a helper
 * that decoded every message as the wrong charset, a parser that dropped the plain-text half. After
 * such a fix every body fetched before it is still wrong in the cache, and no read path will ever
 * ask for it again, so the only cure used to be deleting the cache by hand.
 *
 * `MailProviderSpec.bodyRevision` says it declaratively and this sweep is the base's whole half of
 * the bargain: a revision the meta row has not seen clears every cached body belonging to that
 * provider's accounts, once. The envelope stays, so nothing disappears from a list, and the body is
 * fetched again the next time that message is opened.
 *
 * Four shapes here are load bearing:
 *
 * - The meta row is written LAST. A crash part way through leaves the OLD revision stored, so the
 *   next registration sweeps whatever is left instead of declaring the bodies retired when half of
 *   them are not.
 * - Rows come a PAGE at a time, never as one SELECT. An account with 50,000 cached bodies has to be
 *   a loop of small statements, which is the same shape retention's deletes already use.
 * - The ROW is cleared before its file goes, inside the account's write gate: file first let a reader
 *   confirm a row whose file had vanished, and a crash now leaves at worst an unnamed file.
 * - The SNIPPET is left exactly as it is, and that is deliberate. A row's snippet was derived from
 *   the body being retired, so it carries the same fault, but the envelope's own preview is not kept
 *   anywhere once a body has overwritten that column (`storeBody` writes the body-derived snippet
 *   into it, and an envelope with no preview carries the column forward rather than blanking it).
 *   There is nothing to restore it from, and blanking it would trade wrong text for no text; the
 *   next poll that does carry a preview, or the re-fetch of the body, puts it right. The FTS row is
 *   left for the same reason and with the same precedent: the body-cache eviction in retention.ts
 *   also leaves the index alone, and a re-fetch rewrites it.
 */
import type { BodiedRow } from './store.js'

/** How many bodied rows one statement answers with. The same batch size retention deletes in. */
const PAGE = 200

export interface BodyRevisionDeps {
  store: {
    withAccountWrite<T>(accountId: string, work: () => Promise<T>): Promise<T>
    listAccounts(): Promise<Array<{ account_id: string }>>
    bodiedForAccount(accountId: string, limit: number): Promise<BodiedRow[]>
    clearMessageBody(rowid: number): Promise<void>
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

export interface BodyRevisionResult {
  /** False when there was nothing to do: no revision declared, or the stored one already matches. */
  swept: boolean
  accounts: number
  bodies: number
}

/** One row per provider, so two providers can never read each other's revision. */
export function bodyRevisionMetaKey(providerId: string): string {
  return `body_revision:${providerId}`
}

export async function reconcileBodyRevision(
  deps: BodyRevisionDeps,
  providerId: string,
  revision: string | undefined,
): Promise<BodyRevisionResult> {
  const swept = await sweepOnce(deps, bodyRevisionMetaKey(providerId), providerId, revision, (accountId) => clearAccountBodies(deps, accountId))
  if (!swept) return { swept: false, accounts: 0, bodies: 0 }
  deps.log?.info('mail retired the bodies a provider had cached before its fix', {
    providerId, revision, previous: swept.previous, accounts: swept.accounts, bodies: swept.count,
  })
  return { swept: true, accounts: swept.accounts, bodies: swept.count }
}

/** The `refusalRevision` row of one provider, apart from its `bodyRevision` row. */
export function refusalRevisionMetaKey(providerId: string): string {
  return `refusal_revision:${providerId}`
}

export interface RefusalRevisionDeps {
  store: Pick<BodyRevisionDeps['store'], 'withAccountWrite' | 'listAccounts' | 'tasks'> & {
    clearBodyErrors(accountId: string, code: string, limit: number): Promise<number>
  }
  log?: BodyRevisionDeps['log']
}

export interface RefusalRevisionResult {
  swept: boolean
  accounts: number
  refusals: number
}

/**
 * `MailProviderSpec.refusalRevision`: forget the `too-large` answers this provider gave, once.
 *
 * The other half of the body sweep. A row that remembers `too-large` is never asked again (that is
 * what stops the prefetch re-downloading every over-cap message on every tick), so when a provider
 * learns to read such mail (IMAP reading only the text parts of a message with a big attachment,
 * 2026-11-13) its old answers keep the console saying "too big" until each is cleared. Only that
 * code: `not-found` is about the server, not about the provider's reading, and stays. Bodies already
 * cached are not touched. Same order as the body sweep: the meta row is written LAST.
 */
export async function reconcileRefusalRevision(
  deps: RefusalRevisionDeps,
  providerId: string,
  revision: string | undefined,
): Promise<RefusalRevisionResult> {
  const swept = await sweepOnce(deps, refusalRevisionMetaKey(providerId), providerId, revision, async (accountId) => {
    let cleared = 0
    for (;;) {
      const page = await deps.store.clearBodyErrors(accountId, 'too-large', PAGE)
      cleared += page
      if (page < PAGE) return cleared
    }
  })
  if (!swept) return { swept: false, accounts: 0, refusals: 0 }
  deps.log?.info('mail forgot the bodies a provider used to refuse as too large', {
    providerId, revision, previous: swept.previous, accounts: swept.accounts, refusals: swept.count,
  })
  return { swept: true, accounts: swept.accounts, refusals: swept.count }
}

/**
 * Run `sweep` over every account of this provider, once per revision: what both sweeps share.
 *
 * Undefined when there is nothing to do (no revision declared, or the stored one already matches).
 * Each account's sweep runs inside its write gate, and the meta row is written only after all of
 * them, so a crash part way leaves the old revision and the next registration finishes the job.
 */
async function sweepOnce(
  deps: Pick<BodyRevisionDeps, 'store'> | RefusalRevisionDeps,
  key: string,
  providerId: string,
  revision: string | undefined,
  sweep: (accountId: string) => Promise<number>,
): Promise<{ previous: string; accounts: number; count: number } | undefined> {
  if (revision === undefined) return undefined
  const stored = await deps.store.tasks.getMeta(key)
  if (stored === revision) return undefined

  // An account id is `<providerId>:<providerAccountId>`, so the prefix is the whole test for "is
  // this account this provider's". Everything after that first colon is opaque to the base.
  const prefix = `${providerId}:`
  const accountIds = (await deps.store.listAccounts())
    .map((row) => row.account_id)
    .filter((accountId) => accountId.startsWith(prefix))

  let count = 0
  for (const accountId of accountIds) count += await deps.store.withAccountWrite(accountId, () => sweep(accountId))

  await deps.store.tasks.setMeta(key, revision)
  return { previous: stored ?? '', accounts: accountIds.length, count }
}

/** Caller holds the account's write gate. */
async function clearAccountBodies(deps: BodyRevisionDeps, accountId: string): Promise<number> {
  let cleared = 0
  let firstOfPreviousPage: number | undefined
  for (;;) {
    const page = await deps.store.bodiedForAccount(accountId, PAGE)
    if (page.length === 0) return cleared
    // A page that opens on the row the last one opened on means no progress was made: a clear that
    // did not stick, or a poll that re-fetched a body while this ran. Either way the loop would
    // never end, so it stops and says so.
    if (page[0]!.rowid === firstOfPreviousPage) {
      deps.log?.warn('mail stopped retiring bodies because a page repeated', { accountId, cleared })
      return cleared
    }
    firstOfPreviousPage = page[0]!.rowid
    for (const row of page) {
      await deps.store.clearMessageBody(row.rowid)
      await deps.bodies.remove(row.body_ref)
      cleared += 1
    }
    if (page.length < PAGE) return cleared
  }
}
