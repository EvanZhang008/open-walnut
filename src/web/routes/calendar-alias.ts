/**
 * `/api/calendar/*` → `/api/plugins/calendar/*`.
 *
 * The calendar is a plugin, and its real path is the plugin one. This alias exists purely
 * so the shipped web clients keep working through the move.
 *
 * DELETE THIS (and its mount in server.ts) once every caller uses `/api/plugins/calendar/*`.
 * Today that is 8 files under web/src plus the calendar skill's curl examples; iOS reads the
 * device's own EventKit and never calls this.
 *
 * It hands off to the dispatcher instance the server already mounts at `/api/plugins`, so
 * cloud relay behaviour is inherited rather than re-implemented, and it applies the plugin
 * body parser for the fixed id: without that, a POST/PATCH would arrive with an empty body
 * on any content type the app-level JSON parser does not claim.
 */
import { Router } from 'express'
import type { IntegrationRegistry } from '../../core/integration-registry.js'
import { createPluginBodyParserFor } from '../plugin-route-dispatcher.js'

const PLUGIN_ID = 'calendar'

export function createCalendarAliasRouter(
  registry: IntegrationRegistry,
  cloudMode: boolean,
  dispatcher: Router,
): Router {
  const router = Router()
  router.use(createPluginBodyParserFor(registry, cloudMode, PLUGIN_ID))
  router.use((request, _response, next) => {
    // `originalUrl` is untouched, which is what the plugin's route handlers parse the event
    // id out of, so both spellings of the path resolve the same id.
    const suffix = request.url.startsWith('/') ? request.url : `/${request.url}`
    request.url = `/${PLUGIN_ID}${suffix}`
    next()
  })
  router.use(dispatcher)
  return router
}
