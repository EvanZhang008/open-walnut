/**
 * One sentence per rule, for Settings, the why line and the correction card. The server writes
 * these so every surface says the same thing. An `account` condition shows the account's display
 * name, never its id; a `message` rule shows its stored label.
 */
import { BUILTIN_RULES, IMPORTANT_LABEL, NOT_IMPORTANT_LABEL } from './sort-classify.js'
import type { Rule, RuleWhen } from './sort-types.js'

export interface SummaryContext {
  /** Display name of an account id (falls back to the id). */
  accountLabel?: (accountId: string) => string
}

const SENDER_WORDS: Record<string, string> = {
  person: 'from a person',
  bulk: 'from a marketing sender',
  transactional: 'from an automated notice sender',
  automated: 'from an automated sender',
  unknown: "from a sender Walnut can't place",
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** The condition alone, as a phrase starting with a capital letter. */
export function summarizeWhen(when: RuleWhen, ctx: SummaryContext = {}): string {
  const parts: string[] = []
  const froms = when.from === undefined ? [] : Array.isArray(when.from) ? when.from : [when.from]
  if (when.group !== undefined && froms.length === 0) parts.push(`Mail Walnut groups as ${when.group.trim()}`)
  else parts.push(froms.length > 0 ? `From ${joinOr(froms.map((one) => one.trim()))}` : 'Mail')
  if (when.group !== undefined && froms.length > 0) parts.push(`grouped as ${when.group.trim()}`)
  if (typeof when.subject === 'string') parts.push(`with "${when.subject}" in the subject`)
  else if (when.subject) parts.push(`with a subject matching /${when.subject.re}/`)
  if (when.listId) parts.push(`on the list ${when.listId}`)
  if (when.addressedToMe === true) parts.push('sent to you directly')
  if (when.addressedToMe === false) parts.push('sent to a group')
  if (when.cc === true) parts.push('where you are only in Cc')
  if (when.sender) parts.push(SENDER_WORDS[when.sender] ?? `from a ${when.sender} sender`)
  if (when.account) parts.push(`in ${ctx.accountLabel?.(when.account) ?? when.account}`)
  return parts.join(' ')
}

/** `Only one mail (id <12>)` when a message rule has no label. */
export function messageRuleLabel(rule: Pick<Rule, 'label' | 'when'>): string {
  if (rule.label?.trim()) return rule.label.trim()
  return `Only one mail (id ${(rule.when.message ?? '').slice(0, 12)})`
}

/** `From issues@* or noreply-oncall-notifications@* → On-call & tickets`. */
export function summarizeRule(rule: Pick<Rule, 'when' | 'then' | 'label'>, ctx: SummaryContext = {}): string {
  const target = rule.then.trim()
  if (rule.when.message) return `${messageRuleLabel(rule)} → ${target}`
  return `${summarizeWhen(rule.when, ctx)} → ${target}`
}

/** What Walnut does before (and without) the model: these decide only whether mail needs you. */
const BUILTIN_SUMMARIES: Record<string, string> = {
  'b-correspondent': 'From someone you have written to, sent to you directly',
  'b-bulk': 'From a marketing sender (marketing address, bulk mail header, or the provider says promotions)',
  'b-transactional': 'From an automated sender (no-reply and notice addresses, auto-generated mail)',
  'b-list': 'Mail from a mailing list',
  'b-group-alias': 'From a person, sent to a group you are not named in',
  'b-direct': 'From a person, sent to you directly',
  'b-person': 'From a person, recipients unknown',
  'b-unknown': "Everything else: Walnut can't tell who sent it",
}

/** The eight built-ins as Settings lists them. */
export function builtinSummaries(): Array<{ id: string; summary: string; then: string }> {
  return BUILTIN_RULES.map((rule) => ({
    id: rule.id,
    summary: BUILTIN_SUMMARIES[rule.id] ?? rule.why,
    then: rule.important ? IMPORTANT_LABEL : NOT_IMPORTANT_LABEL,
  }))
}
