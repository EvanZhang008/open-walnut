/**
 * The fleet: Walnut's real programs on separate machines with real links
 * (tests/fleet/README.md).
 *
 *   the Mac: this machine, a Walnut server child (mac-node.ts) with its own data,
 *     daemon and temp dirs, HOME and port
 *     | OpenSSH with this run's key and config (ssh-identity.ts)
 *     | -> a fault proxy per host on 127.0.0.1 (tests/helpers/silent-link-proxy.ts)
 *     | -> the port Docker publishes on 127.0.0.1
 *     v
 *   each host: a Linux container (host-image/) running sshd as user walnut, a mock
 *     `claude` on PATH, and NO daemon: the Mac deploys it over SSH when it connects,
 *     into the host's production paths (/tmp/open-walnut, ~/.open-walnut/tmp)
 *
 * Faults: sleepMac / wakeMac (SIGSTOP / SIGCONT of the Mac's pinned processes),
 * pauseHost / unpauseHost (`docker pause`: the host freezes with its sockets
 * open), cutLink / healLink (the proxy goes silent, or drops every connection,
 * and comes back), slowLink (latency and a byte rate). A clock offset per host
 * (libfaketime through the host's ~/.ssh/environment) is an option of startFleet.
 *
 * Everything Docker side is named walnut-fleet-<run>-* (docker.ts), bound to
 * 127.0.0.1, limited in memory, CPU and pids, and removed by stop() or by the
 * sweep the next run starts with.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from '../../src/lib/sqlite.js'
import { startSilentLinkProxy, type SilentLinkProxy, type SlowLink } from '../helpers/silent-link-proxy.js'
import { waitFor } from '../helpers/replica-cluster.js'
import * as dk from './docker.js'
import { makeSshIdentity, type SshIdentity } from './ssh-identity.js'
import { saveMacLogs, startMac, type MacNode, type MacProgram, type MacSeed } from './mac-node.js'

export const BASE_IMAGE = { public: 'node:22-bookworm-slim', fleet: 'walnut-fleet-base:node22-bookworm-slim' } as const
export const HOST_IMAGE_REPO = 'walnut-fleet-host'
export const HOST_HOME = '/home/walnut'
export const HOST_WORK = '/home/walnut/work'
/** Where a host's daemon keeps what the fleet reads (the production paths: the daemon runs from /tmp/open-walnut). */
export const HOST_PATHS = {
  daemonDir: '/tmp/open-walnut',
  streams: `${HOST_HOME}/.open-walnut/tmp/streams`,
  journal: `${HOST_HOME}/.open-walnut/tmp/offline-host`,
  copy: `${HOST_HOME}/.open-walnut/tmp/host-replica`,
  mockAttempts: `${HOST_HOME}/.fleet-mock`,
} as const

/**
 * The daemon's test windows (the knobs replica-cluster.ts uses): a beat of 1 s, a
 * quiet window of 6 s, a takeover of 12 s, on the Mac and on every host. `real`
 * leaves the production defaults (15 s beats, 30 s quiet, 60 s takeover).
 */
export const FAST_WINDOWS = { WALNUT_LEADER_QUIET_MS: '6000', WALNUT_TRUSTED_CLIENT_BEAT_MS: '1000', WALNUT_LEADER_TAKEOVER_MS: '12000' } as const

export interface FleetOptions {
  hosts: string[]
  windows?: 'fast' | 'real'
  seed?: MacSeed
  /** A clock offset per host, as libfaketime takes it ('+90s', '-2m'): every process an SSH session starts there runs on it. */
  clockOffset?: Record<string, string>
  /** What the Mac runs first (default this tree's sources); `replaceMac` changes it on the same data. */
  mac?: MacProgram
  /** Each host container's memory cap (default 1g): a host server is a second Walnut on the host. */
  hostMemory?: string
}

export interface FleetHost {
  name: string
  container: string
  /** The 127.0.0.1 port Docker publishes for the container's sshd. */
  sshPort: number
  /** The fault proxy the Mac's ssh goes through. */
  proxy: SilentLinkProxy
}

export interface JournalView { records: Array<Record<string, any>>; acked: Set<number> }

export interface Fleet {
  base: string
  run: string
  /** The Mac server running now (replaceMac starts another one on the same data). */
  readonly mac: MacNode
  /**
   * Replaces the Mac's server, as an update or a rollback does: the running server
   * stops (its own daemon and ssh keep running for the next one), then `program`
   * starts on the same data, daemon and temp dirs.
   */
  replaceMac(program: MacProgram): Promise<MacNode>
  hosts: Record<string, FleetHost>
  /** Adds the host to the Mac's config (as Settings > Remote Hosts saves it), asks it to connect, waits until connected. */
  addHost(name: string, def?: Record<string, unknown>, timeoutMs?: number): Promise<number>
  hostConnected(name: string): Promise<boolean>
  /** `sh -c script` on the host as the fleet user (or `user`, root to change the machine itself). */
  hostExec(name: string, script: string, timeoutMs?: number, user?: string): Promise<string>
  hostFile(name: string, file: string): Promise<string | null>
  /** The host's journal of the Mac's Walnut: every record seen this run, and the seqs acked (an acked record leaves the file). */
  hostJournal(name: string): Promise<JournalView>
  /** Whether any file in the host's copy dirs holds `needle`. */
  hostCopyHolds(name: string, needle: string): Promise<boolean>
  hostStream(name: string, sid: string): Promise<Array<Record<string, any>>>
  /** Whether the host's read copy of the Mac's sessions (host.slice) names `sid`: only then can the host answer its calls while the Mac is away. */
  hostSliceHolds(name: string, sid: string): Promise<boolean>
  /** The mock CLI's `walnut` attempts for a session on the host. */
  hostAttempts(name: string, sid: string): Promise<Array<Record<string, any>>>
  /** A task row in the Mac's tasks.sqlite, read only. */
  macTask(id: string): Record<string, any> | null
  sleepMac(opts?: { ssh?: boolean }): void
  wakeMac(): void
  pauseHost(name: string): Promise<void>
  unpauseHost(name: string): Promise<void>
  /**
   * `silent`: every socket stays open and carries nothing, and the heal closes both
   * ends; `severed`: the same, but the heal closes only the Mac's ends, so the host's
   * sshd keeps its side open, as after a network change (the daemon must notice a
   * client that never answers); `drop`: every connection closes now, new ones are held silent.
   */
  cutLink(name: string, how?: 'silent' | 'severed' | 'drop'): void
  healLink(name: string): void
  slowLink(name: string, slow: SlowLink): void
  diagnostics(): Promise<string>
  stop(): Promise<void>
}

function sshBanner(port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const t = setTimeout(() => { s.destroy(); resolve(false) }, timeoutMs)
    s.once('data', (b) => { clearTimeout(t); s.destroy(); resolve(b.toString().startsWith('SSH-')) })
    s.once('error', () => { clearTimeout(t); resolve(false) })
  })
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export async function startFleet(opts: FleetOptions): Promise<Fleet> {
  const why = await dk.dockerUnavailable()
  if (why) throw new Error(`fleet: Docker is not available (${why})`)
  for (const n of opts.hosts) if (!/^[a-z][a-z0-9-]{0,20}$/.test(n)) throw new Error(`fleet: host name ${JSON.stringify(n)} must be lowercase letters, digits and dashes`)
  await dk.sweep()
  const run = crypto.randomBytes(3).toString('hex')
  const imageDir = path.join(import.meta.dirname, 'host-image')
  await dk.ensureBase(BASE_IMAGE.public, BASE_IMAGE.fleet)
  const image = (await dk.ensureImage(HOST_IMAGE_REPO, imageDir, run)).tag
  // In the runner's own temp dir, which is the Mac's TMPDIR too (mac-node.ts): its ssh ControlMaster socket lives there.
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wfl-'))
  const network = `walnut-fleet-${run}`
  const containers: string[] = []
  const hosts: Record<string, FleetHost> = {}
  const windows: Record<string, string> = opts.windows === 'real' ? {} : { ...FAST_WINDOWS }
  let mac: MacNode | null = null
  let ssh: SshIdentity | null = null
  const cleanup = async () => {
    await mac?.stop().catch(() => undefined)
    for (const h of Object.values(hosts)) await h.proxy.close().catch(() => undefined)
    if (mac) saveMacLogs(mac.daemonDir, `fleet-${run}`)
    // KEEP_FLEET=1 keeps the containers and the temp dir to look at (the next run's sweep removes the containers).
    if (process.env.KEEP_FLEET) return
    await dk.removeRun(containers, network).catch(() => undefined)
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  try {
    ssh = makeSshIdentity(base)
    await dk.createNetwork(network, run)
    for (const name of opts.hosts) {
      const container = `walnut-fleet-${run}-${name}`
      const env: Record<string, string> = { FLEET_AUTHORIZED_KEY: ssh.publicKey }
      for (const [k, v] of Object.entries(windows)) env[`FLEET_ENV_${k}`] = v
      const offset = opts.clockOffset?.[name]
      if (offset) {
        // The real clock for timers (monotonic), the offset for the wall clock.
        const lib = `/usr/lib/${(await dk.dockerArch()) === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu/faketime/libfaketime.so.1`
        Object.assign(env, { FLEET_ENV_LD_PRELOAD: lib, FLEET_ENV_FAKETIME: offset, FLEET_ENV_FAKETIME_DONT_FAKE_MONOTONIC: '1' })
      }
      await dk.runContainer({ name: container, image, network, run, env, publish: [22], hostname: name, ...(opts.hostMemory ? { memory: opts.hostMemory } : {}) })
      containers.push(container)
      const sshPort = await dk.publishedPort(container, 22).catch(async (err: Error) => {
        throw new Error(`${err.message}\n--- ${container} log ---\n${(await dk.logs(container)).slice(-2000)}`)
      })
      await waitFor(() => sshBanner(sshPort), 60_000, `${name}'s sshd`)
      const proxy = await startSilentLinkProxy(sshPort)
      hosts[name] = { name, container, sshPort, proxy }
    }
    ssh.writeHosts(Object.fromEntries(Object.values(hosts).map((h) => [h.name, h.proxy.port])))
    mac = await startMac(base, ssh, windows, opts.seed, opts.mac)
  } catch (err) {
    await cleanup()
    throw err
  }
  let theMac: MacNode = mac
  const theSsh: SshIdentity = ssh
  const seen = new Map<string, Map<number, Record<string, any>>>()
  const host = (name: string): FleetHost => {
    const h = hosts[name]
    if (!h) throw new Error(`fleet: no host ${name}`)
    return h
  }
  const hostExec = async (name: string, script: string, timeoutMs?: number, user?: string) => {
    const r = await dk.exec(host(name).container, script, { timeoutMs, ...(user ? { user } : {}) })
    if (r.code !== 0) throw new Error(`fleet: on ${name}: ${script.slice(0, 120)} exited ${r.code}: ${r.stderr.trim().slice(-500)}`)
    return r.stdout
  }
  const hostFile = async (name: string, file: string) => {
    const r = await dk.exec(host(name).container, `cat ${sq(file)}`)
    return r.code === 0 ? r.stdout : null
  }
  const jsonLines = (text: string | null) => (text ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return {} } })
  const hostConnected = async (name: string) => {
    const r = await theMac.call('GET', '/api/hosts/status')
    return !!(r.json?.hosts as Array<{ host: string; connected: boolean }> | undefined)?.find((x) => x.host === name)?.connected
  }

  return {
    base, run, hosts,
    get mac() { return theMac },
    async replaceMac(program) {
      await theMac.stopServer()
      theMac = await startMac(base, theSsh, windows, opts.seed, program)
      mac = theMac
      return theMac
    },
    async addHost(name, def = {}, timeoutMs = 180_000) {
      host(name)
      const t0 = Date.now()
      const cur = await theMac.call('GET', '/api/config')
      if (cur.status !== 200) throw new Error(`fleet: GET /api/config ${cur.status}`)
      // The Remote Hosts editor sends the whole hosts map (each top-level key replaces the stored one).
      const hostsNow = { ...(cur.json?.config?.hosts ?? {}), [name]: { hostname: name, label: name, autofix: false, ...def } }
      const put = await theMac.call('PUT', '/api/config', { hosts: hostsNow })
      if (put.status !== 200) throw new Error(`fleet: PUT /api/config ${put.status} ${put.text.slice(0, 500)}`)
      const conn = await theMac.call('POST', `/api/hosts/${name}/connect`)
      if (conn.status >= 400) throw new Error(`fleet: connect ${name}: ${conn.status} ${conn.text.slice(0, 500)}`)
      await waitFor(() => hostConnected(name), timeoutMs, `the Mac to connect to ${name}`, 500)
      return Date.now() - t0
    },
    hostConnected,
    hostExec,
    hostFile,
    async hostJournal(name) {
      const r = await dk.exec(host(name).container, `cat ${HOST_PATHS.journal}/journal-*.ndjson 2>/dev/null || true`)
      const inFile = new Map<number, Record<string, any>>()
      const acked = new Set<number>()
      for (const o of jsonLines(r.stdout)) {
        if (typeof o.seq === 'number') inFile.set(o.seq, o)
        if (Array.isArray(o.ack)) for (const q of o.ack) acked.add(q)
      }
      const all = seen.get(name) ?? new Map<number, Record<string, any>>()
      seen.set(name, all)
      for (const [q, rec] of inFile) all.set(q, rec)
      // An acked record leaves the file at the next compaction: one seen before and gone now was acked.
      for (const q of all.keys()) if (!inFile.has(q)) acked.add(q)
      return { records: [...all.values()].sort((a, b) => a.seq - b.seq), acked }
    },
    async hostCopyHolds(name, needle) {
      const r = await dk.exec(host(name).container, `grep -rlF -- ${sq(needle)} ${HOST_PATHS.copy} 2>/dev/null | head -1`)
      return r.stdout.trim() !== ''
    },
    async hostStream(name, sid) { return jsonLines(await hostFile(name, `${HOST_PATHS.streams}/${sid}.jsonl`)) },
    async hostSliceHolds(name, sid) {
      const r = await dk.exec(host(name).container, `grep -lF -- ${sq(sid)} ${HOST_PATHS.journal}/slice-*.json 2>/dev/null | head -1`)
      return r.stdout.trim() !== ''
    },
    async hostAttempts(name, sid) { return jsonLines(await hostFile(name, `${HOST_PATHS.mockAttempts}/${sid}.walnut.jsonl`)) },
    macTask(id) {
      const db = new Database(path.join(theMac.data, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
      try { return (db.prepare('SELECT id, title, phase, project, updated_at FROM tasks WHERE id = ?').get(id) as Record<string, any> | undefined) ?? null } finally { db.close() }
    },
    sleepMac: (o) => theMac.sleep(o),
    wakeMac: () => theMac.wake(),
    pauseHost: async (name) => { await dk.pause(host(name).container) },
    unpauseHost: async (name) => { await dk.unpause(host(name).container) },
    cutLink(name, how = 'silent') { host(name).proxy.setMode(how === 'drop' ? 'drop-hold' : how === 'severed' ? 'severed' : 'blackhole') },
    healLink(name) { host(name).proxy.setMode('pass') },
    slowLink(name, slow) { host(name).proxy.setMode('slow', slow) },
    async diagnostics() {
      const parts: string[] = [`--- mac stderr ---\n${theMac.stderrTail().slice(-4000)}`]
      parts.push(`--- mac log (daemon connection) ---\n${theMac.logLines(/DaemonConnection|offline handover/).slice(-40).map((l) => l.slice(0, 400)).join('\n')}`)
      for (const h of Object.values(hosts)) {
        const r = await dk.exec(h.container, `tail -n 40 ${HOST_PATHS.daemonDir}/daemon-start.log 2>/dev/null; ls -la ${HOST_PATHS.daemonDir} 2>/dev/null | head -40; ps -eo pid,user,args | head -40`)
        parts.push(`--- ${h.name} ---\n${r.stdout.slice(-6000)}\n--- ${h.name} container log ---\n${(await dk.logs(h.container)).slice(-2000)}`)
      }
      return parts.join('\n')
    },
    stop: cleanup,
  }
}
