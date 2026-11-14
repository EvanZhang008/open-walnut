// Every new mail of a mailbox goes straight to its router (2026-11-14, the user: "my architecture is
// the mailbox goes directly to the router ... the router itself does the triage"). The intake binds
// each mailbox to its router and enters each new arrival, in the folders that router watches, as
// one of its open items; the router's wake then hands it to its owner. Nothing else reads mail on
// the way: there is no separate triage hop.
// Capture only reads: an item written then (before the body prefetch) could wake the router at a version about to change.
import { accountBinding, readRouterAreas, routerFolders, type RouterAreasFile } from '../../core/router/areas.js'
import {
  accountRouterState, confirmAccountArrivals, ensureAccountRouter, noRouterLetterOpKey, sendNoRouterLetter,
  type AccountRouterOutcome, type AccountRouterState,
} from '../../core/router/account-intake.js'
import type { MailNoRouterParams } from '../../core/human-inbox/walnut-letters/mail-no-router.js'
import type { RouterSource } from '../../core/router/types.js'
import type { MailIncomingCapture, MailIncomingFinish } from './contract.js'
import type { MailHeadline } from './events.js'
import type { MailboxRow, MailStore, MessageRow } from './store.js'
import { mailRouterKey, mailRowDeliveryVersion } from './router-source.js'
import { mailIntakeQueue, type MailIntakeQueue } from './intake-pending.js'

/** Rows per cache query and sources per confirm call. */
export const ROUTER_INTAKE_BATCH = 200

/** What the mail plugin watches for a router that names no folders: the Inbox. */
export const MAIL_ROUTER_DEFAULT_FOLDERS: readonly string[] = ['inbox']

/**
 * A folder outside the Inbox lists its old mail when it is first swept: only mail that arrived
 * this recently there is new.
 */
export const OTHER_FOLDER_NEW_MS = 2 * 24 * 60 * 60_000

const noop: MailIncomingFinish = async () => undefined

type Identity = Pick<MessageRow,
  'rowid' | 'sent_at' | 'received_at' | 'rfc_message_id' | 'from_addr' | 'subject' | 'thread_id' | 'attachments_json'>

const identityOf = (row: MessageRow): Identity => ({
  rowid: row.rowid,
  sent_at: row.sent_at,
  received_at: row.received_at,
  rfc_message_id: row.rfc_message_id,
  from_addr: row.from_addr,
  subject: row.subject,
  thread_id: row.thread_id,
  attachments_json: row.attachments_json,
})

// A body read may fill a sender the listing left blank (gap fill); it never changes a known one.
const sameSender = (initial: string, current: string): boolean => initial === current || (!initial && !!current)

const sameDelivery = (a: Identity, b: Identity): boolean =>
  a.rowid === b.rowid && a.sent_at === b.sent_at && a.received_at === b.received_at
  && a.rfc_message_id === b.rfc_message_id && sameSender(a.from_addr, b.from_addr) && a.subject === b.subject
  && a.thread_id === b.thread_id && a.attachments_json === b.attachments_json

export interface MailRouterIntakeDeps {
  store: Pick<MailStore, 'messagesByIds' | 'listMailboxes'> & Partial<Pick<MailStore, 'getAccount'>>
  home: string
  readAreas?: (home: string) => Promise<RouterAreasFile>
  /** Binds the mailbox to its router, making the Mail router when there is none (core/router/account-intake.ts). */
  ensureRouter?: (accountId: string, home: string) => Promise<AccountRouterOutcome>
  /** Enters a bound mailbox's arrivals as open items of its router; answers the sources it wrote. */
  confirmAccount?: (sources: readonly RouterSource[], home: string) => Promise<readonly RouterSource[]>
  /** Whether a router task is open (not complete, not gone); a paused one is open. */
  routerOpen?: (taskId: string) => Promise<boolean>
  /** The arrivals not entered yet (intake-pending.ts under `home`). */
  pending?: MailIntakeQueue
  /** Tells the person, once per episode, that no router reads this mailbox's new mail (account-intake.ts). */
  /** Sends the no-router letter; false when it was held back and not sent. */
  notifyNoRouter?: (params: MailNoRouterParams, opKey: string) => Promise<boolean | void>
  now?: () => number
  log?: { warn(message: string, data?: Record<string, unknown>): void }
}

/** The intake: `capture` for each tick's arrivals, `retry` once per poll tick for what is still pending. */
export type MailRouterIntake = MailIncomingCapture & {
  /** Enters the account's pending arrivals again; never throws. */
  retry(accountId: string): Promise<void>
}

async function rowsByIds(store: MailRouterIntakeDeps['store'], accountId: string, ids: readonly string[]): Promise<Map<string, MessageRow>> {
  const rows = new Map<string, MessageRow>()
  for (let at = 0; at < ids.length; at += ROUTER_INTAKE_BATCH) {
    for (const row of await store.messagesByIds(accountId, ids.slice(at, at + ROUTER_INTAKE_BATCH))) rows.set(row.message_id, row)
  }
  return rows
}

/** Whether a folder is one the router watches: by role ("inbox") or by name, either case. */
export function watchesFolder(folders: readonly string[], mailbox: Pick<MailboxRow, 'role' | 'name' | 'mailbox_id'> | undefined): boolean {
  if (!mailbox) return false
  const wanted = new Set(folders.map((one) => one.trim().toLowerCase()).filter(Boolean))
  return [mailbox.role, mailbox.name, mailbox.mailbox_id].some((one) => typeof one === 'string' && !!one && wanted.has(one.toLowerCase()))
}

const watchesOnlyInbox = (folders: readonly string[]) => folders.every((one) => one.trim().toLowerCase() === 'inbox')

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/** One arrival to enter: first seen at `seenAt`; `initial` is its capture-time identity (absent on a retry). */
interface Arrival {
  id: string
  seenAt: number
  initial?: Identity
}

export function createMailRouterIntake(deps: MailRouterIntakeDeps): MailRouterIntake {
  const readAreas = deps.readAreas ?? readRouterAreas
  const ensureRouter = deps.ensureRouter ?? ((accountId: string, home: string) => ensureAccountRouter('mail', accountId, { home }))
  const confirmAccount = deps.confirmAccount ?? confirmAccountArrivals
  const now = deps.now ?? Date.now
  const pending = deps.pending ?? mailIntakeQueue(deps.home, { now, log: deps.log })
  const notifyNoRouter = deps.notifyNoRouter ?? sendNoRouterLetter
  // Once per mailbox per run while it holds; a failure or a person's pick asks again next time.
  const ensured = new Set<string>()
  // The retry asks every tick while mail waits: the warning is said once per run.
  const leftUnbound = new Set<string>()
  const ensure = async (accountId: string): Promise<void> => {
    if (ensured.has(accountId)) return
    try {
      const outcome = await ensureRouter(accountId, deps.home)
      if (outcome.bound || outcome.reason !== 'choose') ensured.add(accountId)
      else if (!leftUnbound.has(accountId)) {
        leftUnbound.add(accountId)
        deps.log?.warn('mail router binding left this mailbox unbound', { accountId })
      }
    } catch (error) {
      deps.log?.warn('mail router binding failed', { accountId, error: reason(error) })
    }
  }

  /** Keeps arrivals for the retry; a failure here is the one way mail is lost, so it is said loudly. */
  const keep = async (accountId: string, arrivals: readonly Arrival[]): Promise<void> => {
    if (arrivals.length === 0) return
    try {
      await pending.add(arrivals.map((one) => ({ account: accountId, message: one.id, at: one.seenAt })))
    } catch (error) {
      deps.log?.warn('mail router intake could not keep arrivals for a retry; they are lost', { accountId, count: arrivals.length, error: reason(error) })
    }
  }

  // One at a time: the unread refresh can enter mail beside the poll, and two first sightings would open two episodes.
  let noticeChain: Promise<unknown> = Promise.resolve()
  const notice = (accountId: string, state: AccountRouterState, unread: boolean): Promise<void> => {
    const run = noticeChain.then(() => noticeOne(accountId, state, unread))
    noticeChain = run
    return run
  }
  /** Opens the account's episode and sends its letter once, or closes it once a router reads the mailbox again. Never throws. */
  const noticeOne = async (accountId: string, state: AccountRouterState, unread: boolean): Promise<void> => {
    try {
      const held = (await pending.read()).notices[accountId]
      if (state === 'open') {
        if (held) await pending.setNotice(accountId, null)
        return
      }
      if (!unread || held?.sent) return
      const since = held?.since ?? now()
      const opened = held ?? { opKey: noRouterLetterOpKey(accountId, since), since, sent: false }
      // Written before the send: a crash in between sends again under the same key, which the store dedupes.
      if (!held) await pending.setNotice(accountId, opened)
      const account = await deps.store.getAccount?.(accountId).catch(() => undefined)
      // Held back (the automatic router off, a test run): the episode stays open and asks again next time.
      const sent = await notifyNoRouter({ mailbox: account?.address || account?.display_name || accountId, reason: state }, opened.opKey)
      if (sent !== false) await pending.setNotice(accountId, { ...opened, sent: true })
    } catch (error) {
      deps.log?.warn('mail router intake could not tell that no router reads this mailbox', { accountId, error: reason(error) })
    }
  }

  /**
   * The one way an arrival enters its router, for a new arrival and a retried one alike: the row as
   * the cache holds it now, in a folder the router watches, recent enough measured from when it was
   * first seen. With no router to take it (`none`) it is kept for the retry; with a router whose task
   * is closed it is listed and waits for the reopen. Answers the headlines of the arrivals still current.
   * Throws when the area file, the folders or the rows cannot be read: the caller keeps the arrivals.
   */
  const enter = async (accountId: string, arrivals: readonly Arrival[], retried: boolean): Promise<MailHeadline[]> => {
    const file = await readAreas(deps.home)
    const binding = accountBinding(file, 'mail', accountId)
    const area = binding ? file.areas.find((one) => one.id === binding.areaId) : undefined
    const folders = area ? routerFolders(area, MAIL_ROUTER_DEFAULT_FOLDERS) : MAIL_ROUTER_DEFAULT_FOLDERS
    const state = await accountRouterState(file, 'mail', accountId, deps.routerOpen)
    // No folder list is no proof of a folder nobody watches: a failed read throws, and the arrivals are kept.
    const mailboxes = arrivals.length ? new Map((await deps.store.listMailboxes(accountId)).map((one) => [one.mailbox_id, one])) : new Map<string, MailboxRow>()
    const rows = await rowsByIds(deps.store, accountId, arrivals.map((one) => one.id))
    const shown: MailHeadline[] = []
    const routed: Array<{ arrival: Arrival; source: RouterSource }> = []
    for (const arrival of arrivals) {
      const row = rows.get(arrival.id)
      if (!row || (arrival.initial && !sameDelivery(arrival.initial, identityOf(row)))) continue
      const version = mailRowDeliveryVersion(row)
      shown.push({ from: row.from_addr, subject: row.subject, messageId: arrival.id, version, canonicalKey: mailRouterKey(accountId, arrival.id, row.rfc_message_id) })
      const mailbox = mailboxes.get(row.mailbox_id)
      if (!watchesFolder(folders, mailbox)) continue
      if (mailbox?.role !== 'inbox' && arrival.seenAt - (row.received_at ?? row.sent_at) > OTHER_FOLDER_NEW_MS) continue
      routed.push({ arrival, source: { kind: 'mail', account: accountId, message: arrival.id, version } })
    }
    await notice(accountId, state, routed.length > 0)
    // Every arrival this pass settled: entered, or not for any router (gone from the cache, another folder, too old).
    const settled = new Set(arrivals.map((one) => one.id))
    if (state === 'none') {
      if (!retried) await keep(accountId, routed.map((one) => one.arrival))
      for (const one of routed) settled.delete(one.arrival.id)
    } else {
      const left: Arrival[] = []
      for (let at = 0; at < routed.length; at += ROUTER_INTAKE_BATCH) {
        const batch = routed.slice(at, at + ROUTER_INTAKE_BATCH)
        try {
          await confirmAccount(batch.map((one) => one.source), deps.home)
        } catch (error) {
          // A batch that failed goes in one by one, so one mail its router cannot take holds back no other.
          deps.log?.warn('mail router intake failed; entering that batch one by one', { accountId, count: batch.length, error: reason(error) })
          for (const one of batch) {
            try { await confirmAccount([one.source], deps.home) } catch { left.push(one.arrival) }
          }
        }
      }
      // What did not go in waits for the next tick; a retried one that fails again counts a try.
      if (!retried) await keep(accountId, left)
      else if (left.length) await pending.failed(accountId, left.map((one) => one.id))
      for (const one of left) settled.delete(one.id)
    }
    if (retried) await pending.remove(accountId, [...settled])
    return shown
  }

  const capture = async (accountId: string, headlines: readonly MailHeadline[], opts?: { inbox?: boolean }): Promise<MailIncomingFinish> => {
    const seenAt = now()
    const wanted = new Map<string, Set<string>>()
    for (const one of headlines) {
      if (!one.messageId || !one.version) continue
      wanted.set(one.messageId, (wanted.get(one.messageId) ?? new Set<string>()).add(one.version))
    }
    try {
      await ensure(accountId)
      // Another folder's arrivals cost nothing unless this mailbox's router watches more than the Inbox.
      if (opts?.inbox === false && !await watchesOtherFolders(accountId, deps.home, readAreas)) return noop
      if (wanted.size === 0) return noop
      // Capture only reads: the exact deliveries the tick saw, at their capture-time identity.
      const captured: Arrival[] = []
      const initialRows = await rowsByIds(deps.store, accountId, [...wanted.keys()])
      for (const [id, versions] of wanted) {
        const row = initialRows.get(id)
        const version = row ? mailRowDeliveryVersion(row) : undefined
        if (row && version && versions.has(version)) captured.push({ id, seenAt, initial: identityOf(row) })
      }
      if (captured.length === 0) return async () => []
      // Once, after the prefetch: the same delivery at its final exact version, in a folder its router watches.
      return async () => {
        try {
          return await enter(accountId, captured, false)
        } catch (error) {
          await keep(accountId, captured)
          throw error
        }
      }
    } catch (error) {
      // Nothing of this tick reached the router: every arrival is kept, and the next tick's retry enters it.
      await keep(accountId, [...wanted.keys()].map((id) => ({ id, seenAt })))
      throw error
    }
  }

  const retry = async (accountId: string): Promise<void> => {
    try {
      const file = await pending.read()
      const mine = file.entries.filter((one) => one.account === accountId)
      if (mine.length === 0 && !file.notices[accountId]) return
      await ensure(accountId)
      await enter(accountId, mine.map((one) => ({ id: one.message, seenAt: one.at })), true)
    } catch (error) {
      deps.log?.warn('mail router intake retry failed; it runs again next tick', { accountId, error: reason(error) })
    }
  }

  return Object.assign(capture, { retry })
}

/** Whether a router of this mailbox watches more than the Inbox: only then do other folders' arrivals go to the intake. */
export async function watchesOtherFolders(accountId: string, home: string, readAreas: (home: string) => Promise<RouterAreasFile> = readRouterAreas): Promise<boolean> {
  const file = await readAreas(home).catch(() => undefined)
  const binding = file ? accountBinding(file, 'mail', accountId) : undefined
  const area = binding ? file!.areas.find((one) => one.id === binding.areaId) : undefined
  return !!area && !watchesOnlyInbox(routerFolders(area, MAIL_ROUTER_DEFAULT_FOLDERS))
}

/** Binds every mailbox to its router; one that cannot be bound now is tried again at its next new mail or retry. */
export async function bindMailAccounts(
  store: Pick<MailStore, 'listAccounts'>, home: string, log?: MailRouterIntakeDeps['log'],
  ensureRouter: NonNullable<MailRouterIntakeDeps['ensureRouter']> = (accountId, at) => ensureAccountRouter('mail', accountId, { home: at }),
): Promise<void> {
  const failed = (error: unknown, accountId?: string) =>
    log?.warn('mail router binding failed', { ...(accountId ? { accountId } : {}), error: reason(error) })
  let rows: Awaited<ReturnType<MailStore['listAccounts']>>
  try { rows = await store.listAccounts() } catch (error) { failed(error); return }
  for (const row of rows) {
    try {
      const outcome = await ensureRouter(row.account_id, home)
      if (!outcome.bound && outcome.reason === 'choose') log?.warn('mail router binding left this mailbox unbound', { accountId: row.account_id })
    } catch (error) { failed(error, row.account_id) }
  }
}
