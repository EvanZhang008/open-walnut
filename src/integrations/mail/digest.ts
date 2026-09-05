/**
 * The daily digest: one letter, once a day, that says what is sitting unread.
 *
 * A letter rather than a notification because a letter is the one thing that reaches the human
 * wherever they are (console, phone push, relay) and stays readable afterwards. It carries NO
 * actions, which is what makes it a document instead of a question: there is nothing here for the
 * human to decide, and a letter with buttons badges as a decision waiting on them.
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
import { clipChars, NAME_CHARS, SUBJECT_CHARS } from './agent-format.js'
import { escapeMarkdown } from './render.js'
import { oneLine } from './untrusted.js'
import type { MailAccountDto } from './contract.js'
import type { MailEvents } from './events.js'
import { mailAccountLink } from './message-tasks.js'
import type { MailStore } from './store.js'

/** The meta row that answers "has today's digest gone out". A local `YYYY-MM-DD`. */
export const DIGEST_DAY_KEY = 'last_digest_day'

export const DIGEST_DEFAULT_TIME = '08:00'
export const DIGEST_DEFAULT_MAX_ITEMS = 10

/** Items one account may list, whatever the config asks for. */
export const DIGEST_MAX_ITEMS_CEILING = 50

/**
 * The whole body, in bytes.
 *
 * Well under the 200 KB a letter allows, on purpose: this document is pushed to a phone and read
 * on a phone, and a digest nobody scrolls to the end of is not a better digest.
 */
export const DIGEST_MAX_BYTES = 16 * 1024

export interface DigestItem {
  sender: string
  subject: string
  sentAt: number
}

export interface DigestAccountBlock {
  accountId: string
  label: string
  unread: number
  items: DigestItem[]
}

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

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How long ago, in the words a human uses. Never a date: the digest is about today. */
export function relativeTime(at: number, now: number): string {
  const gap = now - at
  if (!Number.isFinite(at) || at <= 0) return 'date unknown'
  if (gap < MINUTE_MS) return 'just now'
  if (gap < HOUR_MS) return `${Math.floor(gap / MINUTE_MS)}m ago`
  if (gap < DAY_MS) return `${Math.floor(gap / HOUR_MS)}h ago`
  return `${Math.floor(gap / DAY_MS)}d ago`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export interface RenderedDigest {
  subject: string
  markdown: string
  text: string
  unread: number
  accounts: number
}

/**
 * Room kept for the "and N more" line before a single item is admitted.
 *
 * A block that runs out of budget has to be able to say how much it left out, so the line that says
 * so is reserved rather than appended and hoped for.
 */
const MORE_LINE_BYTES = 32

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function itemLine(item: DigestItem, now: number): string {
  // Clipped BEFORE escaping, on the same per-field caps the agent surface uses, so the bound is a
  // bound on what the sender wrote rather than on backslashes Walnut added. Per field and not out of
  // one shared allowance: a single 200 KB subject would otherwise spend the whole letter's budget
  // and hide every other message, which is a mailbox anyone can empty by being verbose in a header.
  const sender = escapeMarkdown(clipChars(item.sender, NAME_CHARS)) || '(no sender)'
  const subject = escapeMarkdown(clipChars(item.subject, SUBJECT_CHARS)) || '(no subject)'
  return `- **${sender}**: ${subject} (${relativeTime(item.sentAt, now)})`
}

/**
 * One account's section, inside a byte budget.
 *
 * `cutItems` is the difference between the first block and the rest. A later block either fits whole
 * or is dropped whole, because a body cut mid-list ends in a dangling bullet and on a phone that
 * reads as a rendering bug rather than as a truncation. The FIRST block cannot be dropped (it may be
 * the only one), so it cuts items instead and says how many it left out.
 *
 * Answers `null` when the block cannot be rendered inside the budget under those rules.
 */
function renderBlock(
  block: DigestAccountBlock,
  now: number,
  budget: number,
  cutItems: boolean,
): string | null {
  const heading = `### ${escapeMarkdown(clipChars(block.label, NAME_CHARS)) || block.accountId}`
    + ` (${block.unread} unread)`
  const footer = `[Open Mail](${mailAccountLink(block.accountId)})`
  // The heading, the link and the "and N more" line are what make a truncated block readable, so
  // they are reserved up front; `+ 4` covers the blank lines that separate them.
  let used = bytes(heading) + bytes(footer) + MORE_LINE_BYTES + 4
  if (used > budget) return null
  const kept: string[] = []
  for (const item of block.items) {
    const line = itemLine(item, now)
    if (used + bytes(line) + 1 > budget) {
      if (cutItems) break
      return null
    }
    kept.push(line)
    used += bytes(line) + 1
  }
  const body = [...kept]
  // Never negative, and never smaller than what is listed: the count comes from the mailbox and the
  // items from the cache, so a mailbox that under-reports must not produce "and -2 more".
  const rest = Math.max(0, block.unread - kept.length)
  if (rest > 0) {
    if (body.length > 0) body.push('')
    body.push(`and ${rest} more`)
  }
  // A LINK, not a bare path: this letter's one call to action is "go look at your mail", and a path
  // printed as text makes that a copy-and-paste job on the phone where the letter is read. Nothing
  // untrusted is in it (Walnut's own words, and an id this file percent-encoded), so it cannot be
  // the hole the escaping above exists to close.
  return [heading, '', ...body, '', footer].join('\n')
}

export interface RenderedDigest {
  subject: string
  markdown: string
  text: string
  unread: number
  accounts: number
}

/**
 * The letter, from already-collected blocks.
 *
 * Pure, so every rule above is checkable without a database: the escaping, the byte cap, the
 * "and N more" arithmetic and the plurals are all reachable from a unit test.
 */
export function renderDigest(blocks: DigestAccountBlock[], now: number): RenderedDigest {
  const unread = blocks.reduce((sum, block) => sum + block.unread, 0)
  const subject = `Mail digest: ${unread} unread across ${plural(blocks.length, 'account')}`
  const sections: string[] = []
  let used = 0
  for (const block of blocks) {
    const section = renderBlock(block, now, DIGEST_MAX_BYTES - used, sections.length === 0)
    if (!section) break
    sections.push(section)
    used += bytes(section) + 2
  }
  const dropped = blocks.length - sections.length
  if (dropped > 0) sections.push(`and ${plural(dropped, 'more account')}`)
  return {
    subject,
    markdown: sections.join('\n\n'),
    text: `${unread} unread across ${plural(blocks.length, 'account')}.`,
    unread,
    accounts: blocks.length,
  }
}

/** Just the letter seam this needs, so a test can hand it one function. */
export interface DigestLetters {
  send(input: {
    subject: string
    markdown?: string
    text?: string
    pin?: boolean
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

    const { blocks, complete } = await this.collect(config.maxItems, deadlineAt)
    const rendered = renderDigest(blocks, at)
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
    const { blocks, complete } = await this.collect(config.maxItems, deadlineAt)
    const rendered = renderDigest(blocks, this.now)
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
  }> {
    // The CHEAP shape: names and counts, no provider call. A digest must never be the reason a mail
    // server is contacted, and `listAccounts()` asks each provider what that account can do.
    const accounts = await this.deps.accounts()
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
        items: rows.map((row) => ({
          sender: senderOf(row.payload, row.from_addr),
          subject: row.subject,
          sentAt: row.sent_at,
        })),
      })
    }
    return { blocks, complete: true }
  }
}

/**
 * The sender's display name when there is one, else the bare address.
 *
 * Read from the payload blob here rather than through a DTO: the digest wants two strings per row
 * and building a full `MailMessageDto` for each would parse attachments and flags nobody reads.
 */
function senderOf(payload: string | null, fromAddr: string): string {
  if (payload) {
    try {
      const parsed = JSON.parse(payload) as { from?: { name?: string; address?: string } }
      const name = parsed.from?.name?.trim()
      if (name) return name
      if (parsed.from?.address) return parsed.from.address
    } catch { /* a payload that will not parse is not worth a failed digest */ }
  }
  return fromAddr
}
