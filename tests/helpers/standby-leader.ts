/**
 * A second leader of the same Walnut beside a replica cluster's Mac (replica-cluster.ts): a standby
 * that boots over a copy of the Mac's data dir, as the leader switch's standby holds one. The copy
 * carries the Mac's auth.json (so the same Walnut id, and the door credential records of its hosts)
 * and its sessions store (with the session channel's cursor of each host).
 *
 * Its own home, data and daemon dirs under the cluster's base (`mb/`, `mbd/`), the cluster's stub
 * bin and app; no link to the host's daemon (macBoot hostLink false): the host reaches it only by
 * dialing its door. `port`: the port it serves on, so the Mac can hand its hosts this door's URL
 * before the standby runs. `extra`: code its boot script runs after its server started (a probe).
 *
 * Every signal goes to a process this helper can name: the standby itself (its ChildProcess) and
 * its own daemon (pinned by its pid file and command line), as replica-cluster.ts does.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { _signalSafetyForTesting, bootMac, macBoot, macEnvOf, waitFor, type ReplicaCluster } from './replica-cluster.js'

export { copyLeaderData, freePort } from './leader-data-copy.js'

const { pin, readPid, signalChild, signalPinned, stillPinned } = _signalSafetyForTesting

export interface StandbyLeader {
  port: number
  pid: number
  data: string
  /** A request to its API (no token: a loopback caller, as the cluster's Mac calls are). */
  call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>
  log(): string
  stop(): Promise<void>
}

function request(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, timeout: 60_000, headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {} }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (x: Buffer) => parts.push(x))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8')
        let json: any
        try { json = JSON.parse(text) } catch { json = { text } }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${p} timed out`)))
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** Boot the standby over `data` (a copy made with copyLeaderData), on `port`. */
export async function startStandbyLeader(c: ReplicaCluster, o: { data: string; port: number; extra?: string; env?: Record<string, string> }): Promise<StandbyLeader> {
  const home = path.dirname(o.data)
  const daemon = path.join(c.base, 'mbd')
  fs.mkdirSync(daemon, { recursive: true, mode: 0o700 })
  const env = macEnvOf({ base: c.base, macHome: home, macData: o.data, macDaemon: daemon, hostService: true, extra: o.env })
  const script = macBoot({ macData: o.data, daemonPort: 0, macCwd: home, hostCwd: home, dev: true, hostDaemon: path.join(c.base, 'hd'), plugin: false, seed: false, hostLink: false, port: o.port, ...(o.extra ? { extra: o.extra } : {}) })
  const logRef = { text: '' }
  const booted = await bootMac(script, path.join(c.base, 'standby-boot.mts'), env, logRef, 'standby-stderr.log')
  const proc: ChildProcess = booted.proc
  const daemonPin = await waitFor(() => pin('standby-daemon', readPid(path.join(daemon, 'daemon.pid')), (cmd) => / --start(\s|$)/.test(cmd)), 60_000, 'the standby\'s own daemon').catch(() => null)
  let stopped = false
  return {
    port: booted.port,
    pid: booted.pid,
    data: o.data,
    call: (method, p, body) => request(booted.port, method, p, body),
    log: () => logRef.text,
    async stop() {
      if (stopped) return
      stopped = true
      signalChild(proc, 'SIGTERM')
      signalPinned(daemonPin, 'SIGTERM')
      await waitFor(() => (proc.exitCode !== null || proc.signalCode !== null) && (!daemonPin || !stillPinned(daemonPin)), 20_000, 'the standby to stop').catch(() => undefined)
      signalChild(proc, 'SIGKILL')
      signalPinned(daemonPin, 'SIGKILL')
    },
  }
}
