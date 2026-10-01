/**
 * Rule propose (spec 6.4, the correction card's step 2): `POST /rules/propose`
 * `{ accountId, messageId, target, note?, scope?, model? }` answers the rules Walnut could learn from
 * ONE correction, each with the numbers a preview gives. It writes nothing: saving is `PUT /rules`.
 *
 * Local drafts, always, in this order:
 *   sender-direct / sender-not-direct  only when this mail's recipients are known; its own value first
 *   sender-subject                     the sender plus the subject's key fragment (sort-subject-fragment.ts)
 *   sender                             the address, or the display name when the row has no address
 *   message                            only this mail, with a server-written label
 * A condition on a display name (no `@`) also names the account: a name is a weak identity, and a
 * work account's "payroll" must not catch a same-named sender in a personal one.
 *
 * The model draft is tried only when a note was written (and `model` is not `false`), through the
 * injected `RuleModel` (sort-rule-model.ts). Its failure is a status, never an error: the local drafts
 * are the answer either way. A console that wants the local drafts at once calls without a note first.
 */
import { PRIMARY_ONLY, errorReply, readBody } from './contract.js'
import { pairsOf, parseBodyScope } from './routes-sort.js'
import { IMPORTANT_LABEL, NOT_IMPORTANT_LABEL, compileWhen } from './sort-classify.js'
import type { MailSortEngine } from './sort-engine.js'
import { candidateProblems, previewMany, type PreviewCandidate } from './sort-preview.js'
import { askRuleModel, type RuleModel, type RuleModelInput } from './sort-rule-model.js'
import { senderLabel } from './sort-sender.js'
import { subjectFragment } from './sort-subject-fragment.js'
import type {
  DraftKind, GroupsScope, MailSortWriteDeps, PreviewResponse, ProposeDraft, ProposeResponse, RuleWhen, SortFeatures,
} from './sort-types.js'

const LABEL_SUBJECT_CHARS = 60

export interface LocalDraft {
  kind: DraftKind
  when: RuleWhen
  label?: string
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** `Only the mail "<subject>" from <sender>, Sep 28`. */
export function messageLabel(subject: string, sender: string, at: number): string {
  const clipped = subject.length > LABEL_SUBJECT_CHARS ? `${subject.slice(0, LABEL_SUBJECT_CHARS).trimEnd()}...` : subject
  return `Only the mail "${clipped}" from ${sender}, ${shortDate(at)}`
}

/** The sender condition: the address, else the display name plus the account. */
export function senderWhen(features: Pick<SortFeatures, 'fromAddr' | 'fromName' | 'accountId'>): RuleWhen | undefined {
  if (features.fromAddr) return { from: features.fromAddr }
  const name = features.fromName.trim()
  if (name) return { from: name, account: features.accountId }
  return undefined
}

/** The local drafts for one mail, in the order the card lists them (pure). */
export function localDrafts(
  features: SortFeatures,
  mail: { subject: string; at: number; messageRfcId: string },
): LocalDraft[] {
  const out: LocalDraft[] = []
  const sender = senderWhen(features)
  if (sender && features.addressedToMe !== 'unknown') {
    const direct: LocalDraft = { kind: 'sender-direct', when: { ...sender, addressedToMe: true } }
    const group: LocalDraft = { kind: 'sender-not-direct', when: { ...sender, addressedToMe: false } }
    out.push(...(features.addressedToMe === true ? [direct, group] : [group, direct]))
  }
  const fragment = subjectFragment(mail.subject)
  if (sender && fragment) out.push({ kind: 'sender-subject', when: { ...sender, subject: fragment } })
  if (sender) out.push({ kind: 'sender', when: sender })
  if (mail.messageRfcId) {
    out.push({
      kind: 'message',
      when: { message: mail.messageRfcId },
      label: messageLabel(mail.subject, senderLabel(features.fromAddr, features.fromName), mail.at),
    })
  }
  return out
}

/** Names the model may target: Important, Not important, then the groups in use and rule targets. */
export async function targetNames(sort: Pick<MailSortEngine, 'catalog'>): Promise<string[]> {
  const names = (await sort.catalog()).map((item) => item.label)
  return [...new Set([IMPORTANT_LABEL, NOT_IMPORTANT_LABEL, ...names])]
}

export function modelInputOf(features: SortFeatures, note: string, target: string, groups: string[]): RuleModelInput {
  return {
    note,
    target,
    groups,
    mail: {
      fromAddr: features.fromAddr,
      fromName: features.fromName,
      subject: features.subject,
      hasListId: !!features.listId,
      addressedToMe: features.addressedToMe,
      onlyCc: features.onlyCc,
      senderKind: features.senderKind,
      accountId: features.accountId,
    },
  }
}

type Recipients = { known: number; of: number }

function draftOf(sort: MailSortEngine, draft: LocalDraft, then: string, preview: PreviewResponse): ProposeDraft {
  return {
    kind: draft.kind,
    when: draft.when,
    then,
    summary: draft.kind === 'message' ? 'Only this mail' : sort.summarize({ when: draft.when, then }),
    ...(draft.label ? { label: draft.label } : {}),
    matches: preview.matches,
    moves: preview.moves,
    samples: preview.samples,
    shadows: preview.shadows,
  }
}

export interface ProposeInput {
  accountId: string
  messageId: string
  target: string
  note?: string
  scope: GroupsScope
  /** `false` skips the model even with a note (the console's first, instant call). */
  model?: boolean
}

export async function propose(
  deps: Pick<MailSortWriteDeps, 'store' | 'sort'> & { ruleModel: RuleModel },
  input: ProposeInput,
): Promise<ProposeResponse | { notFound: true }> {
  const { sort, store } = deps
  await sort.ready()
  const [row] = await store.sort.rowsByIds(input.accountId, [input.messageId])
  if (!row) return { notFound: true }
  const features = sort.features(row)
  const then = input.target.trim()
  const drafts = localDrafts(features, { subject: row.subject, at: row.received_at ?? row.sent_at, messageRfcId: row.rfc_message_id })
  const pairs = await pairsOf(store, input.scope)
  const sender = senderWhen(features)
  const candidates: PreviewCandidate[] = drafts.map((draft) => ({ when: draft.when, then }))
  // The coverage sentence counts over this sender's mail, drafted or not.
  const withSender = sender ? [...candidates, { when: sender, then }] : candidates
  const note = (input.note ?? '').trim()
  const modelRun = note && input.model !== false
    ? targetNames(sort).then((names) => askRuleModel(deps.ruleModel, modelInputOf(features, note, then, names), (when) => compileWhen(when)(features)))
    : Promise.resolve({ status: 'skipped' as const })
  const [previews, answer] = await Promise.all([previewMany({ sort, store }, pairs, withSender), modelRun])
  const recipients = (sender ? (previews[previews.length - 1] as PreviewResponse & { _recipients?: Recipients })._recipients : undefined)
    ?? { known: 0, of: 0 }
  const strip = ({ _recipients: _drop, ...rest }: PreviewResponse & { _recipients?: Recipients }) => rest as PreviewResponse
  const model: ProposeResponse['model'] = { status: answer.status, ...('reason' in answer && answer.reason ? { reason: answer.reason } : {}) }
  if (answer.status === 'ok' && 'when' in answer && answer.when) {
    const [preview] = await previewMany({ sort, store }, pairs, [{ when: answer.when, then }])
    model.draft = {
      when: answer.when, then, summary: sort.summarize({ when: answer.when, then }), matches: preview!.matches, moves: preview!.moves,
    }
  }
  return {
    drafts: drafts.map((draft, index) => draftOf(sort, draft, then, strip(previews[index]!))),
    recipients: { thisMail: features.addressedToMe === 'unknown' ? 'unknown' : 'known', known: recipients.known, of: recipients.of },
    model,
  }
}

export function registerRuleProposeRoutes(
  walnut: MailSortWriteDeps['walnut'],
  deps: Pick<MailSortWriteDeps, 'store' | 'sort'> & { ruleModel: RuleModel },
): void {
  walnut.http.route('post', '/rules/propose', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const accountId = typeof body.accountId === 'string' ? body.accountId : ''
    const messageId = typeof body.messageId === 'string' ? body.messageId : ''
    if (!accountId || !messageId) return { status: 400, json: { error: 'invalid', message: 'accountId and messageId are required' } }
    const thenProblems = candidateProblems({ from: 'x' }, body.target)
    if (thenProblems.length > 0) return { status: 400, json: { error: 'invalid', message: thenProblems[0]!.message.replace(/^then/, 'target') } }
    const scope = body.scope === undefined ? { role: 'inbox' as const } : parseBodyScope(body.scope)
    if ('error' in scope) return { status: 400, json: { error: 'invalid', message: scope.error } }
    try {
      const answer = await propose(deps, {
        accountId, messageId, target: String(body.target), scope,
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(body.model === false ? { model: false } : {}),
      })
      if ('notFound' in answer) return { status: 404, json: { error: 'not-found', message: 'Walnut does not have this mail any more.' } }
      return { json: answer }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
