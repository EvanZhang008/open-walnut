/**
 * The cloud companion's view of the Mac's sessions from its copies (stage 2c of
 * docs/plan/walnut-companion-unified-replica.md; the sessions copy is
 * replication/kinds/sessions.ts, in `cache/replica/home/sessions.sqlite`, the host
 * model catalogs replication/kinds/model-catalogs.ts).
 *
 * Once the sessions copy arrived whole, the view is the projection the Mac would
 * build (session-projection.ts buildSessionProjection: the same eligibility, order
 * and budgets) over the copy's rows, with the box's copy of the Mac's tasks for the
 * task fields, its copy of the Mac's config for the host labels, and its copy of the
 * hosts' model catalogs beside the rows. Every companion reader of the session
 * projection reads it (session-projection.ts readSessionProjection): the list, the
 * events snapshot, the model picker, the session controls, the stop fence, the
 * session's host lookups. Before the copy is held, null: the pushed projection
 * answers as before. Transcript tails are not here: they are still pushed.
 *
 * Once both copies are held, the box no longer reads the pushed session projection,
 * and it tells the Mac so in its answer to that push (companionReadsSessionsCopy,
 * web/routes/bridge-ingest.ts), so the Mac stops sending it (projection-push-state.ts).
 */

import type { SessionProjection } from './session-projection.js'

export interface CompanionSessionList { projection: SessionProjection; asOf: number }

/** The Mac's host labels as the box's config copy has them, or null without one. */
async function copiedHostLabels(): Promise<Map<string, string> | null> {
  const { readConfigCopy } = await import('./replication/kinds/config.js')
  const config = await readConfigCopy()
  if (!config) return null
  const out = new Map<string, string>()
  for (const [alias, def] of Object.entries((config.hosts ?? {}) as Record<string, unknown>)) {
    const label = (def as { label?: unknown } | undefined)?.label
    if (typeof label === 'string' && label.trim()) out.set(alias, label.trim())
  }
  return out
}

/**
 * The hosts' model catalogs: the box's copy, else the ones the last push carried
 * (a Mac too old to send the kind, or the kind resting: the box then still says it
 * reads the push, so that one stays current).
 */
async function hostModelCatalogs(): Promise<SessionProjection['host_model_catalogs'] | undefined> {
  const copied = await (await import('./replication/kinds/model-catalogs.js')).readModelCatalogsCopy()
  if (copied) return Object.keys(copied).length > 0 ? copied : undefined
  return (await (await import('./session-projection.js')).readPushedSessionProjection())?.host_model_catalogs
}

/**
 * When the box holds the whole sessions copy (ms, the Mac's clock), or null (not
 * held, filling in, not the companion, or no config copy yet). The view names each
 * host by the label in the config copy, and its kind can land after the sessions
 * copy: until it does the pushed projection answers, labels included, and keeps
 * coming (2026-10-26: a send in that window was held "for devbox" instead of the
 * host's label).
 */
async function sessionsCopyAsOf(): Promise<number | null> {
  const { followerKind } = await import('./server-role.js')
  if (followerKind() !== 'companion') return null
  const { copyKindAsOf, copyKindHeld } = await import('./replication/kinds/gate.js')
  if (!(await copyKindHeld('config'))) return null
  // 0: a first round still filling in (a partial list would hide sessions).
  return (await copyKindAsOf('sessions')) || null
}

/** The view from the copy, or null while the copy is not held (or anywhere but the companion). */
export async function companionSessionList(): Promise<CompanionSessionList | null> {
  const asOf = await sessionsCopyAsOf()
  if (!asOf) return null
  const [{ readCompanionSessions }, { buildSessionProjection }, hostLabels, catalogs] = await Promise.all([
    import('./replication/kinds/sessions.js'), import('./session-projection.js'), copiedHostLabels(), hostModelCatalogs(),
  ])
  const projection = await buildSessionProjection({ sessions: await readCompanionSessions(), ...(hostLabels ? { hostLabels } : {}) })
  // The view is as of the copy's round (the Mac's clock), not of this read.
  return { projection: { ...projection, exportedAt: new Date(asOf).toISOString(), ...(catalogs ? { host_model_catalogs: catalogs } : {}) }, asOf }
}

/**
 * True when no reader on this box reads the pushed session projection: the
 * companion holds the whole sessions copy and the model catalogs copy. Its answer
 * to the Mac's push of that projection says so (`unread: true`).
 */
export async function companionReadsSessionsCopy(): Promise<boolean> {
  if (!(await sessionsCopyAsOf())) return false
  const { copyKindHeld } = await import('./replication/kinds/gate.js')
  if (!(await copyKindHeld('model-catalogs'))) return false
  // A copy that cannot be read sends the readers to the pushed file: keep it coming.
  try {
    await (await import('./replication/kinds/sessions.js')).readCompanionSessions()
    return true
  } catch {
    return false
  }
}
