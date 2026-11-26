/**
 * The console of a machine that handed the leader over (docs/reference/leader-switch.md, "The old
 * leader's console"). After a switch the old machine is a host of the new leader, and its host
 * replica (the one its daemon runs for the new leader, as on every host) serves the console on the
 * address its leader server used (replica/console-door.ts): the Mac app, a browser and the CLI on
 * that machine keep using http://localhost:<port>.
 *
 * Two files, machine-local and outside every data dir (beside this account's machine id, so a
 * copy of a data dir never carries them and the handed-over home stays as it was handed over):
 *
 *   console/<walnutId>.json         the old leader's server writes it at the handover
 *                                   (leader/switch/console-credential.ts): the home it handed
 *                                   over, the address it served, the switch, and the token of the
 *                                   console device it minted (its record rides the data to the
 *                                   new leader). 0600.
 *   console/<walnutId>.holder.json  the replica that serves that console, or waits for its port:
 *                                   its pid, state and address. `walnut web` on the handed-over
 *                                   home reads it to give the port up (handed-over.ts).
 *
 * The console stands only while the handed-over home's own marker says so: state `handed-over`
 * and the same switch. A cancelled switch removes the marker, a switch back moves the home aside:
 * either ends it, and the replica closes the door.
 *
 * Reads nothing of src/core/leader/: a replica uses this, and a leader with no witnesses loads
 * no switch code.
 */
import fs from 'node:fs'
import path from 'node:path'
import { machineIdFile } from './machine-id.js'
import { LEADER_SWITCH_MARKER_REL } from '../lib/leader-home-gate.js'

export interface HandedOverConsole {
  v: 1
  /** The Walnut whose leader moved (its instance id: the same on both machines). */
  walnutId: string
  /** The home that handed the leader over (absolute). */
  home: string
  /** The address its leader server listened on: the console's. */
  port: number
  host: string
  switchId: string
  /** The machine the lead went to. */
  to: string
  /** The console device's name on the leader, and its token (the record holds only the hash). */
  device: string
  token: string
  at: string
}

export type HolderState = 'waiting' | 'serving'

export interface ConsoleHolder {
  pid: number
  state: HolderState
  port: number
  host: string
  since: string
}

const ID = /^[A-Za-z0-9_-]{1,128}$/

/** The account's console files (beside its machine id, outside every data dir). */
export function consoleDir(): string {
  return path.join(path.dirname(machineIdFile()), 'console')
}

/** The console files of the account whose home is `accountHome` (a switch's side of another account, a rehearsal machine). */
export function consoleDirOfAccount(accountHome: string): string {
  return path.join(path.dirname(machineIdFile(accountHome)), 'console')
}

function fileOf(walnutId: string, dir: string): string {
  if (!ID.test(walnutId)) throw new Error(`not a Walnut id: ${walnutId}`)
  return path.join(dir, `${walnutId}.json`)
}

function holderFileOf(walnutId: string, dir: string): string {
  if (!ID.test(walnutId)) throw new Error(`not a Walnut id: ${walnutId}`)
  return path.join(dir, `${walnutId}.holder.json`)
}

function writePrivate(file: string, body: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode does not tighten a folder that was there already; a leftover tmp file keeps its own.
  fs.chmodSync(dir, 0o700)
  const tmp = `${file}.${process.pid}.tmp`
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
}

function parse(raw: unknown): HandedOverConsole | null {
  const c = raw as Partial<HandedOverConsole> | null
  if (!c || c.v !== 1) return null
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096
  if (!str(c.walnutId) || !ID.test(c.walnutId!) || !str(c.home) || !path.isAbsolute(c.home!) || !str(c.host)) return null
  if (!Number.isInteger(c.port) || c.port! <= 0 || c.port! >= 65536) return null
  if (!str(c.switchId) || !str(c.to) || !str(c.device) || !str(c.token) || c.token!.length < 32) return null
  return c as HandedOverConsole
}

export function writeConsoleFile(c: HandedOverConsole, dir = consoleDir()): void {
  writePrivate(fileOf(c.walnutId, dir), c)
}

/** The console file of `walnutId`, or null (none, unreadable, not one). */
export function readConsoleFile(walnutId: string, dir = consoleDir()): HandedOverConsole | null {
  try {
    return parse(JSON.parse(fs.readFileSync(fileOf(walnutId, dir), 'utf8')))
  } catch {
    return null
  }
}

/** readConsoleFile off the event loop: what a server's timer reads (every host replica looks each second). */
export async function readConsoleFileAsync(walnutId: string, dir = consoleDir()): Promise<HandedOverConsole | null> {
  try {
    return parse(JSON.parse(await fs.promises.readFile(fileOf(walnutId, dir), 'utf8')))
  } catch {
    return null
  }
}

/** Every console file naming `home` (one per Walnut that home led). */
export function consolesOfHome(home: string, dir = consoleDir()): HandedOverConsole[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const want = path.resolve(home)
  const out: HandedOverConsole[] = []
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith('.holder.json')) continue
    try {
      const c = parse(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
      if (c && path.resolve(c.home) === want) out.push(c)
    } catch { /* another's, or broken */ }
  }
  return out
}

/** The leader switch's handed-over marker of a home (lib/leader-home-gate.ts: the one definition of its place). */
export function handedOverMarkerFile(home: string): string {
  return path.join(home, LEADER_SWITCH_MARKER_REL)
}

/** A home that handed the leader over, or is handing it over: it carries the switch's marker. */
export function hasHandedOverMarker(home: string): boolean {
  return fs.existsSync(handedOverMarkerFile(home))
}

/** Why the console of `c` does not stand now, or null when it does: the home's own marker decides (read only). */
export function consoleRefusal(c: HandedOverConsole): string | null {
  let text: string
  try {
    text = fs.readFileSync(handedOverMarkerFile(c.home), 'utf8')
  } catch {
    return `${c.home} carries no handed-over marker (the switch was cancelled, or the home was replaced)`
  }
  let m: { state?: unknown; switchId?: unknown } | null
  try { m = JSON.parse(text) as typeof m } catch { return `${c.home}'s handed-over marker does not read` }
  if (m?.switchId !== c.switchId) return `${c.home} was handed over by another switch (${String(m?.switchId)}, not ${c.switchId})`
  if (m?.state !== 'handed-over') return `the switch ${c.switchId} has not committed (${String(m?.state)})`
  return null
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

export function writeHolder(walnutId: string, h: ConsoleHolder, dir = consoleDir()): void {
  writePrivate(holderFileOf(walnutId, dir), h)
}

/** The live replica holding (or waiting for) the console of `walnutId`, or null: none, or its process is gone. */
export function readHolder(walnutId: string, dir = consoleDir()): ConsoleHolder | null {
  try {
    const h = JSON.parse(fs.readFileSync(holderFileOf(walnutId, dir), 'utf8')) as Partial<ConsoleHolder>
    if (typeof h.pid !== 'number' || !alive(h.pid)) return null
    if (h.state !== 'waiting' && h.state !== 'serving') return null
    if (!Number.isInteger(h.port) || typeof h.host !== 'string') return null
    return h as ConsoleHolder
  } catch {
    return null
  }
}

/**
 * Removes every console file naming `home` (a console that will never stand: its handover did not
 * happen, or the home leads again), and the holder file of each when no live process holds it.
 * Returns the Walnut ids it removed.
 */
export function removeConsolesOfHome(home: string, dir = consoleDir()): string[] {
  const gone: string[] = []
  for (const c of consolesOfHome(home, dir)) {
    try { fs.unlinkSync(fileOf(c.walnutId, dir)) } catch { continue }
    gone.push(c.walnutId)
    if (!readHolder(c.walnutId, dir)) { try { fs.unlinkSync(holderFileOf(c.walnutId, dir)) } catch { /* none */ } }
  }
  return gone
}

/** Removes the holder file when `pid` wrote it. */
export function clearHolder(walnutId: string, pid: number, dir = consoleDir()): void {
  const file = holderFileOf(walnutId, dir)
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid === pid) fs.unlinkSync(file)
  } catch { /* gone */ }
}
