/**
 * /api/v1 session launch endpoints (additive) — create a NEW Claude Code
 * session from mobile, with the same host/path semantics as the web Quick
 * Start launcher.
 *
 *   GET  /sessions/launch-options → { hosts, dirs } — where can a session run
 *        (the primary box + every enabled config.hosts entry) and which paths
 *        the user launches from (frequent-dirs store, same source + scoring
 *        as the web launcher's suggestions).
 *   POST /sessions { cwd, host?, message?, taskId?, model?, mode? }
 *        → 201 { sessionId, taskId, title }
 *
 * Creation reuses quickStartSession() — the exact task-create/reuse →
 * SESSION_START → session-runner chain the web launcher uses — so a mobile
 * launch spawns the CLI locally or via the chosen host's SSH daemon with
 * identical semantics. `taskId` links the new session to an existing task
 * (retry-mode: archives that task's error/stopped sessions to free the slot).
 * Validation + creation live in core/sessions/mobile-launch.ts (shared with
 * the bridge relay below).
 *
 * 201 means ACCEPTED, not spawned: quickStartSession returns right after the
 * SESSION_START bus emit; the CLI spawn is async in session-runner. A bad
 * remote host or a cwd typo surfaces as session `error` status later, not as
 * an HTTP failure here — the record is pre-seeded so the returned sessionId
 * immediately resolves on the transcript/stream/messages endpoints.
 *
 * Cloud companion (REPLICA): the session RECORD lives on the primary box, so
 * both endpoints RELAY through the primary's daemon bridge — the narrow
 * `session.launch` command (allowlisted in the daemon twins) forwards the
 * request as a `launch-request` event to the daemon's connected walnut
 * server, which runs the exact same mobile-launch core and replies. Failure
 * ladder mirrors image.save: pre-session.launch daemon → 400
 * session_launch_needs_upgrade (self-heals on the next primary reconnect);
 * no live bridge / primary down → 503 bridge_offline; validation errors from
 * the primary surface verbatim with their original 4xx code. A *momentary*
 * missing bridge is waited out and retried once instead (only that one error
 * proves the primary never saw the request), while a longer outage answers
 * immediately and says how long the primary has been gone — see
 * relayLaunchAction.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import {
  computeLaunchOptions,
  launchErrorCode,
  performMobileLaunch,
  validateMobileLaunchBody,
} from '../../core/sessions/mobile-launch.js'
import { QuickStartError } from '../../core/sessions/quick-start.js'
import { log } from '../../logging/index.js'

export const sessionLaunchV1Router = Router()

// Same frozen error shape as api-v1.ts / session-stream-v1.ts.
function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

// ── Cloud relay: phone → cloud → bridge(__local__) → daemon → primary ───────
//
// The bridge hop always targets the PRIMARY's daemon ('__local__') regardless
// of which host the SESSION will run on — the primary's server handles the
// host exactly like a local request (SESSION_START → session-runner → that
// host's daemon).

const PRIMARY_BRIDGE_ALIAS = '__local__'
// Launch does task-store writes + bus emits on the primary; give it headroom
// over the 15s bridge default. Options is a pair of file reads — default is fine.
const LAUNCH_RELAY_TIMEOUT_MS = 30_000
/**
 * How long a relay waits out a MISSING bridge before it gives up. Sized from
 * the link's measured behavior: a routine bridge teardown re-registers in 1–3s
 * (the daemon's own redial loop), so 8s covers several redial attempts while
 * staying far inside the phone's 30s request timeout — a POST that dies on that
 * timeout is deliberately NOT auto-retried client-side, so overrunning it would
 * turn a momentary flap into a launch the user has to notice and repeat.
 * Spent ONLY on a FRESH loss (see BRIDGE_FLAP_FRESHNESS_MS): a host that has
 * been asleep for minutes gets an instant, specific 503 instead.
 */
const BRIDGE_RECONNECT_WAIT_MS = 8_000
/**
 * How RECENT the primary's bridge loss has to be for waiting to be worth it.
 *
 * A fresh loss means a flap: the daemon is mid-redial and one bounded wait
 * usually turns into a real 201. A stale loss (or a loss this box never saw)
 * means the primary is asleep or powered off, and spending the budget there only
 * adds 8s of latency before the identical "no" — a budget you spend when you
 * already know the answer is not a budget. So the wait is CONDITIONAL. Do not
 * "simplify" this back into an unconditional wait.
 *
 * 30s is where the two measured populations separate cleanly: 9 of 11 observed
 * bridge holes were 0–3s (routine teardown + redial), and the 2 long ones were
 * 24.7 and 19.0 minutes, both caused by the host sleeping (lid shut, deep sleep
 * with ~45s dark-wake windows).
 */
const BRIDGE_FLAP_FRESHNESS_MS = 30_000

/**
 * Buffer a relay's `res.status().json()` instead of sending it, so the cloud box
 * can merge its own data into the primary's answer (or discard it and answer
 * differently) before a single byte is written.
 *
 * Needed because relayLaunchAction writes the response itself — it is the shared
 * failure ladder and must stay that way. `flush()` replays whatever it buffered
 * onto the real response, which is how the honest 503 still reaches the client
 * when there is nothing better to say.
 */
function captureJson(real: Response): {
  res: Response
  status: () => number
  body: () => unknown
  flush: () => void
} {
  let status = 200
  let body: unknown
  const fake = {
    status(code: number) { status = code; return fake },
    json(payload: unknown) { body = payload; return fake },
  } as unknown as Response
  return {
    res: fake,
    status: () => status,
    body: () => body,
    flush: () => { if (!real.headersSent) real.status(status).json(body) },
  }
}

/** `3` → `3 seconds`, `1` → `1 minute`. */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/**
 * Coarse, phone-readable elapsed time. Null when there is nothing worth saying
 * (a sub-second value, or a clock that ran backwards) — a wrong duration is
 * worse than none.
 */
function humanizeElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1_000) return null
  const secs = Math.round(ms / 1_000)
  if (secs < 60) return plural(secs, 'second')
  const mins = Math.round(secs / 60)
  if (mins < 60) return plural(mins, 'minute')
  return plural(Math.round(mins / 60), 'hour')
}

/**
 * The 503 body when the primary's bridge is not there. The code is frozen
 * (`bridge_offline`); this is only the human sentence, and it is the whole point
 * of the change: the 2026-09-17 report was a MacBook asleep with the lid shut,
 * unreachable in 8-to-15-minute stretches, and "try again when it reconnects"
 * reads identically to a 2-second redial hole. With a known duration the user can
 * tell the two apart and act ("open the lid"); without one we stay vague rather
 * than invent a number. `waitedMs` is 0 when no wait happened, because claiming
 * a wait we did not do is the same kind of lie in the other direction.
 *
 * Plain sentences, no dashes: this string is read on a phone.
 */
function bridgeOfflineMessage(lastLossAt: number | null, waitedMs: number): string {
  const downFor = lastLossAt === null ? null : humanizeElapsed(Date.now() - lastLossAt)
  const waited = waitedMs > 0 ? ` Waited ${Math.round(waitedMs / 1000)}s for it to reconnect.` : ''
  if (!downFor) {
    return `No live bridge to the primary box. Your primary box (Mac) is asleep or offline.${waited}`
  }
  return `Your primary box (Mac) has been unreachable for ${downFor}. `
    + `It may be asleep (open the lid) or offline.${waited}`
}

/** errorKind from the relay reply → frozen v1 HTTP status. */
function relayErrorStatus(errorKind: string): number {
  if (errorKind === 'not_found') return 404
  if (errorKind === 'conflict') return 409
  if (errorKind === 'internal') return 500
  return 400
}

/**
 * Drive one launch-relay action over the bridge and translate the reply into
 * the frozen v1 response. Never throws — every failure is a precise HTTP error.
 *
 * A missing bridge is NOT treated as a verdict: the link's common failure is a
 * 1–3s teardown/redial hole, and answering it with a hard 503 is what made
 * "my phone cannot create a session on a remote host" look absolute while sends
 * to a running session kept working (they bank the message instead — see the
 * FAST-ACCEPT note in session-stream-v1.ts). So a FRESH hole is waited out once
 * and re-sent, while a link that has been gone longer than the flap window gets
 * an immediate, specific answer instead of 8s of pointless latency. See
 * BRIDGE_RECONNECT_WAIT_MS and BRIDGE_FLAP_FRESHNESS_MS.
 */
async function relayLaunchAction(
  res: Response,
  action: 'options' | 'launch',
  params: Record<string, unknown> | undefined,
  successStatus: number,
): Promise<void> {
  const registry = await import('../ws/bridge-registry.js')
  const { bridgeRequest, BridgeOfflineError } = registry
  const sendRelay = (): Promise<Record<string, unknown>> => bridgeRequest(
    PRIMARY_BRIDGE_ALIAS,
    'session.launch',
    { action, ...(params !== undefined ? { params } : {}) },
    action === 'launch' ? LAUNCH_RELAY_TIMEOUT_MS : undefined,
  )
  let reply: Record<string, unknown>
  try {
    reply = await sendRelay()
  } catch (err) {
    // RETRY ONLY ON BridgeOfflineError, and only once. That error is raised
    // before any byte reaches a socket — there was no socket — so the primary
    // provably never saw this request and re-sending it cannot create a second
    // session or a second task. EVERY other failure (a relay timeout, a send
    // that threw mid-flight, a settled non-ok reply) may already have executed
    // the launch on the primary, so it must stay a single attempt. Same
    // reasoning as `canFallback` in session-stream-v1.ts's cloudSend().
    if (!(err instanceof BridgeOfflineError)) {
      sendError(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
      return
    }
    // How long the link has been gone decides BOTH whether waiting is worth it
    // and what the 503 says. Never lets the request fail differently: a registry
    // that cannot answer is treated as "duration unknown". Same rule as the wait.
    let lastLossAt: number | null = null
    try {
      lastLossAt = registry.lastBridgeLossAt(PRIMARY_BRIDGE_ALIAS)
    } catch { /* no duration to report */ }
    // Fresh loss = a flap, worth one bounded wait (the daemon is mid-redial).
    // Stale or unknown loss = the box is asleep or off, and the honest answer is
    // instant: see BRIDGE_FLAP_FRESHNESS_MS for why this is not unconditional.
    const midRedial = lastLossAt !== null && Date.now() - lastLossAt <= BRIDGE_FLAP_FRESHNESS_MS
    let reconnected = false
    if (midRedial) {
      try {
        reconnected = await registry.waitForBridge(PRIMARY_BRIDGE_ALIAS, BRIDGE_RECONNECT_WAIT_MS)
      } catch {
        // A wait we could not perform is not a different outcome: treat it as
        // "the link never came back" and fall through to the honest 503.
        reconnected = false
      }
    }
    if (!reconnected) {
      // Logged so an outage can be told apart from a flap after the fact: the
      // 2026-09-17 diagnosis had to be reconstructed from daemon heartbeat gaps.
      log.web.info('launch relay: primary bridge unavailable', {
        action, waited: midRedial,
        downForMs: lastLossAt === null ? null : Date.now() - lastLossAt,
      })
      sendError(res, 503, 'bridge_offline',
        bridgeOfflineMessage(lastLossAt, midRedial ? BRIDGE_RECONNECT_WAIT_MS : 0))
      return
    }
    log.web.info('launch relay: bridge came back, retrying once', { action })
    try {
      reply = await sendRelay()
    } catch (retryErr) {
      // The link was there a moment ago and is already gone: that is an outage,
      // not a flap, so it gets an answer rather than a second wait.
      sendError(res, 503, 'bridge_offline', retryErr instanceof BridgeOfflineError
        ? 'The primary box\'s bridge reconnected and dropped again before the request landed'
        : retryErr instanceof Error ? retryErr.message : String(retryErr))
      return
    }
  }
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    // Successful launch: seed the id→host mapping NOW. The other v1 session
    // endpoints resolve hosts from the git-synced projection, which lags a
    // launch by 1–3 minutes — without the seed the phone's very next
    // stream/transcript/send calls 404 on the session we just created
    // (2026-08-07 incident: every message "Not sent — tap to retry").
    if (action === 'launch') {
      const sessionId = (reply.result as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string' && sessionId) {
        const { seedLaunchedSession } = await import('../../core/sessions/launch-seed.js')
        const host = typeof params?.host === 'string' ? params.host : ''
        seedLaunchedSession(sessionId, {
          // Same alias mapping as the projection: '' = primary → '__local__'.
          host: host === '' ? '__local__' : host,
          ...(typeof params?.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(typeof params?.model === 'string' ? { model: params.model } : {}),
        })
      }
    }
    res.status(successStatus).json(reply.result)
    return
  }
  const reason = String(reply.error ?? 'unknown')
  // Pre-session.launch daemon: the allowlist rejection and the unknown-command
  // error both mean "this daemon predates launch relay" — it upgrades
  // automatically on the next primary-box reconnect, so tell the app that.
  if (reason.startsWith('unknown command') || reason.includes('not permitted over bridge')) {
    sendError(res, 400, 'session_launch_needs_upgrade',
      'The primary box\'s daemon predates mobile session launch — it upgrades automatically on the next reconnect')
    return
  }
  // "no primary server connected" = daemon alive but its walnut server is
  // down; record creation is impossible. Same user remedy as bridge-down.
  if (reason.includes('no primary server connected')) {
    sendError(res, 503, 'bridge_offline', 'Your primary box (Mac) is offline — it must be up to create sessions')
    return
  }
  const errorKind = typeof reply.errorKind === 'string' ? reply.errorKind : 'bad_request'
  sendError(res, relayErrorStatus(errorKind), errorKind, reason)
}

/**
 * The cloud companion's own host row, appended to whatever the primary said.
 * Only THIS box knows whether it is configured to execute (`cloud.exec`), so
 * the primary's relayed answer can never contain it.
 */
async function cloudExecEntry(): Promise<{ alias: string; label: string } | null> {
  try {
    const [{ cloudExecHostEntry }, { getConfig }] = await Promise.all([
      import('../../core/cloud-exec.js'),
      import('../../core/config-manager.js'),
    ])
    return cloudExecHostEntry(await getConfig(), CLOUD_MODE)
  } catch {
    return null
  }
}

// GET /api/v1/sessions/launch-options — hosts + suggested working dirs for
// the mobile New Session sheet (computed on the primary; relayed on cloud).
sessionLaunchV1Router.get('/sessions/launch-options', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      const entry = await cloudExecEntry()
      // Relay first (the Mac owns the host list + frequent dirs), then append
      // our own executable host. Capture the relay body instead of letting it
      // stream so the merge happens before anything is written.
      const captured = captureJson(res)
      await relayLaunchAction(captured.res, 'options', undefined, 200)
      const relayed = captured.body()
      if (captured.status() === 200 && relayed && typeof relayed === 'object') {
        const body = relayed as { hosts?: Array<{ alias: string; label: string }> }
        const hosts = Array.isArray(body.hosts) ? body.hosts : []
        res.status(200).json({
          ...body,
          hosts: entry && !hosts.some((h) => h.alias === entry.alias) ? [...hosts, entry] : hosts,
        })
        return
      }
      // Primary unreachable. Today this is a bare 503 and the phone shows "you
      // cannot start anything" with no reason and no alternative. If we can
      // execute, answer locally with OUR host + primaryOffline so the client can
      // ask "the Mac is offline — run on the cloud companion?". Deliberately NOT
      // a silent fallback: the user still picks the host.
      const { launchOptionsWhenPrimaryOffline } = await import('../../core/cloud-exec.js')
      const { getConfig } = await import('../../core/config-manager.js')
      const degraded = launchOptionsWhenPrimaryOffline(await getConfig(), CLOUD_MODE)
      if (degraded) {
        log.web.info('launch-options: primary offline, offering cloud exec host')
        res.status(200).json(degraded)
        return
      }
      captured.flush()
      return
    }
    res.json(await computeLaunchOptions())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions — create a session. Validates the body shape, then
// delegates to the shared mobile-launch core (directly on the primary;
// through the bridge relay on cloud). Returns 201 with the pre-assigned
// session id so the app can open the conversation view immediately (the
// record is pre-seeded before the spawn).
sessionLaunchV1Router.post('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Shape validation runs HERE on both boxes: on cloud it fast-fails junk
    // without a bridge round trip (the primary re-validates anyway — the
    // relay crosses a semi-trusted box, so its checks are the real gate).
    let input
    try {
      input = validateMobileLaunchBody(req.body)
    } catch (err) {
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }

    if (CLOUD_MODE) {
      // host === CLOUD_HOST_ALIAS is an EXPLICIT "run it on the companion".
      // Anything else (including absent/'') still means the primary box and is
      // relayed unchanged — a silent fallback to this box when the Mac is
      // offline would run work on the wrong machine, which is worse than the
      // honest 503 the relay already returns.
      const { resolveLaunchTarget, launchHostForCore } = await import('../../core/cloud-exec.js')
      const { getConfig } = await import('../../core/config-manager.js')
      const target = resolveLaunchTarget(input.host, input.cwd, await getConfig(), true)
      if (target.kind === 'refused') {
        sendError(res, 400, 'cloud_exec_unavailable', target.message)
        return
      }
      if (target.kind === 'run-here') {
        try {
          // The alias is an EDGE concept: handed to the core as undefined, the
          // existing local-spawn path takes over unchanged (quickStartSession →
          // SESSION_START → handleStart resolves no sshTarget →
          // createSessionManager routes to this box's daemon). No new branch in
          // the session core, so the generic local path cannot regress here.
          const result = await performMobileLaunch(
            { ...input, host: launchHostForCore(input.host) }, 'cloud-exec-launch',
          )
          // Seed id→host so this box's OWN subsequent stream/send/transcript
          // calls resolve to the cloud host instead of missing the (Mac-owned)
          // projection and 404ing — the 2026-08-07 failure shape, except here
          // the projection will NEVER carry the row, so the seed is load-bearing
          // beyond its TTL. cloudOwnedSession() below is the durable answer.
          if (result.sessionId) {
            const { seedLaunchedSession } = await import('../../core/sessions/launch-seed.js')
            const { CLOUD_HOST_ALIAS } = await import('../../core/cloud-exec.js')
            seedLaunchedSession(result.sessionId, { host: CLOUD_HOST_ALIAS, cwd: input.cwd })
          }
          log.web.info('cloud exec: session launched on the companion', {
            sessionId: result.sessionId, taskId: result.taskId, cwd: input.cwd,
          })
          res.status(201).json(result)
        } catch (err) {
          if (err instanceof QuickStartError) {
            sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
            return
          }
          throw err
        }
        return
      }
      await relayLaunchAction(res, 'launch', (req.body ?? {}) as Record<string, unknown>, 201)
      return
    }

    try {
      const result = await performMobileLaunch(input, 'mobile-launch')
      res.status(201).json(result)
    } catch (err) {
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
// Same form as apiV1Router's funnel: guard headersSent (a handler may fail
// after partially writing) and treat err as unknown.
sessionLaunchV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session launch error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
