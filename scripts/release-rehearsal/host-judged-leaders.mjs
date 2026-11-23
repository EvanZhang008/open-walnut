/**
 * The leaders of a host-judge cluster (tests/helpers/host-judge-cluster.ts) put in one after the
 * other over the Mac's own data, as a person downgrades and upgrades the Mac: the cluster's Mac
 * stopped, then a released Walnut's leader (`open-walnut web`, the launcher and compiled file a
 * registry install left), then this tree's leader again (the cluster's own boot script, with the
 * Mac's probe). Each takes the Mac's port, home, data and daemon dir, so the host and every call
 * of the cluster (`c.mac`) see the same Walnut come back.
 *
 * How a released leader reaches the host: the way the user's Mac reaches a dev box today, the
 * host network (`transport: net`, an endpoint id in the host's row). The released leader's
 * DaemonConnection asks its own local daemon for `net.forward`, and that daemon runs walnut-net;
 * here walnut-net is net-standin.mjs, which pipes the forward to the host service's door on this
 * machine (the port its daemon.port names now). Everything above the network layer is the
 * release's own code. This tree's leader keeps the cluster's direct test link (macBoot).
 *
 * Every signal goes to a process this module started or pinned (the cluster's pin helpers).
 */
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { _signalSafetyForTesting, bootMac, macBoot, macEnvOf, waitFor } from '../../tests/helpers/replica-cluster.ts'
import { macProbe } from '../../tests/helpers/host-judge-cluster.ts'
import { stopOwnDaemon } from './own-daemon.mjs'

const { pin, signalPinned, stillPinned } = _signalSafetyForTesting
const here = path.dirname(new URL(import.meta.url).pathname)

/** The host's id on the host network (any 64 hex: the stand-in lists it as a member). */
export const ENDPOINT = crypto.createHash('sha256').update('rehearsal devbox').digest('hex')
/** The host's row as a host-network machine (macHostExtra lines), as the user's dev boxes are. */
export const NET_HOST_LINES = ['    transport: net', `    endpoint: ${ENDPOINT}`]

/** The cluster's dirs this module uses (startReplicaCluster's layout). */
export function clusterDirs(h) {
  const base = h.c.base
  const macHome = path.join(base, 'mh')
  return {
    base, macHome, macData: h.c.macData, macDaemon: path.join(base, 'md'), hostDaemon: path.join(base, 'hd'),
    macCwd: fs.realpathSync(path.join(macHome, 'work')), hostCwd: fs.realpathSync(path.join(base, 'hh', 'work')),
  }
}

/** The Mac's env as the cluster gives it (macEnvOf), with `extra`. */
const leaderEnv = (d, extra = {}) => macEnvOf({ base: d.base, macHome: d.macHome, macData: d.macData, macDaemon: d.macDaemon, hostService: true, extra })

/** Stop the cluster's own Mac (its boot script process, pinned), and wait until it is gone. */
export async function stopClusterMac(h) {
  const p = pin('mac', h.c.macPid, (cmd) => cmd.includes('mac-boot.mts'))
  if (!p) return { stopped: false, ms: 0 }
  const at = Date.now()
  signalPinned(p, 'SIGTERM')
  const gone = await waitFor(() => !stillPinned(p), 30_000, 'the Mac to stop', 100).then(() => true, () => false)
  if (!gone) signalPinned(p, 'SIGKILL')
  return { stopped: true, ms: Date.now() - at, killed: !gone }
}

/**
 * The stand-in walnut-net for the Mac's local daemon: its net state dir (`<daemon dir>/net`, a
 * daemon dir of its own), a config that makes the daemon run it, the host listed as a member,
 * and the shim WALNUT_NET_BIN names. Returns the env the leader (and so its daemon) needs.
 */
export function netStandinEnv(d) {
  const state = path.join(d.macDaemon, 'net')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ version: 1, key: path.join(state, 'net.key'), control: path.join(state, 'ctl.sock'), members: [{ id: ENDPOINT, name: 'devbox', accept: false }] }, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(state, 'standin-peers.json'), JSON.stringify({ [ENDPOINT]: path.join(d.hostDaemon, 'daemon.port') }))
  const shim = path.join(d.base, 'bin', 'walnut-net')
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, 'net-standin.mjs'))} "$@"\n`, { mode: 0o755 })
  return { WALNUT_NET_BIN: shim, WALNUT_NET_NO_DOWNLOAD: '1' }
}

async function healthOf(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/system/health`, { signal: AbortSignal.timeout(3_000) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

/**
 * The released leader over the Mac's data, on the Mac's port: `<launcher> web --port`. Its env is
 * the Mac's, but for WALNUT_HOST_SERVER_APP_DIR (a test seam a compiled leader refuses: a person's
 * leader installs its own file on the host) and with the stand-in walnut-net. Resolves once it
 * answers health (or with the reason it did not), with its stop.
 */
export async function startOldLeader(h, older, { port, logFile, timeoutMs = 300_000 }) {
  const d = clusterDirs(h)
  const env = leaderEnv(d, netStandinEnv(d))
  delete env.WALNUT_HOST_SERVER_APP_DIR
  const log = fs.openSync(logFile, 'a')
  const at = Date.now()
  const proc = spawn(older.launcher, ['web', '--port', String(port)], { env, cwd: d.macHome, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  const exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })))
  let health = null
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline && proc.exitCode === null && proc.signalCode === null;) {
    health = await healthOf(port)
    if (health) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 30_000))])
      if (!done) proc.kill('SIGKILL')
    }
    return exited
  }
  return { proc, health, upMs: Date.now() - at, exit: proc.exitCode ?? proc.signalCode, stop }
}

/** This tree's leader again over the Mac's data (no seed), with its link to the host and the Mac's probe. */
export async function startNewLeaderAgain(h, { port, label }) {
  const d = clusterDirs(h)
  const script = macBoot({
    macData: d.macData, daemonPort: 0, macCwd: d.macCwd, hostCwd: d.hostCwd, dev: true, hostDaemon: d.hostDaemon, plugin: false,
    seed: false, port, extra: macProbe('full'), doorPortFile: path.join(d.hostDaemon, 'daemon.port'),
  })
  const logRef = { text: '' }
  const at = Date.now()
  const booted = await bootMac(script, path.join(d.base, `mac-boot-${label}.mts`), leaderEnv(d), logRef, `mac-${label}-stderr.log`)
  const p = pin('mac', booted.pid, (cmd) => cmd.includes(`mac-boot-${label}.mts`))
  return {
    pid: booted.pid, upMs: Date.now() - at, log: () => logRef.text,
    async stop() {
      if (!p || !stillPinned(p)) return
      signalPinned(p, 'SIGTERM')
      if (!(await waitFor(() => !stillPinned(p), 30_000, 'the leader to stop', 100).then(() => true, () => false))) signalPinned(p, 'SIGKILL')
    },
  }
}

/** Whatever daemon the Mac's dir names now (the cluster pins only the first one it saw). */
export const stopMacDaemon = (h) => stopOwnDaemon(clusterDirs(h).macDaemon)
