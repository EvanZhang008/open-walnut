/**
 * The one line under each group's name: what the unread mail in it is ABOUT ("SIM tickets on the
 * storage fleet and the DNS rollout"), so a person can tell whether to open the group without opening
 * it. The group's name already says what KIND of mail it is; this says which things.
 *
 * Who writes it:
 * - ONE unread mail: its own subject, always. It is exact, and no model call can beat it.
 * - Two or more: the model (the same host `model.fastText` the labeler uses, so the same provider and
 *   the same hourly budget), from the newest `SUMMARY_MAILS` subjects and senders of the group.
 * - The model off, down, or not there yet: the newest unread mail's subject, which is what a person
 *   would read first anyway.
 *
 * When it is written again (`staleGroups`): new mail arrived in the group (its newest rowid moved), or
 * the unread set changed some other way (mail was read) and the stored line is older than
 * `SUMMARY_REFRESH_MS`. Reading one mail does not cost a call every time; a new arrival always does.
 * A group the model answered nothing for is stamped with an empty line, so it is not asked about again
 * until one of those two things happens (the batch cannot loop).
 *
 * The line is kept per group id across every inbox (role:inbox), not per folder: one group is one
 * kind of mail wherever it lives, and a folder view of a group shows the same line.
 */
/** Whitespace folded, cut at `chars` with an ellipsis (the labeler's rule, restated to keep this file a leaf). */
function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars).trimEnd()}…` : flat
}

export const SUMMARY_BATCH = 8
export const SUMMARY_MAILS = 10
export const SUMMARY_REFRESH_MS = 30 * 60_000
export const MAX_SUMMARY_CHARS = 110
const SUBJECT_CHARS = 140
const TEXT_CHARS = 120
const MAX_TOKENS = 1_024

export const SUMMARY_SYSTEM = [
  "You write the one-line summary under each group of a person's unread email.",
  'For every group, say in at most 14 plain words what its mail is about, so they can decide whether',
  'to open it: name the concrete things (which tickets, which service, which order, which event), not',
  'the kind of mail, because the group name already says that. No counts, no dates, no greeting, no',
  'quotes, no trailing period. Write in the language of the subjects.',
  'Answer with ONE JSON object and nothing else, one entry per group with the same "g":',
  '{"groups":[{"g":0,"summary":"Storage fleet tickets and a DNS rollout approval"}]}',
].join('\n')

export const SUMMARY_MAX_TOKENS = MAX_TOKENS

/** One group's current unread set, as the store counts it across every inbox. */
export interface GroupDigest {
  id: string
  /** The group's stored display label (`sort_label`), before the person's renames. */
  label: string | null
  unread: number
  /** max(rowid) of the unread set: moves when new mail arrives. */
  newestRowid: number
  /** Count, max and sum of the unread rowids: moves when the set changes at all. */
  basis: string
}

export interface StoredSummary {
  summary: string
  basis: string
  newestRowid: number
  updatedAt: number
}

/** The groups due a (new) line, newest mail first, at most `limit`. Pure. */
export function staleGroups(
  digests: ReadonlyArray<GroupDigest>,
  stored: ReadonlyMap<string, StoredSummary>,
  now: number,
  limit = SUMMARY_BATCH,
): GroupDigest[] {
  const due = digests.filter((one) => {
    if (one.unread < 2) return false
    const have = stored.get(one.id)
    if (!have) return true
    if (one.newestRowid > have.newestRowid) return true
    return one.basis !== have.basis && now - have.updatedAt >= SUMMARY_REFRESH_MS
  })
  return due.sort((a, b) => b.newestRowid - a.newestRowid).slice(0, limit)
}

export interface SummaryMail {
  from: string
  subject: string
  text?: string
}

export interface SummaryGroupInput {
  label: string
  mails: SummaryMail[]
}

/** The user turn (pure; the tests read it). */
export function summaryPrompt(groups: ReadonlyArray<SummaryGroupInput>): string {
  return JSON.stringify({
    groups: groups.map((group, g) => ({
      g,
      name: group.label,
      mails: group.mails.slice(0, SUMMARY_MAILS).map((mail) => ({
        from: clip(mail.from, 80),
        subject: clip(mail.subject, SUBJECT_CHARS),
        ...(mail.text ? { text: clip(mail.text, TEXT_CHARS) } : {}),
      })),
    })),
  })
}

/** A model line as shown, or null when it says nothing usable. */
export function cleanSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, '').replace(/[.\u3002]+$/, '').trim()
  if (!text) return null
  return clip(text, MAX_SUMMARY_CHARS)
}

/** `null` = the whole answer is unusable (the call counts as failed); otherwise index to line. */
export function parseSummaries(text: string, count: number): Map<number, string> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  const groups = (parsed as { groups?: unknown } | null)?.groups
  if (!Array.isArray(groups)) return null
  const out = new Map<number, string>()
  for (const entry of groups) {
    if (!entry || typeof entry !== 'object') continue
    const one = entry as Record<string, unknown>
    const g = Number(one.g)
    if (!Number.isInteger(g) || g < 0 || g >= count || out.has(g)) continue
    const line = cleanSummary(one.summary)
    if (line) out.set(g, line)
  }
  return out
}
