import crypto from 'node:crypto'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import type { PluginTombstone } from '../../core/integration-registry.js'
import { validatePluginId } from '../../core/plugins/ids.js'
import type { PluginLifecycleRecord } from '../../core/plugins/plugin-manager.js'
import {
  MAX_PLUGIN_WEB_MODULE_BYTES,
  type PluginWebModule,
  type PluginWebModuleInfo,
} from '../../core/plugins/plugin-web-module.js'
import { callPrimaryControl, type RelayFailure } from './v1-control-relay.js'

const SERVER_RELAY_SID = '__server__'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const OP_NAME_PATTERN = /^[a-z0-9_]{1,128}$/
const PLUGIN_LIFECYCLE_STATES = new Set([
  'discovered',
  'disabled',
  'needs-config',
  'unsupported',
  'activating',
  'active',
  'failed',
  'disposing',
  'quarantined',
])
const TOMBSTONE_REASONS = new Set(['disabled', 'unloaded', 'failed', 'stale-code'])
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const HOP_BY_HOP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024
const MAX_RELAY_HEADERS_BYTES = 64 * 1024
const MAX_PLUGIN_OP_ARGS_BYTES = 256 * 1024
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1_000
const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000

export class PluginRuntimeRelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PluginRuntimeRelayError'
  }
}

export interface PrimaryPluginRuntimeCatalogue {
  plugins: PluginLifecycleRecord[]
  tombstones: PluginTombstone[]
  modules: PluginWebModuleInfo[]
  errors: Array<{ id: string; error: string }>
}

export interface PluginOpInfo {
  name: string
  title: string
  readonly: boolean
}

export type PluginManagementAction = 'reload' | 'disable' | 'clear-quarantine'

export interface PluginHttpRelayRequest {
  pluginId: string
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}

export interface PluginHttpRelayResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function relayError(failure: RelayFailure): PluginRuntimeRelayError {
  if (failure.kind === 'needs_upgrade') return new PluginRuntimeRelayError(failure.message, 501)
  if (failure.kind === 'bridge_offline') return new PluginRuntimeRelayError(failure.message, 503)
  return new PluginRuntimeRelayError(failure.message, failure.status)
}

function parseModuleInfo(value: unknown): PluginWebModuleInfo | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string'
    || typeof item.name !== 'string'
    || typeof item.hash !== 'string'
    || !HASH_PATTERN.test(item.hash)
    || typeof item.size !== 'number'
    || !Number.isSafeInteger(item.size)
    || item.size < 0
    || item.size > MAX_PLUGIN_WEB_MODULE_BYTES
  ) return null
  let id: string
  try {
    id = validatePluginId(item.id)
  } catch {
    return null
  }
  return {
    id,
    name: item.name,
    ...(typeof item.version === 'string' ? { version: item.version } : {}),
    hash: item.hash,
    size: item.size,
  }
}

function parseLifecycleRecord(value: unknown): PluginLifecycleRecord | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string'
    || typeof item.name !== 'string'
    || typeof item.state !== 'string'
    || !PLUGIN_LIFECYCLE_STATES.has(item.state)
    || typeof item.builtin !== 'boolean'
    || typeof item.failureCount !== 'number'
    || !Number.isSafeInteger(item.failureCount)
    || item.failureCount < 0
  ) return null
  let id: string
  try {
    id = validatePluginId(item.id)
  } catch {
    return null
  }
  const missingConfig = Array.isArray(item.missingConfig)
    && item.missingConfig.every((entry) => typeof entry === 'string')
    ? item.missingConfig as string[]
    : undefined
  return {
    id,
    name: item.name,
    state: item.state as PluginLifecycleRecord['state'],
    builtin: item.builtin,
    failureCount: item.failureCount,
    ...(missingConfig ? { missingConfig } : {}),
    ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
    ...(typeof item.error === 'string' ? { error: item.error } : {}),
  }
}

function parseTombstone(value: unknown): PluginTombstone | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string'
    || typeof item.name !== 'string'
    || typeof item.reason !== 'string'
    || !TOMBSTONE_REASONS.has(item.reason)
    || typeof item.at !== 'string'
  ) return null
  let id: string
  try {
    id = validatePluginId(item.id)
  } catch {
    return null
  }
  const capabilities = Array.isArray(item.capabilities)
    && item.capabilities.every((entry) => typeof entry === 'string')
    ? item.capabilities as string[]
    : undefined
  return {
    id,
    name: item.name,
    ...(typeof item.version === 'string' ? { version: item.version } : {}),
    ...(capabilities ? { capabilities } : {}),
    reason: item.reason as PluginTombstone['reason'],
    at: item.at,
  }
}

function cacheFile(pluginId: string, hash: string): string {
  return path.join(WALNUT_HOME, 'cache', 'plugin-web-modules', `${pluginId}-${hash}.mjs`)
}

function contentHash(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function readCached(pluginId: string, hash: string): Promise<Buffer | null> {
  try {
    const content = await fs.readFile(cacheFile(pluginId, hash))
    if (content.byteLength > MAX_PLUGIN_WEB_MODULE_BYTES || contentHash(content) !== hash) return null
    return content
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeCached(pluginId: string, hash: string, content: Buffer): Promise<void> {
  const file = cacheFile(pluginId, hash)
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temporary, content)
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function prunePluginWebModuleCache(
  modules: PluginWebModuleInfo[],
  now = Date.now(),
): Promise<void> {
  const directory = path.join(WALNUT_HOME, 'cache', 'plugin-web-modules')
  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const keep = new Set(modules.map((module) => path.basename(cacheFile(module.id, module.hash))))
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || keep.has(entry.name)) return
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.tmp')) return
    const file = path.join(directory, entry.name)
    try {
      const stat = await fs.stat(file)
      if (now - stat.mtimeMs >= CACHE_STALE_MS) await fs.rm(file, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }))
}

let lastCachePruneAt = 0
let cachePrune: Promise<void> | null = null

function maybePrunePluginWebModuleCache(modules: PluginWebModuleInfo[]): void {
  const now = Date.now()
  if (cachePrune || now - lastCachePruneAt < CACHE_PRUNE_INTERVAL_MS) return
  lastCachePruneAt = now
  cachePrune = prunePluginWebModuleCache(modules, now)
    .catch(() => undefined)
    .finally(() => { cachePrune = null })
}

export async function listPrimaryPluginWebModules(): Promise<PrimaryPluginRuntimeCatalogue> {
  const outcome = await callPrimaryControl(
    'server.plugin-runtime',
    SERVER_RELAY_SID,
    undefined,
    15_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  const parsedModules = Array.isArray(outcome.result.modules)
    ? outcome.result.modules.map(parseModuleInfo).filter((item): item is PluginWebModuleInfo => !!item)
    : []
  const modules = [...new Map(parsedModules.map((module) => [module.id, module])).values()]
  const errors = Array.isArray(outcome.result.errors)
    ? outcome.result.errors.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const item = value as Record<string, unknown>
        return typeof item.id === 'string' && typeof item.error === 'string'
          ? [{ id: item.id, error: item.error }]
          : []
      })
    : []
  const plugins = Array.isArray(outcome.result.plugins)
    ? outcome.result.plugins.map(parseLifecycleRecord).filter((item): item is PluginLifecycleRecord => !!item)
    : []
  const tombstones = Array.isArray(outcome.result.tombstones)
    ? outcome.result.tombstones.map(parseTombstone).filter((item): item is PluginTombstone => !!item)
    : []
  maybePrunePluginWebModuleCache(modules)
  return { plugins, tombstones, modules, errors }
}

export async function readPrimaryPluginWebModule(
  pluginId: string,
  expectedHash?: string,
): Promise<PluginWebModule> {
  try {
    pluginId = validatePluginId(pluginId)
  } catch (error) {
    throw new PluginRuntimeRelayError(
      error instanceof Error ? error.message : String(error),
      400,
    )
  }
  if (expectedHash && !HASH_PATTERN.test(expectedHash)) {
    throw new PluginRuntimeRelayError('Invalid Plugin module hash', 400)
  }
  if (expectedHash) {
    const cached = await readCached(pluginId, expectedHash)
    if (cached) {
      return {
        id: pluginId,
        name: pluginId,
        hash: expectedHash,
        size: cached.byteLength,
        content: cached,
      }
    }
  }

  const outcome = await callPrimaryControl(
    'server.plugin-web-module',
    SERVER_RELAY_SID,
    { pluginId, ...(expectedHash ? { expectedHash } : {}) },
    15_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  const result = outcome.result
  if (
    typeof result.id !== 'string'
    || result.id !== pluginId
    || typeof result.name !== 'string'
    || typeof result.hash !== 'string'
    || !HASH_PATTERN.test(result.hash)
    || typeof result.size !== 'number'
    || !Number.isSafeInteger(result.size)
    || result.size < 0
    || typeof result.data !== 'string'
  ) {
    throw new PluginRuntimeRelayError('Primary returned an invalid Plugin module', 502)
  }
  if (result.size > MAX_PLUGIN_WEB_MODULE_BYTES) {
    throw new PluginRuntimeRelayError('Primary Plugin module is too large', 413)
  }
  if (expectedHash && result.hash !== expectedHash) {
    throw new PluginRuntimeRelayError(
      'Plugin module changed; refresh the Plugin catalogue',
      409,
    )
  }
  const content = Buffer.from(result.data, 'base64')
  if (content.byteLength > MAX_PLUGIN_WEB_MODULE_BYTES) {
    throw new PluginRuntimeRelayError('Primary Plugin module is too large', 413)
  }
  if (content.byteLength !== result.size) {
    throw new PluginRuntimeRelayError('Primary Plugin module size mismatch', 502)
  }
  if (contentHash(content) !== result.hash) {
    throw new PluginRuntimeRelayError('Primary Plugin module hash mismatch', 502)
  }
  await writeCached(pluginId, result.hash, content)
  return {
    id: pluginId,
    name: result.name,
    ...(typeof result.version === 'string' ? { version: result.version } : {}),
    hash: result.hash,
    size: content.byteLength,
    content,
  }
}

function validPluginId(pluginId: string): string {
  try {
    return validatePluginId(pluginId)
  } catch (error) {
    throw new PluginRuntimeRelayError(error instanceof Error ? error.message : String(error), 400)
  }
}

export async function listPrimaryPluginOps(pluginIdInput: string): Promise<PluginOpInfo[]> {
  const pluginId = validPluginId(pluginIdInput)
  const outcome = await callPrimaryControl(
    'server.plugin-ops',
    SERVER_RELAY_SID,
    { pluginId },
    15_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  if (!Array.isArray(outcome.result.ops)) {
    throw new PluginRuntimeRelayError('Primary returned an invalid Plugin operation catalogue', 502)
  }
  const ops = outcome.result.ops.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    if (
      typeof item.name !== 'string'
      || !OP_NAME_PATTERN.test(item.name)
      || typeof item.title !== 'string'
      || typeof item.readonly !== 'boolean'
    ) return []
    return [{ name: item.name, title: item.title, readonly: item.readonly }]
  })
  return [...new Map(ops.map((op) => [op.name, op])).values()]
}

export async function callPrimaryPluginOp(
  pluginIdInput: string,
  opName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pluginId = validPluginId(pluginIdInput)
  if (!OP_NAME_PATTERN.test(opName)) throw new PluginRuntimeRelayError('Invalid operation name', 400)
  let serialized: string
  try {
    serialized = JSON.stringify(args)
  } catch {
    throw new PluginRuntimeRelayError('Plugin operation arguments are not serializable', 400)
  }
  if (Buffer.byteLength(serialized) > MAX_PLUGIN_OP_ARGS_BYTES) {
    throw new PluginRuntimeRelayError('Plugin operation arguments are too large', 413)
  }
  const outcome = await callPrimaryControl(
    'server.plugin-op',
    SERVER_RELAY_SID,
    { pluginId, opName, args },
    15_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  return outcome.result
}

export async function managePrimaryPlugin(
  pluginIdInput: string,
  operation: PluginManagementAction,
): Promise<{ plugin?: PluginLifecycleRecord; ok?: true }> {
  const pluginId = validPluginId(pluginIdInput)
  const outcome = await callPrimaryControl(
    'server.plugin-manage',
    SERVER_RELAY_SID,
    { pluginId, operation },
    30_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  if (operation === 'clear-quarantine') {
    if (outcome.result.ok !== true) throw new PluginRuntimeRelayError('Primary returned an invalid Plugin management result', 502)
    return { ok: true }
  }
  const plugin = parseLifecycleRecord(outcome.result.plugin)
  if (!plugin) throw new PluginRuntimeRelayError('Primary returned an invalid Plugin lifecycle record', 502)
  return { plugin }
}

function filterHeaders(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {}
  let bytes = 0
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(name) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) continue
    const value = String(rawValue)
    if (/\r|\n/.test(value)) continue
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > MAX_RELAY_HEADERS_BYTES) throw new PluginRuntimeRelayError('Plugin HTTP headers are too large', 431)
    output[name] = value
  }
  return output
}

function hasDotPathSegment(value: string): boolean {
  let pathname = value.split('?', 1)[0]
  for (let depth = 0; depth < 4; depth++) {
    const normalized = pathname.replace(/\\/g, '/')
    if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return true
    let decoded: string
    try { decoded = decodeURIComponent(pathname) }
    catch { return true }
    if (decoded === pathname) return false
    pathname = decoded
  }
  return true
}

function validateRelayPath(value: string): string {
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.length > 4_096
    || value.includes('\0')
    || value.includes('#')
    || value.includes('\\')
    || hasDotPathSegment(value)
  ) throw new PluginRuntimeRelayError('Invalid Plugin HTTP path', 400)
  return value
}

export async function relayPrimaryPluginHttpRequest(
  request: PluginHttpRelayRequest,
): Promise<PluginHttpRelayResponse> {
  const pluginId = validPluginId(request.pluginId)
  const method = request.method.toUpperCase()
  if (!HTTP_METHODS.has(method)) throw new PluginRuntimeRelayError('Unsupported Plugin HTTP method', 405)
  const requestPath = validateRelayPath(request.path)
  if (request.body.byteLength > MAX_RELAY_BODY_BYTES) {
    throw new PluginRuntimeRelayError('Plugin HTTP request body is too large for cloud relay', 413)
  }
  const headers = filterHeaders(request.headers)
  const outcome = await callPrimaryControl(
    'server.plugin-http',
    SERVER_RELAY_SID,
    {
      pluginId,
      method,
      path: requestPath,
      headers,
      size: request.body.byteLength,
      data: request.body.toString('base64'),
    },
    15_000,
  )
  if (!outcome.ok) throw relayError(outcome.failure)
  const result = outcome.result
  if (
    typeof result.status !== 'number'
    || !Number.isSafeInteger(result.status)
    || result.status < 100
    || result.status > 599
    || typeof result.size !== 'number'
    || !Number.isSafeInteger(result.size)
    || result.size < 0
    || result.size > MAX_RELAY_BODY_BYTES
    || typeof result.data !== 'string'
    || !result.headers
    || typeof result.headers !== 'object'
    || Array.isArray(result.headers)
  ) throw new PluginRuntimeRelayError('Primary returned an invalid Plugin HTTP response', 502)
  const body = Buffer.from(result.data, 'base64')
  if (body.byteLength !== result.size) {
    throw new PluginRuntimeRelayError('Primary Plugin HTTP response size mismatch', 502)
  }
  const responseHeaders = filterHeaders(
    Object.fromEntries(
      Object.entries(result.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  )
  return { status: result.status, headers: responseHeaders, body }
}
