import express, { Router, type Request, type RequestHandler } from 'express'
import type { IntegrationRegistry } from '../core/integration-registry.js'
import { JobRouteError } from '../core/plugin-jobs/serve.js'
import { ORIGIN_HEADER, withCallerOrigin } from '../lib/caller-origin.js'
import { requestOrigin } from './middleware/request-origin.js'
import {
  PluginRuntimeRelayError,
  type PluginHttpRelayRequest,
  type PluginHttpRelayResponse,
} from './routes/plugin-runtime-bridge.js'

export interface PluginRouteDispatcherOptions {
  /** A replica: a plugin with no route here is asked of the primary. */
  relay?(request: PluginHttpRelayRequest): Promise<PluginHttpRelayResponse>
  /**
   * The leader: a request no route of the plugin's server half answers goes to the plugin's
   * job that serves routes, when it has one (core/plugin-jobs/serve.ts). Never with `relay`:
   * on a replica the primary decides.
   */
  jobs?: {
    serves(pluginId: string): boolean
    forward(request: PluginHttpRelayRequest): Promise<PluginHttpRelayResponse>
  }
  /**
   * Whether a plugin with no routes right now is on its way up (the boot load, a reload): its name
   * when it is, so the answer can say who. Such a request is answered 503 `plugin_starting` with a
   * `Retry-After`, never the generic 404: a 404 told the Slack console "Not found: POST /reaction"
   * for the 10 s a server restart takes to load its plugins (2026-10-26), and the client could not
   * tell a plugin coming back from a route that does not exist.
   */
  starting?(pluginId: string): { name?: string } | undefined
}

/** Seconds a client should wait before asking a starting plugin again. */
export const PLUGIN_STARTING_RETRY_AFTER_S = 2

function pluginBodyParser(
  registry: IntegrationRegistry,
  cloudMode: boolean,
  pluginIdOf: (request: Request) => string | undefined,
  servesFromJob?: (pluginId: string) => boolean,
): RequestHandler {
  const raw = express.raw({ type: '*/*', limit: '15mb' })
  return (request, response, next) => {
    const pluginId = pluginIdOf(request)
    // A plugin whose job serves routes gets raw bytes too, also while its server half is not loaded.
    if (cloudMode || (pluginId !== undefined && (registry.get(pluginId)?.apiVersion === 1 || servesFromJob?.(pluginId)))) {
      raw(request, response, next)
      return
    }
    next()
  }
}

export function createPluginBodyParser(
  registry: IntegrationRegistry,
  cloudMode: boolean,
  servesFromJob?: (pluginId: string) => boolean,
): RequestHandler {
  return pluginBodyParser(registry, cloudMode, (request) => {
    const rawPluginId = request.params.pluginId
    return Array.isArray(rawPluginId) ? rawPluginId[0] : rawPluginId
  }, servesFromJob)
}

/**
 * The same body parsing for a mount whose plugin id is fixed rather than a path parameter.
 *
 * A legacy alias route (`/api/calendar` → `/api/plugins/calendar`) needs this: the parser
 * above is mounted at `/api/plugins/:pluginId`, so an alias that only rewrites the URL and
 * hands off to the dispatcher would deliver an EMPTY body on every POST/PATCH/PUT.
 */
export function createPluginBodyParserFor(
  registry: IntegrationRegistry,
  cloudMode: boolean,
  pluginId: string,
): RequestHandler {
  return pluginBodyParser(registry, cloudMode, () => pluginId)
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) => {
      if (value === undefined) return []
      return [[name, Array.isArray(value) ? value.join(', ') : String(value)]]
    }),
  )
}

/** An error that says its own HTTP answer: a relay's refusal, or a job route's (with its Retry-After). */
function httpErrorOf(error: unknown): { status: number; message: string; retryAfterS?: number } | null {
  if (error instanceof JobRouteError) return { status: error.status, message: error.message, ...(error.retryAfterS ? { retryAfterS: error.retryAfterS } : {}) }
  if (error instanceof PluginRuntimeRelayError) return { status: error.status, message: error.message }
  return null
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
    // The route runs for its requester (src/lib/caller-origin.ts): an op it calls
    // or a request it sends back to this server cannot act as this Mac for a
    // paired phone, an API key or a relayed request. The header the route reads
    // says the same, over any value the client sent (a LAN device's spoofed
    // `__local__` reached a plugin as local), as the bridge relay does.
    const origin = requestOrigin(req)
    req.headers[ORIGIN_HEADER] = origin
    const forward = async (send: (request: PluginHttpRelayRequest) => Promise<PluginHttpRelayResponse>) => {
      try {
        const response = await send({
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
        const http = httpErrorOf(error)
        if (!http) { next(error); return }
        if (http.retryAfterS) res.set('Retry-After', String(http.retryAfterS))
        res.status(http.status).json({ error: http.message })
      }
    }
    // The leader: what the server half does not answer, the plugin's serving job may.
    const jobsFor = () => (!options.relay && options.jobs?.serves(pluginId) ? options.jobs : undefined)
    if (router) {
      withCallerOrigin(origin, () => router(req, res, (error?: unknown) => {
        const jobs = error ? undefined : jobsFor()
        if (!jobs) { next(error); return }
        void forward((r) => jobs.forward(r))
      }))
      return
    }
    if (!options.relay) {
      // A server half on its way up comes first: one of its own routes may be what was asked.
      const starting = options.starting?.(pluginId)
      if (starting) {
        res.status(503).set('Retry-After', String(PLUGIN_STARTING_RETRY_AFTER_S)).json({
          error: 'plugin_starting',
          message: `${starting.name || pluginId} is starting. Try again in a moment.`,
        })
        return
      }
      const jobs = jobsFor()
      if (jobs) {
        await forward((r) => jobs.forward(r))
        return
      }
      next()
      return
    }
    const relay = options.relay
    await forward((r) => relay(r))
  }) as RequestHandler)

  return dispatcher
}
