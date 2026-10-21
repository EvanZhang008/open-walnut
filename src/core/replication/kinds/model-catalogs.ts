/**
 * The `model-catalogs` copy kind (stage 2c of
 * docs/plan/walnut-companion-unified-replica.md): each host's last-known model
 * catalog as this Mac keeps it (core/host-model-catalog.ts), one row per host
 * ('__local__' = the Mac), keyed as the session records name hosts. The
 * companion's model picker answers from it while the Mac is away
 * (sessions/model-options-copy.ts), beside its copy of the Mac's sessions; before
 * this kind the catalogs rode the pushed session projection.
 *
 * A kind of its own because the catalogs have their own store and their own write
 * (a live CLI's answer), and they belong to no other kind's file: not the config
 * copy (config.yaml through an allowlist, which a host's getConfig reads), not the
 * prefs (the user's layout). It rides the `sessions` choice: it serves only the
 * session picker, so a host that keeps no sessions copy keeps none of it.
 *
 * Rows are the catalog without the fields only this Mac uses (the cwd it came
 * from, the answering CLI's spawn time). Unordered, no digest, a few rows; floor
 * 20, so the half rule never asks the user about a cache whose loss only sends
 * the picker back to the static model list.
 */

import { sha12 } from '../kind.js'
import type { SessionModelCatalogEntry } from '../../types.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'

export const MODEL_CATALOGS_SCHEMA_VERSION = 1
export const MODEL_CATALOGS_REMOVAL_FLOOR = 20
const HOST_RE = /^[A-Za-z0-9_.:@-]{1,200}$/
const MAX_MODELS = 200

export interface ModelCatalogRow { key: string; models: SessionModelCatalogEntry[]; fetchedAt: string }

function isModel(v: unknown): v is SessionModelCatalogEntry {
  const m = v as Record<string, unknown> | null
  return !!m && typeof m === 'object' && !Array.isArray(m) && typeof m.value === 'string' && !!m.value && m.value.length <= 200
    && typeof m.displayName === 'string' && m.displayName.length <= 500
}

/** The leader sends only what its followers take (isRow below): a row they refuse would fail every put. */
async function leaderRows(): Promise<ModelCatalogRow[]> {
  const { listHostModelCatalogs } = await import('../../host-model-catalog.js')
  const rows: ModelCatalogRow[] = []
  for (const [host, c] of Object.entries(await listHostModelCatalogs())) {
    const models = Array.isArray(c?.models) ? c.models.filter(isModel).slice(0, MAX_MODELS) : []
    if (!HOST_RE.test(host) || models.length === 0 || typeof c.fetchedAt !== 'string') continue
    rows.push({ key: host, models, fetchedAt: c.fetchedAt })
  }
  return rows
}

const hashes = new WeakMap<object, string>()
function hashOf(row: ModelCatalogRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const MODEL_CATALOGS_KIND: CopyKind<ModelCatalogRow> = {
  kind: 'model-catalogs',
  schemaVersion: MODEL_CATALOGS_SCHEMA_VERSION,
  key: (r) => r.key,
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'sessions',
  rows: leaderRows,
  watch: (soon) => {
    let stop: (() => void) | null = null
    let stopped = false
    void import('../../host-model-catalog.js').then((m) => { if (!stopped) stop = m.onHostModelCatalogWritten(soon) })
    return () => { stopped = true; stop?.() }
  },
}

// --- Follower ---

function isRow(v: unknown): v is ModelCatalogRow {
  const r = v as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3) return false
  return typeof r.key === 'string' && HOST_RE.test(r.key) && typeof r.fetchedAt === 'string'
    && Array.isArray(r.models) && r.models.length > 0 && r.models.length <= MAX_MODELS && r.models.every(isModel)
}

const copy = createFileCopy<ModelCatalogRow>({
  kind: 'model-catalogs',
  schemaVersion: MODEL_CATALOGS_SCHEMA_VERSION,
  label: 'model catalogs copy',
  removalFloor: MODEL_CATALOGS_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.key,
})

export const modelCatalogsFollower = copy.follower

/** The copied catalogs by host, in the projection's shape, or null when there is no copy. */
export async function readModelCatalogsCopy(): Promise<Record<string, { models: SessionModelCatalogEntry[]; fetchedAt: string }> | null> {
  const rows = await copy.read()
  if (!rows) return null
  const out: Record<string, { models: SessionModelCatalogEntry[]; fetchedAt: string }> = {}
  for (const r of Object.values(rows)) out[r.key] = { models: r.models, fetchedAt: r.fetchedAt }
  return out
}

/** Tests only. */
export function _resetModelCatalogsCopyForTesting(): void {
  copy.reset()
}
