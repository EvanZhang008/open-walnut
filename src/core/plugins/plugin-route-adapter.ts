import { Router, type Request } from 'express'
import type { HttpRoute } from '../integration-types.js'

export interface PluginRouteRequest {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
}

export interface PluginRouteReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
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
    try {
      const body = request.body
      const text = Buffer.isBuffer(body)
        ? body.toString('utf8')
        : typeof body === 'string'
          ? body
          : body === undefined
            ? ''
            : JSON.stringify(body)
      const reply = await handler({
        method: request.method,
        path: request.originalUrl,
        query: queryFrom(request),
        headers: headersFrom(request),
        async json<T>() {
          return (Buffer.isBuffer(body) || typeof body === 'string')
            ? JSON.parse(text) as T
            : body as T
        },
        async text() { return text },
      })
      response.status(reply.status ?? (reply.json === undefined && reply.text === undefined ? 204 : 200))
      for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value)
      if (reply.json !== undefined) response.json(reply.json)
      else if (reply.text !== undefined) response.send(reply.text)
      else response.end()
    } catch (error) {
      next(error)
    }
  })

  return { method, path: routePath, handler: router }
}
