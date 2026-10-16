/**
 * The `config` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4 and
 * WP5): the Mac's config.yaml on each host replica, through an ALLOWLIST
 * (replication/config-allowlist.ts) and the secret check, one row per top-level
 * key. The host keeps it in `cache/replica/config.json` (file-copy.ts) and its
 * getConfig() reads it (core/config-manager.ts); every config write there
 * answers 503 needs_leader.
 *
 * A row with anything secret-shaped in it is refused twice: the Mac leaves it
 * out of the manifest (one warning log naming the paths, never a value), and the
 * host skips such a row if one ever arrives. A config.yaml the Mac fails to read
 * or parse throws, so the round skips the kind instead of removing the copy.
 *
 * Unordered, no digest (a few dozen rows). Floor 0: the half rule always
 * applies, so a config that lost most of its sections (a truncated file the Mac
 * read as valid YAML) never empties the copy without the user's confirm.
 */

import fsp from 'node:fs/promises'
import yaml from 'js-yaml'
import { CONFIG_FILE } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import { configCopyRows, configRowAdmissible, type ConfigCopyRow } from '../config-allowlist.js'
import { sha12 } from '../kind.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'

export const CONFIG_SCHEMA_VERSION = 1
export const CONFIG_REMOVAL_FLOOR = 0

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

/**
 * The Mac's config.yaml as a mapping. Missing (and no backup): no rows, a first
 * run. Unreadable, empty, unparsable or not a mapping: throws (the round skips).
 */
export async function readLeaderConfig(): Promise<Record<string, unknown>> {
  const text = (await readText(CONFIG_FILE)) ?? (await readText(`${CONFIG_FILE}.bak`))
  if (text === null) return {}
  if (!text.trim()) throw new Error('config.yaml is empty')
  const parsed = yaml.load(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.yaml is not a mapping')
  return parsed as Record<string, unknown>
}

let lastWarned = ''

async function leaderRows(): Promise<ConfigCopyRow[]> {
  const { rows, refused, unknown } = configCopyRows(await readLeaderConfig())
  const note = JSON.stringify({ refused: refused.map((r) => [r.key, r.findings.map((f) => `${f.path}:${f.reason}`)]), unknown })
  if ((refused.length > 0 || unknown.length > 0) && note !== lastWarned) {
    lastWarned = note
    log.session.warn('config copy: left keys out', {
      refused: refused.map((r) => ({ key: r.key, paths: r.findings.map((f) => f.path), reasons: [...new Set(r.findings.map((f) => f.reason))] })),
      unknown,
    })
  }
  return rows
}

const hashes = new WeakMap<object, string>()
function hashOf(row: ConfigCopyRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const CONFIG_KIND: CopyKind<ConfigCopyRow> = {
  kind: 'config',
  schemaVersion: CONFIG_SCHEMA_VERSION,
  key: (r) => r.key,
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'config',
  rows: leaderRows,
  watch: (soon) => {
    let stop: (() => void) | null = null
    let stopped = false
    void import('../../config-manager.js').then(({ onConfigWritten }) => {
      if (!stopped) stop = onConfigWritten(soon)
    })
    return () => { stopped = true; stop?.() }
  },
}

// --- Follower ---

function isRow(v: unknown): v is ConfigCopyRow {
  const r = v as Partial<ConfigCopyRow> | null
  return !!r && typeof r === 'object' && typeof r.key === 'string' && !!r.key && 'value' in r && Object.keys(r).length === 2
}

const copy = createFileCopy<ConfigCopyRow>({
  kind: 'config',
  schemaVersion: CONFIG_SCHEMA_VERSION,
  label: 'config copy',
  removalFloor: CONFIG_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.key,
  admit: configRowAdmissible,
})

export const configFollower = copy.follower

/** The copy as a config mapping (top-level key -> value), or null when there is none. */
export async function readConfigCopy(): Promise<Record<string, unknown> | null> {
  const rows = await copy.read()
  if (!rows) return null
  const out: Record<string, unknown> = {}
  for (const r of Object.values(rows)) if (configRowAdmissible(r)) out[r.key] = r.value
  return out
}

/** Tests only. */
export function _resetConfigCopyForTesting(): void {
  copy.reset()
  lastWarned = ''
}
