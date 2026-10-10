/**
 * A session's controls on the cloud companion while it leads the session's host
 * (docs/plan/walnut-control-plane.md "Session controls while the Mac is away").
 * Cloud box only; while the Mac answers, the phone's call is the Mac's.
 *
 *   permission  answer the prompt the session waits on
 *   mode        change its permission mode (the host keeps it for the Mac)
 *   stop        the user stop the Mac's terminate sends
 *
 * The host's daemon applies each one (`leader.control`, 'leader-control-v1') at
 * the lead's epoch, for a session of that Walnut, the way `leader.settings`
 * applies a model (sessions/model-options-copy.ts). `target()` is null when the
 * companion does not lead the session's host, or the session is not Claude
 * Code's: the caller relays to the Mac as before.
 */

import type { ProjectedSession, SessionProjection } from '../session-projection.js'

export interface HostControlAnswer { status: number; body: Record<string, unknown> }

export interface LeadHost {
  row: ProjectedSession
  /** When the Mac exported the copy the row came from. */
  asOf: string
  /** The bridge alias of the session's host. */
  host: string
  lead: { walnutId: string; epoch: number }
}

export interface HostControlDeps {
  projection: () => Promise<SessionProjection | null>
  /** The lead this companion holds on a host now, if any. */
  leadFor: (host: string) => Promise<{ walnutId: string; epoch: number } | null>
  request: (host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>
  /** The lead was refused as stale: let it go (backup-leader lostHost). */
  lostHost?: (host: string, why: string) => void
}

const CONTROL_TIMEOUT_MS = 20_000

function answer(status: number, code: string, message: string): HostControlAnswer {
  return { status, body: { error: { code, message } } }
}

/** How a host's refusal reads to the phone: the Mac's own codes where it has one. */
const REFUSAL_STATUS: Record<string, [number, string]> = {
  bad_request: [400, 'bad_request'],
  not_found: [404, 'not_found'],
  not_live: [404, 'not_found'],
  cron_owner: [409, 'cron_owner'],
  refused: [409, 'conflict'],
}

/**
 * One command to the host the companion leads. Ok: the host's reply. Otherwise
 * the answer for the phone, in the Mac's error shape.
 */
export async function callLeadHost(
  deps: Pick<HostControlDeps, 'request' | 'lostHost'>,
  target: LeadHost,
  cmd: string,
  params: Record<string, unknown>,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<{ ok: true; reply: Record<string, unknown> } | { ok: false; answer: HostControlAnswer }> {
  let reply: Record<string, unknown>
  try {
    reply = await deps.request(target.host, cmd, { walnutId: target.lead.walnutId, epoch: target.lead.epoch, sid: target.row.id, ...params }, timeoutMs)
  } catch (err) {
    return { ok: false, answer: answer(503, 'bridge_offline', `Could not reach ${target.host}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  if (reply.ok === true) return { ok: true, reply }
  const kind = String(reply.errorKind ?? '')
  const message = String(reply.error ?? 'refused')
  if (kind === 'stale_epoch' || kind === 'not_leader') {
    deps.lostHost?.(target.host, kind)
    return { ok: false, answer: answer(503, 'bridge_offline', message) }
  }
  if (message.includes('not permitted over bridge')) {
    return { ok: false, answer: answer(400, 'session_control_needs_upgrade', `The daemon on ${target.host} predates this; it upgrades on its next connect to your Mac.`) }
  }
  if (message.includes('not a session of this Walnut')) return { ok: false, answer: answer(404, 'not_found', message) }
  const [status, code] = REFUSAL_STATUS[kind] ?? [400, 'bad_request']
  return { ok: false, answer: answer(status, code, message) }
}

/** The bridge alias of a projected session's host ('' is the Mac itself). */
function aliasOf(host: string): string {
  return host || '__local__'
}

export function createHostSessionControl(deps: HostControlDeps) {
  /** The session's host, when this companion leads it and the session is Claude Code's. */
  async function target(sessionId: string): Promise<LeadHost | null> {
    const projection = await deps.projection()
    const row = projection?.sessions.find((s) => s.id === sessionId)
    if (!projection || !row || row.engine) return null
    const host = aliasOf(row.host)
    if (host === '__local__') return null
    const lead = await deps.leadFor(host)
    return lead ? { row, host, lead, asOf: projection.exportedAt } : null
  }

  /** Modes this companion applied since the Mac's last push: shown until the Mac pushes again. */
  const modeHere = new Map<string, { mode: string; at: number }>()

  /** The session's permission mode: what this companion applied, else the Mac's copy. */
  function currentMode(t: LeadHost): string {
    const mine = modeHere.get(t.row.id)
    if (mine && (Date.parse(t.asOf) || 0) > mine.at) modeHere.delete(t.row.id)
    return modeHere.get(t.row.id)?.mode ?? t.row.mode ?? 'default'
  }

  async function control(t: LeadHost, action: string, params: Record<string, unknown>): Promise<{ ok: true; reply: Record<string, unknown> } | { ok: false; answer: HostControlAnswer }> {
    return callLeadHost(deps, t, 'leader.control', { action, ...params })
  }

  /** POST /sessions/:id/permission. Same result shape as the Mac's. */
  async function permission(t: LeadHost, body: Record<string, unknown>): Promise<HostControlAnswer> {
    const r = await control(t, 'permission', {
      requestId: body.requestId,
      allow: body.allow,
      ...(body.message !== undefined ? { message: body.message } : {}),
      ...(body.answers !== undefined ? { answers: body.answers } : {}),
    })
    if (!r.ok) return r.answer
    return { status: 200, body: { status: 'resolved', requestId: r.reply.requestId, allow: r.reply.allow, viaCompanion: true } }
  }

  /** A permission mode, for PATCH /sessions/:id and POST /sessions/:id/controls. */
  async function mode(t: LeadHost, value: unknown): Promise<{ ok: true; mode: string; appliedLive: boolean } | { ok: false; answer: HostControlAnswer }> {
    const r = await control(t, 'mode', { mode: value })
    if (!r.ok) return r
    modeHere.set(t.row.id, { mode: String(r.reply.mode), at: Date.now() })
    return { ok: true, mode: String(r.reply.mode), appliedLive: r.reply.appliedLive === true }
  }

  /**
   * POST /sessions/:id/terminate. Same result shape as the Mac's. `request` is
   * the stop request this companion made (a fresh id): the host notes it, and
   * the Mac records the same one when it takes the host back.
   */
  async function stop(t: LeadHost, force: boolean, request: { id: string; requestedAt: string }): Promise<HostControlAnswer> {
    const started = Date.now()
    const r = await control(t, 'stop', { stopRequestId: request.id, requestedAt: request.requestedAt, ...(force ? { force: true } : {}) })
    if (!r.ok) {
      // The host's own stop errors ("stop: …"): it has not confirmed the process ended.
      const message = String((r.answer.body.error as { message?: unknown } | undefined)?.message ?? '')
      return message.startsWith('stop:') ? answer(503, 'stop_pending', message) : r.answer
    }
    if (r.reply.stopped === false) {
      return answer(409, 'conflict', `${t.host} did not stop this session (${String(r.reply.reason ?? 'refused')})`)
    }
    return {
      status: 200,
      body: {
        status: 'terminated', sessionId: t.row.id, tookMs: Date.now() - started,
        stopRequest: { id: request.id, requestedAt: request.requestedAt, state: 'confirmed' }, viaCompanion: true,
      },
    }
  }

  return { target, permission, mode, currentMode, stop }
}

let instance: ReturnType<typeof createHostSessionControl> | null = null

/** The cloud box's one instance. */
export function getHostSessionControl(): ReturnType<typeof createHostSessionControl> {
  if (instance) return instance
  instance = createHostSessionControl({
    projection: async () => (await import('../session-projection.js')).readSessionProjection(),
    leadFor: async (host) => {
      const { getBackupLeader } = await import('./backup-leader.js')
      return (await getBackupLeader())?.leadFor(host) ?? null
    },
    request: async (host, cmd, params, timeoutMs) => (await import('../../web/ws/bridge-registry.js')).bridgeRequest(host, cmd, params, timeoutMs),
    lostHost: (host, why) => {
      void import('./backup-leader.js').then(async ({ getBackupLeader }) => (await getBackupLeader())?.lostHost(host, why))
    },
  })
  return instance
}

/** Tests only. */
export function _resetHostSessionControlForTesting(): void {
  instance = null
}
