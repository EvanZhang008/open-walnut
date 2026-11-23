/**
 * The switch's settings, read from a home's config.yaml (`leader_switch:`), with the
 * experiment `switchable_leader`. config.yaml is leader data, so both machines read the same
 * table: each machine's own places are listed under its id.
 *
 * ```yaml
 * leader_switch:
 *   witnesses:                 # three, a majority of two (the list is FIXED: a majority of this list)
 *     - { id: w1, dir: /srv/walnut-witness/w1 }   # a directory on this computer
 *     - id: w2                   # a witness kept by another machine, reached by up to three ways:
 *       machine: <machine id>    #   a: a caller ON that machine opens the record itself
 *       host: dev-box            #   c: the leader's link to that machine's service (a `hosts` alias, or a machine id)
 *       url: https://box/leader-witness  # b: a direct door (witness-door.ts), no leader link needed
 *       key: <64 hex>            # the witness's own key, minted at setup (sensitive: config-redact.ts)
 *   machines:
 *     - id: <machine id>       # this machine's stable id (src/core/machine-id.ts)
 *       home: /path/to/home    # its data home when it leads
 *       standby_dir: /path     # where the other leader's standby batches land on it
 *       port: 3456
 *       account_home: /home/me # optional: the account's home dir there (default: env.HOME below);
 *                              # the switch moves paths under it to the other machine's
 *       start_command: [...]   # optional: how to start its server (default: this CLI's `web --port`)
 *       env: { K: V }          # optional: extra environment for that server
 *   back_window_hours: 168     # `--back` is offered this long after a switch
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../permit/types.js'
import { experimentalEnabled, type ExperimentalFlags } from '../../experimental.js'

/** A witness whose record is a directory on this computer (one-computer rehearsals and tests). */
export interface LocalWitnessPlace { id: string; dir: string }
/**
 * A witness kept by a machine: its record is in that machine's state dir (machine-id.ts
 * witnessRoot), and a caller reaches it by one of three ways (witness-transport.ts waysOf):
 *   a. `machine`: a caller on that machine opens the record itself, under its lock (local-witnesses.ts);
 *   b. `url` with `key`: a direct door of that machine's service (witness-door.ts), proven with the key;
 *   c. `host`: the leader's link to that machine's service (witness-route.ts), a `hosts` alias of
 *      config.yaml or that machine's id when it is not an alias.
 * At least one of the three. `key` is the witness's own (minted at setup, `walnut leader witnesses init`),
 * never a host credential.
 */
export interface RemoteWitnessPlace { id: string; machine?: string; host?: string; url?: string; key?: string }
export type WitnessPlace = LocalWitnessPlace | RemoteWitnessPlace

export function isRemoteWitness(w: WitnessPlace): w is RemoteWitnessPlace {
  return !('dir' in w)
}
export function isLocalWitness(w: WitnessPlace): w is LocalWitnessPlace {
  return 'dir' in w
}

export interface MachinePlace {
  id: string
  home: string
  standbyDir: string
  port: number
  /** The account's home dir on that machine: paths under it move to the other machine's (home-paths.ts). */
  accountHome?: string
  start?: string[]
  env?: Record<string, string>
}

export interface LeaderSwitchSettings {
  witnesses: WitnessPlace[]
  machines: MachinePlace[]
  backWindowHours: number
  params: PermitParams
}

export interface HomeSwitchConfig {
  /** The experiment `switchable_leader`. */
  flag: boolean
  settings: LeaderSwitchSettings | null
  /** Why `settings` is null while the flag is on. */
  problem?: string
  standbyDir?: string
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A witness key: 32 random bytes, hex (hmac-proof.ts PROOF_SECRET_RE). */
const KEY_RE = /^[0-9a-f]{64}$/

/**
 * Why `raw` is no direct witness door URL, or null when it is one: https://, or http:// to a
 * loopback address only (an ssh tunnel, a test), no credentials, no query or fragment.
 */
export function witnessUrlRefusal(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return 'not a URL'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'not https://'
  if (u.protocol === 'http:' && !loopbackHost(u.hostname)) return 'http:// only to a loopback address; every other door is https://'
  if (u.username || u.password) return 'a witness URL carries no credentials'
  if (u.search || u.hash) return 'a witness URL carries no query'
  return null
}

/** A loopback host name or address. */
export function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

function parseWitness(x: Record<string, unknown> | undefined): WitnessPlace | string {
  if (!x || !str(x.id)) return 'leader_switch.witnesses: each needs an id'
  const ways = (['machine', 'host', 'url'] as const).filter((k) => str(x[k]))
  if (str(x.dir) === (ways.length > 0)) return 'leader_switch.witnesses: each needs exactly one of dir (a directory here) or a machine, host or url (another machine)'
  if (str(x.dir)) return { id: x.id, dir: path.resolve(x.dir) }
  if (x.key !== undefined && !(typeof x.key === 'string' && KEY_RE.test(x.key))) return `leader_switch.witnesses: ${x.id}'s key is not one \`walnut leader witnesses init\` minted (64 hex)`
  const refusal = str(x.url) ? witnessUrlRefusal(x.url) : null
  if (refusal) return `leader_switch.witnesses: ${x.id}'s url: ${refusal}`
  return {
    id: x.id,
    ...(str(x.machine) ? { machine: x.machine.trim() } : {}),
    ...(str(x.host) ? { host: x.host.trim() } : {}),
    ...(str(x.url) ? { url: x.url.trim().replace(/\/+$/, '') } : {}),
    ...(typeof x.key === 'string' ? { key: x.key } : {}),
  }
}

/** Every place a witness names: two witnesses that share one count one machine twice. */
function placesNamed(w: WitnessPlace): string[] {
  if (!isRemoteWitness(w)) return [`dir:${w.dir}`]
  return [...(w.machine ? [`machine:${w.machine}`] : []), ...(w.host ? [`host:${w.host.toLowerCase()}`] : []), ...(w.url ? [`url:${w.url}`] : [])]
}

export function readHomeConfigRaw(home: string): Record<string, unknown> {
  const file = path.join(home, 'config.yaml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  const doc = YAML.parse(text) as unknown
  return doc && typeof doc === 'object' ? doc as Record<string, unknown> : {}
}

export function parseSwitchSettings(raw: unknown): { settings: LeaderSwitchSettings | null; problem?: string } {
  if (!raw || typeof raw !== 'object') return { settings: null, problem: 'config.yaml has no leader_switch section' }
  const o = raw as Record<string, unknown>
  const witnesses: WitnessPlace[] = []
  for (const w of Array.isArray(o.witnesses) ? o.witnesses : []) {
    const parsed = parseWitness(w && typeof w === 'object' ? w as Record<string, unknown> : undefined)
    if (typeof parsed === 'string') return { settings: null, problem: parsed }
    witnesses.push(parsed)
  }
  if (witnesses.length < 3) return { settings: null, problem: `leader_switch.witnesses lists ${witnesses.length}; at least three are needed for a majority that survives one loss` }
  if (new Set(witnesses.map((w) => w.id)).size !== witnesses.length) return { settings: null, problem: 'leader_switch.witnesses: ids must be unique' }
  // A `dir` is a path on THIS computer, and the config travels with the home: on another machine the same line names a
  // different directory, so one witness id would be two witnesses with two records. Once a witness is on another machine
  // every witness is named by its machine (`host`), which means the same machine from wherever the config is read.
  if (witnesses.some(isRemoteWitness) && witnesses.some(isLocalWitness)) {
    return { settings: null, problem: 'leader_switch.witnesses: with a witness kept by a machine (machine, host or url), every witness needs a host, machine or url: a dir is a path on one computer only, and the config is read on both machines' }
  }
  // Two witness ids that reach one machine would be one witness counted twice: a majority that is not one.
  const where = witnesses.flatMap(placesNamed)
  if (new Set(where).size !== where.length) return { settings: null, problem: 'leader_switch.witnesses: each witness needs its own dir, machine, host and url (two ids on one place count one machine twice)' }
  const machines: MachinePlace[] = []
  for (const m of Array.isArray(o.machines) ? o.machines : []) {
    const x = m as Record<string, unknown>
    const port = Number(x?.port)
    if (!str(x?.id) || !str(x?.home) || !str(x?.standby_dir) || !Number.isInteger(port) || port <= 0) {
      return { settings: null, problem: 'leader_switch.machines: each needs id, home, standby_dir and port' }
    }
    const start = Array.isArray(x.start_command) && x.start_command.every(str) ? x.start_command as string[] : undefined
    const env = x.env && typeof x.env === 'object'
      ? Object.fromEntries(Object.entries(x.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined
    const accountHome = str(x.account_home) ? x.account_home : env?.HOME
    machines.push({ id: x.id, home: path.resolve(x.home), standbyDir: path.resolve(x.standby_dir), port, ...(accountHome ? { accountHome } : {}), ...(start ? { start } : {}), ...(env ? { env } : {}) })
  }
  if (machines.length < 2) return { settings: null, problem: 'leader_switch.machines must list the two machines a leader can move between' }
  if (new Set(machines.map((m) => m.id)).size !== machines.length) return { settings: null, problem: 'leader_switch.machines: ids must be unique' }
  const hours = Number(o.back_window_hours)
  return {
    settings: {
      witnesses,
      machines,
      backWindowHours: Number.isFinite(hours) && hours > 0 ? hours : 168,
      params: { ...DEFAULT_PERMIT_PARAMS },
    },
  }
}

export function readHomeSwitchConfig(home: string): HomeSwitchConfig {
  const raw = readHomeConfigRaw(home)
  // Read as the server reads it: its own switch, else "Every experiment on".
  const flag = experimentalEnabled(raw.experimental as ExperimentalFlags | undefined, 'switchable_leader')
  const standby = raw.standby as Record<string, unknown> | undefined
  const standbyDir = str(standby?.dir) ? path.resolve(standby.dir) : undefined
  if (!flag) return { flag, settings: null, ...(standbyDir ? { standbyDir } : {}) }
  const { settings, problem } = parseSwitchSettings(raw.leader_switch)
  return { flag, settings, ...(problem ? { problem } : {}), ...(standbyDir ? { standbyDir } : {}) }
}

export function machineById(s: LeaderSwitchSettings, id: string): MachinePlace | undefined {
  return s.machines.find((m) => m.id === id)
}

export function machineByHome(s: LeaderSwitchSettings, home: string): MachinePlace | undefined {
  const h = path.resolve(home)
  return s.machines.find((m) => m.home === h)
}
