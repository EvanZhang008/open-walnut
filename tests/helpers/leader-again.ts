/**
 * The Mac of a replica cluster (replica-cluster.ts) stopped and this tree's leader booted again over
 * its data, as a deploy restarts it: host-judge-cluster.ts restartMac, and the release rehearsal's
 * leaders (scripts/release-rehearsal/host-judged-leaders.mjs). Every signal goes to a process this
 * module can name: the boot script's process, pinned by its pid and command line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { _signalSafetyForTesting, bootMac, macBoot, macEnvOf, waitFor, type ReplicaCluster } from './replica-cluster.js'

const { pin, signalPinned, stillPinned } = _signalSafetyForTesting

/** Stop the cluster's own Mac (its boot script process, pinned), and wait until it is gone. */
export async function stopClusterMac(h: { c: ReplicaCluster }): Promise<{ stopped: boolean; ms: number; killed?: boolean }> {
  const p = pin('mac', h.c.macPid, (cmd) => cmd.includes('mac-boot.mts'))
  if (!p) return { stopped: false, ms: 0 }
  const at = Date.now()
  signalPinned(p, 'SIGTERM')
  const gone = await waitFor(() => !stillPinned(p), 30_000, 'the Mac to stop', 100).then(() => true, () => false)
  if (!gone) signalPinned(p, 'SIGKILL')
  return { stopped: true, ms: Date.now() - at, killed: !gone }
}

/** A leader of this tree booted again over the cluster's Mac data (startLeaderAgain). */
export interface LeaderAgain { pid: number; upMs: number; log(): string; stop(): Promise<void> }

/**
 * This tree's leader again over the cluster's Mac data, home and daemon dir (no seed), on `port`,
 * with its link to the host's door (the port its daemon.port names now) and `extra` as its boot code
 * (the Mac's probe). `env`: more of its env, over the Mac's (macEnvOf).
 */
export async function startLeaderAgain(h: { c: ReplicaCluster }, o: { port: number; label: string; extra: string; env?: Record<string, string> }): Promise<LeaderAgain> {
  const base = h.c.base
  const macHome = path.join(base, 'mh')
  const hostDaemon = path.join(base, 'hd')
  const script = macBoot({
    macData: h.c.macData, daemonPort: 0, macCwd: fs.realpathSync(path.join(macHome, 'work')), hostCwd: fs.realpathSync(path.join(base, 'hh', 'work')),
    dev: true, hostDaemon, plugin: false, seed: false, port: o.port, extra: o.extra, doorPortFile: path.join(hostDaemon, 'daemon.port'),
  })
  const env = macEnvOf({ base, macHome, macData: h.c.macData, macDaemon: path.join(base, 'md'), hostService: true, extra: o.env ?? {} })
  const logRef = { text: '' }
  const at = Date.now()
  const file = `mac-boot-${o.label}.mts`
  const booted = await bootMac(script, path.join(base, file), env, logRef, `mac-${o.label}-stderr.log`)
  const p = pin('mac', booted.pid, (cmd) => cmd.includes(file))
  return {
    pid: booted.pid, upMs: Date.now() - at, log: () => logRef.text,
    async stop() {
      if (!p || !stillPinned(p)) return
      signalPinned(p, 'SIGTERM')
      if (!(await waitFor(() => !stillPinned(p), 30_000, 'the leader to stop', 100).then(() => true, () => false))) signalPinned(p, 'SIGKILL')
    },
  }
}
