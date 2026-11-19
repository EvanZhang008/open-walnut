/**
 * How a terminal reaches its host: its daemon's connection whenever that is up with
 * terminal streams (any kind of host), else ssh where the host has an SSH route, else the
 * host's daemon link (a terminal stream, link-pty.ts, and exec.script for its other
 * steps, host-shell.ts). The ONE decision every terminal step on a remote host
 * takes (the spawn in spawn.ts, dtach's probe and install, the lifecycle's probes
 * and stops), with a test server's isolation applied. A connection is an
 * abstraction: every kind of host gets a terminal (the class guard is
 * tests/web/terminal/terminal-every-host-kind.test.ts). The ssh route's shared
 * ControlMaster is here too: every ssh step to a host rides one master.
 */
import os from 'node:os'
import path from 'node:path'
import type { SshTarget } from '../../providers/session-io.js'
import { getConfig } from '../../core/config-manager.js'
import { terminalRouteKind } from '../../core/hosts/host-status.js'
import { linkTarget } from '../../core/hosts/link.js'
import { IS_DEMO, IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { describeIsolationRefusal, isolationKey, remoteIsolationFor } from '../../providers/remote-isolation.js'
import { demoIsolationInput } from '../../providers/demo-remote-host.js'

export type TerminalRoute =
  | { via: 'ssh'; target: SshTarget }
  | { via: 'link'; link: 'net' | 'cloud-tunnel' | 'ssh-tunnel' }

/** The remote hosts this test server's terminal path reached (its exit ends them and removes its root there). */
const TEST_SERVER_TERMINAL_HOSTS = new Set<string>()
export function testServerTerminalHosts(): string[] { return [...TEST_SERVER_TERMINAL_HOSTS] }

/**
 * The route to `host`. Throws for an unknown alias, and for a host a test server may
 * not touch (its refusal says why).
 */
export async function resolveTerminalRoute(host: string): Promise<TerminalRoute> {
  const config = await getConfig()
  const def = config.hosts?.[host]
  if (!def) throw new Error(`Unknown host: ${host}`)
  // The daemon link it rides, or null for its SSH route.
  const overLink = terminalRouteKind(def) === 'link' ? (def.cloud_box === true ? 'cloud-tunnel' : 'net') : null
  // A test server reaches a remote host only with remote hosts on, and then only its own dirs there.
  const iso = remoteIsolationFor({ hostKey: host, env: process.env, ephemeral: IS_EPHEMERAL, link: overLink ?? 'ssh', home: WALNUT_HOME, demo: demoIsolationInput(IS_DEMO) })
  if (iso.mode === 'off') throw new Error(describeIsolationRefusal(host, iso.reason, iso.dir))
  // A test server's cloud box is attached read only; a terminal there would write on it.
  if (iso.mode === 'attach') throw new Error(`ephemeral server: '${host}' is attached read only here, so this server opens no terminal there`)
  if (iso.mode === 'isolated') TEST_SERVER_TERMINAL_HOSTS.add(host)
  if (overLink) return { via: 'link', link: overLink }
  // An SSH host whose daemon is connected with terminal streams rides that connection too: the
  // daemon's tunnel is already up, while a fresh ssh login may not be (2026-11-19: newdev's
  // sessions and previews ran over its daemon's tunnel while every new `ssh newdev` was refused,
  // so only its Terminal failed). A test server keeps ssh: its own dirs there are ssh's.
  if (iso.mode === 'shared' && await daemonRunsTerminals(host)) return { via: 'link', link: 'ssh-tunnel' }
  return { via: 'ssh', target: linkTarget(host, config) }
}

/** The host's daemon is connected now and runs terminal streams and scripts. Never dials. */
async function daemonRunsTerminals(host: string): Promise<boolean> {
  try {
    const [{ getConnectedDaemonConnection }, { HOST_SCRIPT_CAPABILITY }, { PTY_STREAM_CAPABILITY }] = await Promise.all([
      import('../../providers/daemon-connection.js'), import('../../core/hosts/host-script.js'), import('../../core/hosts/terminal-link.js'),
    ])
    const conn = getConnectedDaemonConnection(host)
    return !!conn && conn.hasCapability(PTY_STREAM_CAPABILITY) && conn.hasCapability(HOST_SCRIPT_CAPABILITY)
  } catch {
    return false
  }
}

/**
 * The control socket of a host's terminal master: Walnut's own, one per alias. A test server
 * keeps its own master: never one the real Walnut's terminals ride. A host turned off or
 * removed ends the master at this path (core/hosts/host-link-end.ts).
 */
export function terminalControlSocket(host: string): string {
  return path.join(os.tmpdir(), IS_EPHEMERAL ? `walnut-term-ssh-${host}-${isolationKey(WALNUT_HOME).slice(0, 8)}` : `walnut-term-ssh-${host}`)
}

/**
 * SSH ControlMaster args shared by the dtach probe/provision AND the terminal
 * spawn for a host. WHY: a fresh SSH connection to a remote dev host behind a
 * proxy can cost 2-21s (highly variable). Without muxing, the probe pays that
 * once and the spawn pays it AGAIN moments later. With a shared ControlPath the
 * probe establishes the master connection and the spawn reuses it instantly
 * (ControlPersist keeps it warm). Same pattern the session daemon uses.
 *
 * `host` is the alias — one socket per alias, stable across probe+spawn+reaper.
 */
export function sshControlMasterArgs(host: string): string[] {
  const socket = terminalControlSocket(host)
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${socket}`,
    '-o', 'ControlPersist=120',
  ]
}
