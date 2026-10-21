/**
 * Trigger templates: ready-made triggers a plugin offers ("a new message in a
 * Slack channel", "new mail from a sender").
 *
 * A template is NOT a new kind of trigger. Arming one stores an ordinary check
 * whose command is `walnut trigger-check <template> '<params>'`: the daemon on
 * this machine still owns the clock, the dedup set and the fire budget, and the
 * command only asks this server to run the plugin's `check` once
 * (POST /api/v1/trigger-templates/:id/check). So the plugin writes a JS function
 * instead of a shell script, and everything the trigger system already does
 * (seen ids, held fires, error reporting, pause/resume) applies unchanged.
 *
 * The command is built here and only here, with params JSON that never holds a
 * single quote, so `parseTemplateRun` can recognize it exactly. That is what lets
 * a session on another host arm one (check-host-policy.ts): the command it hands
 * this Mac's daemon can do nothing but call a registered plugin check.
 *
 * Leaf module: owned-registry + ids only, so the routes, the trigger API and the
 * policy can all import it without pulling in the plugin loader.
 */
import { OwnedRegistry } from '../plugins/owned-registry.js'
import { namespacePluginId, validatePluginId } from '../plugins/ids.js'
import type { Disposable } from '../plugins/disposable.js'
import { REMOTE_HTTP_ORIGIN, isLocalOrigin } from '../../lib/caller-origin.js'

export interface TriggerTemplateParam {
  key: string
  label: string
  description?: string
  required?: boolean
  placeholder?: string
  /** The template answers `options(key, query)` for this param (a channel list, a folder list). */
  options?: boolean
}

export interface TriggerTemplateOption {
  value: string
  label: string
  hint?: string
}

/** What `prepare` returns: the params to store, plus the words the trigger is shown with. */
export interface TriggerTemplatePrepared {
  params: Record<string, string>
  /** Short name for the routine card ("#eng-oncall: new messages"). */
  label: string
  /** One or two sentences for the user: what is watched, when it fires, what the session does. */
  description: string
  /** What the session is told to do on a fire, unless the user wrote their own. */
  prompt: string
}

/** What the template's `check` answers: the trigger check contract, as an object. */
export interface TriggerTemplateCheckResult {
  fire: boolean
  items?: Array<{ id: string; title?: string; [key: string]: unknown }>
  input?: string
  state?: unknown
}

export interface TriggerTemplateCheckInput {
  state: unknown
  lastFireAt: string | null
  now: string
}

/** What a plugin passes to `walnut.registry.triggerTemplate(...)`. */
export interface TriggerTemplateDefinition {
  id: string
  title: string
  description: string
  params?: TriggerTemplateParam[]
  /** Default check interval ("5m"). */
  every?: string
  /** Default fire budget; a chat source checked every 5 minutes wants 288. */
  maxFiresPerDay?: number
  /** Short hints shown under the picker ("#general", "from:alice"). */
  examples?: string[]
  /**
   * A session on another host may arm and run this template. Off by default:
   * its items reach the session that armed it, so set it only when the plugin's
   * own read ops already answer remote sessions.
   */
  remote?: boolean
  /** Validate and normalize the params (resolve "#name" to an id). Throw an Error with a plain message to refuse. */
  prepare(params: Record<string, string>): Promise<TriggerTemplatePrepared> | TriggerTemplatePrepared
  options?(key: string, query: string): Promise<TriggerTemplateOption[]> | TriggerTemplateOption[]
  check(params: Record<string, string>, input: TriggerTemplateCheckInput): Promise<TriggerTemplateCheckResult>
}

export interface TriggerTemplateRecord extends TriggerTemplateDefinition {
  /** `<pluginId>:<localId>`, the id every caller uses. */
  name: string
  pluginId: string
  pluginName: string
}

/** The public view: what a picker or an agent reads. */
export interface TriggerTemplateSummary {
  id: string
  pluginId: string
  pluginName: string
  title: string
  description: string
  params: TriggerTemplateParam[]
  every: string
  maxFiresPerDay?: number
  examples?: string[]
}

const templates = new OwnedRegistry<TriggerTemplateRecord>()

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PARAM_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/
export const DEFAULT_TEMPLATE_EVERY = '5m'

export function registerTriggerTemplate(
  owner: string,
  pluginName: string,
  definition: TriggerTemplateDefinition,
): Disposable {
  validatePluginId(owner)
  if (typeof definition?.id !== 'string' || !LOCAL_ID.test(definition.id)) {
    throw new Error(`Invalid trigger template id: ${JSON.stringify(definition?.id)}`)
  }
  const name = namespacePluginId(owner, definition.id)
  if (typeof definition.title !== 'string' || !definition.title.trim()) {
    throw new Error(`Trigger template "${name}" requires a title`)
  }
  if (typeof definition.prepare !== 'function' || typeof definition.check !== 'function') {
    throw new Error(`Trigger template "${name}" requires prepare() and check()`)
  }
  for (const param of definition.params ?? []) {
    if (!PARAM_KEY.test(param?.key ?? '')) {
      throw new Error(`Trigger template "${name}" has an invalid param key: ${JSON.stringify(param?.key)}`)
    }
  }
  return templates.register(owner, name, { ...definition, name, pluginId: owner, pluginName: pluginName || owner })
}

export function getTriggerTemplate(name: string): TriggerTemplateRecord | null {
  return templates.get(name) ?? null
}

export function summarizeTemplate(record: TriggerTemplateRecord): TriggerTemplateSummary {
  return {
    id: record.name,
    pluginId: record.pluginId,
    pluginName: record.pluginName,
    title: record.title,
    description: record.description ?? '',
    params: (record.params ?? []).map((p) => ({ ...p })),
    every: record.every || DEFAULT_TEMPLATE_EVERY,
    ...(typeof record.maxFiresPerDay === 'number' ? { maxFiresPerDay: record.maxFiresPerDay } : {}),
    ...(record.examples?.length ? { examples: [...record.examples] } : {}),
  }
}

export function listTriggerTemplates(): TriggerTemplateSummary[] {
  return templates.values()
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.title.localeCompare(b.title))
    .map(summarizeTemplate)
}

export function removeTriggerTemplatesForTesting(): void {
  templates.clear()
}

/** Params as stored: string values only, keys the template declares (extra keys dropped). */
export function cleanTemplateParams(record: TriggerTemplateRecord, raw: unknown): Record<string, string> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, string> = {}
  for (const param of record.params ?? []) {
    const value = input[param.key]
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
    if (text) out[param.key] = text.slice(0, 500)
    else if (param.required) throw new Error(`${param.label || param.key} is required`)
  }
  return out
}

/**
 * The stored command. Params ride as JSON in single quotes, with every `'`
 * written as a JSON unicode escape, so the shell sees one literal word and the
 * JSON still parses.
 */
export function templateRun(name: string, params: Record<string, string>): string {
  if (!TEMPLATE_NAME.test(name)) throw new Error(`Invalid trigger template id: ${name}`)
  const json = JSON.stringify(params).replace(/'/g, '\\u0027')
  return `walnut trigger-check ${name} '${json}'`
}

const RUN_SHAPE = /^walnut trigger-check ([a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}) '([^']*)'$/

/** The template and params of a command `templateRun` built, or null for anything else. */
export function parseTemplateRun(run: string): { name: string; params: Record<string, string> } | null {
  const match = RUN_SHAPE.exec(run.trim())
  if (!match) return null
  try {
    const parsed = JSON.parse(match[2]!) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      params[key] = value
    }
    return { name: match[1]!, params }
  } catch {
    return null
  }
}

/**
 * A plugin check gets this long. The daemon kills the whole command at 30s, and
 * the CLI around the call spends a few seconds starting, so the server answers
 * well inside that and the CLI can still print its line.
 */
export const TEMPLATE_CHECK_DEADLINE_MS = 20_000

export class TriggerTemplateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** The registered template, or a 404 that tells the caller where the list is. */
export function requireTriggerTemplate(name: string): TriggerTemplateRecord {
  const record = TEMPLATE_NAME.test(name) ? getTriggerTemplate(name) : null
  if (!record) {
    throw new TriggerTemplateError(
      `no trigger template ${JSON.stringify(name)}: its plugin may be off or removed. trigger_templates lists what is available`,
      404,
    )
  }
  return record
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TriggerTemplateError(`${what} did not answer within ${ms / 1000}s`, 504)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Run a template's prepare; its own Error message becomes a 400 the user can read. */
export async function prepareTemplate(record: TriggerTemplateRecord, rawParams: unknown): Promise<TriggerTemplatePrepared> {
  let cleaned: Record<string, string>
  try {
    cleaned = cleanTemplateParams(record, rawParams)
  } catch (err) {
    throw new TriggerTemplateError(err instanceof Error ? err.message : String(err), 400)
  }
  let prepared: TriggerTemplatePrepared
  try {
    prepared = await withDeadline(Promise.resolve(record.prepare(cleaned)), TEMPLATE_CHECK_DEADLINE_MS, `${record.title}`)
  } catch (err) {
    if (err instanceof TriggerTemplateError) throw err
    throw new TriggerTemplateError(err instanceof Error ? err.message : String(err), 400)
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(prepared?.params ?? cleaned)) {
    if (typeof value === 'string' && value) params[key] = value
  }
  return {
    params,
    label: String(prepared?.label || record.title).trim().slice(0, 120),
    description: String(prepared?.description || record.description || record.title).replace(/\s+/g, ' ').trim().slice(0, 600),
    prompt: String(prepared?.prompt || '').trim()
      || 'Read each new item and do what it asks; tell the user only about what needs them.',
  }
}

/**
 * Why `origin` may not use this template, or null. A caller on this Mac, a
 * paired device or an API key may (both can already start a session here); a
 * session on another host only when the template says `remote`.
 */
export function templateOriginRefusal(record: TriggerTemplateRecord, origin: string | undefined): string | null {
  if (origin === undefined || isLocalOrigin(origin) || origin === REMOTE_HTTP_ORIGIN || record.remote) return null
  return `The "${record.title}" trigger from the ${record.pluginName} plugin is only available to sessions on this Mac`
}

function assertTemplateOrigin(record: TriggerTemplateRecord, origin: string | undefined): void {
  const refusal = templateOriginRefusal(record, origin)
  if (refusal) throw new TriggerTemplateError(refusal, 403)
}

/** Params for a check run: what the template declares, required ones present (else a 400). */
function checkParams(record: TriggerTemplateRecord, rawParams: unknown): Record<string, string> {
  try {
    return cleanTemplateParams(record, rawParams)
  } catch (err) {
    throw new TriggerTemplateError(err instanceof Error ? err.message : String(err), 400)
  }
}

/** One plugin check run, answered in the check contract's shape. */
export async function runTemplateCheck(
  name: string,
  rawParams: unknown,
  rawInput: unknown,
  origin?: string,
): Promise<TriggerTemplateCheckResult> {
  const record = requireTriggerTemplate(name)
  assertTemplateOrigin(record, origin)
  const params = checkParams(record, rawParams)
  const input = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
  const checkInput: TriggerTemplateCheckInput = {
    state: input.state ?? null,
    lastFireAt: typeof input.lastFireAt === 'string' ? input.lastFireAt : null,
    now: typeof input.now === 'string' ? input.now : new Date().toISOString(),
  }
  let result: TriggerTemplateCheckResult
  try {
    result = await withDeadline(record.check(params, checkInput), TEMPLATE_CHECK_DEADLINE_MS, `${record.title} check`)
  } catch (err) {
    if (err instanceof TriggerTemplateError) throw err
    throw new TriggerTemplateError(`${record.title} check failed: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  if (!result || typeof result.fire !== 'boolean') {
    throw new TriggerTemplateError(`${record.title} check answered without a boolean "fire"`, 502)
  }
  return result
}

export async function templateOptions(name: string, key: string, query: string, origin?: string): Promise<TriggerTemplateOption[]> {
  const record = requireTriggerTemplate(name)
  assertTemplateOrigin(record, origin)
  if (!record.options || !(record.params ?? []).some((p) => p.key === key && p.options)) return []
  let list: TriggerTemplateOption[]
  try {
    list = await withDeadline(Promise.resolve().then(() => record.options!(key, query)), 15_000, `${record.title} options`)
  } catch (err) {
    if (err instanceof TriggerTemplateError) throw err
    throw new TriggerTemplateError(`${record.title} options failed: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  return (Array.isArray(list) ? list : [])
    .filter((o) => o && typeof o.value === 'string' && o.value)
    .slice(0, 200)
    .map((o) => ({ value: o.value, label: typeof o.label === 'string' && o.label ? o.label : o.value, ...(o.hint ? { hint: String(o.hint) } : {}) }))
}

/**
 * The command to store when `check` is a template check the caller may arm, or
 * null for anything else. Such a command can only call a registered plugin
 * check, so the host policy (which guards arbitrary shell) does not apply to
 * it. Only exactly that: this Mac, no working directory (the `walnut` it runs
 * is found on PATH, and a directory could put another one first), a template
 * that exists and allows this caller. The command comes back rebuilt from
 * cleaned params, so what is stored is what `templateRun` would write.
 */
export function exemptTemplateRun(
  check: { run?: unknown; cwd?: unknown; host?: unknown },
  origin: string | undefined,
): string | null {
  const parsed = typeof check.run === 'string' ? parseTemplateRun(check.run) : null
  const host = typeof check.host === 'string' && check.host.trim() ? check.host.trim() : '__local__'
  const cwd = typeof check.cwd === 'string' ? check.cwd.trim() : ''
  if (!parsed || host !== '__local__' || cwd) return null
  const record = getTriggerTemplate(parsed.name)
  if (!record || templateOriginRefusal(record, origin)) return null
  try {
    return templateRun(record.name, cleanTemplateParams(record, parsed.params))
  } catch {
    return null
  }
}
