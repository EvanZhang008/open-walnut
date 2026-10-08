/**
 * A session's model and effort on the cloud companion while the Mac is away
 * (docs/plan/walnut-control-plane.md "Model and effort while the Mac is away").
 * Cloud box only; while the Mac answers, the phone's call is the Mac's (web/v1-forward/).
 *
 * Reading: the session's row in the projection the Mac last pushed (its CLI
 * model, effort and host) and that host's model catalog riding beside it, or
 * the static registry when the Mac never sent one. Same shape the Mac answers.
 *
 * Changing: only while the companion leads the session's host. The host's
 * daemon writes the CLI's own apply_flag_settings line into the live session
 * and keeps the values for the Mac (`leader.settings`). A session on the Mac
 * itself has nothing to reach, and before the takeover nothing leads: both say
 * so, as before.
 */

import type { ProjectedSession, SessionProjection } from '../session-projection.js'
import {
  VALID_SESSION_EFFORT_IDS, matchSessionModelCatalogEntry, resolveModelSwitchValue, sessionModelsAsCatalog,
  type SessionEffort, type SessionModelCatalogEntry,
} from '../types.js'
import { effortSupportedBy, modelOptionsFromCatalog, type ModelOptionsResult } from './session-controls.js'

export interface CopyAnswer { status: number; body: Record<string, unknown> }

export interface ModelCopyDeps {
  now: () => number
  projection: () => Promise<SessionProjection | null>
  /** The lead this companion holds on a host now, if any. */
  leadFor: (host: string) => Promise<{ walnutId: string; epoch: number } | null>
  request: (host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>
  /** The lead was refused as stale: let it go (backup-leader lostHost). */
  lostHost?: (host: string, why: string) => void
}

const SETTINGS_TIMEOUT_MS = 15_000

/** The bridge alias of a projected session's host ('' is the Mac itself). */
function aliasOf(host: string): string {
  return host || '__local__'
}

function error(status: number, code: string, message: string): CopyAnswer {
  return { status, body: { error: { code, message } } }
}

export function createModelCopy(deps: ModelCopyDeps) {
  /** What this companion applied on a host since the Mac's last push: shown until the Mac pushes again. */
  const appliedHere = new Map<string, { cliModel?: string; effort?: string; at: number }>()

  async function rowOf(sessionId: string): Promise<{ row: ProjectedSession; projection: SessionProjection } | null> {
    const projection = await deps.projection()
    const row = projection?.sessions.find((s) => s.id === sessionId)
    return row && projection ? { row, projection } : null
  }

  function catalogOf(projection: SessionProjection, row: ProjectedSession): SessionModelCatalogEntry[] {
    const models = projection.host_model_catalogs?.[aliasOf(row.host)]?.models
    return models && models.length > 0 ? models : sessionModelsAsCatalog()
  }

  /** The row's model and effort, with what this companion applied since the Mac last pushed. */
  function current(projection: SessionProjection, row: ProjectedSession): { model: string | null; effort: string | null } {
    const mine = appliedHere.get(row.id)
    const pushedAt = Date.parse(projection.exportedAt) || 0
    if (mine && pushedAt > mine.at) appliedHere.delete(row.id)
    const fresh = mine && pushedAt <= mine.at ? mine : undefined
    return {
      model: fresh?.cliModel ?? row.cli_model ?? row.model ?? null,
      effort: fresh?.effort ?? row.effort ?? null,
    }
  }

  /** The picker data from the copy; null when the copy does not list the session. */
  async function modelOptions(sessionId: string): Promise<(ModelOptionsResult & { offline: true; asOf: string }) | null> {
    const found = await rowOf(sessionId)
    if (!found) return null
    const now = current(found.projection, found.row)
    return { ...modelOptionsFromCatalog(catalogOf(found.projection, found.row), now.model, now.effort), offline: true, asOf: found.projection.exportedAt }
  }

  /** One change on the session's host, while this companion leads it. */
  async function applyOnHost(sessionId: string, change: { model?: string; effort?: string }): Promise<{ ok: true; appliedLive: boolean } | { ok: false; answer: CopyAnswer }> {
    const found = await rowOf(sessionId)
    if (!found) return { ok: false, answer: error(404, 'not_found', 'session not found') }
    const host = aliasOf(found.row.host)
    if (host === '__local__') {
      return { ok: false, answer: error(503, 'bridge_offline', 'This session runs on your Mac, which is offline. Try again when it is back.') }
    }
    const lead = await deps.leadFor(host)
    if (!lead) {
      return { ok: false, answer: error(503, 'bridge_offline', 'Your Mac is offline. The cloud companion takes over this host within about a minute; try again then.') }
    }
    let reply: Record<string, unknown>
    try {
      reply = await deps.request(host, 'leader.settings', { walnutId: lead.walnutId, epoch: lead.epoch, sid: sessionId, ...change }, SETTINGS_TIMEOUT_MS)
    } catch (err) {
      return { ok: false, answer: error(503, 'bridge_offline', `Could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`) }
    }
    if (reply.ok !== true) {
      const kind = String(reply.errorKind ?? '')
      if (kind === 'stale_epoch' || kind === 'not_leader') deps.lostHost?.(host, kind)
      const message = String(reply.error ?? 'refused')
      if (message.includes('not permitted over bridge')) {
        return { ok: false, answer: error(400, 'session_control_needs_upgrade', `The daemon on ${host} predates this; it upgrades on its next connect to your Mac.`) }
      }
      return { ok: false, answer: error(kind === 'stale_epoch' || kind === 'not_leader' ? 503 : 400, kind === 'stale_epoch' || kind === 'not_leader' ? 'bridge_offline' : 'bad_request', message) }
    }
    appliedHere.set(sessionId, { ...appliedHere.get(sessionId), ...(change.model ? { cliModel: change.model } : {}), ...(change.effort ? { effort: change.effort } : {}), at: deps.now() })
    return { ok: true, appliedLive: reply.appliedLive === true }
  }

  /** POST /sessions/:id/model while the Mac is away. Same result shape as the Mac's. */
  async function changeModel(sessionId: string, rawModel: unknown): Promise<CopyAnswer> {
    if (typeof rawModel !== 'string' || !rawModel.trim()) return error(400, 'bad_request', 'model must be a non-empty string')
    const cliModel = resolveModelSwitchValue(rawModel)
    if (!cliModel) return error(400, 'bad_request', 'model must be a catalog value from the models endpoint')
    const r = await applyOnHost(sessionId, { model: cliModel })
    if (!r.ok) return r.answer
    return { status: 200, body: { model: rawModel, cliModel, appliedLive: r.appliedLive, viaCompanion: true } }
  }

  /** POST /sessions/:id/effort while the Mac is away. Same result shape as the Mac's. */
  async function changeEffort(sessionId: string, rawEffort: unknown): Promise<CopyAnswer> {
    if (typeof rawEffort !== 'string' || !VALID_SESSION_EFFORT_IDS.has(rawEffort)) {
      return error(400, 'bad_request', 'effort must be one of low/medium/high/xhigh/max')
    }
    const found = await rowOf(sessionId)
    if (!found) return error(404, 'not_found', 'session not found')
    const model = current(found.projection, found.row).model ?? undefined
    const row = matchSessionModelCatalogEntry(catalogOf(found.projection, found.row), model)
    if (!effortSupportedBy(rawEffort as SessionEffort, model, row)) {
      return error(409, 'conflict', `Model "${model ?? 'unknown'}" does not support "${rawEffort}" reasoning effort`)
    }
    const r = await applyOnHost(sessionId, { effort: rawEffort })
    if (!r.ok) return r.answer
    return { status: 200, body: { effort: rawEffort, appliedLive: r.appliedLive, overridden: false, viaCompanion: true } }
  }

  return { modelOptions, changeModel, changeEffort }
}

let instance: ReturnType<typeof createModelCopy> | null = null

/** The cloud box's one instance. */
export function getModelCopy(): ReturnType<typeof createModelCopy> {
  if (instance) return instance
  instance = createModelCopy({
    now: () => Date.now(),
    projection: async () => (await import('../session-projection.js')).readSessionProjection(),
    leadFor: async (host) => {
      const { getBackupLeader } = await import('../leader/backup-leader.js')
      return (await getBackupLeader())?.leadFor(host) ?? null
    },
    request: async (host, cmd, params, timeoutMs) => (await import('../../web/ws/bridge-registry.js')).bridgeRequest(host, cmd, params, timeoutMs),
    lostHost: (host, why) => {
      void import('../leader/backup-leader.js').then(async ({ getBackupLeader }) => (await getBackupLeader())?.lostHost(host, why))
    },
  })
  return instance
}

/** Tests only. */
export function _resetModelCopyForTesting(): void {
  instance = null
}
