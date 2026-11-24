/**
 * A daemon's serves record (`daemon.serves.json`, served-walnuts-core.ts writes it): what it serves and
 * which Walnuts used it lately, by key. Pure, so the daemon's own service CLI (service-set-choice.ts)
 * reads it without the server's modules: daemon-shared.ts, the server's shared-daemon rule, imports
 * this server's data dir and host server state, which no daemon bundle may carry (their files are not
 * in the daemon's version hash, tests/providers/daemon-version-hash-parity.test.ts).
 */
import crypto from 'node:crypto'

/** Another Walnut seen this recently still uses the daemon. */
export const SHARED_WINDOW_MS = 3 * 24 * 3600_000
export const SERVES_FILE = 'daemon.serves.json'

export type DaemonTwin = 'binary' | 'source'

/** What a running daemon says it serves (its serves file, or `served` in its hello). */
export interface DaemonServes {
  version: string
  twin: DaemonTwin | null
  capabilities: string[]
  /** Walnut key ('-' = a server that names no home) → last seen, ms. */
  walnuts: Record<string, number>
  /** Whether its runtime can have a pty (pty-stream-v1); null or absent when it says nothing (a build older than this field). */
  pty?: boolean | null
}

/**
 * The key a daemon files a Walnut under (served-walnuts-core.ts does the same): the same
 * data dir written with a trailing or doubled slash is one Walnut.
 */
export function walnutKeyOf(home: string): string {
  const dir = home.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  return crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16)
}

/** Reads a serves file's text (or a hello's `served`); null when it is none. */
export function parseServes(input: unknown): DaemonServes | null {
  let v: unknown = input
  if (typeof input === 'string') {
    if (!input.trim()) return null
    try { v = JSON.parse(input) } catch { return null }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.capabilities) || !o.walnuts || typeof o.walnuts !== 'object') return null
  const walnuts: Record<string, number> = {}
  for (const [k, at] of Object.entries(o.walnuts as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) walnuts[k] = at
  }
  return {
    version: typeof o.version === 'string' ? o.version : '',
    twin: o.twin === 'binary' || o.twin === 'source' ? o.twin : null,
    capabilities: o.capabilities.filter((c): c is string => typeof c === 'string'),
    walnuts,
    pty: typeof o.pty === 'boolean' ? o.pty : null,
  }
}
