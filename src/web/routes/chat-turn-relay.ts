/**
 * Cloud chat-turn relay — "the phone's chat runs on the PRIMARY's engine".
 *
 * THE BUG THIS FIXES: a chat turn sent from the phone through the cloud replica
 * ran the replica's OWN in-process `walnut-agent` loop, because the replica's
 * config carries no `agent.provider` and `resolveAgentEngineProvider` defaults
 * to 'walnut-agent'. The Mac is configured `provider: claude-code`, so the same
 * question answered by two different engines depending on which box the phone
 * happened to reach — different tools, different memory, different skills.
 *
 * Writing `provider: claude-code` into the replica's config is NOT the fix: the
 * lane engine needs a local session runner and a `claude` CLI, and the replica
 * has neither. The turn has to RUN on the box that owns the lane session.
 *
 * ── Transport: two lanes that already exist, zero daemon changes ─────────────
 *
 *   uplink   replica → `session.control` bridge RPC (action 'server.chat.turn')
 *            → primary's daemon → primary's walnut server. The daemon forwards
 *            the action string OPAQUELY (it executes nothing itself), so a new
 *            action needs no daemon protocol change, no allowlist entry, and no
 *            daemon redeploy — the same property the Wave-1 lifecycle family
 *            relies on. An old primary answers "Unknown control action", which
 *            the shared ladder classifies as needs_upgrade → we degrade.
 *
 *   downlink primary → `mobile-event` command → its daemon → /bridge → the
 *            replica's bridge-registry → events-v1 → this module → the phone's
 *            conversation SSE channel. Also opaque in `kind`, so also no daemon
 *            change. The inner event name is re-validated here against a fixed
 *            allowlist: a buggy or compromised sender must never be able to
 *            inject arbitrary SSE event names into a phone.
 *
 * ── Why the uplink does NOT await the turn ───────────────────────────────────
 *
 * The daemon's control-relay budget is 45s; a real chat turn runs for minutes.
 * So the uplink is ACCEPT-ONLY: the primary validates, starts the turn, and
 * answers in milliseconds. The answer and every delta come back asynchronously
 * on the downlink. That also means a bridge flap mid-turn costs frames, not the
 * turn — and the answer is still persisted on the primary regardless.
 *
 * ── Where history is persisted: THE PRIMARY, exactly once ────────────────────
 *
 * The primary runs the ordinary `runApiV1Turn`, which already persists the user
 * message and the answer into `conversations/<agent>/<conv>.json` — the file
 * git-sync treats the Mac as the source of truth for. The replica persists
 * NOTHING for a relayed turn and only forwards frames. Two writers would mean
 * two copies of every message once git-sync converged. The cost of that choice
 * is honest eventual consistency: right after a relayed turn the replica's
 * GET /messages still serves its own (lagging) copy, so a phone that reloads
 * inside the sync window can briefly miss the just-finished turn. The live SSE
 * stream carries it, so this is only visible on a hard reload.
 *
 * A conversation created ON the replica is not in the primary's index yet. That
 * is fine: the primary writes the conversation FILE (readStore mints a fresh
 * store) and `touchConversation` no-ops on the missing index row; the row
 * itself arrives from the replica by git-sync (last-writer-wins on _index.json).
 *
 * ── Image attachments: bytes take the image lane, the RPC carries paths ──────
 *
 * An image turn relays too, but its bytes NEVER enter the control RPC: base64 in
 * a 45s RPC is exactly the oversized-frame failure mode that closes the shared
 * bridge socket (1009) and kills every in-flight request with it. Instead the
 * replica stages each picture on the primary through the narrow, already-
 * allowlisted `image.save` daemon command — the same lane a phone's SESSION
 * attachment uses — and puts only the returned host PATHS in the RPC payload
 * (~60 bytes each). The primary adopts those staged files into its own image
 * store and runs its ordinary image orchestration from there.
 *
 * ── Degradation: never "no engine" ───────────────────────────────────────────
 *
 * Bridge down, primary's server down, old primary, relay error, or ANY image
 * that could not be staged (too large for `image.save`, a daemon predating it,
 * a save error) all fall back to the replica's in-process loop and mark the
 * terminal frame `engine: 'walnut-agent-fallback'`. That field is additive; a
 * client that ignores it behaves exactly as before.
 *
 * Image failures are all-or-nothing on purpose: a turn that answered a picture
 * question from a partially-staged attachment set would be confidently wrong,
 * which is worse than the honest degraded answer the local loop gives (it still
 * has every image, on its own disk).
 */

import { CLOUD_MODE } from '../../constants.js'
import { emitSse as emitChannelSse } from '../sse-channels.js'
import { fitsImageSaveLimits, maxImagesPerMessage, type ImagePayload } from './images.js'
import { log } from '../../logging/index.js'

/** Box-level relay actions carry no real session id (same as routines/files). */
const SERVER_RELAY_SID = '__server__'

/** The `mobile-event` kind carrying one chat-turn SSE frame. */
export const CHAT_TURN_FRAME_KIND = 'chat-turn-frame'

/**
 * SSE event names a relayed turn may produce. Everything the frozen v1 chat
 * contract defines for a turn, and nothing else — this is the injection gate on
 * the replica, so keep it exhaustive and closed.
 */
const RELAYABLE_EVENTS = new Set([
  'queued', 'message-start', 'text-delta', 'thinking', 'tool', 'tool-result',
  'message-end', 'error',
])

/** Frames that END a turn — they settle the replica's in-flight bookkeeping. */
const TERMINAL_EVENTS = new Set(['message-end', 'error'])

/**
 * Liveness-only frame: rearms the replica's watchdog and is NEVER fanned out.
 *
 * It exists because a relayed turn can legitimately emit nothing for a long
 * time: `runApiV1Turn` goes through the per-agent queue (concurrency 1, shared
 * with the web console's WS chat and cron), so the turn can sit QUEUED for
 * minutes before its first frame, and a single long tool call is silent too.
 * Without a keepalive the watchdog would report a healthy turn as dead.
 */
const KEEPALIVE_EVENT = '__keepalive'

/** Keepalive cadence on the primary — well inside RELAY_FRAME_SILENCE_MS. */
const KEEPALIVE_INTERVAL_MS = 60_000

/** Engine label stamped on a terminal frame when the relay could not be used. */
export const FALLBACK_ENGINE_LABEL = 'walnut-agent-fallback'

/**
 * No-frame watchdog on the replica. The primary always ends a turn with a
 * terminal frame, so this only fires when the primary or the bridge vanished
 * mid-turn. Without it the phone's composer would stay locked forever.
 * Generous on purpose: a single tool call can legitimately run for minutes
 * without emitting text.
 */
const RELAY_FRAME_SILENCE_MS = 300_000

/** Accept-only uplink budget: the primary answers in milliseconds. */
const RELAY_ACCEPT_TIMEOUT_MS = 30_000

/** The primary's daemon, which owns the image staging lane. Same alias the
 *  control relay targets — the primary's server is the box running the turn. */
const PRIMARY_BRIDGE_ALIAS = '__local__'

/** One `image.save` round trip: up to ~14MB of base64 over the bridge WS. Same
 *  budget the session-send image lane uses (session-stream-v1.ts). */
const IMAGE_STAGE_TIMEOUT_MS = 30_000

// ─── Replica side: uplink + in-flight bookkeeping ───────────────────────────

interface InFlightRelay {
  turnId: string
  /** Engine the PRIMARY reported it would run this turn on (telemetry only). */
  engine: string
  timer: ReturnType<typeof setTimeout>
  /** Resolved on the terminal frame (or the watchdog) — see awaitRelayedTurn. */
  settle: () => void
}

/** Relayed turns this replica is waiting on downlink frames for. */
const inFlight = new Map<string, InFlightRelay>()

export type RelayStartOutcome =
  /** The primary took the turn; frames will arrive on the downlink. */
  | { kind: 'accepted'; engine: string; settled: Promise<void> }
  /** The primary already has a turn running on this conversation. */
  | { kind: 'turn_active'; message: string }
  /** Relay unusable — the caller must run the turn locally instead. */
  | { kind: 'unavailable'; reason: string }

/**
 * Stage one turn's images on the PRIMARY through the daemon's narrow
 * `image.save` command, returning the host paths to put in the RPC payload.
 *
 * All-or-nothing: any refusal (oversized, unsupported mediaType, a daemon
 * predating `image.save`, a host write error, bridge down) returns null and the
 * caller degrades the WHOLE turn to the local loop. Partial staging is never
 * reported as success — see the header note on why a half-attached picture set
 * is worse than an honest fallback.
 */
async function stageImagesOnPrimary(
  rawImages: ImagePayload[],
  conversationId: string,
  turnId: string,
): Promise<string[] | null> {
  // Count cap first — cheap, and the REST route already clamps to the same
  // number, so a longer list means a caller that bypassed it.
  if (rawImages.length > maxImagesPerMessage()) {
    log.web.info('chat-turn relay: too many images to stage — falling back', {
      conversationId, turnId, count: rawImages.length,
    })
    return null
  }

  // Compress BEFORE measuring and before the wire: a raw phone screenshot is
  // several MB of base64 on the socket every other RPC shares, and the daemon
  // would refuse anything over its cap outright. Same clamp the primary applies
  // to a locally-attached image, just done here so the bytes that travel are the
  // bytes that get stored.
  let images: ImagePayload[]
  try {
    const { compressImagesInMemory } = await import('./images.js')
    images = await compressImagesInMemory(rawImages)
  } catch (err) {
    log.web.info('chat-turn relay: image compression failed — falling back', {
      conversationId, turnId, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const oversized = images.find((img) => !fitsImageSaveLimits(img.data))
  if (oversized) {
    // compressForApi gives up rather than throwing on formats sharp can't read
    // (or a GIF that stays huge), so a post-compression check is still needed.
    log.web.info('chat-turn relay: an image exceeds the image.save limits — falling back', {
      conversationId, turnId, base64Length: oversized.data.length,
    })
    return null
  }

  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  const paths: string[] = []
  for (const img of images) {
    let saved: Record<string, unknown>
    try {
      saved = await bridgeRequest(
        PRIMARY_BRIDGE_ALIAS,
        'image.save',
        { data: img.data, mediaType: img.mediaType },
        IMAGE_STAGE_TIMEOUT_MS,
      )
    } catch (err) {
      // Bridge offline / request timeout. Nothing to clean up: the daemon stages
      // into its own /tmp dir, and an orphaned staged file is only a few
      // kilobytes on a path that gets reaped with the rest of the daemon tree.
      log.web.info('chat-turn relay: image staging transport failed — falling back', {
        conversationId, turnId, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    if (saved.ok === true && typeof saved.path === 'string') {
      paths.push(saved.path)
      continue
    }
    log.web.info('chat-turn relay: the primary refused an image — falling back', {
      conversationId, turnId, reason: String(saved.error ?? 'unknown'),
    })
    return null
  }
  log.web.info('chat-turn relay: images staged on the primary', {
    conversationId, turnId, count: paths.length,
  })
  return paths
}

/**
 * Ask the primary to run one chat turn. Never throws: every failure comes back
 * as `unavailable` so the caller can fall back to the in-process loop.
 *
 * Resolves as soon as the primary ACCEPTS. `settled` resolves later, when the
 * turn's terminal frame arrives (or the watchdog fires) — await it to hold a
 * per-conversation turn guard for the turn's real duration.
 *
 * `images` (optional) are staged on the primary FIRST and travel as host paths;
 * their bytes never enter the control RPC. A staging failure degrades the whole
 * turn (`unavailable`) rather than relaying a text-only version of it.
 */
export async function relayChatTurnToPrimary(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
  images: ImagePayload[] = [],
): Promise<RelayStartOutcome> {
  if (!CLOUD_MODE) return { kind: 'unavailable', reason: 'not a cloud replica' }
  if (inFlight.has(conversationId)) {
    return { kind: 'turn_active', message: 'A relayed turn is already active on this conversation' }
  }

  // Staging runs BEFORE the in-flight registration: it is plain I/O with no
  // downlink frames to lose, and a fallback here must leave no bookkeeping
  // behind (the local loop will run this same turnId).
  let imagePaths: string[] = []
  if (images.length > 0) {
    const staged = await stageImagesOnPrimary(images, conversationId, turnId)
    if (staged === null) {
      return { kind: 'unavailable', reason: 'image staging on the primary failed' }
    }
    imagePaths = staged
  }

  // Register BEFORE the RPC, not after the accept. The primary arms its frame
  // mirror before starting the turn, so its first frame ('queued'/
  // 'message-start') can be in the air while we are still awaiting the accept
  // reply — and handleBridgeChatTurnFrame drops frames for conversations it
  // isn't tracking. Registering first makes that window impossible; the entry
  // is removed again on every failure path below. `engine` is provisional until
  // the accept reply names it.
  let settleFn: () => void = () => {}
  const settled = new Promise<void>((resolve) => { settleFn = resolve })
  const timer = setTimeout(() => onRelaySilence(conversationId, turnId), RELAY_FRAME_SILENCE_MS)
  timer.unref?.()
  const entry: InFlightRelay = { turnId, engine: 'unknown', timer, settle: settleFn }
  inFlight.set(conversationId, entry)

  let outcome: { ok: true; result: Record<string, unknown> } | { ok: false; failure: { kind: string; message: string } }
  try {
    const { callPrimaryControl } = await import('./v1-control-relay.js')
    outcome = await callPrimaryControl(
      'server.chat.turn' as never,
      SERVER_RELAY_SID,
      {
        agentId, conversationId, text, turnId,
        // Omitted entirely for a text turn, so the payload an OLD primary sees
        // is byte-identical to the pre-image one.
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      },
      RELAY_ACCEPT_TIMEOUT_MS,
    )
  } catch (err) {
    // The relay module itself failed to load / dispatch. Degrade, never throw.
    clearInFlight(conversationId, turnId)
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }

  if (!outcome.ok) {
    clearInFlight(conversationId, turnId)
    log.web.info('chat-turn relay unavailable — falling back to the in-process loop', {
      conversationId, turnId, agentId, failureKind: outcome.failure.kind, reason: outcome.failure.message,
    })
    return { kind: 'unavailable', reason: `${outcome.failure.kind}: ${outcome.failure.message}` }
  }

  const result = outcome.result
  if (result.accepted !== true) {
    clearInFlight(conversationId, turnId)
    // The primary answered but refused. 'turn_active' is a real 409 for the
    // phone; anything else is safer treated as "relay can't serve this turn".
    if (result.reason === 'turn_active') {
      return { kind: 'turn_active', message: String(result.message ?? 'A turn is already active on this conversation') }
    }
    return { kind: 'unavailable', reason: String(result.reason ?? result.message ?? 'primary refused the turn') }
  }

  const engine = typeof result.engine === 'string' && result.engine ? result.engine : 'unknown'
  // A terminal frame can already have settled (and removed) this entry on a very
  // fast turn — only stamp the engine while the entry is still ours.
  if (inFlight.get(conversationId) === entry) entry.engine = engine

  log.web.info('chat-turn relayed to the primary', { conversationId, turnId, agentId, engine })
  return { kind: 'accepted', engine, settled }
}

/** Watchdog: the primary went silent mid-turn — unlock the phone's composer. */
function onRelaySilence(conversationId: string, turnId: string): void {
  const entry = inFlight.get(conversationId)
  if (!entry || entry.turnId !== turnId) return
  log.web.error('chat-turn relay went silent — reporting a turn error', {
    conversationId, turnId, silenceMs: RELAY_FRAME_SILENCE_MS,
  })
  clearInFlight(conversationId, turnId)
  emitChannelSse(conversationId, 'error', {
    message: 'The primary box stopped responding during this turn — the answer may still be in its history.',
  })
}

function rearmWatchdog(conversationId: string, entry: InFlightRelay): void {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => onRelaySilence(conversationId, entry.turnId), RELAY_FRAME_SILENCE_MS)
  entry.timer.unref?.()
}

function clearInFlight(conversationId: string, turnId: string): void {
  const entry = inFlight.get(conversationId)
  if (!entry || entry.turnId !== turnId) return
  clearTimeout(entry.timer)
  inFlight.delete(conversationId)
  entry.settle()
}

/**
 * Replica: one downlink frame arrived. Validates it, resets the watchdog, and
 * fans it out on the conversation's SSE channel — the exact channel and the
 * exact `reset`-on-message-start semantics the local path uses (api-v1.ts).
 *
 * Frames for a conversation this replica is not tracking are DROPPED: they are
 * either a turn started from the web console on the Mac (which no phone here
 * asked for) or a late frame from a turn we already gave up on.
 */
export function handleBridgeChatTurnFrame(data: unknown): void {
  const d = (data ?? {}) as {
    conversationId?: unknown; turnId?: unknown; event?: unknown; data?: unknown
  }
  const conversationId = typeof d.conversationId === 'string' ? d.conversationId : ''
  const turnId = typeof d.turnId === 'string' ? d.turnId : ''
  const event = typeof d.event === 'string' ? d.event : ''
  if (!conversationId || !event) return
  if (event !== KEEPALIVE_EVENT && !RELAYABLE_EVENTS.has(event)) return

  const entry = inFlight.get(conversationId)
  if (!entry || (turnId && entry.turnId !== turnId)) return

  if (event === KEEPALIVE_EVENT) {
    // Proof of life for a turn that is queued or inside a long tool call.
    // Never fanned out — it is not part of the frozen v1 SSE contract.
    rearmWatchdog(conversationId, entry)
    return
  }

  let payload = d.data
  if (TERMINAL_EVENTS.has(event)) {
    // Stamp the engine that actually answered (additive; old clients ignore it).
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload = { ...(payload as Record<string, unknown>), engine: entry.engine }
    }
  } else {
    // Any non-terminal frame proves the primary is alive — rearm the watchdog.
    rearmWatchdog(conversationId, entry)
  }

  emitChannelSse(conversationId, event, payload ?? {}, { reset: event === 'message-start' })

  if (TERMINAL_EVENTS.has(event)) clearInFlight(conversationId, entry.turnId)
}

/** Tests / shutdown: drop all relay bookkeeping. */
export function resetChatTurnRelayState(): void {
  for (const [conversationId, entry] of [...inFlight]) {
    clearTimeout(entry.timer)
    inFlight.delete(conversationId)
    entry.settle()
  }
  primaryTurns.clear()
  recentTurnIds.clear()
  mirroring.clear()
}

// ─── Primary side: accept a relayed turn, mirror its frames downlink ─────────

/** Conversations with a relayed turn running here right now. */
const primaryTurns = new Map<string, string>()

/**
 * Recently accepted turnIds, so a replayed relay (lost accept reply, phone
 * retry) cannot run the same turn twice. Bounded FIFO — a chat turn is minutes
 * at most, and a duplicate that old is not a retry.
 */
const recentTurnIds = new Set<string>()
const RECENT_TURN_MAX = 200

function rememberTurnId(turnId: string): void {
  recentTurnIds.add(turnId)
  if (recentTurnIds.size > RECENT_TURN_MAX) {
    const oldest = recentTurnIds.values().next().value
    if (oldest !== undefined) recentTurnIds.delete(oldest)
  }
}

/** conversationId → turnId for turns whose SSE frames must be mirrored down. */
const mirroring = new Map<string, string>()

/**
 * Primary: mirror one local SSE frame down the bridge lane, for conversations
 * whose turn was relayed from the cloud. A no-op (one Map lookup) for every
 * ordinary turn, so this is safe to call from the hot emit path.
 */
export function mirrorRelayedChatFrame(conversationId: string, event: string, data: unknown): void {
  const turnId = mirroring.get(conversationId)
  if (turnId === undefined) return
  if (event !== KEEPALIVE_EVENT && !RELAYABLE_EVENTS.has(event)) return
  void (async () => {
    try {
      const { forwardMobileEventToBridge } = await import('./events-v1.js')
      await forwardMobileEventToBridge(CHAT_TURN_FRAME_KIND, { conversationId, turnId, event, data })
    } catch (err) {
      // Best-effort by design: a dropped delta costs a repaint, and the answer
      // is persisted here regardless. The replica's watchdog covers a total
      // downlink loss.
      log.web.debug('chat-turn frame mirror failed', {
        conversationId, turnId, event, error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

/**
 * What the ordinary turn path needs to run an image turn — the exact shape
 * `processAndSaveImages` returns, so a relayed turn is indistinguishable from a
 * locally-attached one downstream.
 */
type RelayedImageData = {
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
  imageContentBlocks: unknown[] | null
}

export interface PrimaryChatTurnOutcome {
  accepted: boolean
  turnId: string
  /** Engine this box will actually run the turn on ('claude-code'|'walnut-agent'). */
  engine?: string
  reason?: string
  message?: string
  /** True when the turnId was already accepted — idempotent replay, not an error. */
  duplicate?: boolean
}

/**
 * Primary: accept ONE relayed chat turn (`session.control` action
 * 'server.chat.turn'). Starts the turn and returns immediately — the daemon's
 * 45s relay budget cannot cover a real turn, and the answer rides the downlink.
 *
 * Deliberately runs the ORDINARY `runApiV1Turn`: it resolves this box's own
 * `agent.provider` (so a claude-code Mac answers on the lane engine, which is
 * the entire point), owns persistence, and owns the SSE contract. There is no
 * second turn implementation to keep in sync.
 *
 * `imagePaths` (optional) name files the replica staged on THIS box through the
 * daemon's `image.save`. They are adopted (validated → re-compressed → saved
 * into this box's own image store) BEFORE the accept, so a bad or vanished
 * attachment is a REFUSAL the replica can still fall back from, never a turn
 * that silently answers a picture question without the picture.
 */
export async function handlePrimaryChatTurnRelay(
  params: Record<string, unknown>,
): Promise<PrimaryChatTurnOutcome> {
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : 'general'
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : ''
  const text = typeof params.text === 'string' ? params.text : ''
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  const imagePaths = Array.isArray(params.imagePaths) ? params.imagePaths : []

  if (!conversationId || !turnId) {
    return { accepted: false, turnId, reason: 'bad_request', message: 'conversationId and turnId are required' }
  }
  // Same rule as the REST route: an image-bearing turn may carry empty text
  // ("what is this?" is the picture itself). Text-only still requires text.
  if (text.trim().length === 0 && imagePaths.length === 0) {
    return { accepted: false, turnId, reason: 'bad_request', message: 'text (non-empty string) is required' }
  }
  if (recentTurnIds.has(turnId)) {
    // Idempotent replay: the turn is already running (or finished) here. Report
    // accepted so the replica keeps waiting for frames instead of double-sending.
    log.web.info('chat-turn relay replay deduped', { conversationId, turnId, agentId })
    return { accepted: true, turnId, duplicate: true, engine: await resolvePrimaryEngineLabel() }
  }
  if (primaryTurns.has(conversationId)) {
    return {
      accepted: false, turnId, reason: 'turn_active',
      message: 'A turn is already active on this conversation',
    }
  }

  // Adopt the staged pictures before committing to the turn. Deliberately ahead
  // of rememberTurnId: a refusal must leave this box exactly as it was, so the
  // replica's local-loop fallback runs the same turnId without tripping the
  // duplicate guard on a later retry.
  let imageData: RelayedImageData | undefined
  if (imagePaths.length > 0) {
    const { adoptRelayedImagePaths } = await import('./images.js')
    const adopted = await adoptRelayedImagePaths(imagePaths)
    if (!adopted) {
      log.web.warn('chat-turn relay refused — staged images unusable', {
        conversationId, turnId, agentId, count: imagePaths.length,
      })
      return {
        accepted: false, turnId, reason: 'images_unavailable',
        message: 'The relayed image attachments could not be read on this box',
      }
    }
    imageData = adopted
  }

  // Materialize the index row for a replica-created conversation NOW, on this
  // box, instead of waiting for git-sync to deliver it. The old "the row
  // arrives by git-sync LWW" plan lost the row whenever both boxes touched
  // _index.json inside one sync window (whole-file LWW keeps ONE side) — the
  // conversation file survived everywhere but every list/read 404'd. With the
  // row written here too, both sides of any index merge carry it.
  const { ensureConversationRow } = await import('../../core/conversations.js')
  await ensureConversationRow(agentId, conversationId, text)

  const engine = await resolvePrimaryEngineLabel()
  rememberTurnId(turnId)
  primaryTurns.set(conversationId, turnId)
  // Arm the mirror BEFORE the turn starts so its very first frame
  // ('queued'/'message-start') is forwarded, not lost to a late registration.
  mirroring.set(conversationId, turnId)

  log.web.info('chat-turn relay accepted from the cloud replica', {
    conversationId, turnId, agentId, engine, messageLength: text.length,
    imageCount: imageData?.savedImages.length ?? 0,
  })

  // Proof-of-life while the turn produces no frames of its own: it can sit in
  // the per-agent queue behind another turn for minutes, and a single long tool
  // call is silent too — either would trip the replica's watchdog.
  const keepalive = setInterval(() => {
    mirrorRelayedChatFrame(conversationId, KEEPALIVE_EVENT, null)
  }, KEEPALIVE_INTERVAL_MS)
  keepalive.unref?.()

  void (async () => {
    try {
      const { runRelayedApiV1Turn } = await import('./api-v1.js')
      await runRelayedApiV1Turn(agentId, conversationId, text, turnId, imageData)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.web.error('relayed chat turn failed on the primary', { conversationId, turnId, agentId, error: message })
      // runApiV1Turn persists+emits its own errors; this covers a throw BEFORE
      // any frame was emitted, which would otherwise leave the phone hanging
      // until its watchdog. Emitted through the mirror while it is still armed.
      mirrorRelayedChatFrame(conversationId, 'error', { message })
    } finally {
      clearInterval(keepalive)
      if (mirroring.get(conversationId) === turnId) mirroring.delete(conversationId)
      if (primaryTurns.get(conversationId) === turnId) primaryTurns.delete(conversationId)
    }
  })()

  return { accepted: true, turnId, engine }
}

/**
 * Primary: answer "which engine will answer this conversation, and on what lane
 * session" for a REPLICA (`session.control` action 'server.chat.engine').
 *
 * The companion to handlePrimaryChatTurnRelay. A relayed turn runs HERE, so the
 * engine and the switchable model are facts about THIS box — a replica answering
 * from its own config reported `in-process` with its own `main_model`, which was
 * true of a fallback turn that almost never happens and false of every relayed
 * turn that does. The phone's model pill was therefore either wrong or (with no
 * `main_model` on the replica) absent entirely.
 *
 * `ensure: true` mints the lane. Deliberately a PARAMETER rather than always-on:
 * the read side is used by a poll, and a poll must never spawn a CLI.
 */
export async function handlePrimaryChatEngineRelay(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : 'general'
  const ensure = params.ensure === true
  const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
  const config = await getConfig()
  if (resolveAgentEngineProvider(config) !== 'claude-code') {
    return {
      engine: 'in-process',
      sessionId: null,
      ...(config.agent?.main_model ? { model: config.agent.main_model } : {}),
    }
  }

  // Resolve the conversation on THIS box: a replica may pass an explicit id, or
  // none at all (its "active conversation" is its own bookkeeping, not ours).
  const { getActiveConversationId } = await import('../../core/conversations.js')
  const conversationId = typeof params.conversationId === 'string' && params.conversationId
    ? params.conversationId
    : await getActiveConversationId(agentId)

  const { getSessionByLane, getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const { personalAiLaneKey } = await import('../../core/sessions/personal-ai-lane.js')
  let record = await getSessionByLane(personalAiLaneKey(agentId, conversationId))
  if (!record && ensure) {
    const { getOrCreateLaneSession } = await import('../../core/sessions/personal-ai-lane.js')
    const lane = await getOrCreateLaneSession(agentId, conversationId)
    record = await getSessionByClaudeId(lane.sessionId)
    log.web.info('chat-engine relay minted the lane for a replica', {
      agentId, conversationId, sessionId: lane.sessionId, created: lane.created,
    })
  }
  return {
    engine: 'lane',
    sessionId: record?.claudeSessionId ?? null,
    ...(record?.cwd ? { cwd: record.cwd } : {}),
    // '' on the record means this box, matching ProjectedSession.host.
    ...(record ? { host: record.host ?? '' } : {}),
  }
}

/** This box's configured chat engine, for the accept reply's telemetry. */
async function resolvePrimaryEngineLabel(): Promise<string> {
  try {
    const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
    return resolveAgentEngineProvider(await getConfig())
  } catch {
    return 'unknown'
  }
}
