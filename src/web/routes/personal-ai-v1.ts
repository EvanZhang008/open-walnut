/**
 * /api/v1 Personal AI conversation management (additive) — rename/pin, delete,
 * stop, and structured-question answers. Mirrors the web console's
 * conversations REST routes + the WS `chat:stop` / `chat:answer-question`
 * RPCs with equivalent semantics (no new behavior).
 *
 *   PATCH  /conversations/:id { title? | pinned? } → { conversation }
 *   DELETE /conversations/:id                      → 204 (main conversation → 409)
 *   POST   /conversations/:id/stop                 → { stopped, questionCancelled }
 *   POST   /conversations/:id/answer { answers }   → { ok: true }
 *   PUT    /conversations/active { conversationId } → { activeConversationId }
 *   GET    /chat/stats?agentId&conversationId      → conversation size stats
 *   GET    /chat/engine?agentId&conversationId     → { engine, sessionId?, switchable?, models? }
 *   PUT    /chat/model?agentId&conversationId      → { model, effort } (in-process engine)
 *   POST   /chat/clear?agentId&conversationId      → { ok: true }
 *   POST   /chat/compact?agentId&conversationId    → { ok, async|alreadyRunning } (Wave 3)
 *
 * The active pointer matters server-side (not just client UI state): cron
 * results and background notifications route into the ACTIVE conversation.
 *
 * Cloud companion (REPLICA): Class A — the replica runs its OWN Personal AI agent
 * (the v1 chat endpoints already work there), so these operate on the local
 * conversation store / turn queue directly. No bridge. The two ENGINE routes are
 * the exception: a chat turn is relayed to the primary, so which engine (and which
 * model) answers is a fact about the primary. Those relay, and when the primary
 * cannot be reached they answer 503 `primary_unreachable` — never this box's own
 * config, which would describe a box that will not answer.
 *
 * Stop semantics: the WS chat keys AbortControllers per client socket; a REST
 * client has no socket identity, so stop aborts ALL of the agent's active
 * turns via core/agent-abort-registry.ts (both WS- and REST-initiated turns
 * register there). For a single-user Personal AI that IS the "stop" the phone means.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { broadcastEvent } from '../ws/handler.js'
import { EventNames } from '../../core/event-bus.js'
import { listConversations } from '../../core/conversations.js'
// Type-only (erased at compile time): session-controls.ts dynamically imports THIS
// module for the `server.chat.model` relay, so a value import would be a cycle.
import type { SessionControlAction } from '../../core/sessions/session-controls.js'

export const personalAiV1Router = Router()

const DEFAULT_AGENT_ID = 'general'

// Same frozen error shape as api-v1.ts.
function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Same agentId resolution as api-v1.ts: query/body param, default 'general'. */
function requestAgentId(req: Request): string | null {
  const raw = (typeof req.query.agentId === 'string' && req.query.agentId)
    || (typeof req.body?.agentId === 'string' && req.body.agentId)
    || DEFAULT_AGENT_ID
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : null
}

async function consoleAgentExists(agentId: string): Promise<boolean> {
  if (agentId === DEFAULT_AGENT_ID) return true
  const { getConsoleAgent } = await import('../../core/agent-registry.js')
  return !!(await getConsoleAgent(agentId))
}

async function conversationExists(agentId: string, conversationId: string): Promise<boolean> {
  if (!/^conv-[A-Za-z0-9-]+$/.test(conversationId)) return false
  const list = await listConversations(agentId)
  return list.some((c) => c.id === conversationId)
}

/** Shared 404 gating: resolve agent + conversation or reply and return null. */
async function resolveConversation(req: Request, res: Response): Promise<{ agentId: string; conversationId: string } | null> {
  const agentId = requestAgentId(req)
  if (!agentId || !(await consoleAgentExists(agentId))) {
    sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
    return null
  }
  const conversationId = String(req.params.id ?? '')
  if (!(await conversationExists(agentId, conversationId))) {
    sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
    return null
  }
  return { agentId, conversationId }
}

// PUT /api/v1/conversations/active { conversationId, agentId? } — switch the
// ACTIVE conversation pointer. Server-side state, not client UI state: cron
// results + background notifications route into the active conversation.
// Registered before the :id routes (different method, but keep the shape
// obvious): 'active' is never treated as a conversation id.
personalAiV1Router.put('/conversations/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
      return
    }
    const conversationId = req.body?.conversationId
    if (typeof conversationId !== 'string' || !(await conversationExists(agentId, conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    const { setActiveConversationId } = await import('../../core/conversations.js')
    await setActiveConversationId(agentId, conversationId)
    // Same event shape as the internal PUT /api/agents/:agentId/conversations/active.
    broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, activeConversationId: conversationId })
    res.json({ activeConversationId: conversationId })
  } catch (err) {
    next(err)
  }
})

/** agentId + conversationId for the chat/* routes (explicit conv id wins; else the active pointer). */
async function resolveChatTarget(req: Request, res: Response): Promise<{ agentId: string; conversationId: string } | null> {
  const agentId = requestAgentId(req)
  if (!agentId || !(await consoleAgentExists(agentId))) {
    sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
    return null
  }
  const rawConvId = (typeof req.query.conversationId === 'string' && req.query.conversationId)
    || (typeof req.body?.conversationId === 'string' && req.body.conversationId)
    || ''
  if (rawConvId) {
    if (!(await conversationExists(agentId, rawConvId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${rawConvId}`)
      return null
    }
    return { agentId, conversationId: rawConvId }
  }
  const { getActiveConversationId } = await import('../../core/conversations.js')
  return { agentId, conversationId: await getActiveConversationId(agentId) }
}

/**
 * On a REPLICA, run one chat control action on the primary and answer with its
 * reply. Returns true when it answered (so the caller returns), false only on the
 * primary itself.
 *
 * A REPLICA NEVER ANSWERS THESE FROM ITS OWN CONFIG. That used to be the
 * degradation ("the bridge is down, so this box's fallback loop really would
 * answer the next message"), and it was wrong twice over: a relayed turn is what
 * actually happens, and the bridge-down window is measured in seconds while the
 * pill it mislabelled stays on screen. The phone's model pill therefore described
 * a box that would never answer — and it locked the control with that box's
 * reason. A 503 the client retries is the honest answer, and it matches what
 * GET /conversations/:id/messages already does for the same hop
 * (`primary_unreachable`, `retry: true`).
 *
 * A genuine DOMAIN failure from the primary (it ran the action and refused) is
 * passed through with its own status and code — that is a real answer about the
 * answering box, not a reachability problem.
 */
async function relayChatToPrimary(
  res: Response,
  action: Extract<SessionControlAction, 'server.chat.engine' | 'server.chat.model'>,
  ids: { agentId: string; conversationId: string },
  params: Record<string, unknown>,
  isValidResult: (result: Record<string, unknown>) => boolean,
): Promise<boolean> {
  if (!CLOUD_MODE) return false
  const unreachable = (reason: string): void => {
    log.web.info('chat control relay unreachable — reporting the primary, not this box', {
      ...ids, action, reason,
    })
    sendError(res, 503, 'primary_unreachable',
      'Your primary box is unreachable, so the chat engine could not be reached yet',
      { retry: true })
  }
  try {
    const { callPrimaryControl } = await import('./v1-control-relay.js')
    // '__server__' is the established box-level sid for a `server.*` action (the
    // daemon executes nothing itself and forwards the action opaquely).
    const outcome = await callPrimaryControl(
      action,
      '__server__',
      { agentId: ids.agentId, conversationId: ids.conversationId, ...params },
      15_000,
    )
    if (!outcome.ok) {
      // needs_upgrade (an old primary that has never heard of this action) and
      // bridge_offline are both "nobody who can answer is reachable" — same 503,
      // and both self-heal on the primary's next deploy/reconnect.
      if (outcome.failure.kind === 'error') {
        sendError(res, outcome.failure.status, outcome.failure.code, outcome.failure.message)
        return true
      }
      unreachable(`${outcome.failure.kind}: ${outcome.failure.message}`)
      return true
    }
    if (!isValidResult(outcome.result)) {
      // A truthy-but-wrong body must never be handed to the phone as if it were
      // the contract (the iOS client fails the whole decode on a shape miss).
      unreachable('the primary answered in an unexpected shape')
      return true
    }
    res.json(outcome.result)
    return true
  } catch (err) {
    unreachable(err instanceof Error ? err.message : String(err))
    return true
  }
}

/** The engine question, relayed. `ensure: true` asks the primary to mint the lane. */
function relayChatEngine(
  res: Response,
  ids: { agentId: string; conversationId: string },
  ensure: boolean,
): Promise<boolean> {
  return relayChatToPrimary(
    res, 'server.chat.engine', ids,
    ensure ? { ensure: true } : {},
    (result) => typeof result.engine === 'string',
  )
}

/** One selectable row, the SAME item shape core/sessions/session-controls.ts
 *  ModelOption uses (that is what GET /sessions/:id/model-options returns and
 *  what the phone's picker already decodes). */
interface ChatModelOption {
  id: string
  label: string
  supportsEffort?: boolean
}

/**
 * The models the IN-PROCESS loop can actually run, in the picker's item shape.
 *
 * Deliberately NOT the lane picker's catalog (sessionModelsAsCatalog /
 * computeModelOptions). Those rows are `claude` CLI switch strings ('sonnet-1m',
 * 'opus') and the CLI is the only thing that can resolve them; the in-process loop
 * calls a provider adapter directly and looks its model up in MODEL_CATALOG, where
 * the ids are per-provider ('global.anthropic.claude-opus-4-8' on bedrock, plain
 * aliases on claude_cli). Offering a lane row here would have validated fine and
 * then failed at the wire on the next turn — a confident wrong answer.
 *
 * So: the same list Settings offers for `agent.main_model`
 * (getModelsForProvider(<the resolved main provider>) + the user's config
 * overrides), which is by construction the set this loop resolves. `supportsEffort`
 * is false because the in-process loop has no effort concept at all.
 *
 * Note: for a provider whose catalog is discovered at runtime (ollama) the static
 * baseline is empty; this endpoint does not probe a local server (a GET on the
 * chat path must not wait on one).
 */
async function inProcessModelOptions(
  config: import('../../core/types.js').Config,
): Promise<ChatModelOption[]> {
  try {
    const { resolveMainProviderName } = await import('../../agent/providers/default-provider.js')
    const { getModelsForProvider } = await import('../../agent/providers/model-catalog.js')
    const provider = resolveMainProviderName(config)
    const overrides = config.providers?.[provider]?.models
    return getModelsForProvider(provider, overrides).map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      supportsEffort: false,
    }))
  } catch (err) {
    // An empty list means "not switchable yet", which is degraded but honest; a
    // throw here would take the whole engine question down with it.
    log.web.warn('in-process model catalog unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// GET /api/v1/chat/engine?agentId&conversationId → { engine, sessionId?, cwd? }
//
// Why this exists: on the lane engine (`config.agent.provider === 'claude-code'`)
// a chat turn runs inside a real `claude` CLI session, so the model/effort/mode
// the answer is produced with live on THAT session record and are switchable
// through the ordinary `/sessions/:id/model|effort|controls` endpoints. Those
// endpoints already accept a lane session id (they resolve by record, not by the
// listable projection); what no v1 route exposed was the id itself, so a mobile
// client had no way to find the session behind its own conversation. The web
// console reads it from an internal non-v1 route (POST .../lane-session), which
// mobile cannot use.
//
// READ-ONLY on purpose: it never mints a lane. Minting is a side effect of
// sending, and a picker that spawns a CLI just by being opened would start a
// process the user never asked for. Hence `sessionId: null` on the LANE engine
// until the conversation has had its first turn: the client shows the model as
// read-only (or hides the pill) rather than fabricating one.
//
// `engine: 'in-process'` means the config is NOT on the lane engine, so there is
// no per-conversation `claude` session. The model is still SWITCHABLE
// (`switchable: true` + a `models` catalog + PUT /chat/model): it used to be
// reported as a read-only config-level fact, and the pill said so out loud ("the
// model comes from the server's config"), which is not something a user should
// have to open Settings to change for one conversation. The override lives on the
// conversation row; `model` here is the EFFECTIVE id (row override, else the config
// default), so a client can render the pill from this response alone.
personalAiV1Router.get('/chat/engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    // On a REPLICA the answering box is the primary (chat turns are relayed
    // there), so the engine question belongs there too. Answering from this
    // box's own config described a fallback turn that almost never runs, and the
    // phone's model pill showed a model no relayed turn would ever use.
    if (await relayChatEngine(res, ids, false)) return
    const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (resolveAgentEngineProvider(config) !== 'claude-code') {
      const { getConversationModel } = await import('../../core/conversations.js')
      const row = await getConversationModel(ids.agentId, ids.conversationId)
      res.json({
        engine: 'in-process',
        sessionId: null,
        switchable: true,
        model: row.model ?? config.agent?.main_model ?? null,
        effort: row.effort ?? null,
        models: await inProcessModelOptions(config),
      })
      return
    }
    const { personalAiLaneKey } = await import('../../core/sessions/personal-ai-lane.js')
    const { getSessionByLane } = await import('../../core/session-tracker.js')
    const record = await getSessionByLane(personalAiLaneKey(ids.agentId, ids.conversationId))
    const sessionId = record?.claudeSessionId ?? null
    res.json({
      engine: 'lane',
      sessionId,
      // Additive: the lane's model is switchable through the session endpoints
      // (/sessions/:id/model|effort) — but only once the lane exists. Omitted
      // rather than false when it doesn't, so no existing client's decode changes.
      ...(sessionId ? { switchable: true } : {}),
      ...(record?.cwd ? { cwd: record.cwd } : {}),
      // '' on the record means the primary box, matching ProjectedSession.host.
      ...(record ? { host: record.host ?? '' } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/chat/model?agentId&conversationId { model?, effort? }
//   → 200 { model: string | null, effort: string | null }
//
// The per-conversation model switch for the IN-PROCESS engine. `null` clears the
// override (back to `config.agent.main_model`); an omitted field is left alone.
// The response echoes the STORED override, so `null` means "following the config
// default" — GET /chat/engine is where the effective id lives.
//
// On the LANE engine this route is a client bug, not a fallback: the lane session
// owns model+effort and /sessions/:id/model applies it live. Answering 409
// `lane_engine` (with the session id to switch instead) makes that loud rather
// than writing a second copy of "which model" that nothing would read.
//
// `effort` is accepted and persisted on every engine but is a NO-OP for the
// in-process loop: nothing in src/agent/ reads a reasoning-effort level (it is a
// `claude -p --effort` concept). Persisting it keeps a user's pick across an engine
// switch; faking it into the provider request would be a lie.
personalAiV1Router.put('/chat/model', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch = parseChatModelPatch(body)
    if ('error' in patch) {
      sendError(res, 400, patch.error.code, patch.error.message)
      return
    }
    // A replica never owns the answering engine — relay the write to the box whose
    // turn will read it (same 503 as the engine question when it can't be reached).
    if (await relayChatToPrimary(
      res, 'server.chat.model', ids,
      {
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      },
      (result) => 'model' in result,
    )) return

    const outcome = await applyChatModelPatch(ids.agentId, ids.conversationId, patch)
    if ('error' in outcome) {
      // sessionId rides BOTH inside the error object and at the top level: the
      // frozen shape puts extras at the top, and a client reading error.sessionId
      // must not come up empty on the one field that tells it where to switch.
      res.status(outcome.error.status).json({
        error: {
          code: outcome.error.code,
          message: outcome.error.message,
          ...(outcome.error.sessionId !== undefined ? { sessionId: outcome.error.sessionId } : {}),
        },
        ...(outcome.error.sessionId !== undefined ? { sessionId: outcome.error.sessionId } : {}),
      })
      return
    }
    res.json(outcome)
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      sendError(res, 404, 'not_found', err.message)
      return
    }
    next(err)
  }
})

/** Validated `{ model?, effort? }` patch (present-and-typed only, no catalog check).
 *  A field ABSENT from the body stays undefined (leave it alone); `null` — and an
 *  all-whitespace string, which is what an emptied text field sends — means clear. */
type ChatModelPatch = { model?: string | null; effort?: string | null }

function parseChatModelPatch(
  body: Record<string, unknown>,
): ChatModelPatch | { error: { code: string; message: string } } {
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model')
  const hasEffort = Object.prototype.hasOwnProperty.call(body, 'effort')
  if (!hasModel && !hasEffort) {
    return { error: { code: 'bad_request', message: 'At least one of model, effort is required' } }
  }
  const patch: ChatModelPatch = {}
  if (hasModel) {
    const raw = body.model
    if (raw !== null && typeof raw !== 'string') {
      return { error: { code: 'bad_request', message: 'model must be a string or null' } }
    }
    patch.model = raw === null ? null : raw.trim() || null
  }
  if (hasEffort) {
    const raw = body.effort
    if (raw !== null && typeof raw !== 'string') {
      return { error: { code: 'bad_request', message: 'effort must be a string or null' } }
    }
    patch.effort = raw === null ? null : raw.trim() || null
  }
  return patch
}

/**
 * Apply a validated patch on THIS box (the answering box). Shared by the local
 * route and the primary-side relay handler below, so a phone on a replica and a
 * phone on the primary can never take different rules.
 */
async function applyChatModelPatch(
  agentId: string,
  conversationId: string,
  patch: ChatModelPatch,
): Promise<
  | { model: string | null; effort: string | null }
  | { error: { status: number; code: string; message: string; sessionId?: string | null } }
> {
  const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
  const config = await getConfig()
  if (resolveAgentEngineProvider(config) === 'claude-code') {
    const { personalAiLaneKey } = await import('../../core/sessions/personal-ai-lane.js')
    const { getSessionByLane } = await import('../../core/session-tracker.js')
    const record = await getSessionByLane(personalAiLaneKey(agentId, conversationId))
    return {
      error: {
        status: 409,
        code: 'lane_engine',
        message: 'This conversation answers on a lane session — switch its model through /api/v1/sessions/:id/model',
        sessionId: record?.claudeSessionId ?? null,
      },
    }
  }
  if (typeof patch.model === 'string') {
    const catalog = await inProcessModelOptions(config)
    if (!catalog.some((m) => m.id === patch.model)) {
      return {
        error: {
          status: 400,
          code: 'unknown_model',
          message: `Unknown model: ${patch.model}`,
        },
      }
    }
  }
  if (typeof patch.effort === 'string') {
    const { VALID_SESSION_EFFORT_IDS } = await import('../../core/types.js')
    if (!VALID_SESSION_EFFORT_IDS.has(patch.effort)) {
      return {
        error: {
          status: 400,
          code: 'bad_request',
          message: `Invalid effort: ${patch.effort} (expected one of ${[...VALID_SESSION_EFFORT_IDS].join(', ')})`,
        },
      }
    }
  }
  const { setConversationModel } = await import('../../core/conversations.js')
  const conversation = await setConversationModel(agentId, conversationId, patch)
  // Same event the PATCH /conversations/:id route emits, so the web console's
  // conversation row updates without a poll.
  broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, conversation })
  log.web.info('chat model override applied via api-v1', {
    agentId, conversationId, model: conversation.model ?? null, effort: conversation.effort ?? null,
  })
  return { model: conversation.model ?? null, effort: conversation.effort ?? null }
}

/**
 * PRIMARY side of `server.chat.model` — the same write the local route does, on
 * the box whose turn will read it. Throws SessionControlError so the relay maps
 * the status/code onto the replica's frozen error shape (the 409's `sessionId`
 * does not survive that hop; a client that needs it asks GET /chat/engine, which
 * relays the whole lane answer).
 */
export async function handlePrimaryChatModelRelay(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { SessionControlError } = await import('../../core/sessions/session-controls.js')
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : DEFAULT_AGENT_ID
  const { getActiveConversationId, ensureConversationRow } = await import('../../core/conversations.js')
  const conversationId = typeof params.conversationId === 'string' && params.conversationId
    ? params.conversationId
    : await getActiveConversationId(agentId)
  const patch = parseChatModelPatch(params)
  if ('error' in patch) throw new SessionControlError(patch.error.message, 400, { code: patch.error.code })
  // Same reason the chat-turn relay ensures the row: the conversation was created
  // in the REPLICA's index, and waiting for git-sync to deliver it here is lossy
  // (whole-file LWW can drop a new row). Without this, picking a model before the
  // conversation's first turn would 500 on "Conversation not found".
  await ensureConversationRow(agentId, conversationId)
  const outcome = await applyChatModelPatch(agentId, conversationId, patch)
  if ('error' in outcome) {
    throw new SessionControlError(outcome.error.message, outcome.error.status, { code: outcome.error.code })
  }
  return outcome as unknown as Record<string, unknown>
}

// POST /api/v1/chat/engine/session?agentId&conversationId → { sessionId, cwd, host, created }
//
// Mint the lane session for this conversation if it doesn't have one yet, so the
// phone's model pill is a PICKER rather than a read-only label on a conversation
// that hasn't been sent to.
//
// The GET above stays read-only, and this is why it can be: minting is now an
// explicit request. The old shape ("sessionId is null until the first turn") left
// the pill permanently disabled on every new conversation — the user's report was
// exactly that: the model control works in tasks and not in the ordinary chat.
//
// Why minting here is not a new side effect: the WEB console already mints on
// MOUNT (`useLaneSession` resolves eagerly, deliberately, so the CLI is warm by
// the time the first message lands). A conversation the user has opened on the
// phone is in the same position. What is still avoided is minting from a GET —
// a poll or a prefetch must never spawn a process.
//
// 409 when the engine flag is off: the in-process loop has no lane, and minting
// one anyway would leave an orphan CLI.
personalAiV1Router.post('/chat/engine/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    // A replica has no session runner: minting must happen on the primary, which
    // is also the box whose lane will answer the next message.
    if (await relayChatEngine(res, ids, true)) return
    const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
    if (resolveAgentEngineProvider(await getConfig()) !== 'claude-code') {
      res.status(409).json({ error: 'Lane engine is not active' })
      return
    }
    const { getOrCreateLaneSession } = await import('../../core/sessions/personal-ai-lane.js')
    const lane = await getOrCreateLaneSession(ids.agentId, ids.conversationId)
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(lane.sessionId)
    const { WALNUT_HOME } = await import('../../constants.js')
    log.web.info('api-v1 lane session resolved for the chat model pill', {
      ...ids, sessionId: lane.sessionId, created: lane.created, engine: lane.engine,
    })
    res.json({
      engine: 'lane',
      sessionId: lane.sessionId,
      cwd: record?.cwd ?? WALNUT_HOME,
      // '' on the record means the primary box, matching ProjectedSession.host.
      host: record?.host ?? '',
      created: lane.created,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/chat/stats?agentId&conversationId — real conversation size
// (API message count + token estimate incl. system/tools), cached between turns.
personalAiV1Router.get('/chat/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const { computeChatStats } = await import('./chat-history.js')
    res.json(await computeChatStats(ids.agentId, ids.conversationId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/chat/clear?agentId&conversationId — clear the conversation.
// Retires the lane session too (same reason as the web route): the CLI holds its
// own copy of the transcript, so leaving it alive means "clear" cleared nothing
// from the model's point of view.
personalAiV1Router.post('/chat/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const chatHistory = await import('../../core/chat-history.js')
    await chatHistory.clear(ids.agentId, ids.conversationId)
    const { archiveLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
    const retired = await archiveLaneForConversation(ids.agentId, ids.conversationId)
    log.web.info('Personal AI conversation cleared via api-v1', { ...ids, retiredLaneSessionId: retired ?? undefined })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/chat/compact?agentId&conversationId (Wave 3) — fire-and-forget
// background compaction (the same trigger the web console uses). Answers
// immediately: { ok, async: true }, or { ok, alreadyRunning: true } when a
// compaction is already in flight. Class A (the replica compacts its own
// Personal AI's conversation with its own model credentials).
personalAiV1Router.post('/chat/compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const { isCompactionInProgress, triggerBackgroundCompaction } = await import('../background-compaction.js')
    if (isCompactionInProgress(ids.agentId, ids.conversationId)) {
      res.json({ ok: true, alreadyRunning: true })
      return
    }
    triggerBackgroundCompaction('api-v1', { force: true, agentId: ids.agentId, conversationId: ids.conversationId })
    res.json({ ok: true, async: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/conversations/:id { title? | pinned? } → { conversation }
personalAiV1Router.patch('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const title = req.body?.title
    const pinned = req.body?.pinned
    if (title !== undefined && typeof title !== 'string') {
      sendError(res, 400, 'bad_request', 'title must be a string')
      return
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      sendError(res, 400, 'bad_request', 'pinned must be a boolean')
      return
    }
    if (title === undefined && pinned === undefined) {
      sendError(res, 400, 'bad_request', 'At least one of title, pinned is required')
      return
    }
    const { renameConversation, setPinned } = await import('../../core/conversations.js')
    let conversation
    if (typeof title === 'string') conversation = await renameConversation(agentId, conversationId, title)
    if (typeof pinned === 'boolean') conversation = await setPinned(agentId, conversationId, pinned)
    broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, conversation })
    res.json({ conversation })
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      sendError(res, 404, 'not_found', err.message)
      return
    }
    next(err)
  }
})

// DELETE /api/v1/conversations/:id → 204. The MAIN conversation is never
// deletable (it receives background notifications + cron) → 409 conflict.
personalAiV1Router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const { deleteConversation, getActiveConversationId } = await import('../../core/conversations.js')
    try {
      await deleteConversation(agentId, conversationId)
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('main')) {
        sendError(res, 409, 'conflict', err.message)
        return
      }
      throw err
    }
    // The active pointer may have moved (if the active conversation was deleted).
    const activeConversationId = await getActiveConversationId(agentId)
    broadcastEvent(EventNames.CONVERSATION_DELETED, { agentId, conversationId, activeConversationId })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations/:id/stop → { stopped, questionCancelled }
// Aborts ALL of the agent's active turns (see the header comment for why
// agent-level, not per-socket) and cancels any pending user_ask question —
// the same pair of effects as the WS `chat:stop`.
personalAiV1Router.post('/conversations/:id/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const { abortAgentTurns } = await import('../../core/agent-abort-registry.js')
    const { hasPendingQuestion, cancelQuestion } = await import('../../core/agent-question.js')
    const questionCancelled = hasPendingQuestion(agentId)
    const stopped = abortAgentTurns(agentId)
    cancelQuestion(agentId)
    // Lane engine: the work lives in a `claude` CLI, which no AbortController can
    // reach — interrupt the lane session too (canonical bus path, never a signal).
    // Unconditional: resolves null when this conversation has no lane record.
    let laneInterrupted: string | null = null
    try {
      const { interruptLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
      laneInterrupted = await interruptLaneForConversation(agentId, conversationId)
    } catch (err) {
      // Never fail the client's stop over the lane half.
      log.web.warn('api-v1 stop: lane interrupt failed', {
        agentId, conversationId, error: err instanceof Error ? err.message : String(err),
      })
    }
    log.web.info('Personal AI turn stopped via api-v1', {
      agentId, conversationId, stopped, questionCancelled,
      laneSessionId: laneInterrupted ?? undefined,
    })
    // Response shape stays frozen ({ stopped, questionCancelled }) — the lane id
    // is logged, not added to the contract.
    res.json({ stopped, questionCancelled })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations/:id/answer { answers: Record<string,string> }
// Answer a pending structured question (user_ask tool) — mirrors the WS
// `chat:answer-question`: persists the answers as a UI entry, broadcasts the
// history update, and unblocks the agent loop. 409 when nothing is pending.
personalAiV1Router.post('/conversations/:id/answer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const answers = req.body?.answers
    if (
      answers === null || typeof answers !== 'object' || Array.isArray(answers)
      || Object.keys(answers).length === 0
      || !Object.values(answers).every((v) => typeof v === 'string')
    ) {
      sendError(res, 400, 'bad_request', 'answers must be a non-empty object of string values')
      return
    }
    const { hasPendingQuestion, submitAnswers } = await import('../../core/agent-question.js')
    if (!hasPendingQuestion(agentId)) {
      sendError(res, 409, 'conflict', 'No pending question for this agent')
      return
    }
    // Persist the user's answers as a UI-only chat entry (same as chat.ts).
    const chatHistory = await import('../../core/chat-history.js')
    const answerLines = Object.entries(answers as Record<string, string>)
      .map(([k, v]) => `${k}: ${v}`).join('\n')
    await chatHistory.addNotification({ role: 'user', content: answerLines, agentId, conversationId })
    broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
      entry: { role: 'user', content: answerLines, source: 'question-answer' },
      agentId,
      conversationId,
    })
    submitAnswers(answers as Record<string, string>, agentId)
    log.web.info('Personal AI question answered via api-v1', { agentId, conversationId, answerCount: Object.keys(answers).length })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
personalAiV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 Personal AI route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
