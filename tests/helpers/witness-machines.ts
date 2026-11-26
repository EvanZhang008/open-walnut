/**
 * Real witness machines on one computer for the leader switch's tests: each is a real leader door
 * (src/replica/leader-door.ts) behind a real TCP loopback listener, serving its witness route from
 * its own state root on disk. `loopbackCall` is a RemoteCall that sends the request as real HTTP
 * bytes over a fresh loopback connection, the way the daemon's relayed stream carries it (one
 * request per stream, host-server/request-over.ts). It is every layer of a witness call but the
 * daemon and the ssh hop.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createLeaderDoor } from '../../src/replica/leader-door.js'
import { requestOver } from '../../src/core/host-server/request-over.js'
import type { DeviceCopy } from '../../src/host-server/device-copy.js'
import type { RemoteCall } from '../../src/core/leader/switch/witness-transport.js'
import { WITNESS_DOOR_PATH } from '../../src/core/leader/switch/witness-wire.js'

export interface WitnessMachine {
  host: string
  port: number
  root: string
  /** The experiment `switchable_leader` on this machine (a host's config copy of the leader's). */
  enabled: boolean
  /** The Walnut this machine's service follows. */
  walnutId: string | null
  /** Refuse new connections from now on (the machine is down); true brings it back. */
  setUp(up: boolean): void
  close(): Promise<void>
}

export async function startWitnessMachine(o: { host: string; root: string; walnutId: string | null; enabled?: boolean }): Promise<WitnessMachine> {
  const m: WitnessMachine = {
    host: o.host, port: 0, root: o.root, enabled: o.enabled ?? true, walnutId: o.walnutId,
    setUp: (up) => { down = !up; if (down) for (const s of sockets) s.destroy() },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); await door.close() },
  }
  let down = false
  const sockets = new Set<net.Socket>()
  const door = createLeaderDoor({
    devices: { put: async () => ({}) } as unknown as DeviceCopy,
    witness: { enabled: async () => m.enabled, walnutId: () => m.walnutId, root: () => m.root },
  })
  const server = net.createServer((sock) => {
    if (down) { sock.destroy(); return }
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    door.accept(sock)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  m.port = (server.address() as net.AddressInfo).port
  return m
}

/** A call to `machines[place.host]` over a fresh loopback connection (a witness whose host is not a machine here: no answer). */
export function loopbackCall(machines: Record<string, { port: number }>, opts: { delayMs?: number; timeoutMs?: number } = {}): RemoteCall {
  return (place, path, body, done) => {
    const m = place.host ? machines[place.host] : undefined
    if (!m) { done(null); return }
    let sock: net.Socket | null = null
    let gone = false
    const go = (): void => {
      if (gone) return
      sock = net.connect(m.port, '127.0.0.1')
      sock.on('error', () => done(null))
      requestOver(sock, 'POST', path, Buffer.from(JSON.stringify(body)), opts.timeoutMs ?? 5_000)
        .then(async (res) => done({ status: res.status, body: await res.json().catch(() => null) }))
        .catch(() => done(null))
    }
    if (opts.delayMs) setTimeout(go, opts.delayMs); else go()
    return () => { gone = true; sock?.destroy() }
  }
}

/** Setup evidence of a Walnut that never had a record: every other witness seen blank. */
export function blankEvidence(list: string[], target: string): Array<{ witness: string; seen: 'blank' }> {
  return list.filter((w) => w !== target).map((witness) => ({ witness, seen: 'blank' as const }))
}

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })

/**
 * A dev box's service with a witness door: the real host replica program (`walnut web --replica`, as its
 * host daemon starts it) with the capability witness-door, its machine state (machine id, witness root) in
 * `machineDir`. Resolves with its public port once its door answers (for `witness`, a witness it holds no
 * record of yet). Shared by tests/e2e/leader-switch-no-link-e2e.test.ts and the cross-machine rehearsal.
 */
export async function startHostReplicaDoor(o: { base: string; machineDir: string; machineId: string; walnutId: string; witness: string; env?: Record<string, string>; pidOnly?: boolean }): Promise<{ port: number; proc: ChildProcess; log: () => string; stop: () => Promise<void> }> {
  const home = path.join(o.base, 'home')
  const data = path.join(home, '.open-walnut-host', 'data')
  const run = path.join(home, '.open-walnut-host', 'run')
  const hostd = path.join(o.base, 'hostd')
  for (const d of [data, run, hostd, o.machineDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const idFile = path.join(o.machineDir, 'machine-id')
  if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, `${o.machineId}\n`)
  const at = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(), NODE_ENV: 'production', NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    WALNUT_HOST_DAEMON_DIR: hostd, WALNUT_DAEMON_DIR: run, OPEN_WALNUT_HOME: data,
    WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(at), WALNUT_WALNUT_ID: o.walnutId, WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_FOLLOWER_TOKEN: crypto.randomBytes(16).toString('hex'),
    WALNUT_CAPABILITIES: 'witness-door', WALNUT_MACHINE_ID_FILE: idFile,
    ...(o.env ?? {}),
  }
  let out = ''
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '../../src/cli.ts'), 'web', '--replica', '--dev'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  // Its whole process group (it was spawned detached as its own group), or with `pidOnly` (rehearsal (b): a
  // machine where nothing signals a group) the process alone, its children left to that machine's cleanup.
  const signal = (s: NodeJS.Signals) => process.kill(o.pidOnly ? proc.pid! : -proc.pid!, s)
  proc.stdout!.on('data', (x: Buffer) => { out = (out + x.toString()).slice(-200_000) })
  proc.stderr!.on('data', (x: Buffer) => { out = (out + x.toString()).slice(-200_000) })
  const deadline = Date.now() + 180_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the host replica exited (${proc.exitCode})\n${out.slice(-3000)}`)
    const r = await fetch(`http://127.0.0.1:${at}${WITNESS_DOOR_PATH}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, walnutId: o.walnutId, witness: o.witness, digest: 'a'.repeat(64), cnonce: 'b'.repeat(64) }) }).catch(() => null)
    if (r && r.status === 404 && ((await r.json().catch(() => ({}))) as { error?: string }).error === 'no_witness_here') break
    if (Date.now() > deadline) { try { signal('SIGKILL') } catch { /* gone */ } throw new Error(`the host replica's witness door did not answer\n${out.slice(-3000)}`) }
    await new Promise((r) => setTimeout(r, 500))
  }
  const stop = async () => {
    if (!proc.pid || proc.exitCode !== null) return
    try { signal('SIGTERM') } catch { return }
    for (let i = 0; i < 100 && proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100))
    if (proc.exitCode === null) try { signal('SIGKILL') } catch { /* gone */ }
  }
  return { port: at, proc, log: () => out, stop }
}
