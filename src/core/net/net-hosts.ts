/**
 * Host rows that belong to the host network (`transport: net`, core/net/net-mac.ts)
 * are addressed by the network, never by the Remote Hosts editor: a hosts map the
 * editor sends keeps every such row's address as it is (its transport and endpoint
 * included), and an older editor, which knows neither field, cannot turn one into an
 * SSH host. The person's own settings on the row (its label, its switches, its
 * capability tags) are theirs to change on such a row as on any other.
 */
import type { Config } from '../types.js'
import { readCodexEngineSettings } from '../../providers/codex-engine-config.js'

type HostRow = Record<string, unknown>
type HostDef = NonNullable<Config['hosts']>[string]

/**
 * Who writes each field of a host-network row when a hosts map is saved (PUT /api/config):
 * - `network`: the network's (core/net/net-mac.ts); what the sender says is ignored;
 * - `person`: the sender's, when it names the field (null removes it), else as stored, so an
 *   editor that does not know the field never drops it;
 * - `own-path`: written by its own route or by Walnut (found hosts, host servers, the cloud
 *   box), kept as stored.
 * A new HostDef field is a type error here until it is classified (2026-11-23: a pod host's
 * `capabilities: ["cloud", "always-on"]` was dropped by every save, so it read as local).
 */
type Writer = 'network' | 'person' | 'own-path'

export const NET_ROW_FIELD_WRITER = {
  hostname: 'network',
  user: 'network',
  port: 'network',
  transport: 'network',
  endpoint: 'network',
  label: 'person',
  enabled: 'person',
  capabilities: 'person',
  autofix: 'person',
  place: 'person',
  shell_setup: 'person',
  keep: 'person',
  runs_sessions: 'person',
  engines: 'person',
  discovered: 'own-path',
  connect: 'own-path',
  connect_by: 'own-path',
  not_offered: 'own-path',
  cloud_box: 'own-path',
  server: 'own-path',
  server_program: 'own-path',
} as const satisfies { readonly [K in keyof Required<HostDef>]: Writer }

type PersonField = { [K in keyof typeof NET_ROW_FIELD_WRITER]: (typeof NET_ROW_FIELD_WRITER)[K] extends 'person' ? K : never }[keyof typeof NET_ROW_FIELD_WRITER]

/** The shape each person field must have to be taken; anything else keeps the stored value. */
export const PERSON_FIELD_OK: { readonly [K in PersonField]: (v: unknown) => boolean } = {
  label: (v) => typeof v === 'string',
  enabled: (v) => typeof v === 'boolean',
  autofix: (v) => typeof v === 'boolean',
  place: (v) => typeof v === 'boolean',
  shell_setup: (v) => typeof v === 'string',
  capabilities: (v) => Array.isArray(v) && v.every((t) => typeof t === 'string'),
  keep: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  runs_sessions: (v) => typeof v === 'boolean',
  // The host's own engine settings, read by the same rule a start reads them (a wrong provider is refused here).
  engines: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && hostEnginesValid(v),
}

/** `hosts.<name>.engines` as codex-engine-config.ts reads it: no throw. */
function hostEnginesValid(v: object): boolean {
  try {
    readCodexEngineSettings({ engines: v })
    return true
  } catch {
    return false
  }
}

function isPersonField(field: string): field is PersonField {
  return Object.hasOwn(PERSON_FIELD_OK, field)
}

/** The editor sent an SSH host under the name of a machine on the host network. */
export class NetHostAliasTaken extends Error {
  constructor(public alias: string) {
    super(`"${alias}" is a machine that joined with a link; give the SSH host another name.`)
    this.name = 'NetHostAliasTaken'
  }
}

/**
 * The hosts map to store for what `sent` says, `current` being what is stored now.
 * `merge` (a writer that does not hold the whole map, config-section-write.ts `mergeEntries`):
 * a net row comes back as only the person fields the sender named (null kept, so the merge
 * removes it), and the merge puts them on the row as the write lock finds it; a whole row
 * here would put back an address the network changed since `current` was read.
 * Otherwise (the whole map): each net row as stored, with the person fields the sender named.
 */
export function keepNetHosts(sent: Record<string, HostRow | undefined>, current: Record<string, unknown>, opts: { merge?: boolean } = {}): Record<string, HostRow | undefined> {
  const out: Record<string, HostRow | undefined> = { ...sent }
  for (const [key, row] of Object.entries(current)) {
    const h = row as HostRow | undefined
    if (!h || h.transport !== 'net') continue
    const s = out[key]
    // An editor that knows the row (an older one sends it back as it read it) sends its
    // hostname unchanged; another hostname is a new SSH host under a taken name.
    if (s && s.transport !== 'net' && typeof s.hostname === 'string' && s.hostname !== h.hostname) throw new NetHostAliasTaken(key)
    const person: HostRow = {}
    for (const [field, value] of Object.entries(s ?? {})) {
      if (!isPersonField(field)) continue
      if (value === null || PERSON_FIELD_OK[field](value)) person[field] = value
    }
    if (opts.merge) {
      // A null for the whole row is no Remove: a net machine leaves only through Remove.
      if (Object.hasOwn(sent, key)) out[key] = person
      continue
    }
    const next: HostRow = { ...h }
    for (const [field, value] of Object.entries(person)) {
      if (value === null) delete next[field]
      else next[field] = value
    }
    out[key] = next
  }
  // A row the editor sent as `net` that is not one already is not the editor's to make.
  for (const [key, s] of Object.entries(out)) {
    if (s && s.transport === 'net' && (current[key] as HostRow | undefined)?.transport !== 'net') {
      const { transport: _t, endpoint: _e, ...rest } = s
      out[key] = rest
    }
  }
  return out
}

/**
 * The hosts map a merged write (`mergeEntries`) leaves, as the write lock finds it: a host
 * the stored map did not hold before and that has no hostname is a patch of a host removed
 * since the writer read it (keepNetHosts' person fields, say), not a new host, so it is dropped.
 */
export function withoutAddresslessNewHosts(hosts: Record<string, unknown>, before: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(hosts)) {
    const fresh = !before || !Object.hasOwn(before, key)
    const hostname = row && typeof row === 'object' ? (row as HostRow).hostname : undefined
    if (fresh && (typeof hostname !== 'string' || hostname === '')) continue
    out[key] = row
  }
  return out
}
