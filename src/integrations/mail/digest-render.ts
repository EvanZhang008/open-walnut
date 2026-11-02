/**
 * The digest letter's layout: byte budgets, escaping, the "and N more" arithmetic. Pure, so every
 * rule is checkable without a database. The words come in as `w`, from the template
 * (core/human-inbox/walnut-letters/mail-digest.ts), which is the one place they are written.
 *
 * Everything a message contributed (a subject, a sender's display name) is escaped and stripped
 * before it is placed: this letter is a document Walnut authors, and a subject that could forge a
 * heading in it could forge one of the account headings the human reads the letter by.
 */
import type { InboxLetterItem } from '../../../packages/plugin-api/src/inbox-items.js'
import type { MailDigestWords } from '../../core/human-inbox/walnut-letters/mail-digest.js'
import { clipChars, NAME_CHARS, SUBJECT_CHARS } from './agent-format.js'
import { digestLetterItem, EMAIL_SUMMARY_UNAVAILABLE, type DigestItem } from './digest-items.js'
import { escapeMarkdown } from './letter-markdown.js'
import { mailAccountLink } from './message-tasks.js'
import { oneLine } from './untrusted.js'

/**
 * The whole body, in bytes.
 *
 * Well under the 200 KB a letter allows, on purpose: this document is pushed to a phone and read
 * on a phone, and a digest nobody scrolls to the end of is not a better digest.
 */
export const DIGEST_MAX_BYTES = 16 * 1024

export interface DigestAccountBlock {
  accountId: string
  label: string
  unread: number
  items: DigestItem[]
}

/** One group's line in a grouped digest: `Ticket updates: 11 unread`. */
export interface DigestGroupLine {
  label: string
  unread: number
}

export interface RenderedDigest {
  subject: string
  markdown: string
  text: string
  unread: number
  accounts: number
  items: InboxLetterItem[]
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How long ago, in the words a human uses. Never a date: the digest is about today. */
export function relativeTimeIn(w: MailDigestWords, at: number, now: number): string {
  const gap = now - at
  if (!Number.isFinite(at) || at <= 0) return w.dateUnknown
  if (gap < MINUTE_MS) return w.justNow
  if (gap < HOUR_MS) return w.minutesAgo(Math.floor(gap / MINUTE_MS))
  if (gap < DAY_MS) return w.hoursAgo(Math.floor(gap / HOUR_MS))
  return w.daysAgo(Math.floor(gap / DAY_MS))
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

function itemLine(w: MailDigestWords, item: DigestItem, now: number): string {
  // Clipped BEFORE escaping, on the same per-field caps the agent surface uses, so the bound is a
  // bound on what the sender wrote rather than on backslashes Walnut added. Per field and not out of
  // one shared allowance: a single 200 KB subject would otherwise spend the whole letter's budget
  // and hide every other message, which is a mailbox anyone can empty by being verbose in a header.
  const sender = escapeMarkdown(clipChars(item.sender, NAME_CHARS)) || w.noSender
  const subject = escapeMarkdown(clipChars(item.subject, SUBJECT_CHARS)) || w.noSubject
  const sourceNote = digestLetterItem(item) ? '' : w.sourceMissing
  return `- **${sender}**: ${subject} (${relativeTimeIn(w, item.sentAt, now)})${sourceNote}`
}

/** An item's stand-ins (no subject, no summary) in the letter's language; the identity is untouched. */
function localItem(w: MailDigestWords, item: InboxLetterItem): InboxLetterItem {
  return {
    ...item,
    subject: item.subject === '(no subject)' ? w.noSubject : item.subject,
    summary: item.summary === EMAIL_SUMMARY_UNAVAILABLE ? w.summaryUnavailable : item.summary,
  }
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
  w: MailDigestWords,
  block: DigestAccountBlock,
  now: number,
  budget: number,
  cutItems: boolean,
  itemBudget: number,
): { markdown: string; items: InboxLetterItem[] } | null {
  const heading = `### ${escapeMarkdown(clipChars(block.label, NAME_CHARS)) || escapeMarkdown(oneLine(block.accountId))}`
    + w.blockUnread(block.unread)
  const footer = `[${w.openMail}](${mailAccountLink(block.accountId)})`
  // The heading, the link and the "and N more" line are what make a truncated block readable, so
  // they are reserved up front; `+ 4` covers the blank lines that separate them.
  let used = bytes(heading) + bytes(footer) + MORE_LINE_BYTES + 4
  if (used > budget) return null
  const kept: string[] = []
  const items: InboxLetterItem[] = []
  const seen = new Set<string>()
  for (const item of block.items) {
    const structured = digestLetterItem(item)
    if (structured && seen.has(structured.id)) continue
    const line = itemLine(w, item, now)
    if (used + bytes(line) + 1 > budget || (structured && items.length >= itemBudget)) {
      if (cutItems) break
      return null
    }
    kept.push(line)
    if (structured) { items.push(localItem(w, structured)); seen.add(structured.id) }
    used += bytes(line) + 1
  }
  const body = [...kept]
  // Never negative, and never smaller than what is listed: the count comes from the mailbox and the
  // items from the cache, so a mailbox that under-reports must not produce "and -2 more".
  const rest = Math.max(0, block.unread - kept.length)
  if (rest > 0) {
    if (body.length > 0) body.push('')
    body.push(w.moreItems(rest))
  }
  // A LINK, not a bare path: this letter's one call to action is "go look at your mail", and a path
  // printed as text makes that a copy-and-paste job on the phone where the letter is read. Nothing
  // untrusted is in it (Walnut's own words, and an id this file percent-encoded), so it cannot be
  // the hole the escaping above exists to close.
  return { markdown: [heading, '', ...body, '', footer].join('\n'), items }
}

function snapshotLine(w: MailDigestWords, now: number): string {
  const date = new Date(now)
  return Number.isFinite(date.getTime()) ? w.snapshotAt(date.toISOString()) : w.snapshotUnknown
}

/** The account sections, inside the byte budget left after `reserved`. */
function renderBlocks(
  w: MailDigestWords,
  blocks: DigestAccountBlock[],
  now: number,
  reserved: number,
): { sections: string[]; items: InboxLetterItem[] } {
  const sections: string[] = []
  const items: InboxLetterItem[] = []
  let used = reserved
  for (const block of blocks) {
    const section = renderBlock(w, block, now, DIGEST_MAX_BYTES - used, sections.length === 0, 100 - items.length)
    if (!section) break
    sections.push(section.markdown)
    items.push(...section.items)
    used += bytes(section.markdown) + 2
  }
  const dropped = blocks.length - sections.length
  if (dropped > 0) sections.push(w.moreAccounts(dropped))
  return { sections, items }
}

/** The plain digest, from already-collected blocks. */
export function renderDigestIn(w: MailDigestWords, blocks: DigestAccountBlock[], now: number): RenderedDigest {
  const unread = blocks.reduce((sum, block) => sum + block.unread, 0)
  const snapshot = snapshotLine(w, now)
  // Reserve the whole-account truncation notice.
  const { sections, items } = renderBlocks(w, blocks, now, bytes(snapshot) + 2 + 64)
  return {
    subject: w.subject(unread, blocks.length),
    markdown: [snapshot, ...sections].join('\n\n'),
    text: w.text(unread, blocks.length, snapshot),
    unread,
    accounts: blocks.length,
    items,
  }
}

/**
 * The grouped-mode letter (spec 9.3): `3 need you, a middle dot, 19 sorted into groups`, the Important
 * unread listed per account exactly as the plain digest lists mail, then one line per group with unread.
 */
export function renderGroupedDigestIn(
  w: MailDigestWords,
  blocks: DigestAccountBlock[],
  groups: DigestGroupLine[],
  now: number,
): RenderedDigest {
  const need = blocks.reduce((sum, block) => sum + block.unread, 0)
  const sorted = groups.reduce((sum, group) => sum + group.unread, 0)
  const headline = w.groupedHeadline(need, sorted)
  const groupLines: string[] = []
  let groupBytes = 64
  for (const group of groups) {
    const line = w.groupLine(escapeMarkdown(clipChars(group.label, NAME_CHARS)), group.unread)
    if (groupBytes + bytes(line) + 1 > 4096) break
    groupLines.push(line)
    groupBytes += bytes(line) + 1
  }
  const droppedGroups = groups.length - groupLines.length
  if (droppedGroups) groupLines.push(w.moreGroups(droppedGroups))
  const tail = groupLines.length > 0 ? [w.sortedHeading, '', ...groupLines].join('\n') : ''
  const snapshot = snapshotLine(w, now)
  const { sections, items } = renderBlocks(w, blocks, now, bytes(tail) + bytes(snapshot) + 4 + 64)
  if (blocks.length === 0) sections.push(w.nothingNeedsYou)
  if (tail) sections.push(tail)
  return {
    subject: w.groupedSubject(headline),
    markdown: [snapshot, ...sections].join('\n\n'),
    text: w.groupedText(headline, snapshot),
    unread: need + sorted,
    accounts: blocks.length,
    items,
  }
}
