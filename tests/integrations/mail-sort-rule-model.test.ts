/**
 * The one model call (spec 6.5, C28 C29 C30 C87): the plugin half.
 *
 * The seam is injected (`RuleModel`), so nothing here reaches a model. What is pinned: the model is
 * shown ONE mail's features (no body, no other mail, no recipient list); anything it answers that is
 * not a valid, matching rule for the chosen target is dropped with `invalid`; a mail whose recipients
 * are unknown gets the `recipients-unknown` reason; errors are `unavailable`, the 12 s clock is
 * `timeout`, no note is `skipped`; and the production seam is the host's `walnut.model.fastText`,
 * with no import of the model layer or the config anywhere in the mail plugin (grep).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileWhen } from '../../src/integrations/mail/sort-classify.js'
import {
  MODEL_WHEN_FIELDS, RULE_MODEL_TIMEOUT_MS, askRuleModel, productionRuleModel, validateModelRule, type RuleModelInput,
} from '../../src/integrations/mail/sort-rule-model.js'
import type { SortFeatures } from '../../src/integrations/mail/sort-types.js'

const FERRY = 'ferry:robin.harbour@ferry.example.invalid'

/** Change Desk's newest mail on the Outlook-shaped account: no address, recipients known. */
const changeDesk: SortFeatures = {
  accountId: FERRY, rfcMessageId: '<change-5500@fixture.example.invalid>', fromAddr: '', fromName: 'Change Desk',
  subject: '[Action Required] Change 5500 needs your approval', hasListUnsubscribe: false,
  recipients: [{ name: 'crew-leads' }, { address: 'dock-team@' }], addressedToMe: false, onlyCc: 'unknown',
  senderKind: 'unknown', correspondent: false,
}
const oldRow: SortFeatures = { ...changeDesk, recipients: undefined, addressedToMe: 'unknown' }

function inputFor(features: SortFeatures, target = 'Notifications', note = 'sent to a group alias'): RuleModelInput {
  return {
    note, target, groups: ['Important', 'Notifications', 'Newsletters & promotions', 'Group mail'],
    mail: {
      fromAddr: features.fromAddr, fromName: features.fromName, subject: features.subject, hasListId: false,
      addressedToMe: features.addressedToMe, onlyCc: features.onlyCc, senderKind: features.senderKind, accountId: features.accountId,
    },
  }
}

const matchesOf = (features: SortFeatures) => (when: Parameters<typeof compileWhen>[0]) => compileWhen(when)(features)

describe('validateModelRule: the model answer is data, not trust', () => {
  const input = inputFor(changeDesk)
  const valid = (when: unknown, then = 'Notifications') => validateModelRule(JSON.stringify({ when, then }), input, matchesOf(changeDesk))

  it('accepts a rule on the allowed fields that matches the corrected mail and names the target', () => {
    expect(valid({ from: 'Change Desk', addressedToMe: false })).toEqual({
      status: 'ok', when: { from: 'Change Desk', addressedToMe: false }, then: 'Notifications',
    })
    // Fenced or wrapped in a sentence is still one JSON object.
    expect(validateModelRule('```json\n{"when":{"from":"Change Desk"},"then":"notifications"}\n```', input, matchesOf(changeDesk)).status).toBe('ok')
  })

  it.each([
    ['not JSON', 'Sure, a rule from the sender.', 'not-json'],
    ['an extra top-level field', JSON.stringify({ when: { from: 'Change Desk' }, then: 'Notifications', note: 'x' }), 'extra-fields'],
    ['an empty when', JSON.stringify({ when: {}, then: 'Notifications' }), 'empty-when'],
    ['a message condition', JSON.stringify({ when: { message: changeDesk.rfcMessageId }, then: 'Notifications' }), 'unknown-field'],
    ['an unknown field', JSON.stringify({ when: { from: 'Change Desk', body: 'x' }, then: 'Notifications' }), 'unknown-field'],
    ['a subject regex', JSON.stringify({ when: { from: 'Change Desk', subject: { re: 'Action.*' } }, then: 'Notifications' }), 'subject-pattern'],
    ['a then that is not the target', JSON.stringify({ when: { from: 'Change Desk' }, then: 'Important' }), 'wrong-target'],
    ['a rule that misses this mail', JSON.stringify({ when: { from: 'Survey Desk' }, then: 'Notifications' }), 'misses-this-mail'],
    ['a wrongly typed field', JSON.stringify({ when: { from: 'Change Desk', cc: false }, then: 'Notifications' }), 'bad-field'],
  ])('drops %s (C30)', (_name, text, reason) => {
    expect(validateModelRule(text, input, matchesOf(changeDesk))).toEqual({ status: 'invalid', reason })
  })

  it('says recipients-unknown when the mail carries no recipients and the model used addressedToMe', () => {
    const old = inputFor(oldRow)
    expect(validateModelRule(JSON.stringify({ when: { from: 'Change Desk', addressedToMe: false }, then: 'Notifications' }), old, matchesOf(oldRow)))
      .toEqual({ status: 'invalid', reason: 'recipients-unknown' })
  })

  it('never lets the model use message or a regex (the allowed list)', () => {
    expect([...MODEL_WHEN_FIELDS]).toEqual(['from', 'subject', 'listId', 'addressedToMe', 'cc', 'sender', 'account'])
  })
})

describe('askRuleModel: statuses', () => {
  const input = inputFor(changeDesk)

  it('skips without a note and never calls the model', async () => {
    let calls = 0
    const answer = await askRuleModel(async () => { calls += 1; return '' }, { ...input, note: '  ' }, matchesOf(changeDesk))
    expect(answer).toEqual({ status: 'skipped' })
    expect(calls).toBe(0)
  })

  it('is unavailable when the call throws, timeout when it is slower than the budget', async () => {
    expect(await askRuleModel(async () => { throw new Error('no credentials') }, input, matchesOf(changeDesk))).toEqual({ status: 'unavailable' })
    let aborted = false
    const slow = (_input: RuleModelInput, signal: AbortSignal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true })
      setTimeout(() => resolve('{}'), 500)
    })
    expect(await askRuleModel(slow, input, matchesOf(changeDesk), 30)).toEqual({ status: 'timeout' })
    expect(aborted).toBe(true)
    expect(RULE_MODEL_TIMEOUT_MS).toBe(12_000)
  })

  it('shows the model one mail: no body, no other mail, no recipient list (C29)', async () => {
    let seen: RuleModelInput | undefined
    await askRuleModel(async (given) => { seen = given; return '{}' }, input, matchesOf(changeDesk))
    expect(Object.keys(seen!).sort()).toEqual(['groups', 'mail', 'note', 'target'])
    expect(Object.keys(seen!.mail).sort()).toEqual(['accountId', 'addressedToMe', 'fromAddr', 'fromName', 'hasListId', 'onlyCc', 'senderKind', 'subject'])
    expect(JSON.stringify(seen)).not.toContain('dock-team')
  })
})

describe('the production seam is the host call, and the plugin never reaches the model layer', () => {
  it('wraps walnut.model.fastText with one user message and no provider or model choice (C87)', async () => {
    const requests: Array<Record<string, unknown>> = []
    const walnut = { model: { fastText: async (request: Record<string, unknown>) => { requests.push(request); return 'answer' } } }
    const model = productionRuleModel(walnut as never)
    expect(await model(inputFor(changeDesk), new AbortController().signal)).toBe('answer')
    expect(Object.keys(requests[0]!).sort()).toEqual(['maxTokens', 'messages', 'signal', 'system'])
    const messages = requests[0]!.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(1)
    expect(JSON.parse(messages[0]!.content).mail.fromName).toBe('Change Desk')
  })

  it('no file under src/integrations/mail imports src/model, getConfig, a direct fast route or a third-party endpoint (C29)', () => {
    const root = path.resolve(__dirname, '../../src/integrations/mail')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(full)
      }
    }
    walk(root)
    const offenders = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return /from ['"][./]*(?:\.\.\/)+model\//.test(text) || /\bgetConfig\b/.test(text) || /directFastRoute/.test(text)
        || /openrouter/i.test(text) || /\bjev\b/i.test(text)
    })
    expect(offenders.map((file) => path.relative(root, file))).toEqual([])
  })
})
