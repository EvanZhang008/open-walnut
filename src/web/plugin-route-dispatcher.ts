import express, { Router, type Request, type RequestHandler } from 'express'
import type { IntegrationRegistry } from '../core/integration-registry.js'
import {
  PluginRuntimeRelayError,
  type PluginHttpRelayRequest,
  type PluginHttpRelayResponse,
} from './routes/plugin-runtime-bridge.js'

export interface PluginRouteDispatcherOptions {
  relay?(request: PluginHttpRelayRequest): Promise<PluginHttpRelayResponse>
}

export function createPluginBodyParser(
  registry: IntegrationRegistry,
  cloudMode: boolean,
): RequestHandler {
  const raw = express.raw({ type: '*/*', limit: '15mb' })
  return (request, response, next) => {
    const rawPluginId = request.params.pluginId
    const pluginId = Array.isArray(rawPluginId) ? rawPluginId[0] : rawPluginId
    if (cloudMode || registry.get(pluginId)?.apiVersion === 1) {
      raw(request, response, next)
      return
    }
    next()
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) => {
      if (value === undefined) return []
      return [[name, Array.isArray(value) ? value.join(', ') : String(value)]]
    }),
  )
}

function requestBody(request: Request): Buffer {
  if (Buffer.isBuffer(request.body)) return request.body
  if (typeof request.body === 'string') return Buffer.from(request.body)
  if (request.body === undefined) return Buffer.alloc(0)
  return Buffer.from(JSON.stringify(request.body))
}

export function createPluginRouteDispatcher(
  registry: IntegrationRegistry,
  options: PluginRouteDispatcherOptions = {},
): Router {
  const dispatcher = Router()

  const routerFor = (pluginId: string): Router | undefined => {
    const routes = registry.get(pluginId)?.httpRoutes ?? []
    if (routes.length === 0) return undefined
    const router = Router()
    for (const route of routes) router.use(route.path, route.handler)
    return router
  }

  dispatcher.use('/:pluginId', (async (req, res, next) => {
    const rawPluginId = req.params.pluginId
    const pluginId = Array.isArray(rawPluginId) ? rawPluginId[0] : rawPluginId
    const router = routerFor(pluginId)
    if (router) {
      router(req, res, next)
      return
    }
    if (!options.relay) {
      next()
      return
    }
    try {
      const response = await options.relay({
        pluginId,
        method: req.method,
        path: req.url.startsWith('/') ? req.url : `/${req.url}`,
        headers: requestHeaders(req),
        body: requestBody(req),
      })
      res.status(response.status)
      for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value)
      res.send(response.body)
    } catch (error) {
      if (error instanceof PluginRuntimeRelayError) {
        res.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  }) as RequestHandler)

  return dispatcher
}
