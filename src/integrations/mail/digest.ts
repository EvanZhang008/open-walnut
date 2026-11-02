/**
 * The daily digest: one letter, once a day, that says what is sitting unread.
 *
 * A letter rather than a notification because a letter is the one thing that reaches the human
 * wherever they are (console, phone push, relay) and stays readable afterwards. It carries NO
 * whole-letter decisions. Optional email items let the human act on each exact source without
 * turning the digest into an AI decision or changing its unread count snapshot.
 *
 * Four rules this file exists to hold, each of them a way a digest goes wrong:
 *
 * - ONE per day, decided from a stored day key rather than from a timer. The tick fires every two
 *   minutes and the process restarts whenever a deploy happens, so "have I sent today's" can only
 *   be answered by something on disk. The key is the LOCAL day, because that is the day the human
 *   means.
 * - ZERO unread sends nothing, and still marks the day. A letter that says "you have no unread
 *   mail" is a push notification for the absence of news, every morning, forever. But "nothing is
 *   unread" and "the budget ran out before anything was counted" are the SAME NUMBER from a caller's
 *   side, so `collect` reports whether it finished and an unfinished read never marks the day: a tick
 *   that arrived with no budget left used to mark the day and send nothing, losing the digest for a
 *   mailbox with 42 unread until the next morning.
 * - It runs INSIDE the tick's budget and checks the clock between accounts. The digest is the
 *   least urgent thing the tick does, and an account with 50,000 cached messages must not be able
 *   to spend the poll's budget on a summary.
 * - The body is CAPPED in bytes, twice over: whole accounts are dropped, and within one account the
 *   items are cut, because the first account cannot be dropped (there may be only one) and fifty
 *   long subjects are 46 KB on their own. Every item's sender and subject is clipped first, on the
 *   same per-field caps the agent surface uses.
 * - The COUNT is the one the badge shows (`mailboxes.unread` for the inbox roles), not a count of
 *   cached rows. Two numbers for one question, differing by whatever has not synced yet, is how
 *   "12 unread" in a letter sits next to a "9" in the sidebar.
 *
 * Everything a message contributed (a subject, a sender's display name) is escaped and stripped
 * before it is placed: this letter is a document Walnut authors, and a subject that could forge a
 * heading in it could forge one of the account headings the human reads the letter by.
 */
import type { InboxLetterItem } from '../../../packages/plugin-api/src/inbox-items.js'
import { walnutLetterLanguage, type LetterLang } from '../../core/human-inbox/walnut-letters/languages.js'
import { MAIL_DIGEST_WORDS } from '../../core/human-inbox/walnut-letters/mail-digest.js'
import { digestItemFromRow } from './digest-items.js'
export type { DigestItem } from './digest-items.js'
import {
  relativeTimeIn,
  renderDigestIn,
  renderGroupedDigestIn,
  type DigestAccountBlock,
  type DigestGroupLine,
  type RenderedDigest,
} from './digest-render.js'
export { DIGEST_MAX_BYTES } from './digest-render.js'
export type { DigestAccountBlock, DigestGroupLine, RenderedDigest } from './digest-render.js'
import type { MailAccountDto } from './contract.js'
import type { MailEvents } from './events.js'
import type { MailStore } from './store.js'
import type { MailSortEngine } from './sort-engine.js'

/** The meta row that answers "has today's digest gone out". A local `YYYY-MM-DD`. */
export const DIGEST_DAY_KEY = 'last_digest_day'

export const DIGEST_DEFAULT_TIME = '08:00'
export const DIGEST_DEFAULT_MAX_ITEMS = 10

/** Items one account may list, whatever the config asks for. */
export const DIGEST_MAX_ITEMS_CEILING = 50

export interface DigestConfig {
  enabled: boolean
  /** Minutes since local midnight. Parsed once, so the comparison is arithmetic. */
  minute: number
  maxItems: number
}

/** The local calendar day, which is the day the human means by "today". */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Minutes since local midnight, for `at`. */
export function localMinute(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * `HH:MM` to minutes since midnight, falling back rather than throwing.
 *
 * A malformed value in a settings field must not stop the digest: the fallback is the documented
 * default, which is the behaviour the human gets before they ever touch the setting.
 */
export function parseDigestTime(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return hour * 60 + minute
  }
  const [hour, minute] = DIGEST_DEFAULT_TIME.split(':').map(Number)
  return hour! * 60 + minute!
}

export function readDigestConfig(config: Record<string, unknown>): DigestConfig {
  const enabled = config.digest_enabled
  const items = config.digest_max_items
  return {
    enabled: enabled === undefined ? true : enabled === true,
    minute: parseDigestTime(config.digest_time),
    maxItems: typeof items === 'number' && Number.isFinite(items) && items > 0
      ? Math.min(Math.floor(items), DIGEST_MAX_ITEMS_CEILING)
      : DIGEST_DEFAULT_MAX_ITEMS,
  }
}

/** How long ago, in the words a human uses (template: walnut-letters/mail-digest.ts). */
export function relativeTime(at: number, now: number, lang: LetterLang = 'en'): string {
  return relativeTimeIn(MAIL_DIGEST_WORDS[lang], at, now)
}

/**
 * The letter, from already-collected blocks, in the user's letter language.
 *
 * Pure, so every rule is checkable without a database: the escaping, the byte cap, the
 * "and N more" arithmetic and the plurals are all reachable from a unit test (digest-render.ts).
 */
export function renderDigest(blocks: DigestAccountBlock[], now: number, lang: LetterLang = 'en'): RenderedDigest {
  return renderDigestIn(MAIL_DIGEST_WORDS[lang], blocks, now)
}

/** The grouped-mode letter (spec 9.3). Pure, like `renderDigest`. */
export function renderGroupedDigest(
  blocks: DigestAccountBlock[],
  groups: DigestGroupLine[],
  now: number,
  lang: LetterLang = 'en',
): RenderedDigest {
  return renderGroupedDigestIn(MAIL_DIGEST_WORDS[lang], blocks, groups, now)
}

/** Just the letter seam this needs, so a test can hand it one function. */
export interface DigestLetters {
  send(input: {
    subject: string
    markdown?: string
    text?: string
    pin?: boolean
    items?: InboxLetterItem[]
  }): Promise<{ letterId: string }>
}

export interface DigestResult {
  letterId: string | null
  unread: number
  accounts: number
  /**
   * True when the cache read did not finish, so every number here is a FLOOR.
   *
   * The flag exists because "nothing is unread" and "nothing was looked at" are both zero, and only
   * one of them means the day is handled.
   */
  incomplete?: true
  /** What to tell the human. Set when the outcome needs a sentence rather than a number. */
  message?: string
}

/** What `sendNow` says when it could not read enough of the cache to answer. */
export const DIGEST_INCOMPLETE_MESSAGE = 'Walnut ran out of time reading the cache; try again.'

export interface MailDigestDeps {
  store: MailStore
  events: MailEvents
  letters: DigestLetters
  accounts: () => Promise<MailAccountDto[]>
  config: { get<T extends Record<string, unknown>>(): Promise<T> }
  log: {
    debug(message: string, meta?: Record<string, unknown>): void
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
  now?: () => number
  /** Inbox sorting; when grouping is on the digest lists Important mail and one line per group. */
  sort?: MailSortEngine
}

export class MailDigest {
  constructor(private readonly deps: MailDigestDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * The tick's hook: send today's digest if it is due and has not gone out.
   *
   * Answers `null` when there was nothing to do, which is what the tick logs nothing about.
   *
   * The day is marked in exactly two cases: a letter went out, or the cache was read RIGHT THROUGH
   * and had nothing unread in it. Anything else leaves the day unmarked so the next tick tries again.
   * The case that forces the distinction is the tick that reaches the digest with its budget already
   * spent: it collects nothing, which renders as zero unread, and marking the day on that used to
   * throw the digest away for a mailbox that had 42 unread messages in it.
   */
  async maybeSend(deadlineAt?: number): Promise<DigestResult | null> {
    const config = readDigestConfig(await this.deps.config.get())
    if (!config.enabled) return null
    const at = this.now
    if (localMinute(at) < config.minute) return null
    const today = localDay(at)
    if ((await this.deps.store.tasks.getMeta(DIGEST_DAY_KEY)) === today) return null

    const { blocks, complete, groups } = await this.collect(config.maxItems, deadlineAt)
    const lang = await walnutLetterLanguage()
    const rendered = groups ? renderGroupedDigest(blocks, groups, at, lang) : renderDigest(blocks, at, lang)
    if (rendered.unread === 0) {
      if (!complete) {
        this.deps.log.debug('mail digest deferred, the cache read ran out of budget', { day: today })
        return null
      }
      await this.deps.store.tasks.setMeta(DIGEST_DAY_KEY, today)
      this.deps.log.debug('mail digest skipped, nothing unread', { day: today })
      return { letterId: null, unread: 0, accounts: rendered.accounts }
    }
    // Sent before the day is marked, so a letter the quota refused is retried on the next tick
    // rather than silently skipped for the day. An INCOMPLETE collection still marks it: a letter
    // has landed, and a second one an hour later would be the surprising outcome.
    const sent = await this.deliver(rendered)
    await this.deps.store.tasks.setMeta(DIGEST_DAY_KEY, today)
    this.deps.log.info('mail digest sent', { day: today, unread: rendered.unread, complete })
    return complete ? sent : { ...sent, incomplete: true }
  }

  /**
   * "Send it now", from the console's menu.
   *
   * Deliberately does NOT mark the day: this is the human asking to see the thing, not the daily
   * schedule running, and swallowing the morning's digest because somebody looked at lunchtime
   * would be a surprising way to lose it. It also ignores `digest_enabled`, because the human asking
   * for it is the consent the setting stands in for.
   *
   * Zero unread sends nothing and says so, and an unfinished read says something DIFFERENT: telling
   * somebody with a full mailbox that nothing is unread is a lie they cannot act on, while "try
   * again" is a button they can press.
   */
  async sendNow(deadlineAt?: number): Promise<DigestResult> {
    const config = readDigestConfig(await this.deps.config.get())
    const { blocks, complete, groups } = await this.collect(config.maxItems, deadlineAt)
    const lang = await walnutLetterLanguage()
    const rendered = groups ? renderGroupedDigest(blocks, groups, this.now, lang) : renderDigest(blocks, this.now, lang)
    if (rendered.unread === 0) {
      if (!complete) {
        return { letterId: null, unread: 0, accounts: 0, incomplete: true, message: DIGEST_INCOMPLETE_MESSAGE }
      }
      return { letterId: null, unread: 0, accounts: rendered.accounts }
    }
    const sent = await this.deliver(rendered)
    return complete ? sent : { ...sent, incomplete: true }
  }

  private async deliver(rendered: RenderedDigest): Promise<DigestResult> {
    const { letterId } = await this.deps.letters.send({
      subject: rendered.subject,
      markdown: rendered.markdown,
      text: rendered.text,
      items: rendered.items,
      // Never pinned: a digest is today's news, and a pin is for something that has to be dealt
      // with. Tomorrow's would sit under it.
      pin: false,
    })
    this.deps.events.digestSent(letterId, rendered.unread)
    return { letterId, unread: rendered.unread, accounts: rendered.accounts }
  }

  /**
   * The numbers, per account, from the CACHE, and whether every account got its turn.
   *
   * The COUNT is the mailbox figure the sidebar badge shows, so the two can never disagree; the
   * ITEMS are cached rows, which is the only place a subject line exists. That split is why the
   * count can legitimately exceed what is listed, and it is what "and N more" then means.
   *
   * One grouped query for every account's counts and one bounded query per account for its items.
   * The clock is checked between accounts, and `complete` is how a caller tells "these are all the
   * accounts" from "this is as far as the budget went": an account left out is not zero unread.
   */
  private async collect(maxItems: number, deadlineAt?: number): Promise<{
    blocks: DigestAccountBlock[]
    complete: boolean
    groups?: DigestGroupLine[]
  }> {
    // The CHEAP shape: names and counts, no provider call. A digest must never be the reason a mail
    // server is contacted, and `listAccounts()` asks each provider what that account can do.
    const accounts = await this.deps.accounts()
    if (this.deps.sort?.groupedOn()) return this.collectGrouped(accounts, maxItems, deadlineAt)
    const counts = await this.deps.store.unreadByAccount()
    const blocks: DigestAccountBlock[] = []
    for (const account of accounts) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        this.deps.log.debug('mail digest ran out of tick budget', {
          collected: blocks.length, of: accounts.length,
        })
        return { blocks, complete: false }
      }
      const unread = counts.get(account.accountId)?.inbox ?? account.unreadInbox ?? 0
      if (unread <= 0) continue
      const rows = await this.deps.store.tasks.unreadInboxMessages(account.accountId, maxItems)
      blocks.push({
        accountId: account.accountId,
        label: account.displayName || account.address || account.accountId,
        // The mailbox's number, unless the cache holds MORE unread rows than the mailbox admits to
        // (a flag change the poll has not pushed yet). Listing four messages under "3 unread" is the
        // one incoherence a reader can see without leaving the letter.
        unread: Math.max(unread, rows.length),
        items: rows.map((row) => digestItemFromRow(row, account)),
      })
    }
    return { blocks, complete: true }
  }

  /**
   * Grouped mode (spec 9.3): the accounts' IMPORTANT unread, listed one by one, and one line per
   * group. Every number is the cached one, the same figure the sidebar badge shows in this mode.
   */
  private async collectGrouped(
    accounts: MailAccountDto[],
    maxItems: number,
    deadlineAt?: number,
  ): Promise<{ blocks: DigestAccountBlock[]; complete: boolean; groups: DigestGroupLine[] }> {
    const sort = this.deps.sort!
    const inbox = await this.deps.store.mailboxesByRole('inbox')
    const pairs = inbox.map((row) => ({ accountId: row.account_id, mailboxId: row.mailbox_id }))
    const [counts, unreadGroups] = await Promise.all([
      this.deps.store.sort.groupCounts(pairs),
      this.deps.store.sort.unreadGroups(pairs),
    ])
    const important = new Map<string, number>()
    for (const row of counts) {
      const unread = Number(row.unread) || 0
      if (row.grp === 'important') important.set(row.account_id, (important.get(row.account_id) ?? 0) + unread)
    }
    const byGroup = new Map<string, { label: string; unread: number }>()
    for (const row of unreadGroups) {
      const held = byGroup.get(row.grp)
      byGroup.set(row.grp, { label: held?.label ?? sort.labelOf(row.grp, row.label), unread: (held?.unread ?? 0) + (Number(row.unread) || 0) })
    }
    const blocks: DigestAccountBlock[] = []
    for (const account of accounts) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) return { blocks, complete: false, groups: [] }
      const unread = important.get(account.accountId) ?? 0
      if (unread <= 0) continue
      // Important is a small set; the newest unread inbox rows, filtered to it, in date order.
      const rows = (await this.deps.store.tasks.unreadInboxMessages(account.accountId, Math.max(maxItems * 20, 200)))
        .filter((row) => !row.sort_group || row.sort_group === 'important')
        .slice(0, maxItems)
      blocks.push({
        accountId: account.accountId,
        label: account.displayName || account.address || account.accountId,
        unread: Math.max(unread, rows.length),
        items: rows.map((row) => digestItemFromRow(row, account)),
      })
    }
    // Unread groups only, biggest first (the letter's job is "how much is waiting where").
    const groups = [...byGroup.values()]
      .filter((group) => group.unread > 0)
      .sort((a, b) => b.unread - a.unread || a.label.localeCompare(b.label))
    return { blocks, complete: true, groups }
  }
}
