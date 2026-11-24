/**
 * The leader-switch rehearsal's world, on one computer: two "machines" A and B (each its own
 * folder used as HOME, a data home, a standby target and a machine-id file), three witness
 * directories, and A's config.yaml naming all of it. Shared by the rehearsal
 * (scripts/leader-switch-rehearsal.ts) and its test (tests/e2e/leader-switch-real-*.test.ts).
 *
 * Nothing here reads or writes outside `root`: no ~/.open-walnut, no :3456.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { LocalSide } from '../../src/core/leader/switch/side.js'
import { setUpLocalWitnesses } from '../../src/core/leader/switch/local-witnesses.js'
import type { LocalWitnessPlace, MachinePlace } from '../../src/core/leader/switch/settings.js'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export interface Machine extends MachinePlace { dir: string; idFile: string }

export interface World {
  root: string
  a: Machine
  b: Machine
  witnesses: LocalWitnessPlace[]
  side(m: Machine): LocalSide
  /** One request to a machine's server; `opId` sends x-walnut-op-id. */
  api(m: Machine, method: string, urlPath: string, body?: unknown, opId?: string): Promise<{ status: number; json: any; headers: Headers }>
  /** `walnut <args>` with the leader's home, as a separate process; resolves with its exit and output. */
  cli(home: string, args: string[], env?: Record<string, string>): Promise<{ code: number | null; signal: string | null; out: string }>
  /**
   * A machine's server started by hand, as a person (or a launcher) would: its log in the
   * machine's folder, never in the home (LocalSide logs into the home's switch folder).
   * Resolves once it answers /api/leader/status, or exits.
   */
  byHand(m: Machine, label: string, timeoutMs?: number): Promise<ByHand>
}

export interface ByHand { ok: boolean; pid?: number; log: string; logText(): string; stop(): Promise<void> }

function machine(root: string, name: string, port: number, homeName = 'home', at?: string): Machine {
  const dir = at ?? path.join(root, name)
  const idFile = path.join(dir, 'machine-id')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(idFile, `machine-${name}\n`)
  const home = path.join(dir, homeName)
  return {
    id: `machine-${name}`,
    dir,
    idFile,
    home,
    standbyDir: path.join(dir, 'standby'),
    port,
    start: [process.execPath, path.join(REPO, 'scripts/leader-switch/rehearsal-server.ts'), '--port', String(port)],
    env: { HOME: dir, USERPROFILE: dir, WALNUT_MACHINE_ID_FILE: idFile, WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'daemon-streams') },
  }
}

/** `extra`: more leader_switch keys (commit_window_s, stop_wait_s), and the doors each machine is reached at. */
export function switchConfig(w: { a: Machine; b: Machine; witnesses: LocalWitnessPlace[] }, standbyDir: string, intervalSeconds = 5, extra: WorldExtra = {}): Record<string, unknown> {
  const m = (x: Machine, doors?: string[]) => ({ id: x.id, home: x.home, standby_dir: x.standbyDir, port: x.port, start_command: x.start, env: x.env, ...(doors?.length ? { doors } : {}) })
  return {
    experimental: { switchable_leader: true },
    standby: { dir: standbyDir, interval_seconds: intervalSeconds },
    leader_switch: { witnesses: w.witnesses.map((x) => ({ id: x.id, dir: x.dir })), machines: [m(w.a, extra.doorsA), m(w.b, extra.doorsB)], back_window_hours: 24, ...(extra.leaderSwitch ?? {}) },
  }
}

export interface WorldExtra { leaderSwitch?: Record<string, unknown>; doorsA?: string[]; doorsB?: string[] }

/** `homeA`: A's data home's name in its folder (`.open-walnut`: where an install keeps it, in HOME). */
/** `dirB`: B's machine folder (its HOME) somewhere else than `<root>/b`, for a home that moves to another prefix. */
export function makeWorld(root: string, opts: { portA: number; portB: number; intervalSeconds?: number; homeA?: string; dirB?: string } & WorldExtra): World {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const a = machine(root, 'a', opts.portA, opts.homeA)
  const b = machine(root, 'b', opts.portB, 'home', opts.dirB)
  const witnesses = ['w1', 'w2', 'w3'].map((id) => ({ id, dir: path.join(root, 'witnesses', id) }))
  fs.mkdirSync(a.home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(a.home, 'config.yaml'), YAML.stringify(switchConfig({ a, b, witnesses }, b.standbyDir, opts.intervalSeconds, opts)))
  setUpLocalWitnesses(witnesses)
  const world: World = {
    root, a, b, witnesses,
    side: (m) => new LocalSide(m),
    async api(m, method, urlPath, body, opId) {
      const res = await fetch(`http://127.0.0.1:${m.port}${urlPath}`, {
        method,
        headers: { 'content-type': 'application/json', ...(opId ? { 'x-walnut-op-id': opId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      })
      return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
    },
    cli(home, args, env = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO, 'src/cli.ts'), ...args], {
          env: { ...process.env, OPEN_WALNUT_HOME: home, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        child.stdout.on('data', (d) => { out += String(d) })
        child.stderr.on('data', (d) => { out += String(d) })
        child.on('exit', (code, signal) => resolve({ code, signal, out }))
      })
    },
    async byHand(m, label, timeoutMs = 120_000) {
      const log = path.join(m.dir, `by-hand-${label}.log`)
      const fd = fs.openSync(log, 'a', 0o600)
      const cmd = m.start!
      const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...m.env, OPEN_WALNUT_HOME: m.home }, detached: true, stdio: ['ignore', fd, fd] })
      fs.closeSync(fd)
      let exited = false
      child.on('exit', () => { exited = true })
      child.unref()
      const logText = () => { try { return fs.readFileSync(log, 'utf8') } catch { return '' } }
      const alive = () => { try { process.kill(child.pid!, 0); return true } catch { return false } }
      const stop = async () => {
        if (!child.pid || !alive()) return
        try { process.kill(child.pid, 'SIGTERM') } catch { /* gone */ }
        for (let i = 0; i < 300 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
        if (alive()) try { process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !exited) {
        const r = await fetch(`http://127.0.0.1:${m.port}/api/leader/status`, { signal: AbortSignal.timeout(5_000) }).catch(() => null)
        if (r) return { ok: true, pid: child.pid, log, logText, stop }
        await new Promise((res) => setTimeout(res, 250))
      }
      await stop()
      return { ok: false, log, logText, stop }
    },
  }
  return world
}
