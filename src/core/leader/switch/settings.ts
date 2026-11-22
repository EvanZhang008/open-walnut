/**
 * The switch's settings, read from a home's config.yaml (`leader_switch:`), with the
 * experiment `switchable_leader`. config.yaml is leader data, so both machines read the same
 * table: each machine's own places are listed under its id.
 *
 * ```yaml
 * leader_switch:
 *   witnesses:                 # three, a majority of two; this phase: local directories
 *     - { id: w1, dir: /srv/walnut-witness/w1 }
 *   machines:
 *     - id: <machine id>       # this machine's stable id (src/core/machine-id.ts)
 *       home: /path/to/home    # its data home when it leads
 *       standby_dir: /path     # where the other leader's standby batches land on it
 *       port: 3456
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

export interface WitnessPlace { id: string; dir: string }

export interface MachinePlace {
  id: string
  home: string
  standbyDir: string
  port: number
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
    const x = w as Record<string, unknown>
    if (!str(x?.id) || !str(x?.dir)) return { settings: null, problem: 'leader_switch.witnesses: each needs id and dir' }
    witnesses.push({ id: x.id, dir: path.resolve(x.dir) })
  }
  if (witnesses.length < 3) return { settings: null, problem: `leader_switch.witnesses lists ${witnesses.length}; at least three are needed for a majority that survives one loss` }
  if (new Set(witnesses.map((w) => w.id)).size !== witnesses.length) return { settings: null, problem: 'leader_switch.witnesses: ids must be unique' }
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
    machines.push({ id: x.id, home: path.resolve(x.home), standbyDir: path.resolve(x.standby_dir), port, ...(start ? { start } : {}), ...(env ? { env } : {}) })
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
