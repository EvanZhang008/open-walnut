/**
 * The shared shapes of inbox sorting: the features one message is classified on, the rules file,
 * and every wire shape the sort routes answer with. Types only, so any file (server or test) can
 * import it without pulling in I/O.
 */
import type { MailAddress } from './types.js'

/** A fact that may be missing from the cache: `unknown` is never evidence either way. */
export type Tri = true | false | 'unknown'

/** `bulk` and `transactional` together are "automated". */
export type SenderKind = 'person' | 'bulk' | 'transactional' | 'unknown'

/** What one cached message is classified on (spec 5.1). Built by sort-features.ts. */
export interface SortFeatures {
  accountId: string
  rfcMessageId: string
  /** Lowercased; empty for display-name-only rows (the Outlook shape). */
  fromAddr: string
  fromName: string
  subject: string
  /** Lowercased `List-Id`, when any source carried one. */
  listId?: string
  hasListUnsubscribe: boolean
  /** Lowercased `Precedence`. */
  precedence?: string
  /** Lowercased `Auto-Submitted`; `no` is dropped (it means "not automated"). */
  autoSubmitted?: string
  /** To + Cc as cached; undefined when the row carries neither. */
  recipients?: MailAddress[]
  addressedToMe: Tri
  onlyCc: Tri
  senderKind: SenderKind
  gmailCategory?: 'promotions' | 'social'
  /** The sender is among the people this account has written to (cached Sent). */
  correspondent: boolean
  /** The group id the model's label resolves to, once it has labeled this mail (a `group` rule reads it). */
  aiGroup?: GroupId
}

/** `important`, `u:<slug>` (a label the model or a rule named) or `s:<senderKey>` (one sender). */
export type GroupId = string

export type RuleSenderValue = 'person' | 'bulk' | 'transactional' | 'automated' | 'unknown'

/** A rule condition (spec 5.5). Every present field must hold (AND). */
export interface RuleWhen {
  from?: string | string[]
  subject?: string | { re: string }
  listId?: string
  addressedToMe?: boolean
  cc?: true
  sender?: RuleSenderValue
  account?: string
  message?: string
  /** Mail the model grouped under this name (a correction made on a whole group). */
  group?: string
}

export type RuleSource = 'user' | 'learned'

export interface Rule {
  id?: string
  when: RuleWhen
  /** A group NAME (or `Important`), never an id. */
  then: string
  source: RuleSource
  note?: string
  /** `YYYY-MM-DD`. */
  created?: string
  /** Default true. */
  enabled?: boolean
  /** Server-written human summary for message rules. */
  label?: string
  /**
   * Keep matching mail out of the inbox: Walnut moves it to the account's archive as it arrives,
   * unread (mail-filter-moves.ts). Only with a group `then`, so a move that fails still has a group.
   */
  skipInbox?: boolean
}

/** The rules file, parsed (spec 5.6). */
export interface RulesFileDoc {
  version: 1
  groups: string[]
  rules: Rule[]
}

/** One rule ready to evaluate: its condition compiled, its target resolved to a group id. */
export interface CompiledRule {
  /** The file id, or a derived stable one for a hand-written rule without `id`. */
  id: string
  index: number
  group: GroupId
  /** The rule's `then`, trimmed: what its group is called. */
  label?: string
  source: RuleSource
  note?: string
  summary?: string
  /** The rule's `skipInbox`: new inbox mail it decides is moved to the archive. */
  skipInbox?: boolean
  match: (features: SortFeatures) => boolean
}

/**
 * What classify answers: `important` or `not-important` from a built-in, or a rule's own target
 * (`important`, `not-important`, `u:<slug>`). `reason` is `builtin:<name>` or `rule:<id>`.
 */
export interface ClassifyResult {
  group: GroupId
  reason: string
  ruleId?: string
}

/** The request scope: one inbox, or every inbox. */
export type GroupsScope = { role: 'inbox' } | { accountId: string; mailboxId: string }

export interface FolderPair {
  accountId: string
  mailboxId: string
}

/** Newest mail of a group when a button was drawn: bulk actions touch only mail at or before it. */
export interface Watermark {
  at: number
  seq: number
}

// ── GET /groups ──

export interface GroupSenderPreview {
  key: string
  label: string
  unread: number
}

/** One group row: ONLY unread mail counts, and a group with none is not listed at all. */
export interface GroupItem {
  id: GroupId
  label: string
  /** The person renamed this group; the model's later words for it do not replace this label. */
  renamed?: boolean
  unread: number
  /** Newest unread mail's time. */
  newestAt: number
  topSenders: GroupSenderPreview[]
  /** Distinct senders of this group's unread with an unsubscribe option. */
  unsubscribable: number
  /** Unread mail on accounts that can change read flags. */
  markableUnread: number
  /** Labels of accounts in this group whose read flags cannot change. */
  readOnlyAccounts: string[]
  watermark: Watermark
  /**
   * The line under the name: what the unread mail is about (sort-group-summary.ts). The model's
   * words when `summaryBy` is `ai`, otherwise the newest unread subject; empty when there is neither.
   */
  summary: string
  summaryBy?: 'ai'
  /** Labels of accounts in this group whose mail Walnut cannot move to an archive. */
  cannotArchive?: string[]
}

export interface RulesError {
  line?: number
  rule?: { index: number; id?: string }
  message: string
  /** Epoch ms the last good rules date from. */
  since: number
}

/**
 * The labeler's state for the header: `on` = the model sorts new unread mail; `down` = its last call
 * failed and the rows fell back to the simple rules until it answers again; `off` = no model call is
 * available on this Walnut at all.
 */
export interface AiStatus {
  state: 'on' | 'down' | 'off'
  /** Unread mail in scope waiting for the model (shown in Important meanwhile). */
  pending: number
}

export interface GroupsResponse {
  rulesRev: string
  /** max(rowid) in scope at read time. */
  seq: number
  recomputing?: { done: number; total: number }
  rulesError?: RulesError
  ai: AiStatus
  important: { total: number; unread: number }
  cachedTotal: number
  cachedUnread: number
  /** From the mailbox rows (the provider's numbers). */
  providerTotal: number
  providerUnread: number
  /** The answer is the last one computed: this read ran out of budget. */
  stale?: boolean
  /** Newest unread first. */
  groups: GroupItem[]
}

export interface GroupsSummary {
  importantUnread: number
  sortedUnread: number
  pending: number
  rulesRev: string
}

// ── /messages?group= ──

export interface SortDto {
  group: GroupId
  /** What the group is called (`Important` for Important). */
  label: string
  reason: string
  /** The ready sentence the reader head shows. */
  why: string
  ruleId?: string
}

// ── rules routes ──

/** A destination a correction may pick: the two reserved ones, then groups in use and rule targets. */
export interface CatalogItem {
  id: GroupId
  label: string
  source: 'reserved' | 'group' | 'rule'
}

export interface RuleView extends Rule {
  id: string
  summary: string
}

export interface RulesResponse {
  /** Absolute path of the rules file, as the server resolves it. */
  path: string
  exists: boolean
  rulesRev: string
  /** Hash of the file bytes: the `baseRev` a PUT must quote. */
  fileRev: string
  groups: string[]
  rules: RuleView[]
  builtins: Array<{ id: string; summary: string; then: string }>
  catalog: CatalogItem[]
  error?: RulesError
}

/** One validation failure; `PUT /rules` answers 400 with a list of these. */
export interface RuleValidationError {
  /** Rule index, or -1 for a file-level problem (`groups`, `version`). */
  index: number
  field: string
  message: string
  line?: number
  id?: string
}

export interface Sample {
  accountId: string
  messageId: string
  sender: string
  subject: string
  at: number
  currentGroup: GroupId
}

export interface Shadow {
  ruleId: string
  summary: string
  mails: number
}

export interface PreviewRequest {
  scope: GroupsScope
  when: RuleWhen
  then: string
  insertAt?: number
}

export interface PreviewResponse {
  matches: number
  moves: number
  samples: Sample[]
  shadows: Shadow[]
  recipientsKnown?: { known: number; of: number }
  partial?: boolean
}

export type DraftKind = 'sender' | 'sender-subject' | 'sender-direct' | 'sender-not-direct' | 'message'

export interface ProposeDraft {
  kind: DraftKind
  when: RuleWhen
  then: string
  summary: string
  label?: string
  matches: number
  moves: number
  samples: Sample[]
  shadows: Shadow[]
}

export type ModelStatus = 'ok' | 'skipped' | 'unavailable' | 'invalid' | 'timeout'

export interface ProposeResponse {
  drafts: ProposeDraft[]
  recipients: { thisMail: 'known' | 'unknown'; known: number; of: number }
  model: {
    status: ModelStatus
    reason?: string
    draft?: { when: RuleWhen; then: string; summary: string; matches: number; moves: number }
  }
}

/** The dependencies of `registerMailSortWriteRoutes` (routes-sort-write.ts). */
export interface MailSortWriteDeps {
  walnut: import('../../core/plugins/server-api.js').WalnutServerPluginApi
  store: import('./store.js').MailStore
  service: import('./service.js').MailService
  providers: import('./provider-registry.js').MailProviderRegistry
  unsubscribe: import('./unsubscribe.js').MailUnsubscribe
  events: import('./events.js').MailEvents
  sort: import('./sort-engine.js').MailSortEngine
  /** "Keep out of the inbox" moves; absent in tests that do not reach them. */
  filters?: Pick<import('./mail-filter-moves.js').MailFilterMover, 'queue' | 'runNow' | 'canArchive'>
}
