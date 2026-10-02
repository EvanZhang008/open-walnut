/**
 * The model labels unread inbox mail: important or not, and for mail that is not, a short name for
 * the KIND of mail it is ("Ticket updates", "Pager alerts"). There are no built-in groups; the names
 * are the model's, reused across batches, and the person can rename one.
 *
 * Why it is shaped like this:
 * - UNREAD ONLY, newest first, received in the last `AI_WINDOW_MS`. A group row is unread mail by
 *   definition, and a real inbox holds a few dozen unread, so every one of them can be asked about.
 *   Older unread and read history fall back on the simple rules (sort-classify.ts).
 * - The person's rules come first. A mail a rule sends to Important or to a named group is never
 *   asked about; every rule's note rides the prompt, which is how a correction teaches the model.
 * - The call is the HOST's `model.fastText`: the user's configured main provider, never a third
 *   party (work mail only goes where the user already sends everything).
 * - The answer is data, not trust: anything that is not one JSON object with a `mails` list is a
 *   failed call, and each entry is checked on its own (a bad entry costs that one mail, not the batch).
 * - A failed call (down, timeout, not JSON) marks the labeler DOWN for `AI_DOWN_MS`: the waiting rows
 *   fall back to the simple rules at once (so nothing sits in "Sorting" forever) and the header says
 *   so; after the pause it tries again.
 * - One batch at a time, at most `AI_HOURLY_CALLS` calls an hour. Beyond that the rows wait, visibly.
 * - Once every waiting mail is labeled, the same runner writes the one-line summary of each group
 *   whose unread changed (sort-group-summary.ts), from the same model and the same hourly budget.
 */
import type { MailSortStore, ScanRow, AiVerdict } from './sort-store.js'
import type { SortFeatures } from './sort-types.js'
import { IMPORTANT_LABEL, NOT_IMPORTANT_LABEL } from './sort-classify.js'
import {
  SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, parseSummaries, summaryPrompt, type GroupDigest, type SummaryGroupInput,
} from './sort-group-summary.js'

/** Bump when the prompt changes meaning: every unread mail is labeled again. */
export const AI_PROMPT_REV = 1
export const AI_BATCH = 30
export const AI_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
export const AI_TIMEOUT_MS = 45_000
export const AI_DOWN_MS = 5 * 60_000
export const AI_HOURLY_CALLS = 60
export const AI_DEBOUNCE_MS = 1_500
export const MAX_AI_LABEL_CHARS = 32
const MAX_AI_LABEL_WORDS = 4
const MAX_AI_WHY_CHARS = 120
const MAX_TOKENS = 2_048
const SUBJECT_CHARS = 200
const TEXT_CHARS = 200
const MAX_NOTES = 30
const NOTE_CHARS = 300
const MAX_GROUP_NAMES = 40

/** Names that say nothing about the kind of mail; a label like these is dropped (the sender stands in). */
const EMPTY_NAMES = new Set([
  IMPORTANT_LABEL.toLowerCase(), NOT_IMPORTANT_LABEL.toLowerCase(), 'other', 'others', 'misc', 'miscellaneous',
  'unknown', 'none', 'general', 'mail', 'email', 'inbox', 'not-important', 'unimportant',
])

export const LABEL_SYSTEM = [
  "You sort a person's unread email. For every mail decide three things.",
  'important: true only when a person wrote to them and expects them to read or act: a direct question,',
  'a request, a personal note, a review or approval that names them, a meeting change they must answer.',
  'false for automated notices, alerts, pages, ticket updates, build and deploy mail, newsletters,',
  'marketing, receipts, statements, calendar noise, surveys, out-of-office replies, and mail sent to a',
  'list or group alias rather than to them.',
  'group: for mail that is NOT important, a short name for the KIND of mail (1 to 3 words, first word',
  'capitalised, for example "Ticket updates", "Pager alerts", "Newsletters", "Receipts") so similar mail',
  'lands together. Reuse a name from "groups" whenever one fits; make a new one only when none does.',
  'Never use "Important", "Not important", "Other" or "Misc". Leave it out for important mail.',
  'why: at most 12 plain words saying why.',
  'The person\'s own notes about their mail are in "notes": they override your judgement.',
  '"to" says how the mail reached them: "you" (named in To), "cc" (only in Cc), "group" (sent to a list',
  'or alias they are on, not to them), "unknown" (Walnut cannot see the recipients).',
  'Answer with ONE JSON object and nothing else, one entry per mail with the same "i":',
  '{"mails":[{"i":0,"important":false,"group":"Ticket updates","why":"Automated ticket status change"}]}',
].join('\n')

export type LabelModel = (request: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
  signal?: AbortSignal
}) => Promise<string>

/** What the labeler needs from the engine, read fresh for every batch. */
export interface LabelContext {
  rev: string
  me: Array<{ name: string; address: string }>
  notes: string[]
  groups: string[]
  /** True when a rule decides this mail outright (Important or a named group): not asked about. */
  decides: (row: ScanRow) => boolean
  features: (row: ScanRow) => SortFeatures
}

/** The summary half of a pass: what to write, and where it goes. */
export interface SummaryDeps {
  /** The groups due a line (sort-group-summary `staleGroups`), each with its newest mail. */
  plan: () => Promise<Array<{ digest: GroupDigest; input: SummaryGroupInput }>>
  save: (entries: Array<{ id: string; summary: string; basis: string; newestRowid: number }>) => Promise<void>
}

export interface LabelerDeps {
  store: Pick<MailSortStore, 'aiCandidates' | 'applyAiVerdicts'>
  /** Undefined: no model call on this Walnut (state `off`). */
  model?: LabelModel
  context: () => Promise<LabelContext>
  /** Re-sort these rows under their new verdicts. */
  reclassify: (rows: ReadonlyArray<ScanRow>) => Promise<void>
  /** The labeler just went down: move every waiting row onto the simple rules. */
  onDown: () => Promise<void>
  /** Absent: no group summaries (the lines fall back to each group's newest subject). */
  summaries?: SummaryDeps
  /** Host timers, so a plugin teardown cancels a pending run. */
  timeout?: (handler: () => void, ms: number) => { dispose(): void }
  now?: () => number
  log?: {
    info?(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
}

export interface ParsedLabel {
  important: boolean
  label: string | null
  why: string | null
}

// ── the prompt ──

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars).trimEnd()}…` : flat
}

function toOf(features: SortFeatures): 'you' | 'cc' | 'group' | 'unknown' {
  if (features.addressedToMe === 'unknown') return 'unknown'
  if (features.onlyCc === true) return 'cc'
  return features.addressedToMe ? 'you' : 'group'
}

function senderWord(features: SortFeatures): string {
  switch (features.senderKind) {
    case 'person': return 'person'
    case 'bulk': return 'marketing'
    case 'transactional': return 'automated'
    default: return 'unknown'
  }
}

/** The user turn for one batch (pure; the tests read it). */
export function labelPrompt(rows: ReadonlyArray<ScanRow>, context: LabelContext): string {
  const mails = rows.map((row, i) => {
    const f = context.features(row)
    const from = f.fromName && f.fromAddr ? `${f.fromName} <${f.fromAddr}>` : f.fromAddr || f.fromName || 'unknown'
    return {
      i,
      from: clip(from, 120),
      to: toOf(f),
      sender: senderWord(f),
      ...(f.hasListUnsubscribe || f.listId ? { list: true } : {}),
      subject: clip(row.subject ?? '', SUBJECT_CHARS),
      ...(typeof row.snippet === 'string' && row.snippet ? { text: clip(row.snippet, TEXT_CHARS) } : {}),
      ...(row.ai_label ? { was: row.ai_label } : {}),
    }
  })
  return JSON.stringify({
    me: context.me,
    notes: context.notes.slice(0, MAX_NOTES).map((note) => clip(note, NOTE_CHARS)),
    groups: context.groups.slice(0, MAX_GROUP_NAMES),
    mails,
  })
}

// ── the answer ──

function jsonObjectIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
}

/** A model group name as stored, or null when it names nothing (spelling of a known name is kept). */
export function cleanLabel(value: unknown, known: ReadonlyArray<string>): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '')
  if (!text || text.length > MAX_AI_LABEL_CHARS) return null
  if (text.split(' ').length > MAX_AI_LABEL_WORDS) return null
  if (EMPTY_NAMES.has(text.toLowerCase())) return null
  const same = known.find((one) => one.toLowerCase() === text.toLowerCase())
  if (same) return same
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The model's text, checked. `null` = the whole answer is unusable (not one JSON object with a
 * `mails` list): the call counts as failed. Otherwise a map from batch index to what that entry said;
 * a missing or malformed entry is simply absent.
 */
export function parseLabels(text: string, count: number, known: ReadonlyArray<string>): Map<number, ParsedLabel> | null {
  const parsed = jsonObjectIn(text) as { mails?: unknown } | undefined
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.mails)) return null
  const out = new Map<number, ParsedLabel>()
  for (const entry of parsed.mails as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const one = entry as Record<string, unknown>
    const i = Number(one.i)
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue
    if (typeof one.important !== 'boolean') continue
    const why = typeof one.why === 'string' && one.why.trim() ? clip(one.why, MAX_AI_WHY_CHARS) : null
    out.set(i, {
      important: one.important,
      label: one.important ? null : cleanLabel(one.group, known),
      why,
    })
  }
  return out
}

// ── the runner ──

export type LabelerState = 'on' | 'down' | 'off'

export class MailSortLabeler {
  private timer: { dispose(): void } | null = null
  private running: Promise<void> | null = null
  private again = false
  private downUntil = 0
  private calls: number[] = []
  private disposed = false

  constructor(private readonly deps: LabelerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  state(): LabelerState {
    if (!this.deps.model) return 'off'
    return this.now() < this.downUntil ? 'down' : 'on'
  }

  /** Should an unlabeled unread inbox mail wait for the model (and read as Important meanwhile)? */
  wants(receivedAt: number): boolean {
    return this.state() === 'on' && receivedAt >= this.now() - AI_WINDOW_MS
  }

  /** Label soon (debounced); a call while a run is going queues one more pass. */
  schedule(delayMs = AI_DEBOUNCE_MS): void {
    if (this.disposed || !this.deps.model) return
    if (this.running) { this.again = true; return }
    if (this.timer) return
    this.arm(delayMs)
  }

  /**
   * Try again after a pause (the model down, the hour's calls spent). Unlike `schedule`, this never
   * queues another pass of the run it is called from: that pass would meet the same pause and ask
   * again, a loop of resolved promises that never yields to the event loop (it froze the test
   * process at 100% CPU, and would freeze the server the same way).
   */
  private retryAfter(delayMs: number): void {
    if (this.disposed || !this.deps.model) return
    this.timer?.dispose()
    this.arm(delayMs)
  }

  private arm(delayMs: number): void {
    const timeout = this.deps.timeout ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      return { dispose: () => clearTimeout(handle) }
    })
    this.timer = timeout(() => {
      this.timer = null
      if (!this.disposed) void this.runNow()
    }, delayMs)
  }

  /**
   * Run now; resolves when this run (and any pass queued meanwhile) is done. Tests await it.
   * Never rejects: the timer calls it fire-and-forget, so a pass that meets a closed database (the
   * plugin torn down mid-pass) would otherwise be an unhandled rejection. The next schedule retries.
   */
  runNow(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      try {
        do { this.again = false; await this.pass() } while (this.again && !this.disposed)
      } catch (error) {
        if (!this.disposed) this.deps.log?.warn('mail labeling pass failed', { error: String(error).slice(0, 200) })
      } finally { this.running = null }
    })()
    return this.running
  }

  /** Resolves when no run is going. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  private overBudget(): boolean {
    const hourAgo = this.now() - 60 * 60 * 1000
    this.calls = this.calls.filter((at) => at > hourAgo)
    return this.calls.length >= AI_HOURLY_CALLS
  }

  private async goDown(reason: string): Promise<void> {
    const first = this.state() !== 'down'
    this.downUntil = this.now() + AI_DOWN_MS
    if (first) this.deps.log?.warn('mail labeling fell back to simple rules', { reason: reason.slice(0, 200), retryInMs: AI_DOWN_MS })
    await this.deps.onDown().catch((error) => this.deps.log?.warn('mail labeling fallback failed', { error: String(error) }))
    this.retryAfter(AI_DOWN_MS + 1_000)
  }

  private async pass(): Promise<void> {
    const model = this.deps.model
    if (!model || this.disposed) return
    if (await this.labelAll(model)) await this.summarizeAll(model)
  }

  /**
   * One model call under the timeout. `null` = it failed and the labeler is now down (the caller
   * stops); otherwise the model's text.
   */
  private async ask(model: LabelModel, system: string, user: string, maxTokens: number): Promise<string | null> {
    this.calls.push(this.now())
    const controller = new AbortController()
    let clock: ReturnType<typeof setTimeout> | undefined
    try {
      const text = await Promise.race([
        model({ system, messages: [{ role: 'user', content: user }], maxTokens, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          clock = setTimeout(() => { controller.abort(); reject(new Error('The model took too long.')) }, AI_TIMEOUT_MS)
        }),
      ])
      return String(text ?? '')
    } catch (error) {
      await this.goDown(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      if (clock) clearTimeout(clock)
    }
  }

  /** True when every waiting mail is labeled; false when the run stopped early (down, budget, gone). */
  private async labelAll(model: LabelModel): Promise<boolean> {
    while (!this.disposed) {
      if (this.state() === 'down') return false
      if (this.overBudget()) {
        this.deps.log?.info?.('mail labeling paused for the hour', { calls: this.calls.length })
        this.retryAfter(10 * 60_000)
        return false
      }
      const context = await this.deps.context()
      const rows = await this.deps.store.aiCandidates(context.rev, this.now() - AI_WINDOW_MS, AI_BATCH)
      if (rows.length === 0) return true
      const ask = rows.filter((row) => !context.decides(row))
      let answers = new Map<number, ParsedLabel>()
      if (ask.length > 0) {
        const text = await this.ask(model, LABEL_SYSTEM, labelPrompt(ask, context), MAX_TOKENS)
        if (text === null) return false
        const parsed = parseLabels(text, ask.length, context.groups)
        if (!parsed) { await this.goDown('The model did not answer with the expected JSON.'); return false }
        answers = parsed
      }
      const index = new Map(ask.map((row, i) => [row.rowid, i]))
      const verdicts: AiVerdict[] = rows.map((row) => {
        const i = index.get(row.rowid)
        // A mail a rule decides keeps whatever the model said before (a `group` rule may read it).
        if (i === undefined) {
          return {
            rowid: row.rowid, label: row.ai_label, important: row.ai_important === null ? null : row.ai_important === 1,
            why: row.ai_why, rev: context.rev,
          }
        }
        const answer = answers.get(i)
        return {
          rowid: row.rowid,
          label: answer?.label ?? null,
          important: answer ? answer.important : null,
          why: answer?.why ?? null,
          rev: context.rev,
        }
      })
      await this.deps.store.applyAiVerdicts(verdicts)
      // The rows as they are now, so the re-sort reads the verdict just written.
      await this.deps.reclassify(rows.map((row, n) => ({
        ...row,
        ai_label: verdicts[n]!.label,
        ai_important: verdicts[n]!.important === null ? null : verdicts[n]!.important ? 1 : 0,
        ai_why: verdicts[n]!.why,
        ai_rev: context.rev,
      })))
      if (ask.length > 0) {
        this.deps.log?.info?.('mail labeled', { asked: ask.length, answered: answers.size, byRule: rows.length - ask.length })
      }
      // Let the other routes breathe between batches.
      await new Promise((resolve) => setImmediate(resolve))
    }
    return false
  }

  /**
   * Write the lines of the groups whose unread changed, one call per `SUMMARY_BATCH` groups. Every
   * group in a batch is saved (an unanswered one with an empty line), so the next plan no longer
   * holds it and the loop ends when nothing is due.
   */
  private async summarizeAll(model: LabelModel): Promise<void> {
    const summaries = this.deps.summaries
    if (!summaries) return
    while (!this.disposed) {
      if (this.state() === 'down') return
      const plan = await summaries.plan()
      if (plan.length === 0) return
      if (this.overBudget()) {
        this.deps.log?.info?.('mail group summaries paused for the hour', { calls: this.calls.length })
        this.retryAfter(10 * 60_000)
        return
      }
      const text = await this.ask(model, SUMMARY_SYSTEM, summaryPrompt(plan.map((one) => one.input)), SUMMARY_MAX_TOKENS)
      if (text === null) return
      // An unreadable answer costs these groups their line (the newest subject stands in until the
      // group changes), not the labeling: a summary is decoration, and going down over one would
      // hand every new arrival to the simple rules for AI_DOWN_MS.
      const lines = parseSummaries(text, plan.length)
      await summaries.save(plan.map((one, g) => ({
        id: one.digest.id, summary: lines?.get(g) ?? '', basis: one.digest.basis, newestRowid: one.digest.newestRowid,
      })))
      if (!lines) {
        this.deps.log?.warn('mail group summaries unreadable', { groups: plan.length })
        return
      }
      this.deps.log?.info?.('mail group summaries written', { groups: plan.length, answered: lines.size })
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  dispose(): void {
    this.disposed = true
    this.timer?.dispose()
    this.timer = null
  }
}
