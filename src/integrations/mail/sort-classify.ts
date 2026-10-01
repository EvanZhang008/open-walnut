/**
 * The classifier: one message's features plus the rule list in, one IMPORTANCE verdict out. Pure,
 * no I/O.
 *
 * There are no built-in groups. What a mail is grouped under is the model's call (sort-ai.ts), or a
 * person's rule; this file only answers "does this need the person", which is what every row the
 * model has not labeled yet (read history, a model that is down) falls back on. The engine composes
 * the final verdict (sort-engine.ts `verdictOf`).
 *
 * User and learned rules always run first (file order, first match wins), then the eight built-ins.
 * `unknown` recipients are never evidence: no rule treats a missing recipient list as "not addressed
 * to me".
 */
import { compileSubjectPattern } from './sort-regex-safety.js'
import type { ClassifyResult, CompiledRule, GroupId, SortFeatures } from './sort-types.js'

/** Bump when the built-in table below changes: every cached verdict is then recomputed. */
export const BUILTIN_REV = 3

export const IMPORTANT = 'important'
/** A rule's "not important, let Walnut pick the group" (and every built-in's no). Never stored. */
export const NOT_IMPORTANT = 'not-important'
export const IMPORTANT_LABEL = 'Important'
export const NOT_IMPORTANT_LABEL = 'Not important'

/** Names a rule's `then` may use for the two reserved destinations, compared case-insensitively. */
const RESERVED: Record<string, GroupId> = {
  important: IMPORTANT,
  'not important': NOT_IMPORTANT,
}

export function reservedGroupId(name: string): GroupId | undefined {
  return RESERVED[name.trim().toLowerCase()]
}

/** `u:<slug>`: lowercased, every run of non letters/digits becomes one `-`. */
export function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
}

/** The group id a `then` name (or a model label) resolves to (reserved names first). */
export function groupIdForName(name: string): GroupId {
  return reservedGroupId(name) ?? `u:${slugOf(name)}`
}

/** The group of one sender, for not-important mail no model has labeled. */
export function senderGroupId(senderKey: string): GroupId {
  return `s:${senderKey}`
}

/**
 * Whether a string from a request can be a stored group id: `important`, `u:<slug>`, or
 * `s:<sender key>` (an address, `name:<display name>` or `unknown`, so spaces, `@` and `.` are
 * allowed there). Shape only: whether the group holds any mail is the query's business.
 */
export function isGroupIdShape(value: string): boolean {
  if (value === IMPORTANT) return true
  if (/^u:[\p{L}\p{N}-]{1,80}$/u.test(value)) return true
  // eslint-disable-next-line no-control-regex
  return /^s:[^\u0000-\u001f\u007f]{1,320}$/u.test(value)
}

export function labelOfBuiltin(id: GroupId): string | undefined {
  if (id === IMPORTANT) return IMPORTANT_LABEL
  if (id === NOT_IMPORTANT) return NOT_IMPORTANT_LABEL
  return undefined
}

export interface BuiltinRule {
  id: string
  reason: string
  important: boolean
  why: string
  test: (features: SortFeatures) => boolean
}

/** In order. The `why` is what the reader head says when this rule decided. */
export const BUILTIN_RULES: ReadonlyArray<BuiltinRule> = [
  {
    id: 'b-correspondent', reason: 'builtin:correspondent', important: true,
    why: 'You have written to this sender',
    test: (f) => f.correspondent && f.addressedToMe === true,
  },
  {
    id: 'b-bulk', reason: 'builtin:bulk', important: false, why: 'Marketing sender',
    test: (f) => f.senderKind === 'bulk',
  },
  {
    id: 'b-transactional', reason: 'builtin:transactional', important: false, why: 'Automated notice',
    test: (f) => f.senderKind === 'transactional',
  },
  {
    id: 'b-list', reason: 'builtin:list', important: false, why: 'Mailing list',
    test: (f) => f.hasListUnsubscribe || !!f.listId,
  },
  {
    id: 'b-group-alias', reason: 'builtin:group-alias', important: false, why: 'Sent to a group, not to you',
    test: (f) => f.senderKind === 'person' && f.addressedToMe === false,
  },
  {
    id: 'b-direct', reason: 'builtin:direct', important: true, why: 'To you directly',
    test: (f) => f.senderKind === 'person' && f.addressedToMe === true,
  },
  {
    id: 'b-person', reason: 'builtin:person', important: true, why: 'From a person',
    test: (f) => f.senderKind === 'person' && f.addressedToMe === 'unknown',
  },
  {
    id: 'b-unknown', reason: 'builtin:unsure', important: false, why: "Walnut can't tell who sent this",
    test: () => true,
  },
]

/** First matching user/learned rule, else the first matching built-in. */
export function classify(features: SortFeatures, rules: ReadonlyArray<CompiledRule>): ClassifyResult {
  for (const rule of rules) {
    if (rule.match(features)) return { group: rule.group, reason: `rule:${rule.id}`, ruleId: rule.id }
  }
  for (const builtin of BUILTIN_RULES) {
    if (builtin.test(features)) return { group: builtin.important ? IMPORTANT : NOT_IMPORTANT, reason: builtin.reason }
  }
  return { group: NOT_IMPORTANT, reason: 'builtin:unsure' }
}

// ── compiling a rule condition ──

/** A glob (`*` = any run of characters) as an anchored, case-insensitive test. */
export function globTest(pattern: string): (value: string) => boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  const regex = new RegExp(`^${source}$`, 'is')
  return (value) => regex.test(value)
}

/**
 * One `from` pattern. With an `@` it matches the address (`@domain` = any address at that domain);
 * without one it matches the whole display name, whitespace collapsed, so a name-only row can be
 * named.
 */
export function fromTest(pattern: string): (features: SortFeatures) => boolean {
  const trimmed = pattern.trim()
  if (trimmed.includes('@')) {
    const test = globTest(trimmed.startsWith('@') ? `*${trimmed}` : trimmed)
    return (f) => !!f.fromAddr && test(f.fromAddr.toLowerCase())
  }
  const test = globTest(trimmed.replace(/\s+/g, ' '))
  return (f) => !!f.fromName && test(f.fromName.trim().replace(/\s+/g, ' '))
}

/**
 * The condition as one predicate. Assumes the rule already passed validation
 * (sort-rules-schema.ts): an unsafe pattern here throws rather than being run.
 */
export function compileWhen(
  when: import('./sort-types.js').RuleWhen,
  /** How a group NAME becomes an id (the engine passes one that knows the person's renames). */
  groupId: (name: string) => GroupId = groupIdForName,
): (features: SortFeatures) => boolean {
  const tests: Array<(f: SortFeatures) => boolean> = []
  if (when.from !== undefined) {
    const each = (Array.isArray(when.from) ? when.from : [when.from]).map(fromTest)
    tests.push((f) => each.some((test) => test(f)))
  }
  if (typeof when.subject === 'string') {
    const needle = when.subject.toLowerCase()
    tests.push((f) => f.subject.slice(0, 300).toLowerCase().includes(needle))
  } else if (when.subject && typeof when.subject === 'object') {
    const compiled = compileSubjectPattern(when.subject.re)
    if (!compiled.ok) throw new Error(compiled.message)
    tests.push((f) => compiled.test(f.subject))
  }
  if (when.listId !== undefined) {
    const test = globTest(when.listId.toLowerCase())
    tests.push((f) => !!f.listId && test(f.listId.toLowerCase()))
  }
  if (when.addressedToMe !== undefined) {
    const wanted = when.addressedToMe
    tests.push((f) => f.addressedToMe === wanted)
  }
  if (when.cc === true) tests.push((f) => f.onlyCc === true)
  if (when.sender !== undefined) {
    const sender = when.sender
    tests.push(sender === 'automated'
      ? (f) => f.senderKind === 'bulk' || f.senderKind === 'transactional'
      : (f) => f.senderKind === sender)
  }
  if (when.account !== undefined) {
    const account = when.account
    tests.push((f) => f.accountId === account)
  }
  if (when.message !== undefined) {
    const message = when.message
    tests.push((f) => f.rfcMessageId === message)
  }
  if (when.group !== undefined) {
    const id = groupId(when.group)
    tests.push((f) => f.aiGroup === id)
  }
  // An empty condition never matches: validation refuses it, and this is the belt to that brace.
  if (tests.length === 0) return () => false
  return (f) => tests.every((test) => test(f))
}

/** A stable id for a rule written by hand without one (same rule, same place, same id). */
export function derivedRuleId(rule: import('./sort-types.js').Rule, index: number): string {
  const text = JSON.stringify([rule.when, rule.then, index])
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return `r-${hash.toString(16).padStart(8, '0').slice(0, 6)}`
}

/** Enabled rules, compiled, in file order. The doc must already be valid. */
export function compileRules(
  rules: ReadonlyArray<import('./sort-types.js').Rule>,
  summarize?: (rule: import('./sort-types.js').Rule) => string,
  groupId: (name: string) => GroupId = groupIdForName,
): CompiledRule[] {
  const out: CompiledRule[] = []
  rules.forEach((rule, index) => {
    if (rule.enabled === false) return
    out.push({
      id: rule.id ?? derivedRuleId(rule, index),
      index,
      group: groupId(rule.then),
      label: rule.then.trim(),
      source: rule.source,
      ...(rule.note ? { note: rule.note } : {}),
      ...(summarize ? { summary: summarize(rule) } : {}),
      ...(rule.skipInbox ? { skipInbox: true } : {}),
      match: compileWhen(rule.when, groupId),
    })
  })
  return out
}

// ── the why line ──

export const SORTING_WHY = 'Sorting\u2026'
export const AI_REASON = 'ai'
export const AI_PENDING_REASON = 'ai:pending'
const WHY_NOTE_CHARS = 60

/** The why sentence for a stored verdict (the reader head). Never repeats the group name. */
export function whyOf(
  reason: string | null | undefined,
  rule?: { source: 'user' | 'learned'; note?: string; summary?: string },
  aiWhy?: string | null,
): string {
  if (!reason || reason === AI_PENDING_REASON) return SORTING_WHY
  if (reason === AI_REASON) return aiWhy?.trim() || 'Sorted by Walnut'
  const builtin = BUILTIN_RULES.find((one) => one.reason === reason)
  if (builtin) return builtin.why
  if (!reason.startsWith('rule:')) return SORTING_WHY
  if (!rule) return 'Your rule'
  const text = (rule.note?.trim() || rule.summary?.trim() || '').replace(/\s+/g, ' ')
  const short = text.length > WHY_NOTE_CHARS ? `${text.slice(0, WHY_NOTE_CHARS).trimEnd()}\u2026` : text
  const lead = rule.source === 'learned' ? 'You taught Walnut' : 'Your rule'
  return short ? `${lead}: ${short}` : lead
}
