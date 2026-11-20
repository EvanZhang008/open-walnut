/**
 * Where a project's code comes from, and a start from it ("start a new task from a project").
 *
 * A project's registry row may say where its new tasks get their code
 * (`metadata.workspace_source`): a workspace provider, the folder on the project's host the
 * workspace is made from (`anchor`, else `default_cwd`), and the provider's input values used by
 * default (an array field holds the project's favourites, ticked on every start). Every start
 * from the project makes a fresh isolated workspace through the existing launch path
 * (launch.ts workspaceLaunchPlan, task-start's default workspace).
 *
 *   explicit    metadata.workspace_source                     { provider, anchor?, inputs? }
 *   legacy      default_cwd + isolated_workspace === 'on'     { provider: 'auto', anchor: default_cwd }
 *   none        anything else: the project keeps the folder flow
 *
 * 'auto' is "the provider that claims the anchor" (default-isolation.ts draftDefaultAsk). The
 * legacy fold is read only, never written back: an older Walnut ignores the new keys.
 *
 * `workspace_source_usage` counts how often each value of an array input was used for a start
 * from the project; suggestions are the favourites first, then those values by count. Only what
 * the start really used is counted: the workspace row's checked inputs, array fields of the
 * provider's own schema only (an 'auto' start: the provider that claimed the folder), bounded.
 *
 * A row read never waits on a host: the provider's name and fields come from the local
 * provider catalog (registry.ts) only.
 */

import os from 'node:os'
import { workspaceProviderCatalog, type ProviderInfo } from './registry.js'
import type { TaskWorkspace, WorkspaceInputSchema } from './types.js'
import { log } from '../../logging/index.js'
import { defaultCwdOnHost } from '../sessions/launch-place.js'

export const WORKSPACE_SOURCE_KEY = 'workspace_source'
export const WORKSPACE_SOURCE_USAGE_KEY = 'workspace_source_usage'
export const AUTO_PROVIDER = 'auto'
/** Values kept per field in the usage counts (the least used go first). */
export const MAX_USAGE_VALUES = 200
/** Fields kept in the usage counts, and the length of one counted value. */
export const MAX_USAGE_FIELDS = 16
export const MAX_USAGE_VALUE_CHARS = 200
/** Suggestions offered per field. */
export const MAX_SUGGESTIONS = 30
const MAX_INPUTS_BYTES = 16 * 1024
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface WorkspaceSource { provider: string; anchor?: string; inputs?: Record<string, unknown> }
export type SourceUsage = Record<string, Record<string, number>>

/** What a project row carries for the start picker (the web registry list and /api/v1/projects). */
export interface StartSource {
  provider: string
  provider_name?: string
  anchor: string
  host: string
  host_label?: string
  inputs: Record<string, unknown>
  suggestions: Record<string, string[]>
  input_schema?: WorkspaceInputSchema
}

type Meta = Record<string, unknown> | null | undefined

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isFolder = (v: string) => v.startsWith('/') || v === '~' || v.startsWith('~/')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [])

/** The project's own `workspace_source`, when it reads as one. Pure. */
export function explicitWorkspaceSource(meta: Meta): WorkspaceSource | null {
  const raw = meta?.[WORKSPACE_SOURCE_KEY]
  if (!isPlainObject(raw) || typeof raw.provider !== 'string' || !raw.provider) return null
  const anchor = typeof raw.anchor === 'string' && isFolder(raw.anchor) ? raw.anchor : undefined
  return { provider: raw.provider, ...(anchor ? { anchor } : {}), ...(isPlainObject(raw.inputs) ? { inputs: raw.inputs } : {}) }
}

/** The source a start from this project uses, with its folder resolved (the legacy fold included); null: none. Pure. */
export function effectiveWorkspaceSource(meta: Meta): (WorkspaceSource & { anchor: string; inputs: Record<string, unknown> }) | null {
  // The source is made on the project's own host, so its default folder is read for that host.
  const own = defaultCwdOnHost(meta as { default_cwd?: string; default_host?: string } | null, projectHost(meta))
  const cwd = own && isFolder(own) ? own : undefined
  const explicit = explicitWorkspaceSource(meta)
  if (explicit) {
    const anchor = explicit.anchor ?? cwd
    return anchor ? { provider: explicit.provider, anchor, inputs: explicit.inputs ?? {} } : null
  }
  if (cwd && meta?.isolated_workspace === 'on') return { provider: AUTO_PROVIDER, anchor: cwd, inputs: {} }
  return null
}

/** The project's host for a start: '__local__' or a config.hosts key. Pure. */
export function projectHost(meta: Meta): string {
  const h = typeof meta?.default_host === 'string' ? meta.default_host.trim() : ''
  return !h || h === 'local' ? '__local__' : h
}

function readUsage(meta: Meta): SourceUsage {
  const raw = meta?.[WORKSPACE_SOURCE_USAGE_KEY]
  const out: SourceUsage = {}
  if (!isPlainObject(raw)) return out
  for (const [field, counts] of Object.entries(raw)) {
    if (!isPlainObject(counts)) continue
    const clean: Record<string, number> = {}
    for (const [value, n] of Object.entries(counts)) if (typeof n === 'number' && Number.isFinite(n) && n > 0) clean[value] = n
    out[field] = clean
  }
  return out
}

/** The array-of-string fields: from the schema when known, else what the inputs and usage hold. */
function arrayFields(schema: WorkspaceInputSchema | undefined, inputs: Record<string, unknown>, usage: SourceUsage): string[] {
  if (schema) return Object.entries(schema.properties ?? {}).filter(([, f]) => f.type === 'array').map(([k]) => k)
  return [...new Set([...Object.keys(inputs).filter((k) => Array.isArray(inputs[k])), ...Object.keys(usage)])]
}

/** Per array field: the favourites first, then the used values by count (ties by name), de-duplicated, at most 30. Pure. */
export function sourceSuggestions(inputs: Record<string, unknown>, usage: SourceUsage, schema?: WorkspaceInputSchema): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const field of arrayFields(schema, inputs, usage)) {
    const used = Object.entries(usage[field] ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v)
    const list = [...new Set([...strings(inputs[field]), ...used])].slice(0, MAX_SUGGESTIONS)
    if (list.length) out[field] = list
  }
  return out
}

/**
 * The values of a start that count: the array-of-string fields the provider's schema names, the
 * first 16 of them, each value cut to 200 characters, at most 200 values a field. No schema
 * (a provider the local catalog does not know): nothing counts. Pure.
 */
export function countedInputs(schema: WorkspaceInputSchema | undefined, inputs: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!schema || !isPlainObject(inputs)) return out
  for (const [field, f] of Object.entries(schema.properties ?? {})) {
    if (Object.keys(out).length >= MAX_USAGE_FIELDS) break
    if (f?.type !== 'array' || (f.items && f.items.type !== 'string') || !Object.hasOwn(inputs, field)) continue
    const values = [...new Set(strings(inputs[field]).map((v) => v.slice(0, MAX_USAGE_VALUE_CHARS)))].slice(0, MAX_USAGE_VALUES)
    if (values.length) out[field] = values
  }
  return out
}

/** The usage counts after one start with these counted values: each +1, at most 200 values a field and 16 fields. Pure. */
export function bumpUsage(usage: SourceUsage, counted: Record<string, string[]>): SourceUsage {
  const next: SourceUsage = { ...usage }
  for (const [field, values] of Object.entries(counted)) {
    if (!values.length || (!Object.hasOwn(next, field) && Object.keys(next).length >= MAX_USAGE_FIELDS)) continue
    const counts = { ...(next[field] ?? {}) }
    for (const v of values) counts[v] = (counts[v] ?? 0) + 1
    const kept = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_USAGE_VALUES)
    next[field] = Object.fromEntries(kept)
  }
  return next
}

/**
 * A `workspace_source` / `workspace_source_usage` write, checked before it is stored: a sentence
 * for the 400, or null. `undefined` (the route's null) clears the key. Pure.
 */
export function checkWorkspaceSourceShape(patch: Record<string, unknown>): string | null {
  if (Object.hasOwn(patch, WORKSPACE_SOURCE_KEY) && patch[WORKSPACE_SOURCE_KEY] !== undefined) {
    const v = patch[WORKSPACE_SOURCE_KEY]
    if (!isPlainObject(v)) return 'workspace_source must be an object { provider, anchor?, inputs? } (null clears it)'
    const extra = Object.keys(v).filter((k) => !['provider', 'anchor', 'inputs'].includes(k))
    if (extra.length) return `workspace_source has unknown field(s): ${extra.join(', ')}`
    if (typeof v.provider !== 'string' || !(v.provider === AUTO_PROVIDER || PROVIDER_ID.test(v.provider))) {
      return 'workspace_source.provider must be a workspace provider id (workspace_providers lists them) or "auto"'
    }
    if (v.anchor !== undefined && v.anchor !== null && (typeof v.anchor !== 'string' || !isFolder(v.anchor) || v.anchor.length > 4096)) {
      return 'workspace_source.anchor must be an absolute folder path (or one under ~)'
    }
    if (v.inputs !== undefined && v.inputs !== null) {
      if (!isPlainObject(v.inputs)) return 'workspace_source.inputs must be an object of the provider\'s field values'
      if (JSON.stringify(v.inputs).length > MAX_INPUTS_BYTES) return 'workspace_source.inputs is too large (16 KB at most)'
    }
  }
  if (Object.hasOwn(patch, WORKSPACE_SOURCE_USAGE_KEY) && patch[WORKSPACE_SOURCE_USAGE_KEY] !== undefined) {
    const u = patch[WORKSPACE_SOURCE_USAGE_KEY]
    const ok = isPlainObject(u) && Object.keys(u).length <= MAX_USAGE_FIELDS && Object.values(u).every((c) => isPlainObject(c)
      && Object.keys(c).length <= MAX_USAGE_VALUES && Object.keys(c).every((v) => v.length <= MAX_USAGE_VALUE_CHARS)
      && Object.values(c).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))
    if (!ok) {
      return `workspace_source_usage must map each field to { value: count } (at most ${MAX_USAGE_FIELDS} fields, ${MAX_USAGE_VALUES} values a field, ${MAX_USAGE_VALUE_CHARS} characters a value)`
    }
  }
  return null
}

function localLabel(): string {
  return os.platform() === 'darwin' ? 'This Mac' : 'This computer'
}

/** A row's start source, with what the local catalog and config know. Pure. */
export function startSourceOf(meta: Meta, ctx: { providers: ProviderInfo[]; hostLabel: (host: string) => string | undefined }): StartSource | null {
  const source = effectiveWorkspaceSource(meta)
  if (!source) return null
  const host = projectHost(meta)
  const info = source.provider === AUTO_PROVIDER ? undefined : ctx.providers.find((p) => p.id === source.provider)
  const label = host === '__local__' ? localLabel() : ctx.hostLabel(host) ?? host
  return {
    provider: source.provider,
    ...(info ? { provider_name: info.displayName } : {}),
    anchor: source.anchor,
    host,
    host_label: label,
    inputs: source.inputs,
    suggestions: sourceSuggestions(source.inputs, readUsage(meta), info?.inputSchema),
    ...(info?.inputSchema ? { input_schema: info.inputSchema } : {}),
  }
}

/** One reader for many rows (the project list): the catalog and the host labels are read once. */
export async function startSourceReader(): Promise<(meta: Meta) => StartSource | null> {
  const [{ providers }, config] = await Promise.all([
    workspaceProviderCatalog().catch(() => ({ providers: [] as ProviderInfo[] })),
    import('../config-manager.js').then((m) => m.getConfig()).catch(() => null),
  ])
  const { hostDisplayName } = await import('../hosts/host-display-name.js')
  // Labels by alias, looked up per row: no list of hosts to pick from is built here.
  const rows = (config?.hosts ?? {}) as Record<string, { label?: unknown } | undefined>
  const hostLabel = (host: string) => (Object.hasOwn(rows, host) ? hostDisplayName(host, rows[host]?.label) : undefined)
  return (meta) => startSourceOf(meta, { providers, hostLabel })
}

async function projectRow(name: string): Promise<{ name: string; meta: Record<string, unknown> } | null> {
  const { launchProjectName } = await import('../sessions/project-launch-defaults.js')
  const canonical = await launchProjectName(name)
  if (!canonical) return null
  const tm = await import('../task-manager.js')
  const record = await tm.getProjectRecord(canonical)
  return record ? { name: record.name, meta: record.metadata ?? {} } : null
}

/** A project's start source by name; null for Inbox, an unknown project or one with no source. */
export async function projectStartSource(name: string): Promise<StartSource | null> {
  const row = await projectRow(name)
  return row ? (await startSourceReader())(row.meta) : null
}

/** This machine's `~` expanded once; another host's stays literal (its daemon reads it). Pure. */
export function anchorOn(anchor: string, host: string): string {
  return host === '__local__' && (anchor === '~' || anchor.startsWith('~/')) ? os.homedir() + anchor.slice(1) : anchor
}

/** A start from a project that cannot go ahead: the routes answer it as is. */
export class ProjectStartError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message) }
}

export interface ProjectStart {
  /** The project's canonical name. */
  project: string
  cwd: string
  /** '__local__' or a config.hosts key. */
  host: string
  /** The quick-start body's `workspace`: the claiming provider, or the named one with its inputs. */
  workspace: { auto: true } | { provider: string; inputs: Record<string, unknown> }
}

/**
 * Where a start from this project runs and with which workspace. `host` overrides the project's
 * host for this start ('__local__' = this machine; absent or '' = the project's own host); `inputs`
 * overrides the source's values field by field.
 * The inputs are checked against the provider's fields by the launch path itself (workspaceLaunchPlan).
 */
export async function resolveProjectStart(name: string, opts: { host?: string; inputs?: Record<string, unknown> } = {}): Promise<ProjectStart> {
  if (typeof name !== 'string' || !name.trim()) throw new ProjectStartError('A start from a project needs its name (project).', 400, 'no-project-source')
  const row = await projectRow(name)
  if (!row) throw new ProjectStartError(`No project "${name.trim()}".`, 404, 'unknown-project')
  const source = effectiveWorkspaceSource(row.meta)
  if (!source) {
    throw new ProjectStartError(`Project "${row.name}" has no code source: set one in its settings (Code source), or pick a folder.`, 400, 'no-project-source')
  }
  // Absent or '' = the project's own host; '__local__' (or 'local') = this machine. Both routes alike.
  const host = !opts.host ? projectHost(row.meta) : opts.host === 'local' ? '__local__' : opts.host
  const cwd = anchorOn(source.anchor, host)
  const workspace = source.provider === AUTO_PROVIDER
    ? { auto: true as const }
    : { provider: source.provider, inputs: { ...source.inputs, ...(isPlainObject(opts.inputs) ? opts.inputs : {}) } }
  return { project: row.name, cwd, host, workspace }
}

/** One write at a time per project in this process, so two starts at once both count. */
const usageWrites = new Map<string, Promise<void>>()

/**
 * Count the array values a start used: its workspace row's provider and checked inputs (never
 * throws: suggestions are a nicety).
 */
export function recordSourceUse(name: string, used: Pick<TaskWorkspace, 'provider' | 'inputs'> | undefined): Promise<void> {
  if (!used?.provider || !isPlainObject(used.inputs) || !Object.values(used.inputs).some((v) => strings(v).length)) return Promise.resolve()
  const key = name.trim().toLowerCase()
  const run = (usageWrites.get(key) ?? Promise.resolve()).then(async () => {
    const { providers } = await workspaceProviderCatalog()
    const counted = countedInputs(providers.find((p) => p.id === used.provider)?.inputSchema, used.inputs)
    if (!Object.keys(counted).length) return
    const row = await projectRow(name)
    if (!row) return
    const tm = await import('../task-manager.js')
    await tm.setProjectMetadata(row.name, { [WORKSPACE_SOURCE_USAGE_KEY]: bumpUsage(readUsage(row.meta), counted) })
  }).catch((err) => {
    log.session.warn('project source usage not recorded', { project: name, error: err instanceof Error ? err.message : String(err) })
  })
  usageWrites.set(key, run)
  void run.finally(() => { if (usageWrites.get(key) === run) usageWrites.delete(key) })
  return run
}

/** After a start from a project: count what its workspace used, once the start was accepted (both routes). */
export function recordStartUse(project: string, answer: Record<string, unknown> | null | undefined): void {
  if (answer?.preparing !== true || answer.workspaceError) return
  const ws = isPlainObject(answer.task) && isPlainObject(answer.task.workspace) ? answer.task.workspace : null
  if (ws && typeof ws.provider === 'string') void recordSourceUse(project, { provider: ws.provider, inputs: isPlainObject(ws.inputs) ? ws.inputs : undefined })
}

/** What a start from a project answers when it cannot go ahead (both routes' bodies carry `code`). */
export interface ProjectStartRefusal { status: number; body: { error: string; code: string } }

/** `fromProject`'s companions, shape-checked: the values to override, or a refusal. Pure. */
export function projectStartAsk(body: Record<string, unknown>): { host?: string; inputs?: Record<string, unknown> } | ProjectStartRefusal {
  const bad = (error: string): ProjectStartRefusal => ({ status: 400, body: { error, code: 'bad-request' } })
  if (body.walnutAgent === true) return bad('A quick question starts from no project source.')
  if (body.workspaceInputs !== undefined && body.workspaceInputs !== null && !isPlainObject(body.workspaceInputs)) return bad('workspaceInputs must be an object of the provider\'s field values')
  if (body.host !== undefined && body.host !== null && typeof body.host !== 'string') return bad('host must be a string')
  return {
    ...(typeof body.host === 'string' ? { host: body.host } : {}),
    ...(isPlainObject(body.workspaceInputs) ? { inputs: body.workspaceInputs } : {}),
  }
}

export function refusalOf(err: unknown): ProjectStartRefusal | null {
  return err instanceof ProjectStartError ? { status: err.status, body: { error: err.message, code: err.code } } : null
}

/**
 * The web quick-start body of a start from a project (`fromProject: true`): its folder, host and
 * workspace filled in from the project's source, so the route runs on as for a picked folder.
 * `used` counts the values once the start was accepted. Null: not a start from a project.
 */
export async function quickStartBodyFromProject(body: Record<string, unknown>): Promise<
  { body: Record<string, unknown>; used: (answer: Record<string, unknown>) => void } | { refuse: ProjectStartRefusal } | null
> {
  if (body?.fromProject !== true) return null
  const ask = projectStartAsk(body)
  if ('status' in ask) return { refuse: ask }
  let start: ProjectStart
  try {
    start = await resolveProjectStart(typeof body.project === 'string' ? body.project : '', ask)
  } catch (err) {
    const refusal = refusalOf(err)
    if (refusal) return { refuse: refusal }
    throw err
  }
  const { cwd: _c, ownTaskDir: _o, createCwd: _m, ...rest } = body
  return {
    body: {
      ...rest, cwd: start.cwd, host: start.host === '__local__' ? undefined : start.host,
      project: start.project, projectFromFolder: false, workspace: start.workspace,
    },
    used: (answer) => recordStartUse(start.project, answer),
  }
}
