/**
 * What the mail routes do for a caller that is not the person at the Mail app.
 *
 * The eight mail ops (agent-surface.ts) are the agent's door to mail: they quote every authored
 * field inside an untrusted-data block, and none of them sends, unsubscribes or answers an invite
 * on its own. The routes under `/api/plugins/mail/*` are the console's door, and the generic `api`
 * op reaches them too (2026-11-26, issue #23 point 4: an agent without its mail ops read the mail
 * by another way; a probe then showed the `api` op reading subjects with no frame, and the
 * console's Send route sending a draft with no approval letter). So every route answers an agent
 * caller the way the ops would:
 *
 * - Every answer it reads is framed as untrusted data (`frameForAgent`): one JSON envelope naming
 *   the source and its trust, with the reminder outside the data, and every authored string
 *   cleaned the way the ops clean it (controls and bidi marks out, a frame tag escaped).
 * - A request that IS the person's act (their click on Send, Unsubscribe, an invite's answer) runs
 *   the ask the matching op makes instead (`personAct`). The ask itself honours the approvals switch.
 *
 * Who counts as an agent here: a call carrying a session id (`x-walnut-caller-sid`, set by Walnut's
 * op executor for every session's call) or marked as a script's (`x-walnut-caller-kind:
 * automation`, a `walnut tools call` with no session). These are the same two signals the read
 * routes already used to keep agents on the cache. For a person's act, a browser under automation on
 * the user's own install is not the person either (core/sessions/automated-client.ts); its reads are
 * not framed, because it renders the console, which reads the plain shapes.
 *
 * What this cannot stop: a process of the same user reading the cache file itself (`plugin.sqlite`
 * in the plugin's data directory) or calling the routes with no Walnut header. The guidance for that
 * is where the agent decides it: the `walnut` CLI's line when an op is unreachable
 * (providers/host-exec-run-id.ts awayLines) and the walnut-mail skill.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { PluginRouteHandler, PluginRouteReply, PluginRouteRequest } from '../../core/plugins/plugin-route-adapter.js'
import { automatedClientIsAgent, automatedClientOf } from '../../core/sessions/automated-client.js'
import { LOCAL_ORIGIN, ORIGIN_HEADER, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { withMailCaller } from './caller-scope.js'
import { cleanOutside, frameOutsideData, stripControls, truncateUtf8, WALNUT_NOTE_FIELD } from '../../core/outside-content.js'
import { AGENT_READ_MAX_BYTES } from './untrusted.js'

const CALLER_SID_HEADER = 'x-walnut-caller-sid'
const CALLER_KIND_HEADER = 'x-walnut-caller-kind'

/**
 * A call made by an agent or a script, never by the console a person reads. The negation of the rule
 * the person-only core routes share (web/routes/person-caller.ts isPersonCaller), read off a plugin
 * request: a session id, any caller-kind mark, or an origin that is neither this computer nor a paired
 * device. The origin header is the one the host's plugin dispatcher stamps over anything the client sent.
 */
export function isAgentCaller(request: Pick<PluginRouteRequest, 'headers'>): boolean {
  // A request with no headers at all (an in-process caller, a test's stub) names no agent.
  const headers: Partial<Record<string, string>> = request.headers ?? {}
  if (headers[CALLER_SID_HEADER]?.trim() || headers[CALLER_KIND_HEADER]?.trim()) return true
  const origin = headers[ORIGIN_HEADER]?.trim()
  return !!origin && origin !== LOCAL_ORIGIN && origin !== REMOTE_HTTP_ORIGIN
}

/** A call that is not the person's own click: an agent, a script, or a browser under automation on the user's install. */
export async function isNotThePerson(request: Pick<PluginRouteRequest, 'headers'>): Promise<boolean> {
  if (isAgentCaller(request)) return true
  return !!automatedClientOf(request.headers ?? {}) && await automatedClientIsAgent()
}

export { WALNUT_NOTE_FIELD }

const MAIL = { source: 'mail' }

/** Answer JSON framed; Walnut's own note (WALNUT_NOTE_FIELD) is lifted out beside the frame. */
function framedJson(json: unknown): Record<string, unknown> {
  if (json && typeof json === 'object' && !Array.isArray(json) && typeof (json as Record<string, unknown>)[WALNUT_NOTE_FIELD] === 'string') {
    const { [WALNUT_NOTE_FIELD]: walnutNote, ...rest } = json as Record<string, unknown>
    return frameOutsideData(MAIL, rest, walnutNote as string)
  }
  return frameOutsideData(MAIL, json)
}

/** Text framed as data, with `truncated` when it was cut. */
function framedTextData(text: string, truncated: boolean): Record<string, unknown> {
  const env = frameOutsideData(MAIL, null) as { external_content: Record<string, unknown> }
  delete env.external_content.data
  env.external_content.text = cleanOutside(text)
  if (truncated) env.external_content.truncated = true
  return env
}

async function bytesOf(body: NonNullable<PluginRouteReply['body']>, max: number): Promise<{ bytes: Uint8Array; more: boolean }> {
  if (body instanceof Uint8Array) return { bytes: body.subarray(0, max), more: body.byteLength > max }
  const chunks: Uint8Array[] = []
  let size = 0
  const iterator = body[Symbol.asyncIterator]()
  try {
    while (size <= max) {
      const next = await iterator.next()
      if (next.done) return { bytes: Buffer.concat(chunks).subarray(0, max), more: size > max }
      chunks.push(next.value)
      size += next.value.byteLength
    }
    return { bytes: Buffer.concat(chunks).subarray(0, max), more: true }
  } finally {
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {})
  }
}

/** A streamed answer that is JSON (a save's outcome), else undefined. */
function parsedJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try { return JSON.parse(trimmed) } catch { return undefined }
}

/** Headers that describe a body this answer no longer carries. */
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-disposition', 'content-encoding'])

function withoutBodyHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())))
}

/**
 * A route's answer as an agent caller gets it: whatever it read, framed. A refusal (4xx/5xx) keeps
 * its shape, since its words are Walnut's and its code is what the caller acts on.
 */
export async function frameForAgent(reply: PluginRouteReply): Promise<PluginRouteReply> {
  if ((reply.status ?? 200) >= 400) return reply
  if (reply.json !== undefined) return { ...reply, json: framedJson(reply.json) }
  if (reply.text !== undefined) {
    const cut = truncateUtf8(stripControls(reply.text), AGENT_READ_MAX_BYTES)
    return { ...reply, headers: withoutBodyHeaders(reply.headers), text: undefined, json: framedTextData(cut.text, cut.shown < cut.total) }
  }
  if (reply.body !== undefined) {
    // Bytes (an attachment, a save's streamed answer) reach an agent as text, at most what one
    // mail_read shows. Read lazily, while the host writes the answer, so the route's own stream
    // deadline (`timeoutMs`) holds, not the 60 s a handler has to answer in.
    const source = reply.body
    async function* framedBytes(): AsyncGenerator<Uint8Array> {
      const { bytes, more } = await bytesOf(source, AGENT_READ_MAX_BYTES)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      const json = parsedJson(text)
      yield new TextEncoder().encode(JSON.stringify(json !== undefined && !more
        ? framedJson(json)
        : framedTextData(stripControls(text), more)))
    }
    return {
      status: reply.status,
      headers: { ...withoutBodyHeaders(reply.headers), 'Content-Type': 'application/json; charset=utf-8' },
      body: framedBytes(),
      ...(reply.timeoutMs !== undefined ? { timeoutMs: reply.timeoutMs } : {}),
    }
  }
  return reply
}

const PERSON_ACT = Symbol('mail.personAct')
const FRAMED = Symbol('mail.framedForAgent')

/**
 * A route whose request is the person's own act. `forOthers` answers anyone else: the ask the
 * matching op makes, or a refusal that says who does it.
 */
export function personAct(handler: PluginRouteHandler, forOthers: PluginRouteHandler): PluginRouteHandler {
  const routed: PluginRouteHandler = async (request) => (await isNotThePerson(request) ? forOthers(request) : handler(request))
  return Object.assign(routed, { [PERSON_ACT]: true })
}

/** The approvals switch (Settings, General), as a person's act with no ask of its own reads it. */
export interface ApprovalsSwitch {
  /** Whether an agent's step waits for the person (core/approvals/ask-me.ts asksPerson). */
  asksPerson(): Promise<boolean>
  /** Lists a step that went ahead with approvals off, under its gate (core/approvals/ask-me.ts ASK_ME_GATES). */
  recordUnasked(gate: 'mailSend' | 'mailUnsubscribe', what: string): Promise<void>
}

/**
 * A person's act that no op asks the person about (an invite's answer, a batch of unsubscribes).
 * Anyone else goes ahead only while approvals are off, recorded as such; otherwise `refusal`.
 * No switch at all: it asks.
 */
export function personActOrApprovalsOff(
  handler: PluginRouteHandler,
  approvals: ApprovalsSwitch | undefined,
  step: { gate: 'mailSend' | 'mailUnsubscribe'; what: string },
  refusal: PluginRouteReply,
): PluginRouteHandler {
  return personAct(handler, async (request) => {
    if (!approvals || await approvals.asksPerson()) return refusal
    const reply = await handler(request)
    if ((reply.status ?? 200) < 400) await approvals.recordUnasked(step.gate, step.what)
    return reply
  })
}

export function isPersonAct(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as unknown as Record<symbol, unknown>)[PERSON_ACT] === true
}

export function isFramedForAgent(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as unknown as Record<symbol, unknown>)[FRAMED] === true
}

/**
 * Every write route an agent may run as it is, and why. A write that is in neither this list nor
 * wrapped in `personAct` fails tests/integrations/mail-agent-routes.test.ts: a new route has to say
 * which it is.
 */
export const AGENT_MAY_WRITE: Readonly<Record<string, string>> = {
  'post /accounts': 'connects a mailbox with the password or sign-in the caller was given: an agent setting up the user\'s own account at their ask; nothing is sent and the secret stays with the provider',
  'post /messages/:accountId/:messageId/read': 'the read flag, as mail_mark_read sets it',
  'post /refresh': 'polls the mailbox now',
  'post /mailboxes/fetch': 'fetches one folder now',
  'post /digest/send-now': 'a letter to the person, nothing outward',
  'post /drafts': 'a draft, as mail_draft writes it',
  'patch /drafts/:draftId': 'a draft edit, as mail_draft makes it',
  'delete /drafts/:draftId': 'discards a draft that was never sent',
  'post /drafts/:draftId/request-send': 'the ask mail_request_send makes',
  'post /sends/:sendId/retry': 'a retry is a fresh approval round: the person is asked again',
  'post /messages/:accountId/:messageId/attachments/:attachmentId/save': 'saves an attachment to the person\'s own disk',
  'put /rules': 'the person\'s sort rules file, local',
  'post /rules/init': 'writes the starter sort rules, local',
  'post /rules/restore': 'restores the sort rules backup, local',
  'put /groups/pref': 'a sort group\'s display preference, local',
  'put /groups/:groupId/label': 'a sort group\'s label, local',
  'post /groups/read': 'the read flag on a sort group, undone the same way',
  'post /groups/archive': 'moves mail to the archive folder inside the person\'s own mailbox, undone by bulk undo',
  'post /rules/apply': 'applies the sort rules inside the person\'s own mailbox, undone by bulk undo',
  'post /bulk/:jobId/stop': 'stops a bulk job',
  'post /bulk/:jobId/undo': 'undoes a bulk job',
  'post /bulk/:jobId/retry': 'retries a bulk job\'s failed items',
  'post /rules/preview': 'a read: what a rule would match',
  'post /rules/propose': 'a read: a proposed rule, nothing written',
  'post /unsubscribe/batch/:batchId/stop': 'stops a running batch, starts nothing',
}

/**
 * `walnut` with its `http.route` framing every answer an agent caller reads. Everything else is the
 * same object (a Proxy, so the host's getters keep reading live state).
 */
export function agentAwareRoutes(walnut: WalnutServerPluginApi): WalnutServerPluginApi {
  const http = new Proxy(walnut.http, {
    get(target, key) {
      if (key !== 'route') return Reflect.get(target, key, target)
      return (method: string, path: string, handler: PluginRouteHandler) => {
        const framed: PluginRouteHandler = async (request) => {
          // Run as the caller's session, so a step that goes ahead unasked names it (caller-scope.ts).
          const reply = await withMailCaller(request.headers?.[CALLER_SID_HEADER], () => handler(request))
          return isAgentCaller(request) ? frameForAgent(reply) : reply
        }
        Object.assign(framed, { [FRAMED]: true, ...(isPersonAct(handler) ? { [PERSON_ACT]: true } : {}) })
        return target.route(method as never, path, framed)
      }
    },
  })
  return new Proxy(walnut, {
    get(target, key) {
      return key === 'http' ? http : Reflect.get(target, key, target)
    },
  })
}
