import { Router, type Request } from 'express'
import { once } from 'node:events'
import type { HttpRoute } from '../integration-types.js'

export interface PluginRouteRequest {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  /** Aborted when the browser closes the response or the route deadline expires. */
  signal: AbortSignal
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
}

export interface PluginRouteReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
  /** Binary bytes or lazy chunks; the host writes only while the browser accepts them. */
  body?: Uint8Array | AsyncIterable<Uint8Array>
  /** Maximum route lifetime, including lazy chunks. Default 60 seconds, at most ten minutes. */
  timeoutMs?: number
}

export type PluginRouteHandler = (request: PluginRouteRequest) => PluginRouteReply | Promise<PluginRouteReply>

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

function validateRoutePath(routePath: string): string {
  if (!routePath.startsWith('/') || routePath.startsWith('//') || routePath.includes('\0')) {
    throw new Error(`Plugin route path must be an absolute in-plugin path: ${JSON.stringify(routePath)}`)
  }
  const normalized = routePath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Plugin route path must not contain "..": ${JSON.stringify(routePath)}`)
  }
  return normalized
}

function queryFrom(request: Request): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(request.query)) {
    if (typeof value === 'string') output[key] = value
    else if (Array.isArray(value)) output[key] = value.map(String)
    else if (value !== undefined) output[key] = String(value)
  }
  return output
}

function headersFrom(request: Request): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) output[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return output
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {})
    return Promise.reject(new Error('Plugin request closed'))
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Plugin request closed'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

export function createPluginHttpRoute(
  methodInput: string,
  routePathInput: string,
  handler: PluginRouteHandler,
): HttpRoute {
  const method = methodInput.toLowerCase() as HttpRoute['method']
  if (!METHODS.has(method)) throw new Error(`Unsupported Plugin route method: ${methodInput}`)
  const routePath = validateRoutePath(routePathInput)
  const router = Router()

  router[method]('/', async (request, response, next) => {
    const controller = new AbortController()
    const aborted = () => controller.abort()
    request.once('aborted', aborted)
    response.once('close', aborted)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      timer = setTimeout(() => {
        controller.abort()
        if (response.headersSent) response.destroy()
        else response.status(504).end()
      }, 60_000)
      timer.unref?.()
      const body = request.body
      const text = Buffer.isBuffer(body)
        ? body.toString('utf8')
        : typeof body === 'string'
          ? body
          : body === undefined
            ? ''
            : JSON.stringify(body)
      const reply = await untilAborted(Promise.resolve(handler({
        method: request.method,
        path: request.originalUrl,
        query: queryFrom(request),
        headers: headersFrom(request),
        signal: controller.signal,
        async json<T>() {
          return (Buffer.isBuffer(body) || typeof body === 'string')
            ? JSON.parse(text) as T
            : body as T
        },
        async text() { return text },
      })), controller.signal)
      if (controller.signal.aborted) return
      clearTimeout(timer)
      const timeoutMs = reply.timeoutMs ?? 60_000
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid plugin route deadline')
      timer = setTimeout(() => { controller.abort(); response.destroy() }, timeoutMs)
      timer.unref?.()
      response.status(reply.status ?? (reply.json === undefined && reply.text === undefined && reply.body === undefined ? 204 : 200))
      for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value)
      if (reply.json !== undefined) response.json(reply.json)
      else if (reply.text !== undefined) response.send(reply.text)
      else if (reply.body instanceof Uint8Array) response.end(request.method === 'HEAD' ? undefined : reply.body)
      else if (reply.body !== undefined) {
        const iterator = reply.body[Symbol.asyncIterator]()
        try {
          if (request.method === 'HEAD') { response.end(); return }
          while (!controller.signal.aborted) {
            const next = await untilAborted(iterator.next(), controller.signal)
            if (next.done) break
            if (!(next.value instanceof Uint8Array)) throw new Error('Plugin response chunks must be bytes')
            if (!response.write(next.value)) await once(response, 'drain', { signal: controller.signal })
          }
          if (!controller.signal.aborted) response.end()
        } finally {
          // A plugin that awaits a remote read must still see cancellation even if next never settles.
          if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {})
        }
      } else response.end()
    } catch (error) {
      if (!controller.signal.aborted) {
        if (response.headersSent) response.destroy(error instanceof Error ? error : undefined)
        else next(error)
      }
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
      request.off('aborted', aborted)
      response.off('close', aborted)
    }
  })

  return { method, path: routePath, handler: router }
}
