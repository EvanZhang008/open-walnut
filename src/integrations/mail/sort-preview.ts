/**
 * Rule preview (spec 6.4): `POST /rules/preview` answers what a candidate rule would do to the cached
 * mail of a scope, without writing anything.
 *
 * - `matches`: cached mail the condition matches; `moves`: of those, mail whose group would change.
 * - `samples`: up to five matches, the ones that would move first, newest first.
 * - `shadows`: existing user or learned rules that would stop deciding some mail (because the new rule,
 *   inserted at `insertAt`, now decides it) AND send it somewhere else. "Everything from X goes to
 *   Notifications" saved on day five overriding "X with Action Required goes to Important" from day
 *   one is exactly this.
 * - `recipientsKnown`: when the condition uses `addressedToMe`, how many of the mails matching the
 *   rest of it carry any recipients at all (Outlook rows mostly carry none).
 *
 * The scan runs in batches of 500 rows with the event loop released between batches, and stops at
 * two seconds with `partial: true` (the console then says "at least"). Settings calls this while the
 * person types, so it must never hold the loop.
 */
import { PRIMARY_ONLY, errorReply, readBody } from './contract.js'
import { pairsOf, parseBodyScope } from './routes-sort.js'
import { IMPORTANT, NOT_IMPORTANT, compileWhen, groupIdForName } from './sort-classify.js'
import type { MailSortEngine } from './sort-engine.js'
import { whenProblems } from './sort-rules-schema.js'
import { senderLabel } from './sort-sender.js'
import type { ScanRow } from './sort-store.js'
import type { CompiledRule, FolderPair, MailSortWriteDeps, PreviewResponse, RuleWhen, Sample, Shadow } from './sort-types.js'
import type { MailStore } from './store.js'

export const PREVIEW_BATCH = 500
export const PREVIEW_BUDGET_MS = 2_000
const MAX_SAMPLES = 5
const CANDIDATE_ID = 'candidate'

export interface PreviewCandidate {
  when: RuleWhen
  then: string
}

/**
 * Would a rule sending mail to `target` move a mail now in `current`? `Not important` moves only
 * mail that is in Important now (elsewhere it already is not important, and keeps its group).
 */
export function movesTo(current: string, target: string): boolean {
  if (target === NOT_IMPORTANT) return current === IMPORTANT
  return current !== target
}

/** One candidate's tally, filled in by the scan. */
interface Tally {
  matches: number
  moves: number
  movers: Sample[]
  stayers: Sample[]
  shadows: Map<string, number>
  recipientsKnown: number
  recipientsOf: number
}

export interface PreviewOptions {
  insertAt?: number
  budgetMs?: number
  batch?: number
  now?: () => number
}

function keepNewest(list: Sample[], sample: Sample): void {
  list.push(sample)
  list.sort((a, b) => b.at - a.at)
  if (list.length > MAX_SAMPLES) list.length = MAX_SAMPLES
}

/**
 * The candidate compiled as a user rule, spliced into the rules in use at `insertAt` (file index).
 * `idFor` resolves its `then` as the engine does (a renamed group's new name is that group).
 */
export function withCandidate(
  rules: ReadonlyArray<CompiledRule>,
  candidate: PreviewCandidate,
  insertAt = 0,
  idFor: (name: string) => string = groupIdForName,
): CompiledRule[] {
  const compiled: CompiledRule = {
    id: CANDIDATE_ID,
    index: insertAt,
    group: idFor(candidate.then),
    source: 'user',
    match: compileWhen(candidate.when),
  }
  const at = rules.findIndex((rule) => rule.index >= insertAt)
  const out = [...rules]
  out.splice(at < 0 ? out.length : at, 0, compiled)
  return out
}

/** The condition minus `addressedToMe`: the "same sender" part the recipients sentence counts over. */
function withoutRecipients(when: RuleWhen): RuleWhen | undefined {
  const { addressedToMe: _drop, ...rest } = when
  return Object.keys(rest).length > 0 ? rest : undefined
}

function sampleOf(row: ScanRow, fromName: string, fromAddr: string): Sample {
  return {
    accountId: row.account_id,
    messageId: row.message_id,
    sender: senderLabel(fromAddr, fromName),
    subject: row.subject,
    at: row.received_at ?? row.sent_at,
    currentGroup: row.sort_group ?? IMPORTANT,
  }
}

/**
 * Evaluate several candidates in ONE scan of the scope (propose previews every draft at once).
 * Answers in the candidates' order.
 */
export async function previewMany(
  deps: { sort: MailSortEngine; store: MailStore },
  pairs: ReadonlyArray<FolderPair>,
  candidates: ReadonlyArray<PreviewCandidate>,
  options: PreviewOptions = {},
): Promise<PreviewResponse[]> {
  const { sort, store } = deps
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? PREVIEW_BUDGET_MS)
  const batch = options.batch ?? PREVIEW_BATCH
  const current = sort.compiledRules()
  const sourceOf = new Map(current.map((rule) => [rule.id, rule]))
  const plans = candidates.map((candidate) => ({
    candidate,
    target: sort.idForLabel(candidate.then),
    match: compileWhen(candidate.when),
    sender: withoutRecipients(candidate.when),
    rules: withCandidate(current, candidate, options.insertAt ?? 0, (name) => sort.idForLabel(name)),
    tally: { matches: 0, moves: 0, movers: [], stayers: [], shadows: new Map(), recipientsKnown: 0, recipientsOf: 0 } as Tally,
  })).map((plan) => ({ ...plan, senderMatch: plan.sender ? compileWhen(plan.sender) : undefined }))
  let partial = false
  let after = 0
  for (;;) {
    const rows = await store.sort.scanScope(pairs, after, batch)
    for (const row of rows) {
      const features = sort.features(row)
      const before = sort.classifyWith(features, current)
      for (const plan of plans) {
        if (plan.senderMatch?.(features)) {
          plan.tally.recipientsOf += 1
          if (features.addressedToMe !== 'unknown') plan.tally.recipientsKnown += 1
        }
        if (!plan.match(features)) continue
        plan.tally.matches += 1
        const moving = movesTo(row.sort_group ?? IMPORTANT, plan.target)
        if (moving) plan.tally.moves += 1
        keepNewest(moving ? plan.tally.movers : plan.tally.stayers, sampleOf(row, features.fromName, features.fromAddr))
        // A shadow: an existing user/learned rule decided this mail, the candidate now does, elsewhere.
        const old = before.ruleId ? sourceOf.get(before.ruleId) : undefined
        if (old && old.group !== plan.target) {
          const afterResult = sort.classifyWith(features, plan.rules)
          if (afterResult.ruleId === CANDIDATE_ID) plan.tally.shadows.set(old.id, (plan.tally.shadows.get(old.id) ?? 0) + 1)
        }
      }
    }
    if (rows.length < batch) break
    after = rows[rows.length - 1]!.rowid
    if (now() >= deadline) { partial = true; break }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return plans.map(({ candidate, tally }) => {
    const shadows: Shadow[] = [...tally.shadows.entries()]
      .map(([ruleId, mails]) => ({ ruleId, mails, summary: sourceOf.get(ruleId)?.summary ?? ruleId }))
      .sort((a, b) => b.mails - a.mails)
    return {
      matches: tally.matches,
      moves: tally.moves,
      samples: [...tally.movers, ...tally.stayers].slice(0, MAX_SAMPLES),
      shadows,
      ...(candidate.when.addressedToMe !== undefined ? { recipientsKnown: { known: tally.recipientsKnown, of: tally.recipientsOf } } : {}),
      ...(partial ? { partial: true } : {}),
      // Kept for propose's coverage sentence; stripped from the preview route's answer.
      _recipients: { known: tally.recipientsKnown, of: tally.recipientsOf },
    } as PreviewResponse & { _recipients: { known: number; of: number } }
  })
}

/** A candidate's problems, or none. `then` must name a group, Important or Not important. */
export function candidateProblems(when: unknown, then: unknown): Array<{ field: string; message: string }> {
  const out = whenProblems(when).map(([field, message]) => ({ field, message }))
  if (typeof then !== 'string' || !then.trim()) out.push({ field: 'then', message: 'then must name a group, Important or Not important.' })
  return out
}

export function registerRulePreviewRoutes(walnut: MailSortWriteDeps['walnut'], deps: Pick<MailSortWriteDeps, 'store' | 'sort'>): void {
  walnut.http.route('post', '/rules/preview', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const scope = parseBodyScope(body.scope)
    if ('error' in scope) return { status: 400, json: { error: 'invalid', message: scope.error } }
    const problems = candidateProblems(body.when, body.then)
    if (problems.length > 0) return { status: 400, json: { error: 'invalid', errors: problems.map((one) => ({ index: 0, ...one })) } }
    const insertAt = Number.isFinite(Number(body.insertAt)) && Number(body.insertAt) > 0 ? Math.floor(Number(body.insertAt)) : 0
    try {
      await deps.sort.ready()
      const pairs = await pairsOf(deps.store, scope)
      const [answer] = await previewMany(deps, pairs, [{ when: body.when as RuleWhen, then: String(body.then).trim() }], { insertAt })
      const { _recipients: _drop, ...json } = answer as PreviewResponse & { _recipients?: unknown }
      return { json }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
