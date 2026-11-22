/**
 * One machine is one host, by its daemon. Two aliases in Settings can reach ONE daemon process:
 * a row found in ~/.ssh/config (`newdev`, ssh) and the row the same machine joined the host
 * network as (`clouddev`, "New big clouddev"). 2026-11-20: the user saw that machine twice in the
 * host picker, and Usage & Costs counted it two and three times (every alias read the same
 * transcripts and stored each response under its own name: about 40% of one week was copies).
 *
 * Which aliases are one machine comes only from the daemon's own word, and only while each row
 * still connects where it did then, never a hostname or an address: the machine id each alias's
 * hello gave (`machine`, same-daemon-record.ts sameMachineAliases), so two aliases seen at
 * different times are one machine; else, for a daemon older than that id, the pair recorded in the
 * host profiles (`sameDaemon`) when both links' hellos named one process.
 *
 * The lists that read it are synchronous (joined-twins.ts, the one place every picker, host_list,
 * Usage and Settings take their hosts from), so the pairs are kept here as a snapshot: read at
 * start, again whenever a pair is written or dropped, and checked against the rows on every read
 * (a row that now connects elsewhere is itself again at once).
 *
 * Of the aliases of one daemon, the person's is the one they added and named (preferredAlias);
 * the others are left out of every list and read as it, while a session or task bound to one of
 * them keeps its alias and keeps working over that link from the Mac. The daemon's bridge to the
 * cloud companion goes by that one name only (daemonKeeperAlias), so while the Mac is away the
 * companion reaches only sessions bound to it; one bound to another alias waits for the Mac.
 */
import type { Config } from '../types.js'

export const LOCAL_HOST_ALIAS = '__local__'

export type TwinRow = {
  hostname?: unknown; user?: unknown; port?: unknown; transport?: unknown; endpoint?: unknown
  enabled?: unknown; discovered?: unknown; label?: unknown
} | undefined
export type TwinRows = Record<string, TwinRow>

/**
 * The aliases recorded as one machine with `host`, `host` included, sorted: the same machine id
 * (`machines`, sameMachineAliases of `config`, read here when not given), or a recorded pair. Each
 * is checked against the rows in `config` (both sides still connect where they did when it was
 * recorded); links are followed through, so A-B and B-C join C to A.
 */
export async function sameDaemonAliases(host: string, config: Config, machines?: ReadonlyMap<string, readonly string[]>): Promise<string[]> {
  // Loaded when asked: every list of hosts imports this module, and the record reaches the host profiles.
  const { recordedSameDaemon, sameMachineAliases } = await import('./same-daemon-record.js')
  const byMachine = machines ?? await sameMachineAliases(config).catch(() => new Map<string, string[]>())
  const seen = new Set<string>([host])
  const pending = [host]
  for (let i = 0; i < pending.length; i++) {
    for (const other of [...(byMachine.get(pending[i]) ?? []), ...await recordedSameDaemon(pending[i], config)]) {
      if (!seen.has(other)) { seen.add(other); pending.push(other) }
    }
  }
  return [...seen].sort()
}

/** Whether the host network is on (a host-network row is reachable only then). */
export type NetSwitch = { enabled?: unknown } | null | undefined
const netOn = (net: unknown): boolean => !!net && typeof net === 'object' && (net as { enabled?: unknown }).enabled === true

/**
 * The alias a person picked over the others: one that can be used now (enabled; a host-network row
 * only while the host network is on, when `net` is given), then one they added (not found), then
 * labelled, then by name.
 */
export function preferredAlias(aliases: readonly string[], rows: TwinRows, net?: NetSwitch): string {
  const rank = (a: string) => {
    const r = rows[a]
    return [usable(r, net) ? 0 : 1, r?.discovered === true ? 1 : 0, typeof r?.label === 'string' && r.label.trim() ? 0 : 1]
  }
  return [...aliases].sort((a, b) => {
    const x = rank(a), y = rank(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return a < b ? -1 : a > b ? 1 : 0
  })[0]
}

/**
 * The one name a daemon reached by several aliases goes by toward anything outside this Walnut
 * (the cloud bridge it dials, the read copy it answers from while the leader is away): this
 * machine's own key when it is one of them, else the alias the person uses (preferredAlias).
 * Every link to that daemon must push the same answer: when each pushed its own alias, the
 * daemon's bridge took the name of whichever pushed last (2026-11-20: `clouddev` and `newdev`
 * swapped about 230 times a day, and while the Mac was asleep the phone found no `clouddev`).
 */
export function daemonKeeperAlias(aliases: readonly string[], rows: TwinRows, net?: NetSwitch): string {
  if (aliases.includes(LOCAL_HOST_ALIAS)) return LOCAL_HOST_ALIAS
  return preferredAlias(aliases, rows, net)
}

/** A row that can carry the machine now: enabled, and a host-network row only while the host network is on (`net` given). */
function usable(row: TwinRow, net: NetSwitch | undefined): boolean {
  if (row?.enabled === false) return false
  return net === undefined || row?.transport !== 'net' || netOn(net)
}

/** What of a row decides where it connects: a change to it voids what the daemon confirmed for that row. */
function reachOf(row: TwinRow): string {
  const r = row ?? {}
  return JSON.stringify([r.transport ?? '', r.hostname ?? '', r.user ?? '', r.port ?? '', r.endpoint ?? ''])
}

/** Each group: its aliases with where each row connected when the pair was checked. */
let groups: Array<Map<string, string>> = []
/** The rows and host-network switch last read in full, for a reader that holds only one row (a status frame). */
let lastRows: TwinRows = {}
let lastNet: NetSwitch = null
let first: Promise<void> | null = null
let running: Promise<void> | null = null
let again = false

/**
 * Read the pairs again from the host profiles, checked against config.yaml's rows. One at a
 * time; a call while one runs runs once more after it. This Mac's own key is never in a group.
 */
export function refreshDaemonTwins(config?: Config): Promise<void> {
  if (running) { again = true; return running }
  running = (async () => {
    do {
      again = false
      try {
        let cfg = config
        if (!cfg) {
          const { getConfig, isFallbackConfig } = await import('../config-manager.js')
          cfg = await getConfig()
          if (isFallbackConfig(cfg)) return
        }
        const rows = (cfg.hosts ?? {}) as TwinRows
        const next: Array<Map<string, string>> = []
        const placed = new Set<string>()
        // The machine ids are read once for every alias (each alias's profile, then `ssh -G` for shared ids only).
        const { sameMachineAliases } = await import('./same-daemon-record.js')
        const machines = await sameMachineAliases(cfg).catch(() => new Map<string, string[]>())
        for (const alias of Object.keys(rows).sort()) {
          if (alias === LOCAL_HOST_ALIAS || placed.has(alias)) continue
          const members = (await sameDaemonAliases(alias, cfg, machines).catch(() => [alias])).filter((a) => a !== LOCAL_HOST_ALIAS && rows[a])
          if (members.length < 2) continue
          for (const m of members) placed.add(m)
          next.push(new Map(members.map((m) => [m, reachOf(rows[m])])))
        }
        groups = next
        lastRows = rows
        lastNet = (cfg.net ?? null) as NetSwitch
      } catch { /* a profile or config that cannot be read keeps what was read before */ }
      config = undefined
    } while (again)
  })().finally(() => { running = null })
  return running
}

/** The first read of the pairs (started now when nothing started it yet): what a reader that must not miss a twin awaits. */
export function daemonTwinsReady(): Promise<void> {
  if (!first) first = refreshDaemonTwins()
  return first
}

/** Whether the snapshot already holds `host` with each of `others` in one group (a pair confirmed again needs no read). */
export function daemonTwinsKnown(host: string, others: readonly string[]): boolean {
  const g = groups.find((m) => m.has(host))
  return !!g && others.every((o) => g.has(o))
}

/** The groups of aliases of one daemon whose rows still connect where they did, two or more each. */
export function daemonTwinGroups(rows: TwinRows): string[][] {
  const out: string[][] = []
  let whole = true
  for (const g of groups) {
    const members = [...g].filter(([alias, reach]) => rows[alias] && reachOf(rows[alias]) === reach).map(([alias]) => alias)
    if ([...g.keys()].some((a) => !rows[a])) whole = false
    if (members.length >= 2) out.push(members)
  }
  // Rows that hold every grouped alias are the config as it is now: a label renamed since the last read shows at once.
  if (groups.length && whole) lastRows = rows
  return out
}

/**
 * Each alias of a daemon that is not the one the person uses for it, with that one. The one used is
 * a row that can be used now (preferredAlias); a group with none stays as it is.
 */
export function daemonTwins(rows: TwinRows, net: NetSwitch): Array<{ alias: string; joined: string }> {
  const out: Array<{ alias: string; joined: string }> = []
  for (const members of daemonTwinGroups(rows)) {
    const keeper = daemonKeeperAlias(members, rows, net ?? null)
    if (!usable(rows[keeper], net ?? null)) continue // none of them is in use: each stays as it is
    for (const alias of members) if (alias !== keeper) out.push({ alias, joined: keeper })
  }
  return out
}

/**
 * The name a person knows `alias` by when it is another alias of a machine they use: that
 * machine's label (or alias). Undefined for any other alias, which keeps its own name.
 */
export function twinMachineLabel(alias: string, rows: TwinRows, net: NetSwitch): string | undefined {
  const twin = daemonTwins(rows, net).find((t) => t.alias === alias)
  if (!twin) return undefined
  const label = rows[twin.joined]?.label
  return typeof label === 'string' && label.trim() ? label.trim() : twin.joined
}

/**
 * twinMachineLabel for a reader that holds only `alias`'s own row (a host's status frame): the
 * other rows as last read in full.
 */
export function twinMachineLabelOf(alias: string, row: TwinRow): string | undefined {
  if (!groups.length || alias === LOCAL_HOST_ALIAS) return undefined
  return twinMachineLabel(alias, { ...lastRows, [alias]: row }, lastNet)
}

/** Tests: stand in for the recorded pairs, each group with the rows it was checked against (null: none). */
export function __setDaemonTwinsForTest(next: Array<{ aliases: string[]; rows: TwinRows }> | null, net: NetSwitch = { enabled: true }): void {
  groups = (next ?? []).map((g) => new Map(g.aliases.map((a) => [a, reachOf(g.rows[a])])))
  first = next ? Promise.resolve() : null
  lastRows = next ? Object.assign({}, ...next.map((g) => g.rows)) : {}
  lastNet = net
}
