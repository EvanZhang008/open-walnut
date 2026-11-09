import path from 'node:path'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { ROUTER_SOURCE_KINDS, type RouterSource, type RouterSourceKind } from './types.js'
import { ensureRouterDataVersion, RouterDataVersionError } from './data-version.js'

export interface RouterAreaSource {
  kind: RouterSourceKind
  account: string
}

export interface RouterArea {
  id: string
  name: string
  host: string
  taskIds: string[]
  sources: RouterAreaSource[]
}

export interface RouterAssignment {
  taskId: string
  areaId: string
  paused: boolean
}

export interface RouterAreaItem {
  source: RouterSource
  areaId: string
  // Cache identity restricts copied items; only the exact source grants content access.
  canonicalKey?: string
}

export interface RouterRuleBinding {
  ruleId: string
  // The rule's fingerprint at the person's confirmation; a changed rule no longer matches.
  revision: string
  areaId: string
  confirmedAt: number
}

export interface RouterAreasFile {
  version: 1
  areas: RouterArea[]
  routers: RouterAssignment[]
  items: RouterAreaItem[]
  ruleBindings?: RouterRuleBinding[]
}

export type RouterAreaErrorCode =
  | 'invalid_home'
  | 'invalid_areas'
  | 'unsupported_version'
  | 'area_reassignment'
  | 'source_unassigned'
  | 'task_unassigned'
  | 'cross_area'
  | 'area_unassigned'
  | 'area_forbidden'
  | 'router_data_version'

export class RouterAreaError extends Error {
  readonly code: RouterAreaErrorCode
  readonly status: number

  constructor(code: RouterAreaErrorCode, status: number, message: string) {
    super(message)
    this.name = 'RouterAreaError'
    this.code = code
    this.status = status
  }
}

export const ROUTER_AREA_ID_MAX = 80
export const ROUTER_AREA_NAME_MAX = 120
export const ROUTER_AREA_HOST_MAX = 200
const TASK_ID_MAX = 200
const ACCOUNT_MAX = 320
const MESSAGE_MAX = 1000
export const ROUTER_CANONICAL_KEY_MAX = 2048
const AREA_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
export const ROUTER_RULE_ID_PATTERN = /^[A-Za-z0-9][\w.-]{0,59}$/
export const ROUTER_RULE_REVISION_PATTERN = /^[0-9a-f]{64}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function emptyFile(): RouterAreasFile {
  return { version: 1, areas: [], routers: [], items: [] }
}

export function routerAreasPath(home: string): string {
  if (typeof home !== 'string' || home.length === 0 || CONTROL_CHARS.test(home) || !path.isAbsolute(home)) {
    throw new RouterAreaError('invalid_home', 400, 'Router home must be an absolute path')
  }
  if (home.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new RouterAreaError('invalid_home', 400, 'Router home must not contain ".." segments')
  }
  return path.join(path.resolve(home), 'router', 'areas.json')
}

function invalid(message: string): RouterAreaError {
  return new RouterAreaError('invalid_areas', 400, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainString(value: unknown, field: string, max: number, options: { trimmed?: boolean } = {}): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`)
  if (value.length === 0 || (options.trimmed && value.trim().length === 0)) throw invalid(`${field} must not be empty`)
  if (value.length > max) throw invalid(`${field} must be at most ${max} characters`)
  if (CONTROL_CHARS.test(value)) throw invalid(`${field} must not contain control characters`)
  return value
}

function sourceKind(value: unknown, field: string): RouterSourceKind {
  if (typeof value !== 'string' || !(ROUTER_SOURCE_KINDS as readonly string[]).includes(value)) {
    throw invalid(`${field} must be one of ${ROUTER_SOURCE_KINDS.join(', ')}`)
  }
  return value as RouterSourceKind
}

function accountKey(kind: string, account: string): string {
  return JSON.stringify([kind, account])
}

function itemKey(source: RouterSource): string {
  return JSON.stringify([source.kind, source.account, source.message, source.version ?? ''])
}

/** One canonical identity within one kind and account: the only scope a canonical key reaches. */
export function canonicalItemKey(kind: string, account: string, canonicalKey: string): string {
  return JSON.stringify([kind, account, canonicalKey])
}

function normalizeArea(value: unknown, index: number): RouterArea {
  const field = `areas[${index}]`
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  const id = plainString(value.id, `${field}.id`, ROUTER_AREA_ID_MAX)
  if (!AREA_ID_PATTERN.test(id)) {
    throw invalid(`${field}.id must be a lowercase slug of letters, digits, "-" or "_"`)
  }
  const name = plainString(value.name, `${field}.name`, ROUTER_AREA_NAME_MAX, { trimmed: true })
  const host = plainString(value.host, `${field}.host`, ROUTER_AREA_HOST_MAX, { trimmed: true })
  if (!Array.isArray(value.taskIds)) throw invalid(`${field}.taskIds must be an array`)
  const taskIds = value.taskIds.map((taskId, i) => plainString(taskId, `${field}.taskIds[${i}]`, TASK_ID_MAX))
  if (!Array.isArray(value.sources)) throw invalid(`${field}.sources must be an array`)
  const seen = new Set<string>()
  const sources = value.sources.map((source, i): RouterAreaSource => {
    const sourceField = `${field}.sources[${i}]`
    if (!isRecord(source)) throw invalid(`${sourceField} must be an object`)
    const kind = sourceKind(source.kind, `${sourceField}.kind`)
    const account = plainString(source.account, `${sourceField}.account`, ACCOUNT_MAX)
    const key = accountKey(kind, account)
    if (seen.has(key)) throw invalid(`${sourceField} repeats ${kind} account in area ${id}`)
    seen.add(key)
    return { kind, account }
  })
  return { id, name, host, taskIds, sources }
}

function normalizeRouter(value: unknown, index: number): RouterAssignment {
  const field = `routers[${index}]`
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  const taskId = plainString(value.taskId, `${field}.taskId`, TASK_ID_MAX)
  const areaId = plainString(value.areaId, `${field}.areaId`, ROUTER_AREA_ID_MAX)
  if (typeof value.paused !== 'boolean') throw invalid(`${field}.paused must be a boolean`)
  return { taskId, areaId, paused: value.paused }
}

function normalizeItem(value: unknown, index: number): RouterAreaItem {
  const field = `items[${index}]`
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  if (!isRecord(value.source)) throw invalid(`${field}.source must be an object`)
  const kind = sourceKind(value.source.kind, `${field}.source.kind`)
  const account = plainString(value.source.account, `${field}.source.account`, ACCOUNT_MAX)
  const message = plainString(value.source.message, `${field}.source.message`, MESSAGE_MAX)
  const areaId = plainString(value.areaId, `${field}.areaId`, ROUTER_AREA_ID_MAX)
  const version = value.source.version === undefined ? undefined
    : plainString(value.source.version, `${field}.source.version`, 200)
  const source = { kind, account, message, ...(version !== undefined ? { version } : {}) }
  if (value.canonicalKey === undefined) return { source, areaId }
  const canonicalKey = plainString(value.canonicalKey, `${field}.canonicalKey`, ROUTER_CANONICAL_KEY_MAX)
  return { source, areaId, canonicalKey }
}

function normalizeBinding(value: unknown, index: number): RouterRuleBinding {
  const field = `ruleBindings[${index}]`
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  const ruleId = plainString(value.ruleId, `${field}.ruleId`, 60)
  if (!ROUTER_RULE_ID_PATTERN.test(ruleId)) throw invalid(`${field}.ruleId is not a routing rule id`)
  const revision = plainString(value.revision, `${field}.revision`, 64)
  if (!ROUTER_RULE_REVISION_PATTERN.test(revision)) throw invalid(`${field}.revision must be a rule fingerprint`)
  const areaId = plainString(value.areaId, `${field}.areaId`, ROUTER_AREA_ID_MAX)
  if (typeof value.confirmedAt !== 'number' || !Number.isFinite(value.confirmedAt) || value.confirmedAt < 0) {
    throw invalid(`${field}.confirmedAt must be a time`)
  }
  return { ruleId, revision, areaId, confirmedAt: value.confirmedAt }
}

export function normalizeRouterAreas(value: unknown): RouterAreasFile {
  if (!isRecord(value)) throw invalid('Router areas must be an object')
  if (value.version !== 1) {
    throw new RouterAreaError('unsupported_version', 409, `Router areas version ${String(value.version)} is not supported by this Walnut`)
  }
  for (const key of ['areas', 'routers', 'items'] as const) {
    if (!Array.isArray(value[key])) throw invalid(`${key} must be an array`)
  }
  const areas = (value.areas as unknown[]).map(normalizeArea)
  const routers = (value.routers as unknown[]).map(normalizeRouter)
  const items = (value.items as unknown[]).map(normalizeItem)
  if (value.ruleBindings !== undefined && !Array.isArray(value.ruleBindings)) throw invalid('ruleBindings must be an array')
  const ruleBindings = ((value.ruleBindings ?? []) as unknown[]).map(normalizeBinding)

  const areaById = new Map<string, RouterArea>()
  const taskOwner = new Map<string, string>()
  for (const area of areas) {
    if (areaById.has(area.id)) throw invalid(`Area id ${area.id} is used twice`)
    areaById.set(area.id, area)
    for (const taskId of area.taskIds) {
      const owner = taskOwner.get(taskId)
      if (owner !== undefined) throw invalid(`Task ${taskId} belongs to both ${owner} and ${area.id}`)
      taskOwner.set(taskId, area.id)
    }
  }

  const routerTasks = new Set<string>()
  const activeByArea = new Map<string, string>()
  for (const router of routers) {
    const area = areaById.get(router.areaId)
    if (!area) throw invalid(`Router ${router.taskId} names unknown area ${router.areaId}`)
    if (taskOwner.get(router.taskId) !== area.id) {
      throw invalid(`Router ${router.taskId} is not a task of area ${area.id}`)
    }
    if (routerTasks.has(router.taskId)) throw invalid(`Task ${router.taskId} is assigned as a router twice`)
    routerTasks.add(router.taskId)
    if (!router.paused) {
      const active = activeByArea.get(area.id)
      if (active !== undefined) {
        throw invalid(`Area ${area.id} has two active routers: ${active} and ${router.taskId}`)
      }
      activeByArea.set(area.id, router.taskId)
    }
  }

  const seenItems = new Set<string>()
  const canonicalArea = new Map<string, string>()
  for (const item of items) {
    const area = areaById.get(item.areaId)
    if (!area) throw invalid(`An item names unknown area ${item.areaId}`)
    const key = itemKey(item.source)
    if (seenItems.has(key)) throw invalid(`A ${item.source.kind} item of one account is listed twice`)
    seenItems.add(key)
    const allowed = area.sources.some((source) => source.kind === item.source.kind && source.account === item.source.account)
    if (!allowed) throw invalid(`Area ${area.id} has no ${item.source.kind} source for the item's account`)
    // Several exact items of one area may share a canonical key; two areas never do.
    if (item.canonicalKey !== undefined) {
      const ckey = canonicalItemKey(item.source.kind, item.source.account, item.canonicalKey)
      const owner = canonicalArea.get(ckey)
      if (owner !== undefined && owner !== item.areaId) {
        throw invalid(`A ${item.source.kind} item of one account is in both ${owner} and ${item.areaId} under one canonical identity`)
      }
      canonicalArea.set(ckey, item.areaId)
    }
  }

  const boundRules = new Set<string>()
  for (const binding of ruleBindings) {
    if (!areaById.has(binding.areaId)) throw invalid(`Rule ${binding.ruleId} is bound to unknown area ${binding.areaId}`)
    if (boundRules.has(binding.ruleId)) throw invalid(`Rule ${binding.ruleId} is bound twice`)
    boundRules.add(binding.ruleId)
  }

  return { version: 1, areas, routers, items, ...(ruleBindings.length ? { ruleBindings } : {}) }
}

export function assertNoReassignment(before: RouterAreasFile, after: RouterAreasFile): void {
  const nextItems = new Map(after.items.map((item) => [itemKey(item.source), item]))
  for (const item of before.items) {
    const nextItem = nextItems.get(itemKey(item.source))
    const next = nextItem?.areaId
    if (next === item.areaId) {
      // A saved canonical key is part of the confirmation: it may be added, never changed or dropped.
      if (item.canonicalKey !== undefined && nextItem!.canonicalKey !== item.canonicalKey) {
        throw new RouterAreaError(
          'area_reassignment',
          409,
          `The canonical identity of a ${item.source.kind} item of area ${item.areaId} cannot be ${nextItem!.canonicalKey === undefined ? 'removed' : 'changed'}; use a migration`,
        )
      }
      continue
    }
    throw new RouterAreaError(
      'area_reassignment',
      409,
      next === undefined
        ? `A ${item.source.kind} item of area ${item.areaId} cannot be removed; use a migration`
        : `A ${item.source.kind} item cannot move from area ${item.areaId} to ${next}; use a migration`,
    )
  }
  const nextTasks = new Map<string, string>()
  for (const area of after.areas) for (const taskId of area.taskIds) nextTasks.set(taskId, area.id)
  for (const area of before.areas) {
    for (const taskId of area.taskIds) {
      const next = nextTasks.get(taskId)
      if (next === area.id) continue
      throw new RouterAreaError(
        'area_reassignment',
        409,
        next === undefined
          ? `Task ${taskId} cannot be removed from area ${area.id}; use a migration`
          : `Task ${taskId} cannot move from area ${area.id} to ${next}; use a migration`,
      )
    }
  }
}

export async function readRouterAreas(home: string): Promise<RouterAreasFile> {
  const file = routerAreasPath(home)
  const raw = await readJsonFile<unknown>(file, emptyFile(), { readErrors: 'throw' })
  return normalizeRouterAreas(raw)
}

/** The task store stamped for isolated areas (core/router/data-version.ts), as a RouterAreaError. */
export async function ensureAreasDataVersion(home: string): Promise<void> {
  try {
    await ensureRouterDataVersion(home)
  } catch (error) {
    if (error instanceof RouterDataVersionError) throw new RouterAreaError('router_data_version', error.status, error.message)
    throw error
  }
}

export async function updateRouterAreas(
  home: string,
  change: (file: RouterAreasFile) => RouterAreasFile | Promise<RouterAreasFile>,
): Promise<RouterAreasFile> {
  const file = routerAreasPath(home)
  return updateJsonFile<RouterAreasFile>(
    file,
    emptyFile(),
    async () => {
      const before = normalizeRouterAreas(await readJsonFile<unknown>(file, emptyFile(), { readErrors: 'throw' }))
      const proposed = await change(structuredClone(before))
      const after = normalizeRouterAreas(proposed)
      assertNoReassignment(before, after)
      // The stamp lands before the file: a failed save leaves a 14 store, which only refuses old builds.
      if (after.areas.length > 0) await ensureAreasDataVersion(home)
      return after
    },
    { durable: true },
  )
}

function areaOf(file: RouterAreasFile, areaId: string): RouterArea | undefined {
  return file.areas.find((area) => area.id === areaId)
}

export function sourceArea(file: RouterAreasFile, source: RouterSource): RouterArea | undefined {
  const item = file.items.find((entry) =>
    entry.source.kind === source.kind
    && entry.source.account === source.account
    && entry.source.message === source.message
    && (entry.source.version ?? '') === (source.version ?? ''))
  if (!item) return undefined
  const area = areaOf(file, item.areaId)
  if (!area) return undefined
  const allowed = area.sources.some((entry) => entry.kind === source.kind && entry.account === source.account)
  return allowed ? area : undefined
}

export function taskArea(file: RouterAreasFile, taskId: string): RouterArea | undefined {
  return file.areas.find((area) => area.taskIds.includes(taskId))
}

export function activeRouter(file: RouterAreasFile, areaId: string): RouterAssignment | undefined {
  const area = areaOf(file, areaId)
  if (!area) return undefined
  return file.routers.find((router) => router.areaId === areaId && !router.paused && area.taskIds.includes(router.taskId))
}

export function assertSameArea(file: RouterAreasFile, source: RouterSource, targetTaskId: string): RouterArea {
  const from = sourceArea(file, source)
  if (!from) throw new RouterAreaError('source_unassigned', 403, `This ${source.kind} item is not assigned to any area`)
  const to = taskArea(file, targetTaskId)
  if (!to) throw new RouterAreaError('task_unassigned', 403, `Task ${targetTaskId} does not belong to any area`)
  if (to.id !== from.id) {
    throw new RouterAreaError('cross_area', 403, `This item belongs to area ${from.id}, not to area ${to.id} of task ${targetTaskId}`)
  }
  return from
}
