// A person's area binding of a triage rule stores only its id and fingerprint, so a changed rule never grants an area unconfirmed.
import crypto from 'node:crypto'
import { WALNUT_HOME } from '../../constants.js'
import { readRoutingRules, ruleMatches, type TriageRoutingRule } from '../triage/routing-rules.js'
import {
  ROUTER_CANONICAL_KEY_MAX, ROUTER_RULE_ID_PATTERN, ROUTER_RULE_REVISION_PATTERN, readRouterAreas, updateRouterAreas,
  type RouterAreasFile, type RouterRuleBinding,
} from './areas.js'
import { currentRouterSources, resolveRouterItem } from './source-registry.js'
import type { RouterItem, RouterSource } from './types.js'

export class RouterRuleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

export interface RouterRuleTarget { title: string; open: boolean }

export interface RouterRulesDeps {
  rules?: (home: string) => Promise<TriageRoutingRule[]>
  targets?: (ids: string[]) => Promise<Map<string, RouterRuleTarget>>
  resolve?: (source: RouterSource) => Promise<RouterItem>
  current?: (sources: readonly RouterSource[]) => Promise<RouterSource[]>
  now?: () => number
  expectedBindingsRevision?: string
  /**
   * Bindings read when the arrival was captured. Given, only those still exactly as they were may grant,
   * so an unrelated binding change never blocks and a binding added or changed since never authorizes.
   */
  expectedRuleBindings?: readonly RouterRuleBinding[]
}

export interface RouterRuleView {
  id: string
  match: TriageRoutingRule['match']
  taskId: string
  taskTitle?: string
  revision: string
  enabled: boolean
  areaId?: string
  confirmed: boolean
}

export interface RouterRulesReply {
  rules: RouterRuleView[]
  bindings: RouterRuleBinding[]
  fileRevision: string
}

export interface RouterAreaRule {
  id: string
  match: TriageRoutingRule['match']
  taskId: string
  taskTitle?: string
}

const MAX_BINDINGS = 200
const BINDING_KEYS = new Set(['ruleId', 'revision', 'areaId', 'confirmedAt'])

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

export function routerRuleRevision(rule: Pick<TriageRoutingRule, 'id' | 'match' | 'taskId'>): string {
  return sha256(JSON.stringify([rule.id, rule.match.from ?? '', rule.match.subject ?? '', rule.taskId]))
}

export function ruleBindingsRevision(file: Pick<RouterAreasFile, 'ruleBindings'>): string {
  return sha256(JSON.stringify(file.ruleBindings ?? []))
}

export function sameRuleBinding(a: RouterRuleBinding, b: RouterRuleBinding): boolean {
  return a.ruleId === b.ruleId && a.revision === b.revision && a.areaId === b.areaId && a.confirmedAt === b.confirmedAt
}

async function defaultTargets(ids: string[]): Promise<Map<string, RouterRuleTarget>> {
  if (ids.length === 0) return new Map()
  const { queryTasksSlim } = await import('../task-manager.js')
  const tasks = await queryTasksSlim({ ids })
  return new Map(tasks.map((task) => [task.id, { title: task.title, open: task.phase !== 'COMPLETE' }]))
}

const readRules = (home: string, deps: RouterRulesDeps) => (deps.rules ?? readRoutingRules)(home)
const readTargets = (ids: string[], deps: RouterRulesDeps) => (deps.targets ?? defaultTargets)([...new Set(ids)])

function confirmedRules(file: RouterAreasFile, rules: readonly TriageRoutingRule[]): Array<{ rule: TriageRoutingRule; areaId: string }> {
  const bindings = new Map((file.ruleBindings ?? []).map((binding) => [binding.ruleId, binding]))
  return rules.flatMap((rule) => {
    const binding = bindings.get(rule.id)
    return binding && binding.revision === routerRuleRevision(rule) ? [{ rule, areaId: binding.areaId }] : []
  })
}

function itemMatches(rule: TriageRoutingRule, item: Pick<RouterItem, 'source' | 'sender' | 'subject'>): boolean {
  return ruleMatches(rule, { source: item.source.kind === 'slack' ? 'slack' : 'mail', from: item.sender ?? '', subject: item.subject ?? '' })
}

function liveMatches(
  file: RouterAreasFile, rules: readonly TriageRoutingRule[], targets: Map<string, RouterRuleTarget>,
  item: Pick<RouterItem, 'source' | 'sender' | 'subject'>,
): Array<{ rule: TriageRoutingRule; areaId: string }> {
  return confirmedRules(file, rules).filter(({ rule, areaId }) => rule.enabled && targets.get(rule.taskId)?.open === true
    && file.areas.some((area) => area.id === areaId) && itemMatches(rule, item))
}

function soleArea(matches: ReadonlyArray<{ areaId: string }>): string | undefined {
  const areas = new Set(matches.map((match) => match.areaId))
  return areas.size === 1 ? [...areas][0] : undefined
}

export async function routerRulesView(home = WALNUT_HOME, deps: RouterRulesDeps = {}, file?: RouterAreasFile): Promise<RouterRulesReply> {
  const areas = file ?? await readRouterAreas(home)
  const rules = await readRules(home, deps)
  const targets = await readTargets(rules.map((rule) => rule.taskId), deps)
  const bindings = new Map((areas.ruleBindings ?? []).map((binding) => [binding.ruleId, binding]))
  return {
    rules: rules.map((rule) => {
      const revision = routerRuleRevision(rule)
      const binding = bindings.get(rule.id)
      const taskTitle = targets.get(rule.taskId)?.title || rule.taskTitle
      return {
        id: rule.id, match: { ...rule.match }, taskId: rule.taskId, ...(taskTitle ? { taskTitle } : {}), revision, enabled: rule.enabled,
        ...(binding ? { areaId: binding.areaId } : {}), confirmed: binding?.revision === revision,
      }
    }),
    bindings: areas.ruleBindings ?? [],
    fileRevision: ruleBindingsRevision(areas),
  }
}

interface RequestedBinding { ruleId: string; revision: string; areaId: string }

function parseBindings(body: unknown): { bindings: RequestedBinding[]; expectedRevision: string } {
  const raw = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  if (typeof raw.expectedRevision !== 'string' || !ROUTER_RULE_REVISION_PATTERN.test(raw.expectedRevision)) {
    throw new RouterRuleError('revision_required', 'Give expectedRevision, the fileRevision these bindings were read at.')
  }
  if (!Array.isArray(raw.bindings) || raw.bindings.length > MAX_BINDINGS) {
    throw new RouterRuleError('bad_bindings', `Give bindings as a list of at most ${MAX_BINDINGS} rule areas.`)
  }
  const seen = new Set<string>()
  const bindings = raw.bindings.map((one): RequestedBinding => {
    const entry = (one && typeof one === 'object' && !Array.isArray(one) ? one : null) as Record<string, unknown> | null
    if (!entry || Object.keys(entry).some((key) => !BINDING_KEYS.has(key))
      || typeof entry.ruleId !== 'string' || !ROUTER_RULE_ID_PATTERN.test(entry.ruleId)
      || typeof entry.revision !== 'string' || !ROUTER_RULE_REVISION_PATTERN.test(entry.revision)
      || typeof entry.areaId !== 'string' || !entry.areaId || entry.areaId.length > 80) {
      throw new RouterRuleError('bad_bindings', 'Each binding names ruleId, revision and areaId.')
    }
    if (seen.has(entry.ruleId)) throw new RouterRuleError('rule_bound_twice', `Rule ${entry.ruleId} can belong to one area only.`)
    seen.add(entry.ruleId)
    return { ruleId: entry.ruleId, revision: entry.revision, areaId: entry.areaId }
  })
  return { bindings, expectedRevision: raw.expectedRevision }
}

/** Saved bindings may stay as they are (inactive when stale); a new or changed one needs the rule's live fingerprint. */
export async function saveRouterRuleBindings(body: unknown, home = WALNUT_HOME, deps: RouterRulesDeps = {}): Promise<RouterRulesReply> {
  const { bindings, expectedRevision } = parseBindings(body)
  const now = (deps.now ?? Date.now)()
  const saved = await updateRouterAreas(home, async (file) => {
    if (ruleBindingsRevision(file) !== expectedRevision) {
      throw new RouterRuleError('rules_changed', 'Area rules changed since they were read. Read them again and confirm.', 409)
    }
    const rules = new Map((await readRules(home, deps)).map((rule) => [rule.id, rule]))
    const prior = new Map((file.ruleBindings ?? []).map((binding) => [binding.ruleId, binding]))
    const next = bindings.map((binding): RouterRuleBinding => {
      const kept = prior.get(binding.ruleId)
      if (kept && kept.revision === binding.revision && kept.areaId === binding.areaId) return kept
      if (!file.areas.some((area) => area.id === binding.areaId)) {
        throw new RouterRuleError('area_missing', `Area ${binding.areaId} does not exist.`, 409)
      }
      const rule = rules.get(binding.ruleId)
      if (!rule || routerRuleRevision(rule) !== binding.revision) {
        throw new RouterRuleError('rule_changed', `Rule ${binding.ruleId} is gone or changed since it was read. Read it again and confirm.`, 409)
      }
      return { ...binding, confirmedAt: now }
    })
    const { ruleBindings: _drop, ...rest } = file
    return next.length ? { ...rest, ruleBindings: next } : rest
  })
  return routerRulesView(home, deps, saved)
}

/** `ruleId` ties the match to its binding; a match without one restricts but never authorizes. */
export interface PendingRuleMatch { areaId: string; match: TriageRoutingRule['match']; ruleId?: string }

/** What an inbound rule would capture: it only restricts reads, never grants; a failed read throws. */
export async function readPendingRuleMatches(file: RouterAreasFile, home = WALNUT_HOME, deps: RouterRulesDeps = {}): Promise<PendingRuleMatch[]> {
  if (!file.ruleBindings?.length) return []
  const candidates = confirmedRules(file, await readRules(home, deps))
    .filter(({ rule, areaId }) => rule.enabled && file.areas.some((area) => area.id === areaId))
  if (candidates.length === 0) return []
  const targets = await readTargets(candidates.map(({ rule }) => rule.taskId), deps)
  return candidates.filter(({ rule }) => targets.get(rule.taskId)?.open === true).map(({ rule, areaId }) => ({ areaId, match: { ...rule.match }, ruleId: rule.id }))
}

/** A missing match field cannot clear a restriction; a known non-match can. */
export function pendingRuleAreas(
  pending: ReadonlyArray<PendingRuleMatch>, item: { kind: RouterSource['kind']; sender?: string; subject?: string },
): Set<string> {
  const kind = item.kind
  if (pending.length === 0 || (kind !== 'mail' && kind !== 'slack')) return new Set()
  return new Set(pending.filter((one) => {
    if (!one.match.from && !one.match.subject) return true
    const sender = item.sender ?? one.match.from ?? ''
    const subject = item.subject ?? one.match.subject ?? ''
    return ruleMatches({ enabled: true, match: one.match } as TriageRoutingRule, { source: kind, from: sender, subject })
  }).map((one) => one.areaId))
}

export async function routerAreaRules(
  areas: RouterAreasFile, areaId: string, item: Pick<RouterItem, 'source' | 'sender' | 'subject'>,
  home = WALNUT_HOME, deps: RouterRulesDeps = {},
): Promise<RouterAreaRule[]> {
  if (!(areas.ruleBindings ?? []).some((binding) => binding.areaId === areaId)) return []
  const rules = await readRules(home, deps)
  const candidates = confirmedRules(areas, rules).filter((one) => one.areaId === areaId)
  const targets = await readTargets(candidates.map(({ rule }) => rule.taskId), deps)
  return liveMatches(areas, rules, targets, item).filter((one) => one.areaId === areaId).map(({ rule }) => {
    const taskTitle = targets.get(rule.taskId)?.title
    return { id: rule.id, match: { ...rule.match }, taskId: rule.taskId, ...(taskTitle ? { taskTitle } : {}) }
  })
}

export async function confirmedRouteRule(
  areas: RouterAreasFile, areaId: string, ruleId: string, source: RouterSource,
  home = WALNUT_HOME, deps: RouterRulesDeps = {},
): Promise<RouterAreaRule> {
  const item = await (deps.resolve ?? resolveRouterItem)(source)
  const rule = (await routerAreaRules(areas, areaId, item, home, deps)).find((one) => one.id === ruleId)
  if (!rule) {
    throw new RouterRuleError('rule_unavailable', 'This rule is not confirmed for this area, is off, has no open target, or does not match this exact item.', 409)
  }
  return rule
}

const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '')

function validSource(source: RouterSource): boolean {
  return !!source && ['mail', 'slack', 'wechat'].includes(source.kind) && typeof source.account === 'string' && !!source.account
    && typeof source.message === 'string' && !!source.message
    && (source.version === undefined || (typeof source.version === 'string' && !!source.version))
    && (source.kind !== 'mail' || source.version !== undefined)
}

function blocked(file: RouterAreasFile, source: RouterSource, areaId: string, canonicalKey: string): boolean {
  return file.items.some((one) => sameSource(one.source, source)
    || (one.areaId !== areaId && one.source.kind === source.kind && one.source.account === source.account
      && (one.canonicalKey === canonicalKey || one.source.message === source.message)))
}

const expectedBindings = (file: RouterAreasFile, deps: RouterRulesDeps) =>
  deps.expectedBindingsRevision === undefined || deps.expectedBindingsRevision === ruleBindingsRevision(file)

/** The rules that may grant: every live one, or only snapshot entries still exactly as the file holds them. */
function grantingRules(file: RouterAreasFile, deps: RouterRulesDeps): Set<string> | undefined {
  if (!deps.expectedRuleBindings) return undefined
  const now = new Map((file.ruleBindings ?? []).map((binding) => [binding.ruleId, binding]))
  return new Set(deps.expectedRuleBindings.filter((one) => {
    const held = now.get(one.ruleId)
    return !!held && sameRuleBinding(one, held)
  }).map((one) => one.ruleId))
}

function quietSourceMiss(error: unknown): boolean {
  return ['source_missing', 'source_changed'].includes((error as { code?: string } | null)?.code ?? '')
}

/**
 * Only exact new arrivals enter, under the lock with live rules, targets and cache; a failed check throws and grants nothing.
 * Returns the sources this call wrote: a refused, conflicting, blocked or already listed one is never among them.
 */
export async function confirmRouterIncoming(
  sources: readonly RouterSource[], home = WALNUT_HOME, deps: RouterRulesDeps = {},
): Promise<readonly RouterSource[]> {
  const { role } = await import('../server-role.js')
  const { ambientTestRun } = await import('../test-run.js')
  if (role() === 'replica' || ambientTestRun()) return []
  const asked = sources.filter(validSource).map((one) => Object.freeze({ ...one }))
  if (asked.length === 0) return []
  const before = await readRouterAreas(home)
  if (!before.ruleBindings?.length || !expectedBindings(before, deps) || grantingRules(before, deps)?.size === 0) return []
  const fresh = asked.filter((one) => !before.items.some((item) => sameSource(item.source, one)))
  const resolve = deps.resolve ?? resolveRouterItem
  const found: Array<{ source: RouterSource; item: RouterItem; canonicalKey: string }> = []
  for (const source of fresh) {
    let item: RouterItem
    try { item = await resolve(source) } catch (error) {
      if (quietSourceMiss(error)) continue
      throw error
    }
    if (item.source.kind !== source.kind || item.source.account !== source.account || item.source.message !== source.message
      || (source.version !== undefined && item.source.version !== source.version)) continue
    const canonicalKey = item.scopeKey ?? item.key
    if (typeof canonicalKey !== 'string' || !canonicalKey || canonicalKey.length > ROUTER_CANONICAL_KEY_MAX
      || /[\u0000-\u001f\u007f]/.test(canonicalKey)) continue
    found.push({ source, item, canonicalKey })
  }
  if (found.length === 0) return []
  const current = deps.current ?? currentRouterSources
  let entered: RouterSource[] = []
  const saved = await updateRouterAreas(home, async (file) => {
    // Reset per run: only the run that was saved may report what it wrote.
    entered = []
    if (!file.ruleBindings?.length || !expectedBindings(file, deps)) return file
    const granting = grantingRules(file, deps)
    if (granting?.size === 0) return file
    const rules = await readRules(home, deps)
    const targets = await readTargets(confirmedRules(file, rules).map(({ rule }) => rule.taskId), deps)
    const live = await current(found.map((one) => one.source))
    for (const one of found) {
      if (!live.some((entry) => sameSource(entry, one.source))) continue
      // Every current match must agree on one area; with a snapshot, one of them must be a binding it held.
      const matches = liveMatches(file, rules, targets, one.item)
      if (granting && !matches.some(({ rule }) => granting.has(rule.id))) continue
      const areaId = soleArea(matches)
      const area = areaId ? file.areas.find((entry) => entry.id === areaId) : undefined
      if (!area || blocked(file, one.source, area.id, one.canonicalKey)) continue
      if (!area.sources.some((entry) => entry.kind === one.source.kind && entry.account === one.source.account)) {
        area.sources.push({ kind: one.source.kind, account: one.source.account })
      }
      file.items.push({ source: { ...one.source }, areaId: area.id, canonicalKey: one.canonicalKey })
      entered.push({ ...one.source })
    }
    return file
  })
  return entered.filter((one) => saved.items.some((item) => sameSource(item.source, one)))
}
