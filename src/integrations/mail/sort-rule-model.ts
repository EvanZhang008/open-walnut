/**
 * The one model call of inbox sorting (spec 6.5): turn the person's note ("these go to a group
 * alias, I only care when they are addressed to me") into a rule condition.
 *
 * `RuleModel` is an injectable seam. The production one wraps `walnut.model.fastText`, the HOST's
 * call: the host always uses the user's configured main provider (it never names another provider,
 * never a third-party endpoint), so work mail only ever goes where the user already sends everything.
 * This plugin imports nothing from the model layer or the config.
 *
 * The model sees the note, the target group, the group names and this ONE mail's features: sender
 * address and name, subject, whether it has a List-Id, whether it was addressed to the person, whether
 * they were only in Cc, the sender kind and the account id. Never a body, never another mail, never the
 * recipient list.
 *
 * Its answer is data, not trust. Anything but one JSON object `{ when, then }` whose `when` uses only
 * the fields the rules engine accepts (minus `subject.re` and `message`), matches the corrected mail,
 * and whose `then` is the target the person picked, is dropped (`invalid`); the local drafts stand.
 */
import type { RuleWhen, SenderKind, Tri } from './sort-types.js'
import { groupIdForName } from './sort-classify.js'
import { whenProblems } from './sort-rules-schema.js'

export const RULE_MODEL_TIMEOUT_MS = 12_000
const MAX_TOKENS = 400

export interface RuleModelInput {
  note: string
  /** The group label the person picked (or `Important`). */
  target: string
  /** Every group name the rule may target. */
  groups: string[]
  mail: {
    fromAddr: string
    fromName: string
    subject: string
    hasListId: boolean
    addressedToMe: Tri
    onlyCc: Tri
    senderKind: SenderKind
    accountId: string
  }
}

export type RuleModel = (input: RuleModelInput, signal: AbortSignal) => Promise<string>

export type RuleModelStatus = 'ok' | 'skipped' | 'unavailable' | 'invalid' | 'timeout'

export interface RuleModelAnswer {
  status: RuleModelStatus
  /** `recipients-unknown` (the one reason the console words differently), or a short diagnosis. */
  reason?: string
  when?: RuleWhen
  then?: string
}

/** Condition fields the model may use: the rules engine's, minus `message` (and `subject.re`). */
export const MODEL_WHEN_FIELDS = ['from', 'subject', 'listId', 'addressedToMe', 'cc', 'sender', 'account'] as const

export const RULE_MODEL_SYSTEM = [
  'You turn a short note about one email into a mail sorting rule.',
  'Answer with ONE JSON object and nothing else: {"when": {...}, "then": "<group>"}.',
  '"then" must be exactly the target group you are given.',
  '"when" may only use these fields, all of which must hold:',
  '- "from": a string or a list of strings. With "@" it matches the sender address (glob, * is any text);',
  '  without "@" it matches the sender display name.',
  '- "subject": a plain string the subject must contain (never a regular expression).',
  '- "listId": a glob for the mailing list id.',
  '- "addressedToMe": true or false (whether the mail named the person as a recipient).',
  '- "cc": true (the person was only in Cc).',
  '- "sender": "person", "bulk", "transactional", "automated" or "unknown".',
  '- "account": an account id.',
  'The rule must match the email you are shown. Use the fewest fields that express the note.',
  'If the email says addressedToMe is "unknown", do not use "addressedToMe".',
].join('\n')

/** The production seam: the host's fast text call on the user's own main provider. */
export function productionRuleModel(walnut: { model?: { fastText?(request: {
  system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens: number; signal?: AbortSignal
}): Promise<string> } }): RuleModel {
  return async (input, signal) => {
    const fastText = walnut.model?.fastText
    if (typeof fastText !== 'function') throw new Error('This Walnut has no model call for plugins.')
    return fastText.call(walnut.model, {
      system: RULE_MODEL_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
      maxTokens: MAX_TOKENS,
      signal,
    })
  }
}

/** The first `{ ... }` object in the text (models wrap JSON in fences or a sentence now and then). */
function jsonObjectIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
}

/**
 * Validate the model's text against spec 6.5. `matches` answers whether a condition matches the
 * corrected mail (the caller compiles it with the engine's own compiler).
 */
export function validateModelRule(
  text: string,
  input: RuleModelInput,
  matches: (when: RuleWhen) => boolean,
): RuleModelAnswer {
  const parsed = jsonObjectIn(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid', reason: 'not-json' }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'when' && key !== 'then')) return { status: 'invalid', reason: 'extra-fields' }
  const when = record.when
  if (!when || typeof when !== 'object' || Array.isArray(when) || Object.keys(when).length === 0) {
    return { status: 'invalid', reason: 'empty-when' }
  }
  const keys = Object.keys(when)
  if (keys.some((key) => !(MODEL_WHEN_FIELDS as readonly string[]).includes(key))) return { status: 'invalid', reason: 'unknown-field' }
  const w = when as RuleWhen
  if (w.subject !== undefined && typeof w.subject !== 'string') return { status: 'invalid', reason: 'subject-pattern' }
  if (w.addressedToMe !== undefined && input.mail.addressedToMe === 'unknown') {
    return { status: 'invalid', reason: 'recipients-unknown' }
  }
  if (whenProblems(w).length > 0) return { status: 'invalid', reason: 'bad-field' }
  const then = typeof record.then === 'string' ? record.then.trim() : ''
  if (!then || groupIdForName(then) !== groupIdForName(input.target)) return { status: 'invalid', reason: 'wrong-target' }
  let hit = false
  try { hit = matches(w) } catch { hit = false }
  if (!hit) return { status: 'invalid', reason: 'misses-this-mail' }
  return { status: 'ok', when: w, then: input.target }
}

/** Ask the model, inside the 12 s budget, and validate what it says. Never throws. */
export async function askRuleModel(
  model: RuleModel,
  input: RuleModelInput,
  matches: (when: RuleWhen) => boolean,
  timeoutMs = RULE_MODEL_TIMEOUT_MS,
): Promise<RuleModelAnswer> {
  if (!input.note.trim()) return { status: 'skipped' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const clock = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve('timeout') }, timeoutMs)
  })
  try {
    const answer = await Promise.race([model(input, controller.signal).then((text) => ({ text })), clock])
    if (answer === 'timeout') return { status: 'timeout' }
    return validateModelRule(String(answer.text ?? ''), input, matches)
  } catch {
    return controller.signal.aborted ? { status: 'timeout' } : { status: 'unavailable' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
