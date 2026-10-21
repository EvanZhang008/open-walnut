/**
 * The cloud companion's session list from its copy of the Mac's sessions (stage 2c
 * of docs/plan/walnut-companion-unified-replica.md; the copy is
 * replication/kinds/sessions.ts, in `cache/replica/home/sessions.sqlite`).
 *
 * Once the copy arrived whole, the list is the projection the Mac would build
 * (session-projection.ts buildSessionProjection: the same eligibility, order and
 * budgets) over the copy's rows, with the box's copy of the Mac's tasks for the task
 * fields and its copy of the Mac's config for the host labels. The readers that
 * have not moved yet keep the pushed projection (the model picker with its host
 * catalogs, the transcript tails, the events snapshot). Before the copy is held,
 * null: the pushed projection answers as before.
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

/** The list from the copy, or null while the copy is not held (or anywhere but the companion). */
export async function companionSessionList(): Promise<CompanionSessionList | null> {
  const { followerKind } = await import('./server-role.js')
  if (followerKind() !== 'companion') return null
  const { copyKindAsOf } = await import('./replication/kinds/gate.js')
  // 0: a first round still filling in (a partial list would hide sessions).
  const asOf = await copyKindAsOf('sessions')
  if (!asOf) return null
  const [{ readCompanionSessions }, { buildSessionProjection }, hostLabels] = await Promise.all([
    import('./replication/kinds/sessions.js'), import('./session-projection.js'), copiedHostLabels(),
  ])
  const projection = await buildSessionProjection({ sessions: await readCompanionSessions(), ...(hostLabels ? { hostLabels } : {}) })
  // The list is as of the copy's round (the Mac's clock), not of this read.
  return { projection: { ...projection, exportedAt: new Date(asOf).toISOString() }, asOf }
}
