import { registry } from '../integration-registry.js'
import { getPluginLifecycleRecords } from '../integration-loader.js'
import { validatePluginId } from './ids.js'
import { callPluginOp, getPluginApiBase, listPluginOps } from './server-api.js'

const OP_NAME_PATTERN = /^[a-z0-9_]{1,128}$/
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
const MAX_PLUGIN_OP_ARGS_BYTES = 256 * 1024
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024
const MAX_HTTP_HEADERS_BYTES = 64 * 1024
const HTTP_TIMEOUT_MS = 12_000
const MANAGEMENT_TIMEOUT_MS = 25_000

class PluginControlFailure extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export type PluginControlRelayOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; error: string }

function pluginIdFrom(value: unknown): string {
  try {
    return validatePluginId(typeof value === 'string' ? value : '')
  } catch (error) {
    throw new PluginControlFailure(error instanceof Error ? error.message : String(error), 400)
  }
}

function requireActivePlugin(pluginId: string): void {
  const active = getPluginLifecycleRecords(registry)
    .some((plugin) => plugin.id === pluginId && plugin.state === 'active')
  if (!active || !registry.get(pluginId)) {
    throw new PluginControlFailure(`Active Plugin "${pluginId}" was not found`, 404)
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    throw new PluginControlFailure('Value is not serializable', 400)
  }
}

function filterHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginControlFailure('Plugin HTTP headers must be an object', 400)
  }
  const output: Record<string, string> = {}
  let bytes = 0
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || typeof rawValue !== 'string' || /\r|\n/.test(rawValue)) {
      throw new PluginControlFailure('Invalid Plugin HTTP header', 400)
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue)
    if (bytes > MAX_HTTP_HEADERS_BYTES) {
      throw new PluginControlFailure('Plugin HTTP headers are too large', 431)
    }
    output[name] = rawValue
  }
  return output
}

function decodeBase64(value: unknown, expectedSize: unknown): Buffer {
  if (
    typeof value !== 'string'
    || typeof expectedSize !== 'number'
    || !Number.isSafeInteger(expectedSize)
    || expectedSize < 0
  ) throw new PluginControlFailure('Invalid Plugin HTTP body', 400)
  if (expectedSize > MAX_HTTP_BODY_BYTES) {
    throw new PluginControlFailure('Plugin HTTP body is too large', 413)
  }
  if (value.length > Math.ceil(MAX_HTTP_BODY_BYTES / 3) * 4 + 4) {
    throw new PluginControlFailure('Plugin HTTP body is too large', 413)
  }
  const content = Buffer.from(value, 'base64')
  const normalized = value.replace(/=+$/, '')
  if (
    content.byteLength !== expectedSize
    || content.byteLength > MAX_HTTP_BODY_BYTES
    || content.toString('base64').replace(/=+$/, '') !== normalized
  ) throw new PluginControlFailure('Invalid Plugin HTTP body encoding', 400)
  return content
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

function relayPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.length > 4_096
    || value.includes('\0')
    || value.includes('#')
    || value.includes('\\')
    || hasDotPathSegment(value)
  ) throw new PluginControlFailure('Invalid Plugin HTTP path', 400)
  return value
}

function loopbackUrl(pathname: string): URL {
  const apiBase = getPluginApiBase()
  if (!apiBase) throw new PluginControlFailure('Plugin runtime is not ready', 503)
  const base = new URL(apiBase)
  const target = new URL(pathname, base)
  if (target.origin !== base.origin) throw new PluginControlFailure('Invalid Plugin runtime target', 400)
  return target
}

function pluginLoopbackUrl(pluginId: string, pathname: string): URL {
  const prefix = `/api/plugins/${encodeURIComponent(pluginId)}`
  const target = loopbackUrl(`${prefix}${pathname}`)
  if (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) {
    throw new PluginControlFailure('Invalid Plugin runtime target', 400)
  }
  return target
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new PluginControlFailure('Plugin HTTP response is too large for cloud relay', 413)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchLoopback(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  responseLimit: number,
): Promise<{ response: Response; body: Buffer }> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { response, body: await readLimited(response, responseLimit) }
  } catch (error) {
    if (error instanceof PluginControlFailure) throw error
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new PluginControlFailure('Plugin request timed out', 504)
    }
    throw new PluginControlFailure(error instanceof Error ? error.message : String(error), 502)
  }
}

async function managePlugin(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pluginId = pluginIdFrom(params.pluginId)
  const operation = params.operation
  if (operation !== 'reload' && operation !== 'disable' && operation !== 'clear-quarantine') {
    throw new PluginControlFailure('Invalid Plugin management operation', 400)
  }
  const target = loopbackUrl(`/api/plugin-runtime/${encodeURIComponent(pluginId)}/${operation}`)
  const { response, body } = await fetchLoopback(target, { method: 'POST' }, MANAGEMENT_TIMEOUT_MS, 512 * 1024)
  let parsed: unknown
  try {
    parsed = body.byteLength === 0 ? {} : JSON.parse(body.toString('utf8'))
  } catch {
    throw new PluginControlFailure('Plugin runtime returned an invalid response', 502)
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).error === 'string'
      ? (parsed as Record<string, unknown>).error as string
      : `Plugin management failed with HTTP ${response.status}`
    throw new PluginControlFailure(message, response.status)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginControlFailure('Plugin runtime returned an invalid response', 502)
  }
  return parsed as Record<string, unknown>
}

async function relayPluginHttp(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pluginId = pluginIdFrom(params.pluginId)
  requireActivePlugin(pluginId)
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : ''
  if (!HTTP_METHODS.has(method)) throw new PluginControlFailure('Unsupported Plugin HTTP method', 405)
  const pathname = relayPath(params.path)
  const headers = filterHeaders(params.headers)
  const body = decodeBase64(params.data, params.size)
  if ((method === 'GET' || method === 'HEAD') && body.byteLength > 0) {
    throw new PluginControlFailure(`${method} Plugin requests cannot have a body`, 400)
  }
  const target = pluginLoopbackUrl(pluginId, pathname)
  const { response, body: responseBody } = await fetchLoopback(
    target,
    {
      method,
      headers,
      ...(body.byteLength > 0 ? { body: body as unknown as BodyInit } : {}),
    },
    HTTP_TIMEOUT_MS,
    MAX_HTTP_BODY_BYTES,
  )
  return {
    status: response.status,
    headers: filterHeaders(Object.fromEntries(response.headers.entries())),
    size: responseBody.byteLength,
    data: responseBody.toString('base64'),
  }
}

export async function handlePluginControlRelay(
  action: string,
  paramsInput: unknown,
): Promise<PluginControlRelayOutcome> {
  const params = plainObject(paramsInput)
  try {
    switch (action) {
      case 'server.plugin-ops': {
        const pluginId = pluginIdFrom(params.pluginId)
        requireActivePlugin(pluginId)
        return { ok: true, result: { ops: await listPluginOps() } }
      }
      case 'server.plugin-op': {
        const pluginId = pluginIdFrom(params.pluginId)
        requireActivePlugin(pluginId)
        const opName = typeof params.opName === 'string' ? params.opName : ''
        if (!OP_NAME_PATTERN.test(opName)) throw new PluginControlFailure('Invalid operation name', 400)
        const args = plainObject(params.args)
        if (serializedSize(args) > MAX_PLUGIN_OP_ARGS_BYTES) {
          throw new PluginControlFailure('Plugin operation arguments are too large', 413)
        }
        return {
          ok: true,
          result: await callPluginOp(pluginId, opName, args) as unknown as Record<string, unknown>,
        }
      }
      case 'server.plugin-manage':
        return { ok: true, result: await managePlugin(params) }
      case 'server.plugin-http':
        return { ok: true, result: await relayPluginHttp(params) }
      default:
        return { ok: false, status: 400, error: `Unknown Plugin control action: ${action}` }
    }
  } catch (error) {
    return {
      ok: false,
      status: error instanceof PluginControlFailure ? error.status : 500,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
