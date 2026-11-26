/**
 * The routes whose answer carries outside text, for the generic `api` op (core.ts).
 *
 * The named ops frame outside text themselves (human_inbox_get, the mail ops, router_context...), but
 * the `api` op reaches any route as it is, so an agent that read a letter, a calendar event or a
 * plugin's notification through it read a stranger's words with no frame (2026-11-26, issue #23).
 * The `api` op's answer for a path under a prefix below is framed as data (frameOutsideData), with the
 * route named, whatever the method: a write answers outside text too (an inbox write answers the
 * letter, a plugin op route answers the op's data), and a framed write receipt is harmless. Only that
 * answer: an op that calls these routes internally (day_review reads calendar events with `call()`)
 * still gets the plain JSON it parses.
 *
 * tests/unit/ops/outside-api-routes.test.ts reads every route (any method) a route file serves from a
 * module that holds outside text (the inbox, the router, notifications, plugin routes) and fails on one
 * this table does not cover and the test's own plain list does not name with a reason.
 */
import { frameOutsideData, isWalnutFramed } from '../core/outside-content.js'

export { agentReadsFramed } from './outside-answer.js'

export interface OutsideApiRoute {
  /**
   * A path prefix, lower case, as the server mounts it (src/web/server.ts, routes/api-v1.ts): the path
   * itself and every path below it. A `:name` segment matches any one segment (a host, a server).
   */
  prefix: string
  /** The `source` the frame names. */
  source: string
  why: string
}

export const OUTSIDE_API_ROUTES: readonly OutsideApiRoute[] = [
  { prefix: '/api/plugins/', source: 'plugin route', why: 'every plugin\'s routes answer what it read from outside: calendar events, synced tickets, mail' },
  { prefix: '/api/calendar', source: 'calendar', why: 'the calendar plugin\'s older alias (routes/calendar-alias.ts): event titles, places, organizers' },
  { prefix: '/api/plugin-runtime', source: 'plugin runtime', why: 'a plugin op run through its route (POST /:id/ops/:op) answers the op\'s data; the rest is plugin-written (its ops, its App state, its catalog)' },
  { prefix: '/api/plugin-status-items', source: 'plugin status item', why: 'a plugin writes each status item\'s words' },
  { prefix: '/api/v1/human-inbox', source: 'letters', why: 'letters a plugin or the mail router wrote, and mail items in any letter; a write (read, pin, archive, settle) answers the letter whole' },
  { prefix: '/api/human-inbox', source: 'letters', why: 'the inbox\'s unversioned path, parsed by the same body limits as /api/v1/human-inbox' },
  { prefix: '/api/v1/router/', source: 'mail router', why: 'router context and routes carry mail senders, subjects, bodies and thread history' },
  { prefix: '/api/mention-sources', source: 'mention source', why: 'a source\'s search answers mail subjects and senders' },
  { prefix: '/api/notifications', source: 'notifications', why: 'a plugin\'s notification carries its words (a mail subject, an event title)' },
  { prefix: '/api/v1/notifications', source: 'notifications', why: 'the same feed through api v1' },
  { prefix: '/api/v1/trigger-templates', source: 'trigger template', why: 'a template\'s check (POST /:id/check) answers the newest items it watches: mail senders, subjects and previews' },
  { prefix: '/api/v1/me/app-state', source: 'app state', why: 'a plugin App\'s state: what it shows, which can come from outside Walnut (the app_state op frames it the same way)' },
  { prefix: '/api/v1/org/report', source: 'walnut report quoting letters', why: 'POST /org/report (the morning report) quotes the subjects of letters awaiting the user, a plugin\'s among them' },
  // The routes of the ops the op ledger calls outside (tests/core/outside-op-ledger.test.ts holds each op's route here).
  { prefix: '/api/time/timeline', source: 'time timeline', why: 'every source on one timeline: calendar meeting titles and the labels plugins give their items (time_timeline frames it)' },
  { prefix: '/api/time/report', source: 'time report', why: 'a range of days whose item groups carry plugin item labels (time_report frames them)' },
  { prefix: '/api/v1/routines/check-test', source: 'trigger check output', why: 'what a check script printed, which can quote mail, pages or tickets it watched (trigger_test frames it)' },
  { prefix: '/api/routines/check-test', source: 'trigger check output', why: 'the same run through the routines router (routes/cron.ts)' },
  { prefix: '/api/cron/check-test', source: 'trigger check output', why: 'the routines router\'s older /api/cron alias' },
  { prefix: '/api/mcp/servers/:server/read', source: 'mcp tool', why: 'an MCP tool\'s answer: whatever its server read from outside (mcp_read frames it)' },
  { prefix: '/api/mcp/servers/:server/call', source: 'mcp tool', why: 'an MCP tool\'s answer (mcp_call frames it)' },
  { prefix: '/api/v1/hosts/:host/http', source: 'fetched page', why: 'the body and headers of a URL a host fetched (host_http frames them)' },
  { prefix: '/api/v1/hosts/:host/mcp/:server/call', source: 'mcp tool', why: 'an MCP tool\'s answer on a host (host_mcp_call frames it)' },
  { prefix: '/api/v1/hosts/:host/mcp-calls', source: 'mcp tool', why: 'a host MCP call\'s answer read later (host_mcp_result frames it)' },
  { prefix: '/api/topics', source: 'topic messages', why: 'a topic\'s messages, a person member\'s among them, came by mail (topic_read and topic_list frame them)' },
]

/**
 * Routes under OUTSIDE_API_ROUTES whose answer to an agent caller is framed by the route itself, so the
 * `api` op does not frame it twice. Skipped by the route, never by what the answer looks like: an
 * answer crossed HTTP, so it is not the object this process framed, and a look-alike envelope is
 * anyone's to write (2026-11-26 review). Only for a self-call made as an agent: the route frames by
 * the caller's headers, and a person's call reads its plain shape.
 */
export const SELF_FRAMING_API_ROUTES: readonly { prefix: string; why: string }[] = [
  {
    prefix: '/api/plugins/mail/',
    why: 'every mail route answers an agent caller framed (integrations/mail/agent-caller.ts agentAwareRoutes); tests/integrations/mail-agent-routes.test.ts holds every route the plugin registers to it',
  },
]

/** The path as the server routes it: no query, dot segments resolved, slashes folded, lower case (Express matches without case). */
export function routedPath(path: string): string {
  let pathname = path.split(/[?#]/, 1)[0] ?? ''
  try { pathname = new URL(pathname, 'http://walnut.invalid').pathname } catch { /* kept as given */ }
  let decoded = pathname
  try { decoded = decodeURIComponent(pathname) } catch { /* kept as given */ }
  return decoded.replace(/\/{2,}/g, '/').toLowerCase()
}

function underPrefix(routed: string, prefix: string): boolean {
  const bare = prefix.replace(/\/$/, '')
  if (!bare.includes('/:')) return routed === bare || routed.startsWith(`${bare}/`)
  const want = bare.split('/')
  const have = routed.split('/')
  if (have.length < want.length) return false
  return want.every((seg, i) => (seg.startsWith(':') ? have[i]!.length > 0 : seg === have[i]))
}

/** The table's row for a path, or undefined: a route whose answer is Walnut's or the user's own. */
export function outsideApiRouteOf(path: string): OutsideApiRoute | undefined {
  const routed = routedPath(path)
  return OUTSIDE_API_ROUTES.find((r) => underPrefix(routed, r.prefix))
}

/**
 * The `api` op's answer for `path`, any method: framed when the route answers outside text. Left as
 * it is only when this process built the envelope (isWalnutFramed), or the route frames its own
 * answer for the agent the self-call was made as (SELF_FRAMING_API_ROUTES).
 */
export function frameApiAnswer(path: string, answer: unknown, askedAsAgent: boolean): unknown {
  if (answer === undefined || isWalnutFramed(answer)) return answer
  const route = outsideApiRouteOf(path)
  if (!route) return answer
  const routed = routedPath(path)
  if (askedAsAgent && SELF_FRAMING_API_ROUTES.some((r) => underPrefix(routed, r.prefix))) return answer
  return frameOutsideData({ source: route.source, attrs: { route: routed } }, answer)
}
