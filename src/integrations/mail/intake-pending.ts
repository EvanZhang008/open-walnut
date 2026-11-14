// The mail the router intake could not enter yet, kept on disk so it is entered later instead of lost
// (2026-11-14 review: a headline appears once, at first ingest, and nothing re-scans the cache, so
// a failed intake, or a mailbox no router reads, lost that mail for good). Each poll tick retries
// the account's entries (router-intake.ts `retry`) through the same path as a new arrival.
//
// Also the open "no router reads this mailbox" episode per account, so its letter goes out once.
//
// `<home>/router/mail-intake-pending.json`: machine-local (router/ is never synced), written only
// under its lock (updateJsonFile).
import path from 'node:path'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'

/** Entries kept at most; over it the oldest go, with a warning. */
export const MAIL_INTAKE_PENDING_CAP = 5_000
/** An entry older than this goes, with a warning: the mail is a week old and still unread by any router. */
export const MAIL_INTAKE_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** A retried mail whose own write failed this often is dropped, with a warning: something in that mail itself refuses it. */
export const MAIL_INTAKE_MAX_TRIES = 50

export interface MailIntakePendingEntry {
  account: string
  message: string
  /** When the intake first saw this arrival (epoch ms): the new-mail window is measured from it. */
  at: number
  /** Retries whose own write failed (the rest of its batch went in): one mail that can never enter cannot hold the queue forever. */
  tries?: number
}

/** One episode of an account no router reads: its letter's op key, and whether the letter went out. */
export interface MailIntakeNotice {
  opKey: string
  since: number
  sent: boolean
}

export interface MailIntakePendingFile {
  version: 1
  entries: MailIntakePendingEntry[]
  notices: Record<string, MailIntakeNotice>
}

export interface MailIntakeQueue {
  /** The whole file, unlocked (a retry's look; every change goes through `update`). */
  read(): Promise<MailIntakePendingFile>
  /** Adds entries (one per account and message, the earliest `at` kept). */
  add(entries: readonly MailIntakePendingEntry[]): Promise<void>
  /** Removes the account's entries for these messages. */
  remove(account: string, messages: readonly string[]): Promise<void>
  /** Counts one more failed retry for each of these; one at the limit is dropped with a warning. */
  failed(account: string, messages: readonly string[]): Promise<void>
  /** Opens, marks sent or closes (null) the account's episode. */
  setNotice(account: string, notice: MailIntakeNotice | null): Promise<void>
}

export function mailIntakePendingPath(home: string): string {
  return path.join(home, 'router', 'mail-intake-pending.json')
}

const empty = (): MailIntakePendingFile => ({ version: 1, entries: [], notices: {} })

function normalize(raw: unknown): MailIntakePendingFile {
  const out = empty()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (Array.isArray(r.entries)) {
    for (const one of r.entries) {
      const e = one as Partial<MailIntakePendingEntry> | null
      if (!e || typeof e.account !== 'string' || !e.account || typeof e.message !== 'string' || !e.message) continue
      const at = Number(e.at)
      const tries = Number(e.tries)
      out.entries.push({
        account: e.account, message: e.message, at: Number.isFinite(at) && at > 0 ? at : Date.now(),
        ...(Number.isFinite(tries) && tries > 0 ? { tries: Math.floor(tries) } : {}),
      })
    }
  }
  if (r.notices && typeof r.notices === 'object') {
    for (const [account, one] of Object.entries(r.notices as Record<string, unknown>)) {
      const n = one as Partial<MailIntakeNotice> | null
      if (!n || typeof n.opKey !== 'string' || !n.opKey) continue
      out.notices[account] = { opKey: n.opKey, since: Number(n.since) || 0, sent: n.sent === true }
    }
  }
  return out
}

type Log = { warn(message: string, data?: Record<string, unknown>): void }

/** One entry per account and message (the earliest `at`), none older than the age limit, at most the cap (oldest go). */
function prune(file: MailIntakePendingFile, now: number, log?: Log): MailIntakePendingFile {
  const byKey = new Map<string, MailIntakePendingEntry>()
  for (const one of file.entries) {
    const key = `${one.account}\u0000${one.message}`
    const held = byKey.get(key)
    if (!held) byKey.set(key, one)
    else byKey.set(key, { ...held, at: Math.min(held.at, one.at), ...((held.tries ?? 0) || (one.tries ?? 0) ? { tries: Math.max(held.tries ?? 0, one.tries ?? 0) } : {}) })
  }
  const kept = [...byKey.values()].sort((a, b) => a.at - b.at)
  const fresh = kept.filter((one) => now - one.at <= MAIL_INTAKE_PENDING_MAX_AGE_MS)
  if (fresh.length < kept.length) {
    log?.warn('mail intake dropped arrivals no router took within 7 days', { dropped: kept.length - fresh.length })
  }
  const over = Math.max(0, fresh.length - MAIL_INTAKE_PENDING_CAP)
  if (over > 0) log?.warn('mail intake pending queue is full; the oldest arrivals were dropped', { dropped: over })
  return { ...file, entries: fresh.slice(over) }
}

export function mailIntakeQueue(home: string, opts: { now?: () => number; log?: Log } = {}): MailIntakeQueue {
  const file = mailIntakePendingPath(home)
  const now = opts.now ?? Date.now
  const update = (change: (current: MailIntakePendingFile) => void) =>
    updateJsonFile<unknown>(file, empty(), (raw) => {
      const current = normalize(raw)
      change(current)
      return prune(current, now(), opts.log)
    })
  return {
    read: async () => normalize(await readJsonFile<unknown>(file, empty())),
    add: async (entries) => {
      if (entries.length === 0) return
      await update((current) => { current.entries.push(...entries.map((one) => ({ ...one }))) })
    },
    remove: async (account, messages) => {
      if (messages.length === 0) return
      const gone = new Set(messages)
      await update((current) => { current.entries = current.entries.filter((one) => one.account !== account || !gone.has(one.message)) })
    },
    failed: async (account, messages) => {
      if (messages.length === 0) return
      const hit = new Set(messages)
      await update((current) => {
        let dropped = 0
        current.entries = current.entries.flatMap((one) => {
          if (one.account !== account || !hit.has(one.message)) return [one]
          const tries = (one.tries ?? 0) + 1
          if (tries >= MAIL_INTAKE_MAX_TRIES) { dropped += 1; return [] }
          return [{ ...one, tries }]
        })
        if (dropped) opts.log?.warn('mail intake dropped arrivals its router refused every time', { account, dropped, tries: MAIL_INTAKE_MAX_TRIES })
      })
    },
    setNotice: async (account, notice) => {
      await update((current) => {
        if (notice) current.notices[account] = { ...notice }
        else delete current.notices[account]
      })
    },
  }
}
