/**
 * `MailSortEngine`: the one object the rest of the mail plugin asks about sorting.
 *
 * It holds the rules in use (from the rules file, or its last good copy), their compiled form and
 * revision, each account's identity and correspondents, and the background recompute. Everything
 * it computes per message is synchronous and pure (sort-features.ts, sort-classify.ts); everything
 * it reads or writes goes through `MailStore.sort`.
 */
import crypto from 'node:crypto'
import { MAIL_EVENT, type MailEvents } from './events.js'
import type { MessagePayload } from './service-dto.js'
import { parseJson } from './service-dto.js'
import {
  AI_PENDING_REASON, AI_REASON, BUILTIN_REV, IMPORTANT, IMPORTANT_LABEL, NOT_IMPORTANT, NOT_IMPORTANT_LABEL,
  classify, compileRules, groupIdForName, labelOfBuiltin, reservedGroupId, senderGroupId, whyOf,
} from './sort-classify.js'
import { AI_PROMPT_REV, MAX_AI_LABEL_CHARS, MailSortLabeler, type LabelContext, type LabelModel } from './sort-ai.js'
import { SUMMARY_MAILS, staleGroups, type GroupDigest, type SummaryGroupInput } from './sort-group-summary.js'
import { correspondentKeysOf, featuresOf, identityOf, type AccountIdentity, type SortHints } from './sort-features.js'
import { MailSortRecompute } from './sort-recompute.js'
import { summarizeRule } from './sort-rule-summary.js'
import { MailRulesFile, type RulesFileState, type RulesSaveOutcome } from './sort-rules-file.js'
import { senderKey, senderLabel } from './sort-sender.js'
import type { ScanRow, Verdict } from './sort-store.js'
import type {
  AiStatus, CatalogItem, ClassifyResult, CompiledRule, FolderPair, GroupId, Rule, RulesError, RulesFileDoc,
  SortDto, SortFeatures,
} from './sort-types.js'
import type { MailStore } from './store.js'
import type { MailEnvelope, MailListHeaders } from './types.js'

export const GROUPED_META_KEY = 'grouped_on'
/** When each `skipInbox` rule first existed (ms), so only mail received after that is moved. */
export const FILTER_SINCE_META_KEY = 'mail_filter_since'
const SENT_ROLES_TTL_MS = 60_000
const SENT_PAGE = 2_000

export interface MailSortEngineDeps {
  store: MailStore
  events?: MailEvents
  dataDir: string
  /** Host timers for the rules file poll. */
  interval?: (handler: () => void | Promise<void>, ms: number) => { dispose(): void }
  /** False in tests that drive the file themselves. */
  watch?: boolean
  /** Can this account change read flags? (the provider's capability) */
  canMarkRead?: (accountId: string) => boolean
  /** The host's fast model call; without it nothing is labeled and the simple rules decide. */
  model?: LabelModel
  /** Host one-shot timers (the labeler's debounce). */
  timeout?: (handler: () => void, ms: number) => { dispose(): void }
  now?: () => number
  log?: {
    info?(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
}

export interface SortColumns {
  group: string
  reason: string
  rev: string
  senderKey: string
  label: string
  /** The `skipInbox` rule that wants this new inbox mail moved to the archive (never stored). */
  moveOut?: string
}

/** The model's stored verdict for one row, as the scans and the ingest lookup return it. */
export interface AiColumns {
  ai_label: string | null
  ai_important: number | null
  ai_why?: string | null
  ai_rev: string | null
}

/** Everything the final verdict is composed from, beside the features. */
interface ComposeInput {
  features: SortFeatures
  base: ClassifyResult
  ai: AiColumns | null
  unread: boolean
  inbox: boolean
  at: number
}

const SEEN_FLAG = '\\Seen'

function unreadOf(flagsJson: string | null | undefined): boolean {
  const flags = parseJson<unknown>(flagsJson ?? '[]', [])
  return !(Array.isArray(flags) && flags.includes(SEEN_FLAG))
}

/** The labeling revision: the prompt, and everything the model is told about the person. */
export function computeAiRev(rules: ReadonlyArray<Rule>, identities: ReadonlyMap<string, AccountIdentity>): string {
  const taught = rules.filter((rule) => rule.enabled !== false).map((rule) => [rule.when, rule.then, rule.note ?? ''])
  const people = [...identities.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, me]) => [id, me.address, me.displayName])
  return `a${AI_PROMPT_REV}-${crypto.createHash('sha1').update(JSON.stringify([taught, people])).digest('hex').slice(0, 10)}`
}

function hintsOf(row: { gmail_category?: string | null; list_headers_json?: string | null }): SortHints | undefined {
  const category = row.gmail_category === 'promotions' || row.gmail_category === 'social' ? row.gmail_category : undefined
  const headers = row.list_headers_json ? parseJson<MailListHeaders | null>(row.list_headers_json, null) : null
  if (!category && !headers) return undefined
  return { ...(category ? { gmailCategory: category } : {}), ...(headers ? { listHeaders: headers } : {}) }
}

/**
 * `idFor` resolves a rule's `then` the way the compiled rules do, so a rename that changes where a
 * rule sends mail (a rule naming the group's new name) changes the revision, and one that does not
 * leaves it alone.
 */
export function computeRulesRev(
  rules: ReadonlyArray<Rule>,
  identities: ReadonlyMap<string, AccountIdentity>,
  idFor: (name: string) => GroupId = groupIdForName,
): string {
  const enabled = rules.filter((rule) => rule.enabled !== false).map((rule) => [rule.when, idFor(rule.then)])
  const people = [...identities.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, me]) => [id, me.address, me.displayName, me.separatesCc])
  return crypto.createHash('sha1').update(JSON.stringify([BUILTIN_REV, enabled, people])).digest('hex').slice(0, 12)
}

export class MailSortEngine {
  private readonly file: MailRulesFile
  private readonly recompute: MailSortRecompute
  private compiled: CompiledRule[] = []
  private byId = new Map<string, CompiledRule>()
  private currentRev = ''
  private identities = new Map<string, AccountIdentity>()
  private accountLabels = new Map<string, string>()
  private withCc = new Set<string>()
  private correspondents = new Map<string, Set<string>>()
  private sentPairs: { at: number; keys: Set<string> } | null = null
  private grouped = true
  private started: Promise<void> | null = null
  private disposed = false
  private readonly labeler: MailSortLabeler
  /** The person's renames (group id to name), mirrored from `mail_sort_labels`. */
  private overrides = new Map<string, string>()
  private inboxPairs: { at: number; keys: Set<string> } | null = null
  /** `skipInbox` rule id to the time it first existed (FILTER_SINCE_META_KEY). */
  private filterSince = new Map<string, number>()
  private moveSink: ((requests: Array<{ accountId: string; messageId: string; mailboxId: string; ruleId: string }>) => void) | null = null

  constructor(private readonly deps: MailSortEngineDeps) {
    this.file = new MailRulesFile({
      dataDir: deps.dataDir,
      meta: { get: (key) => deps.store.tasks.getMeta(key), set: (key, value) => deps.store.tasks.setMeta(key, value) },
      ...(deps.interval ? { interval: deps.interval } : {}),
      ...(deps.watch === false ? { watch: false } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      onChange: (state) => this.onRulesFile(state),
      ...(deps.log ? { log: deps.log } : {}),
    })
    this.recompute = new MailSortRecompute({
      store: deps.store.sort,
      verdictOf: (row) => this.verdictOf(row),
      events: {
        sortProgress: (event) => deps.events?.sortProgress(event),
        sorted: (rev) => { deps.events?.sorted(rev); this.labeler.schedule() },
        groupsChanged: (pairs) => deps.events?.groupsChanged(pairs),
      },
      ...(deps.log ? { log: deps.log } : {}),
    })
    this.labeler = new MailSortLabeler({
      store: deps.store.sort,
      ...(deps.model ? { model: deps.model } : {}),
      context: () => this.labelContext(),
      reclassify: (rows) => this.resort(rows),
      onDown: () => this.releasePending(),
      summaries: {
        plan: () => this.summaryPlan(),
        save: async (entries) => {
          await this.deps.store.summaries.save(entries, (this.deps.now ?? Date.now)())
          // New lines to draw; not `notifyGroupsChanged`, which would wake the labeler once more.
          const pairs = await this.inboxFolderPairs()
          if (pairs.length > 0) this.deps.events?.groupsChanged(pairs)
        },
      },
      ...(deps.timeout ? { timeout: deps.timeout } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    })
  }

  /** Load identities, correspondents and rules, then start the backfill. Idempotent. */
  start(): Promise<void> {
    if (!this.started) {
      // A failed boot (the cache not open yet) is retried by the next caller, never cached.
      this.started = this.boot().catch((error) => { this.started = null; throw error })
    }
    return this.started
  }

  /** Resolves once `start()` has finished (routes await it before answering). */
  ready(): Promise<void> {
    return this.start()
  }

  private async boot(): Promise<void> {
    const grouped = await this.deps.store.tasks.getMeta(GROUPED_META_KEY).catch(() => undefined)
    this.grouped = grouped !== '0'
    await this.loadIdentities(true)
    await this.loadCorrespondents()
    this.overrides = await this.deps.store.sort.labelOverrides().catch(() => new Map())
    this.filterSince = await this.loadFilterSince()
    await this.file.start()
    this.recomputeIfNeeded()
    this.labeler.schedule(0)
  }

  private async loadIdentities(rescanCc = false): Promise<boolean> {
    // The Cc scan reads every payload (in the database worker), so only at boot; ingest keeps the
    // set current after that.
    const [accounts, withCc] = await Promise.all([
      this.deps.store.listAccounts(),
      rescanCc ? this.deps.store.sort.accountsWithCc().catch(() => this.withCc) : Promise.resolve(this.withCc),
    ])
    this.withCc = withCc
    const next = new Map<string, AccountIdentity>()
    // A person's two mailboxes usually carry the same display name: a shared name says which
    // account by its address instead ("Mail in Robin can't be moved" would name both).
    const named = new Map<string, number>()
    for (const row of accounts) if (row.display_name) named.set(row.display_name, (named.get(row.display_name) ?? 0) + 1)
    for (const row of accounts) {
      next.set(row.account_id, identityOf(
        { address: row.address, displayName: row.display_name },
        row.provider_id === 'imap' || withCc.has(row.account_id),
      ))
      const unique = row.display_name && named.get(row.display_name) === 1 ? row.display_name : ''
      this.accountLabels.set(row.account_id, unique || row.address || row.display_name || row.account_id)
    }
    const before = JSON.stringify([...this.identities.entries()].sort())
    this.identities = next
    return before !== JSON.stringify([...next.entries()].sort())
  }

  /** Re-read account identities (a display name changed, an account arrived): re-sort if needed. */
  async refreshIdentities(): Promise<void> {
    if (await this.loadIdentities()) this.recomputeIfNeeded()
  }

  private async loadCorrespondents(): Promise<void> {
    const next = new Map<string, Set<string>>()
    let after = 0
    for (;;) {
      const rows = await this.deps.store.sort.sentRecipients(after, SENT_PAGE)
      for (const row of rows) {
        const payload: MessagePayload = {
          ...(row.to_json ? { to: parseJson(row.to_json, []) } : {}),
          ...(row.cc_json ? { cc: parseJson(row.cc_json, []) } : {}),
        }
        const keys = correspondentKeysOf(payload)
        if (keys.length === 0) continue
        let set = next.get(row.account_id)
        if (!set) { set = new Set(); next.set(row.account_id, set) }
        for (const key of keys) set.add(key)
      }
      if (rows.length < SENT_PAGE) break
      after = rows[rows.length - 1]!.rowid
      await new Promise((resolve) => setImmediate(resolve))
    }
    this.correspondents = next
  }

  // ── rules ──

  private onRulesFile(state: RulesFileState): void {
    const summarize = (rule: Rule) => this.summarize(rule)
    try {
      // A rule may name a group by the name the person renamed it to.
      this.compiled = compileRules(state.doc.rules, summarize, (name) => this.idForLabel(name))
    } catch (error) {
      // Validation guarantees this cannot happen; built-ins only is the safe answer if it does.
      this.deps.log?.warn('mail sort rules failed to compile', { error: String(error) })
      this.compiled = []
    }
    this.byId = new Map(this.compiled.map((rule) => [rule.id, rule]))
    this.stampFilterSince()
    const before = this.currentRev
    this.recomputeIfNeeded()
    this.deps.events?.rulesChanged({
      rulesRev: this.currentRev, fileRev: state.fileRev,
      ...(state.error ? { error: { ...state.error } } : {}),
    })
    if (before && before !== this.currentRev) this.deps.log?.info?.('mail sort rules changed', { rulesRev: this.currentRev })
  }

  private async loadFilterSince(): Promise<Map<string, number>> {
    const raw = await this.deps.store.tasks.getMeta(FILTER_SINCE_META_KEY).catch(() => undefined)
    const out = new Map<string, number>()
    try {
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      for (const [id, at] of Object.entries(parsed)) if (typeof at === 'number' && Number.isFinite(at)) out.set(id, at)
    } catch { /* a corrupt row reads as none: every rule starts from now */ }
    return out
  }

  /** A `skipInbox` rule seen for the first time starts now; a rule that went away is forgotten. */
  private stampFilterSince(): void {
    const now = (this.deps.now ?? Date.now)()
    const live = new Set(this.compiled.filter((rule) => rule.skipInbox).map((rule) => rule.id))
    let changed = false
    for (const id of live) if (!this.filterSince.has(id)) { this.filterSince.set(id, now); changed = true }
    for (const id of [...this.filterSince.keys()]) if (!live.has(id)) { this.filterSince.delete(id); changed = true }
    if (!changed) return
    void this.deps.store.tasks.setMeta(FILTER_SINCE_META_KEY, JSON.stringify(Object.fromEntries(this.filterSince)))
      .catch((error) => this.deps.log?.warn('mail filter start times not saved', { error: String(error) }))
  }

  /**
   * The `skipInbox` rule that decided this inbox mail, when the mail arrived after the rule existed:
   * that mail is moved out of the inbox. Old mail a new rule re-sorts is not (the card offers that
   * separately, for the unread the person can see).
   */
  moveOutRule(reason: string, inbox: boolean, at: number): string | undefined {
    if (!inbox || !reason.startsWith('rule:')) return undefined
    const id = reason.slice(5)
    if (!this.byId.get(id)?.skipInbox) return undefined
    const since = this.filterSince.get(id)
    return since !== undefined && at >= since ? id : undefined
  }

  /** Is this an enabled `skipInbox` rule? (The card's "move the unread now" names one.) */
  isFilterRule(ruleId: string): boolean {
    return !!this.byId.get(ruleId)?.skipInbox
  }

  private recomputeIfNeeded(): void {
    if (this.disposed) return
    this.currentRev = computeRulesRev(this.file.current.doc.rules, this.identities, (name) => this.idForLabel(name))
    if (!this.started) return
    void this.recompute.start(this.currentRev).catch((error) => {
      this.deps.log?.warn('mail sort recompute failed', { error: String(error) })
    })
  }

  get rulesRev(): string {
    return this.currentRev
  }

  get fileRev(): string {
    return this.file.current.fileRev
  }

  get rulesPath(): string {
    return this.file.path
  }

  get fileExists(): boolean {
    return this.file.current.exists
  }

  get rulesError(): RulesError | undefined {
    return this.file.current.error
  }

  /** The rules in use (the file, or the last good copy of it). */
  rules(): RulesFileDoc {
    return this.file.current.doc
  }

  compiledRules(): CompiledRule[] {
    return this.compiled
  }

  recomputing(): { done: number; total: number } | undefined {
    return this.recompute.progress()
  }

  /** Resolves when no recompute is running (tests). */
  idle(): Promise<void> {
    return this.recompute.idle()
  }

  /**
   * Where a correction may send mail: Important, Not important, then the groups that hold unread
   * mail in `pairs` (newest first) and every rule's named target. The model's groups come and go
   * with the unread mail, so this is read, never kept.
   */
  async catalog(pairs?: ReadonlyArray<FolderPair>): Promise<CatalogItem[]> {
    const out: CatalogItem[] = [
      { id: IMPORTANT, label: IMPORTANT_LABEL, source: 'reserved' },
      { id: NOT_IMPORTANT, label: NOT_IMPORTANT_LABEL, source: 'reserved' },
    ]
    const seen = new Set<string>([IMPORTANT, NOT_IMPORTANT])
    const scope = pairs ?? await this.inboxFolderPairs()
    const rows = await this.deps.store.sort.unreadGroups(scope).catch(() => [])
    const groups = new Map<string, { label: string; newest: number }>()
    for (const row of rows) {
      if (!row.grp.startsWith('u:')) continue
      const held = groups.get(row.grp)
      const newest = Math.max(held?.newest ?? 0, row.newest_at ?? 0)
      groups.set(row.grp, { label: held?.label ?? row.label ?? row.grp.slice(2), newest })
    }
    for (const [id, group] of [...groups.entries()].sort((a, b) => b[1].newest - a[1].newest)) {
      seen.add(id)
      out.push({ id, label: this.labelOf(id, group.label), source: 'group' })
    }
    for (const rule of this.rules().rules) {
      const id = this.idForLabel(rule.then)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, label: this.labelOf(id, rule.then.trim()), source: 'rule' })
    }
    return out
  }

  /** A group's name: the person's rename, else what the row stored (model label, rule, sender). */
  labelOf(groupId: GroupId, stored?: string | null): string {
    return labelOfBuiltin(groupId) ?? this.overrides.get(groupId) ?? (stored?.trim() || groupId.replace(/^[us]:/, ''))
  }

  isRenamed(groupId: GroupId): boolean {
    return this.overrides.has(groupId)
  }

  /** The id a name resolves to: a renamed group's new name finds that group, else the slug. */
  idForLabel(name: string): GroupId {
    const reserved = reservedGroupId(name)
    if (reserved) return reserved
    const lower = name.trim().toLowerCase()
    for (const [id, label] of this.overrides) if (label.toLowerCase() === lower) return id
    return groupIdForName(name)
  }

  /** Rename a group (`PUT /groups/:id/label`). The model is told the new name and keeps to it. */
  async renameGroup(groupId: GroupId, name: string): Promise<{ ok: true; label: string } | { ok: false; message: string }> {
    const label = name.replace(/\s+/g, ' ').trim()
    if (!groupId.startsWith('u:') && !groupId.startsWith('s:')) return { ok: false, message: 'Only a group can be renamed.' }
    if (!label) return { ok: false, message: 'A group needs a name.' }
    if (label.length > MAX_AI_LABEL_CHARS + 8) return { ok: false, message: `A group name is at most ${MAX_AI_LABEL_CHARS + 8} characters.` }
    if (reservedGroupId(label)) return { ok: false, message: `${label} is not a group name.` }
    // Taken: another group's rename, or the name of a group on screen now (the model's, or a rule's).
    const lower = label.toLowerCase()
    const renamed = [...this.overrides.entries()].find(([id, one]) => id !== groupId && one.toLowerCase() === lower)?.[1]
    const shown = renamed ? undefined : (await this.catalog().catch(() => []))
      .find((one) => one.source !== 'reserved' && one.id !== groupId && one.label.toLowerCase() === lower)?.label
    const taken = renamed ?? shown
    if (taken) return { ok: false, message: `Another group is already called ${taken}.` }
    await this.deps.store.sort.setLabelOverride(groupId, label, (this.deps.now ?? Date.now)())
    this.overrides.set(groupId, label)
    this.onRulesFile(this.file.current)
    this.notifyGroupsChanged(await this.inboxFolderPairs())
    return { ok: true, label }
  }

  accountLabel(accountId: string): string {
    return this.accountLabels.get(accountId) ?? accountId
  }

  summarize(rule: Pick<Rule, 'when' | 'then' | 'label'>): string {
    return summarizeRule(rule, { accountLabel: (id) => this.accountLabel(id) })
  }

  /** `PUT /rules`. On success the new rules are live and the recompute has started. */
  async saveRules(
    input: { groups: unknown; rules: unknown },
    baseRev: string,
    touch?: { accountId: string; messageId: string },
  ): Promise<RulesSaveOutcome & { rulesRev?: string }> {
    const outcome = await this.file.save(input, baseRev)
    if (!outcome.ok) return outcome
    if (touch) await this.reclassify(touch.accountId, [touch.messageId])
    return { ...outcome, rulesRev: this.currentRev }
  }

  initRules(): Promise<RulesSaveOutcome> {
    return this.file.init()
  }

  restoreRules(): Promise<RulesSaveOutcome> {
    return this.file.restore()
  }

  /** Re-read the rules file now (tests, and Settings' Reload). */
  reloadRules(): Promise<void> {
    return this.file.check()
  }

  // ── per message ──

  private identityFor(accountId: string): AccountIdentity {
    return this.identities.get(accountId) ?? { address: '', displayName: '', separatesCc: false }
  }

  /** Features of one cached row (with its hints joined, as every scan returns it). */
  features(row: ScanRow): SortFeatures {
    const features = featuresOf(
      row,
      parseJson<MessagePayload>(row.payload, {}),
      hintsOf(row),
      this.identityFor(row.account_id),
      this.correspondents.get(row.account_id),
    )
    if (row.ai_label) features.aiGroup = this.idForLabel(row.ai_label)
    return features
  }

  /** Classify under the rules in use, or under a candidate rule list (preview, propose). */
  classifyWith(features: SortFeatures, rules: ReadonlyArray<CompiledRule> = this.compiled): ClassifyResult {
    return classify(features, rules)
  }

  /**
   * The final verdict, from the person's rules, the model's label and the simple rules, in that
   * order of authority:
   * 1. a rule that names Important or a group decides outright;
   * 2. a rule that says Not important keeps the model's group (or the sender's, without one);
   * 3. the model's verdict, when it has given one (a stale one still counts until relabeled);
   * 4. unread inbox mail the model has not seen yet waits in Important ("Sorting");
   * 5. otherwise the built-ins: Important, or the sender's own group.
   */
  private compose(input: ComposeInput): { group: GroupId; reason: string; label: string } {
    const { features, base, ai } = input
    const key = senderKey(features.fromAddr, features.fromName)
    const bySender = { group: senderGroupId(key), label: senderLabel(features.fromAddr, features.fromName) }
    const aiLabel = ai?.ai_label?.trim() || null
    const aiGroup = aiLabel ? { group: this.idForLabel(aiLabel), label: aiLabel } : null
    if (base.ruleId && base.group !== NOT_IMPORTANT) {
      if (base.group === IMPORTANT) return { group: IMPORTANT, reason: base.reason, label: IMPORTANT_LABEL }
      const rule = this.byId.get(base.ruleId)
      return { group: base.group, reason: base.reason, label: rule?.label ?? base.group.slice(2) }
    }
    if (base.ruleId) return { ...(aiGroup ?? bySender), reason: base.reason }
    if (ai && ai.ai_rev && ai.ai_important !== null && ai.ai_important !== undefined) {
      if (ai.ai_important === 1) return { group: IMPORTANT, reason: AI_REASON, label: IMPORTANT_LABEL }
      return { ...(aiGroup ?? bySender), reason: AI_REASON }
    }
    if (input.unread && input.inbox && !ai?.ai_rev && this.labeler.wants(input.at)) {
      return { group: IMPORTANT, reason: AI_PENDING_REASON, label: IMPORTANT_LABEL }
    }
    if (base.group === IMPORTANT) return { group: IMPORTANT, reason: base.reason, label: IMPORTANT_LABEL }
    return { ...bySender, reason: base.reason }
  }

  verdictOf(row: ScanRow): Verdict {
    const features = this.features(row)
    const verdict = this.compose({
      features,
      base: classify(features, this.compiled),
      ai: row,
      unread: Number(row.seen) === 0,
      inbox: row.mailbox_role === 'inbox',
      at: row.received_at ?? row.sent_at,
    })
    return {
      rowid: row.rowid,
      group: verdict.group,
      reason: verdict.reason,
      rev: this.currentRev,
      senderKey: senderKey(features.fromAddr, features.fromName),
      label: verdict.label,
    }
  }

  /** The `sort` DTO field for a stored verdict. NULL group = still sorting, shown in Important. */
  sortDtoOf(row: { sort_group?: string | null; sort_reason?: string | null; sort_label?: string | null; ai_why?: string | null }): SortDto {
    const reason = row.sort_reason ?? ''
    if (!row.sort_group) return { group: IMPORTANT, label: IMPORTANT_LABEL, reason: AI_PENDING_REASON, why: whyOf(null) }
    const ruleId = reason.startsWith('rule:') ? reason.slice(5) : undefined
    const rule = ruleId ? this.byId.get(ruleId) : undefined
    return {
      group: row.sort_group,
      label: this.labelOf(row.sort_group, row.sort_label),
      reason,
      why: whyOf(
        reason,
        rule ? { source: rule.source, ...(rule.note ? { note: rule.note } : {}), ...(rule.summary ? { summary: rule.summary } : {}) } : undefined,
        row.ai_why,
      ),
      ...(ruleId ? { ruleId } : {}),
    }
  }

  /**
   * For one ingest page: a function from a row write to its sort columns, with the page's hints and
   * stored model verdicts read in one query each. Sent mail also teaches the correspondents set.
   */
  async prepareIngest(accountId: string, envelopes: ReadonlyArray<MailEnvelope>): Promise<(write: {
    messageId: string; mailboxId: string; rfcMessageId: string; fromAddr: string; subject: string; payload: string
    flagsJson?: string; sentAt?: number; receivedAt?: number | null
  }) => SortColumns> {
    await this.start().catch(() => undefined)
    const byFolder = new Map<string, string[]>()
    for (const envelope of envelopes) {
      const list = byFolder.get(envelope.mailboxId) ?? []
      list.push(envelope.messageId)
      byFolder.set(envelope.mailboxId, list)
    }
    const hints = new Map<string, SortHints | undefined>()
    for (const [mailboxId, ids] of byFolder) {
      for (const row of await this.deps.store.sort.getHints(accountId, mailboxId, ids).catch(() => [])) {
        hints.set(`${row.mailbox_id}\u0000${row.message_id}`, hintsOf(row))
      }
    }
    // A row the model already labeled keeps that label when a flag or a move re-sorts it.
    const ai = new Map<string, AiColumns>()
    const ids = envelopes.map((one) => one.messageId)
    for (const row of await this.deps.store.sort.aiVerdictsOf(accountId, ids).catch(() => [])) ai.set(row.message_id, row)
    const [sent, inbox] = await Promise.all([this.sentFolders(), this.inboxFolders()])
    return (write) => {
      const payload = parseJson<MessagePayload>(write.payload, {})
      if (sent.has(`${accountId}\u0000${write.mailboxId}`)) this.learnCorrespondents(accountId, payload)
      if (!this.withCc.has(accountId) && payload.cc?.length) this.withCc.add(accountId)
      const features = featuresOf(
        { account_id: accountId, rfc_message_id: write.rfcMessageId, from_addr: write.fromAddr, subject: write.subject },
        payload,
        hints.get(`${write.mailboxId}\u0000${write.messageId}`),
        this.identityFor(accountId),
        this.correspondents.get(accountId),
      )
      const stored = ai.get(write.messageId)
      if (stored?.ai_label) features.aiGroup = this.idForLabel(stored.ai_label)
      const inInbox = inbox.has(`${accountId}\u0000${write.mailboxId}`)
      const at = write.receivedAt ?? write.sentAt ?? (this.deps.now ?? Date.now)()
      const verdict = this.compose({
        features,
        base: classify(features, this.compiled),
        ai: stored ?? null,
        unread: unreadOf(write.flagsJson),
        inbox: inInbox,
        at,
      })
      const moveOut = this.moveOutRule(verdict.reason, inInbox, at)
      return {
        ...verdict, rev: this.currentRev, senderKey: senderKey(features.fromAddr, features.fromName),
        ...(moveOut ? { moveOut } : {}),
      }
    }
  }

  // ── the model's labels ──

  /** What the labeler asks under: the person, their notes, and the names in use. */
  private async labelContext(): Promise<LabelContext> {
    const me = [...this.identities.values()]
      .map((one) => ({ name: one.displayName, address: one.address }))
      .filter((one) => one.name || one.address)
    const notes: string[] = []
    for (const rule of this.rules().rules) {
      if (rule.enabled === false) continue
      const summary = this.summarize(rule)
      notes.push(rule.note?.trim() ? `${rule.note.trim()} (rule: ${summary})` : `Rule: ${summary}`)
    }
    const recent = await this.deps.store.sort.recentLabels(40).catch(() => [])
    const names = new Map<string, string>()
    const add = (name: string | undefined) => {
      const text = name?.trim()
      if (text && !reservedGroupId(text) && !names.has(text.toLowerCase())) names.set(text.toLowerCase(), text)
    }
    for (const label of this.overrides.values()) add(label)
    for (const rule of this.rules().rules) add(rule.then)
    for (const label of recent) add(this.labelOf(this.idForLabel(label), label))
    return {
      rev: this.aiRev(),
      me,
      notes,
      groups: [...names.values()],
      // Without the model's label: a `group` rule depends on the label, so it never skips the model.
      decides: (row) => {
        const { aiGroup: _label, ...features } = this.features(row)
        const base = classify(features, this.compiled)
        return !!base.ruleId && base.group !== NOT_IMPORTANT
      },
      features: (row) => this.features(row),
    }
  }

  aiRev(): string {
    return computeAiRev(this.rules().rules, this.identities)
  }

  /** The groups (across every inbox) due a new one-line summary, each with its newest unread mail. */
  private async summaryPlan(): Promise<Array<{ digest: GroupDigest; input: SummaryGroupInput }>> {
    const pairs = await this.inboxFolderPairs()
    if (pairs.length === 0) return []
    const [digests, stored] = await Promise.all([
      this.deps.store.summaries.digests(pairs),
      this.deps.store.summaries.stored(),
    ])
    const due = staleGroups(digests, stored, (this.deps.now ?? Date.now)())
    if (due.length === 0) return []
    const rows = await this.deps.store.summaries.samples(pairs, due.map((one) => one.id), SUMMARY_MAILS)
    const mails = new Map<string, SummaryGroupInput['mails']>()
    for (const row of rows) {
      const list = mails.get(row.grp) ?? []
      list.push({ from: senderLabel(row.from_addr, row.from_name), subject: row.subject, ...(row.snippet ? { text: row.snippet } : {}) })
      mails.set(row.grp, list)
    }
    return due.map((digest) => ({ digest, input: { label: this.labelOf(digest.id, digest.label), mails: mails.get(digest.id) ?? [] } }))
  }

  /** Re-sort rows the labeler just answered for. */
  private async resort(rows: ReadonlyArray<ScanRow>): Promise<void> {
    if (rows.length === 0) return
    const verdicts = rows.map((row) => this.verdictOf(row))
    await this.deps.store.sort.applyVerdicts(verdicts)
    this.moveOutOf(rows, verdicts)
    this.notifyGroupsChanged(pairsOfRows(rows), false)
  }

  /**
   * Hand the rows a `skipInbox` rule now decides to the mover. A `group` rule can only decide once
   * the model has labeled the mail, which is after ingest, so the labeler's re-sort is where most
   * new mail meets its filter.
   */
  private moveOutOf(rows: ReadonlyArray<ScanRow>, verdicts: ReadonlyArray<Verdict>): void {
    if (!this.moveSink) return
    const requests = rows.flatMap((row, n) => {
      const ruleId = this.moveOutRule(verdicts[n]!.reason, row.mailbox_role === 'inbox', row.received_at ?? row.sent_at)
      return ruleId ? [{ accountId: row.account_id, messageId: row.message_id, mailboxId: row.mailbox_id, ruleId }] : []
    })
    if (requests.length > 0) this.moveSink(requests)
  }

  /** Where re-sorted mail a filter decides goes (mail-filter-moves.ts), set once at activation. */
  setMoveSink(sink: ((requests: Array<{ accountId: string; messageId: string; mailboxId: string; ruleId: string }>) => void) | null): void {
    this.moveSink = sink
  }

  /** The labeler went down: every row waiting for it goes onto the simple rules now. */
  private async releasePending(): Promise<void> {
    for (;;) {
      const rows = await this.deps.store.sort.rowsByReason(AI_PENDING_REASON, 500)
      if (rows.length === 0) return
      await this.resort(rows)
      if (rows.length < 500) return
    }
  }

  /** The labeler's state and the unread still waiting for it, for one scope. */
  async aiStatus(pairs: ReadonlyArray<FolderPair>): Promise<AiStatus> {
    const state = this.labeler.state()
    const pending = state === 'on' ? await this.deps.store.sort.pendingCount(pairs).catch(() => 0) : 0
    return { state, pending }
  }

  /** Label now and wait for it (tests, and the fixture's `/__fixture` hooks). */
  labelNow(): Promise<void> {
    return this.labeler.runNow()
  }

  private learnCorrespondents(accountId: string, payload: MessagePayload): void {
    const keys = correspondentKeysOf(payload)
    if (keys.length === 0) return
    let set = this.correspondents.get(accountId)
    if (!set) { set = new Set(); this.correspondents.set(accountId, set) }
    for (const key of keys) set.add(key)
  }

  private async inboxFolders(): Promise<Set<string>> {
    const now = Date.now()
    if (this.inboxPairs && now - this.inboxPairs.at < SENT_ROLES_TTL_MS) return this.inboxPairs.keys
    const rows = await this.deps.store.mailboxesByRole('inbox').catch(() => [])
    const keys = new Set(rows.map((row) => `${row.account_id}\u0000${row.mailbox_id}`))
    // An empty answer is not kept: at boot the folder list may not be in yet, and a cached "no inbox"
    // would treat the first minute of mail as not in an inbox.
    this.inboxPairs = keys.size > 0 ? { at: now, keys } : null
    return keys
  }

  /** The sync re-listed an account's folders and a role moved: read the inbox and sent sets again. */
  foldersChanged(): void {
    this.inboxPairs = null
    this.sentPairs = null
  }

  private async inboxFolderPairs(): Promise<FolderPair[]> {
    const keys = await this.inboxFolders()
    return [...keys].map((key) => {
      const [accountId, mailboxId] = key.split('\u0000')
      return { accountId: accountId!, mailboxId: mailboxId! }
    })
  }

  private async sentFolders(): Promise<Set<string>> {
    const now = Date.now()
    if (this.sentPairs && now - this.sentPairs.at < SENT_ROLES_TTL_MS) return this.sentPairs.keys
    const rows = await this.deps.store.mailboxesByRole('sent').catch(() => [])
    const keys = new Set(rows.map((row) => `${row.account_id}\u0000${row.mailbox_id}`))
    this.sentPairs = { at: now, keys }
    return keys
  }

  /** Re-sort these rows now (a hint arrived, a rule was saved with `touch`). */
  async reclassify(accountId: string, messageIds: ReadonlyArray<string>): Promise<number> {
    if (messageIds.length === 0) return 0
    await this.start().catch(() => undefined)
    const rows = await this.deps.store.sort.rowsByIds(accountId, messageIds)
    if (rows.length === 0) return 0
    const verdicts = rows.map((row) => this.verdictOf(row))
    const changed = await this.deps.store.sort.applyVerdicts(verdicts)
    this.moveOutOf(rows, verdicts)
    this.notifyGroupsChanged(pairsOfRows(rows))
    return changed
  }

  /** Store the provider's category lists and re-sort only the rows whose category moved. */
  async applyCategoryHints(accountId: string, mailboxId: string, lists: { promotions: string[]; social: string[] }): Promise<number> {
    const changed = await this.deps.store.sort.setGmailCategory(accountId, mailboxId, {
      promotions: Array.isArray(lists.promotions) ? lists.promotions.filter((id) => typeof id === 'string') : [],
      social: Array.isArray(lists.social) ? lists.social.filter((id) => typeof id === 'string') : [],
    })
    if (changed.length === 0) return 0
    return this.reclassify(accountId, changed)
  }

  /** Store late-fetched list headers (`null` = checked, none) and re-sort those rows. */
  async applyListHeaders(
    accountId: string,
    mailboxId: string,
    entries: ReadonlyArray<{ messageId: string; headers: MailListHeaders | null }>,
  ): Promise<number> {
    if (entries.length === 0) return 0
    await this.deps.store.sort.setListHeaders(accountId, mailboxId, entries, (this.deps.now ?? Date.now)())
    return this.reclassify(accountId, entries.map((one) => one.messageId))
  }

  /** Group counts moved in these folders; new or changed unread mail also wakes the labeler. */
  notifyGroupsChanged(pairs: ReadonlyArray<FolderPair>, label = true): void {
    if (pairs.length > 0) this.deps.events?.groupsChanged(pairs)
    if (label) this.labeler.schedule()
  }

  /** Can this account's read flags change? Unknown providers count as no. */
  canMarkRead(accountId: string): boolean {
    return this.deps.canMarkRead?.(accountId) ?? false
  }

  // ── the Grouped / All mail switch (the server's mirror of it) ──

  groupedOn(): boolean {
    return this.grouped
  }

  async setGroupedOn(on: boolean): Promise<void> {
    this.grouped = on
    await this.deps.store.tasks.setMeta(GROUPED_META_KEY, on ? '1' : '0')
  }

  dispose(): void {
    this.disposed = true
    this.file.dispose()
    this.recompute.dispose()
    this.labeler.dispose()
  }
}

function pairsOfRows(rows: ReadonlyArray<{ account_id: string; mailbox_id: string }>): FolderPair[] {
  const pairs = new Map<string, FolderPair>()
  for (const row of rows) pairs.set(`${row.account_id}\u0000${row.mailbox_id}`, { accountId: row.account_id, mailboxId: row.mailbox_id })
  return [...pairs.values()]
}

/** The event names this engine emits, for the one test that lists them. */
export const SORT_EVENTS = [
  MAIL_EVENT.groupsChanged, MAIL_EVENT.sortProgress, MAIL_EVENT.sorted, MAIL_EVENT.rulesChanged,
] as const
