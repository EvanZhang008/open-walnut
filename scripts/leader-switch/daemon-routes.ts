/**
 * The rehearsal's network between machines on one computer (scripts/leader-switch/remote-world.ts):
 * in a leader server's own process, the links to other machines' daemons go to loopback ports (each
 * a silent-link proxy in front of that machine's real daemon) instead of ssh. Only the dial changes:
 * the server's own code decides when it dials (a server that does not lead dials no host), and every
 * command, the hello and its capabilities, the reconnect loop and the pool are the production ones.
 *
 *   connect()           a routed host is dialled straight to its port (the DaemonConnection's direct dial)
 *   reconnect()         the same dial again, after a drop (a direct dial has no ssh to rebuild)
 *   runRemoteScript()   the host server manager's one probe (which ports are free, asked of this runtime)
 *                       runs in a local shell with that machine's HOME and PATH: the test transport is
 *                       this computer. Any other remote script for a routed host is refused
 *   eager               the console rehearsal's old machine: its link is put in the pool once a second
 *                       while this server is no trial start (console-world.ts), as a pooled ssh link is
 *
 * Set by machine-server.ts from WALNUT_REHEARSAL_DAEMON_ROUTES ({"<host>": {"port": n, "home": dir, "path"?: PATH,
 * "eager"?: true}}). Nothing in production sets it.
 */
import { execFile } from 'node:child_process'

export interface DaemonRoute { port: number; home: string; path?: string; eager?: boolean }

export async function routeDaemonLinks(routes: Record<string, DaemonRoute>): Promise<void> {
  const dcm = await import('../../src/providers/daemon-connection.js')
  type Conn = { hostKey: string; connectDirect(url: string): Promise<void>; dialDirect(url: string): Promise<void>; recoverDisconnectedSessions?(): Promise<void> }
  const proto = dcm.DaemonConnection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const route = (c: Conn) => (Object.hasOwn(routes, c.hostKey) ? routes[c.hostKey]! : null)
  const url = (r: DaemonRoute) => `ws://127.0.0.1:${r.port}`
  const connect = proto.connect!
  proto.connect = function (this: Conn) {
    const r = route(this)
    return r ? this.connectDirect(url(r)) : connect.call(this)
  }
  const reconnect = proto.reconnect!
  proto.reconnect = async function (this: Conn) {
    const r = route(this)
    if (!r) return reconnect.call(this)
    await this.dialDirect(url(r))
    this.recoverDisconnectedSessions?.().catch(() => {})
  }
  const runRemoteScript = proto.runRemoteScript!
  const runtimeQ = `'${process.execPath}' `
  proto.runRemoteScript = function (this: Conn, script: unknown, timeoutMs: unknown = 30_000) {
    const r = route(this)
    if (!r) return runRemoteScript.call(this, script, timeoutMs)
    if (typeof script !== 'string' || !script.startsWith(runtimeQ)) return Promise.reject(new Error('the test transport runs only the host server probes'))
    return new Promise((resolve, reject) => execFile('/bin/sh', ['-c', script], { timeout: Number(timeoutMs), env: { PATH: r.path ?? process.env.PATH ?? '', HOME: r.home } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))))
  }
  // Only once this server may lead (a trial start reaches no host).
  if (process.env.WALNUT_LEADER_TRIAL === '1') return
  for (const [host, r] of Object.entries(routes)) {
    if (!r.eager) continue
    const pool = async () => { dcm.setPooledConnectionForTest(host, await dcm.getDirectDaemonConnection(host, url(r))) }
    setInterval(() => { void pool().catch(() => {}) }, 1_000).unref()
  }
}
