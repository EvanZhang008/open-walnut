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
 *       relay: w-k               #   relay: also through the door of that witness (the companion), which passes the
 *                                #   call to this witness's machine over a stream it parked there (witness-relay.ts)
 *   relay_commit: true         # a switch whose commit majority needs a relay may go (default: refused, this phase)
 *   machines:
 *     - id: <machine id>       # this machine's stable id (src/core/machine-id.ts)
 *       home: /path/to/home    # its data home when it leads
 *       standby_dir: /path     # where the other leader's standby batches land on it
 *       port: 3456
 *       account_home: /home/me # optional: the account's home dir there (default: env.HOME below);
 *                              # the switch moves paths under it to the other machine's
 *       start_command: [...]   # optional: how to start its server (default: this CLI's `web --port`)
 *       env: { K: V }          # optional: extra environment for that server
 *       doors: [wss://...]     # optional: where hosts reach its server when it leads (its leader door, wss:// or https://;
 *                              # ws:// or http:// to loopback): the old machine's standby names them, hosts follow them
 *       host_key: dev-box      # optional: the name the OTHER machine's leader gives this machine in its `hosts`
 *                              # (when this machine is the old leader, it becomes that leader's host by it)
 *   back_window_hours: 168     # `--back` is offered this long after a switch
 *   commit_window_s: 300       # from the handover to the new leader's commit start, at most
 *   stop_wait_s: 120           # the old leader cancels its own handover when no switch stop came this long after it
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../permit/types.js'
import { checkTiming } from '../permit/rules.js'
import { experimentalEnabled, type ExperimentalFlags } from '../../experimental.js'
import { log } from '../../../logging/index.js'
import { WITNESS_RELAY_SUB } from './witness-wire.js'

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
export interface RemoteWitnessPlace {
  id: string; machine?: string; host?: string; url?: string; key?: string
  /** `relay`: the id of the witness whose door relays to this one (its door has a url); `relayUrl` is that door's relay, `<url>/relay`. */
  relay?: string; relayUrl?: string
}
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
  /** Where hosts and devices reach this machine's server when it leads (wss:// or https://, ws:// or http:// to loopback): told by the old machine's standby after a switch. */
  doors?: string[]
  /** The name the other machine's leader gives this machine in its `hosts` (host_key): the old leader becomes its host by it. */
  hostKey?: string
}

/** Why `raw` is no leader door address (null: it is one): wss:// or https://, ws:// or http:// only to loopback, no credentials or query. */
export function doorAddressRefusal(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return 'not a URL'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(u.protocol)) return 'not wss:// or https://'
  if ((u.protocol === 'http:' || u.protocol === 'ws:') && !loopbackHost(u.hostname)) return 'ws:// and http:// only to a loopback address'
  if (u.username || u.password) return 'a door address carries no credentials'
  if (u.search || u.hash) return 'a door address carries no query'
  return null
}

export interface LeaderSwitchSettings {
  witnesses: WitnessPlace[]
  machines: MachinePlace[]
  backWindowHours: number
  params: PermitParams
  /** How long a switch may take from the handover to the new leader's commit start (commit_window_s, default 300 s). */
  commitWindowMs: number
  /** How long the old leader waits for its switch stop after its handover before it cancels the handover itself (stop_wait_s, default 120 s). */
  stopWaitMs: number
  /**
   * `relay_commit: true`: a switch whose commit majority needs a witness reached only through a relay may go. Off by default:
   * this phase such a switch (a Mac with no witness of its own as the new leader) is refused by the preflight, which names it.
   */
  relayCommit: boolean
}

export const DEFAULT_COMMIT_WINDOW_S = 300
export const DEFAULT_STOP_WAIT_S = 120

export interface HomeSwitchConfig {
  /** The experiment `switchable_leader`. */
  flag: boolean
  settings: LeaderSwitchSettings | null
  /** Why `settings` is null while the flag is on. */
  problem?: string
  standbyDir?: string
  /** standby.host: the copy goes to another machine, over the leader's link to its daemon (the copy link kind daemon). */
  standbyHost?: string
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A witness key: 32 random bytes, hex (hmac-proof.ts PROOF_SECRET_RE). */
const KEY_RE = /^[0-9a-f]{64}$/

/** A door URL as it is stored and compared: the URL's own normal form (scheme and host lower case, default port dropped), no trailing slash. */
export function normalWitnessUrl(raw: string): string {
  const u = new URL(raw.trim())
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

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
    ...(str(x.url) ? { url: normalWitnessUrl(x.url) } : {}),
    ...(typeof x.key === 'string' ? { key: x.key } : {}),
    ...(str(x.relay) ? { relay: x.relay.trim() } : {}),
  }
}

/** Each `relay` names another witness of the list that has a door url (never itself, never one that is relayed in turn): its relay door is set. */
function resolveRelays(witnesses: WitnessPlace[]): string | null {
  for (const w of witnesses) {
    if (!isRemoteWitness(w) || !w.relay) continue
    const via = witnesses.find((v) => v.id === w.relay)
    if (!via || via === w) return `leader_switch.witnesses: ${w.id}'s relay names no other witness of the list (${w.relay})`
    if (!isRemoteWitness(via) || !via.url) return `leader_switch.witnesses: ${w.id}'s relay ${via.id} has no door url to relay through`
    if (via.relay) return `leader_switch.witnesses: ${w.id}'s relay ${via.id} is itself relayed (one hop only)`
    w.relayUrl = `${via.url}${WITNESS_RELAY_SUB}`
  }
  return null
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
  const relayProblem = resolveRelays(witnesses)
  if (relayProblem) return { settings: null, problem: relayProblem }
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
    let doors: string[] | undefined
    if (x.doors !== undefined) {
      if (!Array.isArray(x.doors) || x.doors.length > 8 || !x.doors.every((d) => doorAddressRefusal(d) === null)) {
        return { settings: null, problem: `leader_switch.machines: ${x.id}'s doors must be a list of wss:// or https:// addresses (ws:// or http:// only to loopback)` }
      }
      doors = (x.doors as string[]).map((d) => d.replace(/\/+$/, ''))
    }
    if (x.host_key !== undefined && !(typeof x.host_key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x.host_key))) {
      return { settings: null, problem: `leader_switch.machines: ${x.id}'s host_key must be a host name (letters, digits, . _ -)` }
    }
    const hostKey = typeof x.host_key === 'string' ? x.host_key : undefined
    machines.push({ id: x.id, home: path.resolve(x.home), standbyDir: path.resolve(x.standby_dir), port, ...(accountHome ? { accountHome } : {}), ...(start ? { start } : {}), ...(env ? { env } : {}), ...(doors ? { doors } : {}), ...(hostKey ? { hostKey } : {}) })
  }
  if (machines.length < 2) return { settings: null, problem: 'leader_switch.machines must list the two machines a leader can move between' }
  if (new Set(machines.map((m) => m.id)).size !== machines.length) return { settings: null, problem: 'leader_switch.machines: ids must be unique' }
  const hours = Number(o.back_window_hours)
  const seconds = (v: unknown, dflt: number, min: number) => { const n = Number(v); return (Number.isFinite(n) && n >= min ? n : dflt) * 1000 }
  return {
    settings: {
      witnesses,
      machines,
      backWindowHours: Number.isFinite(hours) && hours > 0 ? hours : 168,
      params: permitParamsFor(process.env, witnesses),
      commitWindowMs: seconds(o.commit_window_s, DEFAULT_COMMIT_WINDOW_S, 30),
      stopWaitMs: seconds(o.stop_wait_s, DEFAULT_STOP_WAIT_S, 10),
      relayCommit: o.relay_commit === true,
    },
  }
}

/** The shortest record WALNUT_LEADER_PERMIT_VALID_MS may ask for (the runtime tests' 3 s). */
const MIN_SCALED_VALID_MS = 3_000

/** The knob was set where it is not honoured: said once per process. */
let scaledRefusedSaid = false

/**
 * The permit's clocks. WALNUT_LEADER_PERMIT_VALID_MS: the live tests' scaled time (as
 * WALNUT_LEADER_RESTART_GRACE_MS and WALNUT_LEADER_HEARTBEAT_MS), between 3 s and the default 60 s;
 * every other time of the permit scales with it, so the margins still cover the same drift.
 * Honoured only when every witness of `witnesses` is a witness dir (the one-computer test layout):
 * with a machine witness or a remote one (a real setup) the default clocks run and a warning says
 * why. A witness this machine keeps is also opened by other machines' calls with the default, and a
 * witness on another machine refuses a scaled record (bad-validity). Whatever runs, a witness keeps
 * a held record for the longer of the two validities (rules.ts holdsForHolder).
 */
export function permitParamsFor(env: NodeJS.ProcessEnv = process.env, witnesses: readonly WitnessPlace[] = []): PermitParams {
  const want = Number(env.WALNUT_LEADER_PERMIT_VALID_MS)
  if (!Number.isFinite(want) || want < MIN_SCALED_VALID_MS || want >= DEFAULT_PERMIT_PARAMS.validMs) return { ...DEFAULT_PERMIT_PARAMS }
  if (witnesses.length === 0 || !witnesses.every(isLocalWitness)) {
    if (!scaledRefusedSaid) {
      scaledRefusedSaid = true
      log.leader.warn('leader switch: WALNUT_LEADER_PERMIT_VALID_MS is honoured only when every witness is a witness dir (a test layout); the default permit clocks run', { asked: want })
    }
    return { ...DEFAULT_PERMIT_PARAMS }
  }
  const f = Math.floor(want) / DEFAULT_PERMIT_PARAMS.validMs
  const d = DEFAULT_PERMIT_PARAMS
  const scaled: PermitParams = {
    ...d,
    validMs: Math.floor(want), renewEveryMs: Math.round(d.renewEveryMs * f), holderMarginMs: Math.round(d.holderMarginMs * f),
    witnessMarginMs: Math.round(d.witnessMarginMs * f), minSendRemainingMs: Math.round(d.minSendRemainingMs * f),
    backoffBaseMs: Math.max(1, Math.round(d.backoffBaseMs * f)), backoffMaxMs: Math.max(1, Math.round(d.backoffMaxMs * f)),
  }
  try { checkTiming(scaled); return scaled } catch { return { ...DEFAULT_PERMIT_PARAMS } }
}

export function readHomeSwitchConfig(home: string): HomeSwitchConfig {
  const raw = readHomeConfigRaw(home)
  // Read as the server reads it: its own switch, else "Every experiment on".
  const flag = experimentalEnabled(raw.experimental as ExperimentalFlags | undefined, 'switchable_leader')
  const standby = raw.standby as Record<string, unknown> | undefined
  const standbyDir = str(standby?.dir) ? path.resolve(standby.dir) : undefined
  const standbyHost = str(standby?.host) ? standby.host : undefined
  const at = { ...(standbyDir ? { standbyDir } : {}), ...(standbyHost ? { standbyHost } : {}) }
  if (!flag) return { flag, settings: null, ...at }
  const { settings, problem } = parseSwitchSettings(raw.leader_switch)
  return { flag, settings, ...(problem ? { problem } : {}), ...at }
}

/**
 * The standby copy's switch config, read whole: a batch swaps each file in by two renames (standby/target.ts
 * swapIn), so for a moment a file is not there. Its config.yaml missing is read again for up to `waitMs`.
 */
export async function readCopySwitchConfig(copy: string, waitMs = 5_000): Promise<HomeSwitchConfig> {
  const until = Date.now() + waitMs
  for (;;) {
    const cfg = readHomeSwitchConfig(copy)
    if (cfg.flag || fs.existsSync(path.join(copy, 'config.yaml')) || Date.now() > until) return cfg
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function machineById(s: LeaderSwitchSettings, id: string): MachinePlace | undefined {
  return s.machines.find((m) => m.id === id)
}

export function machineByHome(s: LeaderSwitchSettings, home: string): MachinePlace | undefined {
  const h = path.resolve(home)
  return s.machines.find((m) => m.home === h)
}
