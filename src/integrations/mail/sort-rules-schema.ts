/**
 * Validation of the rules file (spec 5.5, 5.6). ONE invalid rule makes the whole file invalid:
 * the engine then keeps the last good rules rather than silently dropping a rule and re-sorting
 * every mail around the hole.
 *
 * Messages are sentences a person reads in Settings and in the grouped view, verbatim.
 */
import { groupIdForName, reservedGroupId } from './sort-classify.js'
import { compileSubjectPattern } from './sort-regex-safety.js'
import type { Rule, RuleSenderValue, RuleValidationError, RuleWhen, RulesFileDoc } from './sort-types.js'

export const MAX_GROUP_NAME = 40
export const MAX_RULES = 500
const RULE_KEYS = new Set(['id', 'when', 'then', 'source', 'note', 'created', 'enabled', 'label', 'skipInbox'])
const WHEN_KEYS = new Set(['from', 'subject', 'listId', 'addressedToMe', 'cc', 'sender', 'account', 'message', 'group'])
const SENDERS = new Set<RuleSenderValue>(['person', 'bulk', 'transactional', 'automated', 'unknown'])
/** The display names a `then` may use for the reserved destinations, for the "did you mean" suggestion. */
const RESERVED_LABELS = ['Important', 'Not important']

export const THEN_REQUIRED = 'then must name a group, Important or Not important.'
export const SKIP_INBOX_NEEDS_GROUP = 'skipInbox needs a group in then: mail kept out of the inbox is still shown in that group.'
export const WHEN_EMPTY = 'when must list at least one condition.'

export function tooSimilar(a: string, b: string): string {
  return `"${a}" and "${b}" are too similar. Rename one of them.`
}

/** Plain Levenshtein, case-insensitive; names are at most 40 characters. */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[y.length]!
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A group name's own shape problem, or null. */
export function groupNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'A group name cannot be empty.'
  if (/[\r\n]/.test(name)) return 'A group name must fit on one line.'
  if (name.trim().length > MAX_GROUP_NAME) return `A group name is at most ${MAX_GROUP_NAME} characters.`
  return null
}

function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return value.trim() ? [value] : null
  if (Array.isArray(value) && value.length > 0 && value.every((one) => typeof one === 'string' && one.trim())) {
    return value as string[]
  }
  return null
}

/** Problems with one `when`, as [field, message] pairs. */
export function whenProblems(when: unknown): Array<[string, string]> {
  if (!isRecord(when) || Object.keys(when).length === 0) return [['when', WHEN_EMPTY]]
  const out: Array<[string, string]> = []
  for (const key of Object.keys(when)) {
    if (!WHEN_KEYS.has(key)) out.push([`when.${key}`, `when.${key} is not a condition Walnut knows.`])
  }
  const w = when as Record<string, unknown>
  if ('from' in w && !stringList(w.from)) out.push(['when.from', 'from must be a text or a list of texts.'])
  if ('subject' in w) {
    const subject = w.subject
    if (typeof subject === 'string') {
      if (!subject.trim()) out.push(['when.subject', 'subject cannot be empty.'])
    } else if (isRecord(subject) && typeof subject.re === 'string' && Object.keys(subject).length === 1) {
      const compiled = compileSubjectPattern(subject.re)
      if (!compiled.ok) out.push(['when.subject', compiled.message])
    } else {
      out.push(['when.subject', 'subject must be a text or { re: "pattern" }.'])
    }
  }
  if ('listId' in w && (typeof w.listId !== 'string' || !w.listId.trim())) out.push(['when.listId', 'listId must be a text.'])
  if ('addressedToMe' in w && typeof w.addressedToMe !== 'boolean') {
    out.push(['when.addressedToMe', 'addressedToMe must be true or false.'])
  }
  if ('cc' in w && w.cc !== true) out.push(['when.cc', 'cc can only be true.'])
  if ('sender' in w && !SENDERS.has(w.sender as RuleSenderValue)) {
    out.push(['when.sender', 'sender must be person, bulk, transactional, automated or unknown.'])
  }
  if ('account' in w && (typeof w.account !== 'string' || !w.account.trim())) out.push(['when.account', 'account must be an account id.'])
  if ('message' in w && (typeof w.message !== 'string' || !w.message.trim())) out.push(['when.message', 'message must be a message id.'])
  if ('group' in w) {
    const problem = groupNameProblem(w.group)
    if (problem) out.push(['when.group', `group: ${problem}`])
    else if (reservedGroupId(String(w.group))) out.push(['when.group', 'group names one of the groups Walnut sorts mail into.'])
  }
  return out
}

function createdOf(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value
  return null
}

/**
 * The `then` problem for one rule, given every name known so far (groups list, reserved labels,
 * earlier rules' targets). A near miss of a known name is a typo, not a new group.
 */
function thenProblem(then: unknown, known: string[]): string | null {
  if (typeof then !== 'string' || !then.trim()) return THEN_REQUIRED
  const name = then.trim()
  const shape = groupNameProblem(name)
  if (shape) return `then: ${shape}`
  if (reservedGroupId(name)) return null
  if (known.some((one) => one.toLowerCase() === name.toLowerCase())) return null
  const id = groupIdForName(name)
  const collision = known.find((one) => groupIdForName(one) === id)
  if (collision) return tooSimilar(collision, name)
  const near = known.find((one) => editDistance(one, name) <= 2)
  if (near) return `then: ${name} is not a group. Did you mean ${near}?`
  return null
}

export type RulesValidation =
  | { ok: true; doc: RulesFileDoc }
  | { ok: false; errors: RuleValidationError[] }

/** Validate a parsed file (or a PUT body). Empty input is an empty, valid file. */
export function validateRulesDoc(raw: unknown): RulesValidation {
  const errors: RuleValidationError[] = []
  if (raw === undefined || raw === null) return { ok: true, doc: { version: 1, groups: [], rules: [] } }
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ index: -1, field: 'file', message: 'The rules file must be a map with version, groups and rules.' }] }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'groups' && key !== 'rules') {
      errors.push({ index: -1, field: key, message: `${key} is not a rules file field.` })
    }
  }
  if (raw.version !== undefined && raw.version !== 1) errors.push({ index: -1, field: 'version', message: 'version must be 1.' })
  const groups: string[] = []
  if (raw.groups !== undefined && raw.groups !== null && !Array.isArray(raw.groups)) {
    errors.push({ index: -1, field: 'groups', message: 'groups must be a list of names.' })
  }
  for (const name of Array.isArray(raw.groups) ? raw.groups : []) {
    const problem = groupNameProblem(name)
    if (problem) { errors.push({ index: -1, field: 'groups', message: problem }); continue }
    const trimmed = (name as string).trim()
    if (reservedGroupId(trimmed)) continue
    if (groups.some((one) => one.toLowerCase() === trimmed.toLowerCase())) continue
    const clash = groups.find((one) => groupIdForName(one) === groupIdForName(trimmed))
    if (clash) { errors.push({ index: -1, field: 'groups', message: tooSimilar(clash, trimmed) }); continue }
    groups.push(trimmed)
  }
  if (raw.rules !== undefined && raw.rules !== null && !Array.isArray(raw.rules)) {
    errors.push({ index: -1, field: 'rules', message: 'rules must be a list.' })
  }
  const list: unknown[] = Array.isArray(raw.rules) ? raw.rules : []
  if (list.length > MAX_RULES) errors.push({ index: -1, field: 'rules', message: `At most ${MAX_RULES} rules.` })
  const known = [...RESERVED_LABELS, ...groups]
  const ids = new Map<string, number>()
  const rules: Rule[] = []
  list.forEach((item, index) => {
    const push = (field: string, message: string, id?: string) =>
      errors.push({ index, field, message, ...(id ? { id } : {}) })
    if (!isRecord(item)) { push('rule', 'A rule must be a map with when and then.'); return }
    const id = typeof item.id === 'string' ? item.id.trim() : undefined
    for (const key of Object.keys(item)) if (!RULE_KEYS.has(key)) push(key, `${key} is not a rule field.`, id)
    if (item.id !== undefined && (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id))) push('id', 'id must be letters, digits, - or _.', id)
    if (id) {
      if (ids.has(id)) push('id', `Two rules use the id ${id}.`, id)
      else ids.set(id, index)
    }
    for (const [field, message] of whenProblems(item.when)) push(field, message, id)
    const then = thenProblem(item.then, known)
    const thenName = typeof item.then === 'string' ? item.then.trim() : ''
    if (then) push('then', then, id)
    else if (thenName && !known.some((one) => one.toLowerCase() === thenName.toLowerCase())) known.push(thenName)
    const source = item.source ?? 'user'
    if (source !== 'user' && source !== 'learned') push('source', 'source must be user or learned.', id)
    if (item.note !== undefined && typeof item.note !== 'string') push('note', 'note must be a text.', id)
    if (item.label !== undefined && typeof item.label !== 'string') push('label', 'label must be a text.', id)
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') push('enabled', 'enabled must be true or false.', id)
    if (item.skipInbox !== undefined && typeof item.skipInbox !== 'boolean') push('skipInbox', 'skipInbox must be true or false.', id)
    else if (item.skipInbox === true && !then && thenName && reservedGroupId(thenName)) {
      push('skipInbox', SKIP_INBOX_NEEDS_GROUP, id)
    }
    const created = createdOf(item.created)
    if (created === null) push('created', 'created must be a date like 2026-09-28.', id)
    rules.push({
      ...(id ? { id } : {}),
      when: item.when as RuleWhen,
      then: typeof item.then === 'string' ? item.then.trim() : '',
      source: source === 'learned' ? 'learned' : 'user',
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      ...(created ? { created } : {}),
      ...(item.enabled === false ? { enabled: false } : {}),
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
      ...(item.skipInbox === true ? { skipInbox: true } : {}),
    })
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, doc: { version: 1, groups, rules } }
}
