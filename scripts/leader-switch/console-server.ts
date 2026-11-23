/**
 * A server of the console rehearsal (scripts/leader-switch/console-world.ts): a real, NOT
 * ephemeral Walnut server on a synthetic home, started by the switch's LocalSide
 * (leader_switch.machines[].start_command) like rehearsal-server.ts. It is not ephemeral because
 * the new leader must configure the old machine as one of its hosts (an ephemeral server only
 * reads remote hosts), and its whole world stays inside the rehearsal folder (HOME, the data
 * home, the daemon dirs; checked below).
 *
 * The one test seam: the old machine's host daemon is reached by the direct test transport
 * (as tests/helpers/replica-cluster.ts reaches its host), never ssh: WALNUT_CONSOLE_HOST_KEY
 * names the host entry, WALNUT_CONSOLE_HOST_DAEMON_PORT the daemon's port. The manager's one
 * host probe (free ports, asked of this runtime) runs in a local sh with the host's HOME
 * (WALNUT_CONSOLE_HOST_HOME); any other remote script for that host is refused.
 *
 *   bun scripts/leader-switch/console-server.ts --port <n>
 */
import path from 'node:path'

const portArg = process.argv.indexOf('--port')
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
if (!Number.isInteger(port) || port <= 0 || port === 3456) {
  console.error('console-server: --port <n> (never 3456)')
  process.exit(2)
}
const home = process.env.HOME ?? ''
// Never the account's own home: a rehearsal machine's HOME is a folder of the rehearsal. The
// account's home comes from its user record (Bun's os.userInfo().homedir follows $HOME).
const accountHome = await (async () => {
  const { execFileSync } = await import('node:child_process')
  const os = await import('node:os')
  try {
    if (process.platform === 'darwin') return execFileSync('dscl', ['.', '-read', `/Users/${os.userInfo().username}`, 'NFSHomeDirectory'], { encoding: 'utf8' }).split(':').pop()!.trim()
    return execFileSync('getent', ['passwd', String(process.getuid?.() ?? '')], { encoding: 'utf8' }).split(':')[5]!.trim()
  } catch {
    return ''
  }
})()
if (!home || (accountHome && path.resolve(home) === path.resolve(accountHome))) {
  console.error('console-server: HOME must be a folder of the rehearsal, never the account\'s own home')
  process.exit(2)
}
const inside = (p: string | undefined) => !!p && !!home && path.resolve(p).startsWith(path.resolve(home) + path.sep)
if (!inside(process.env.OPEN_WALNUT_HOME) || !inside(process.env.WALNUT_DAEMON_DIR) || !inside(process.env.WALNUT_STREAMS_DIR)) {
  console.error('console-server: OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR and WALNUT_STREAMS_DIR must be set inside HOME (the rehearsal folder)')
  process.exit(2)
}
process.env.WALNUT_DISABLE_SEARCH ??= '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI ??= '1'
process.env.WALNUT_LOCAL_CLAUDE_PROBE ??= '0'
process.env.WALNUT_NO_AUTO_UPDATE ??= '1'

const c = await import('../../src/constants.js')
if (c.WALNUT_HOME !== path.resolve(process.env.OPEN_WALNUT_HOME!) || c.CLOUD_MODE || c.IS_EPHEMERAL) {
  console.error(`console-server: REFUSING the home ${c.WALNUT_HOME}`)
  process.exit(3)
}

const hostKey = (process.env.WALNUT_CONSOLE_HOST_KEY ?? '').trim()
const daemonPort = Number(process.env.WALNUT_CONSOLE_HOST_DAEMON_PORT ?? '')
if (hostKey && Number.isInteger(daemonPort) && daemonPort > 0) {
  const dcm = await import('../../src/providers/daemon-connection.js')
  const { execFile } = await import('node:child_process')
  const original = dcm.DaemonConnection.prototype.runRemoteScript
  const runtimeQ = `'${process.execPath}' `
  dcm.DaemonConnection.prototype.runRemoteScript = function (this: { hostKey: string }, script: string, timeoutMs = 30_000) {
    if (this.hostKey !== hostKey) return original.call(this, script, timeoutMs)
    if (typeof script !== 'string' || !script.startsWith(runtimeQ)) return Promise.reject(new Error('the test transport runs only the host server probes'))
    return new Promise<string>((resolve, reject) => execFile('/bin/sh', ['-c', script], { timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: process.env.WALNUT_CONSOLE_HOST_HOME || process.env.HOME } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))))
  } as typeof original
  // The direct link IS the host's link: every lookup of the host (its status, a session's host,
  // the server manager) gets it, as an ssh link would be pooled; redialled once a second, as the
  // ssh path redials a link the host closed.
  const direct = async () => {
    const conn = await dcm.getDirectDaemonConnection(hostKey, `ws://127.0.0.1:${daemonPort}`)
    dcm.setPooledConnectionForTest(hostKey, conn)
  }
  // Only once this server leads (a trial start reaches no host).
  if (process.env.WALNUT_LEADER_TRIAL !== '1') {
    setInterval(() => { void direct().catch(() => {}) }, 1_000).unref()
  }
}

const { startServer, armGracefulSignalExit, standbyEnded } = await import('../../src/web/server.js')
const { stop } = await (await import('./server-stops.js')).wireServerStops({ bailMs: 15_000 })
armGracefulSignalExit()
try {
  await startServer({ port, dev: false })
  console.log(`REHEARSAL_SERVER_READY ${JSON.stringify({ pid: process.pid, port, home: process.env.OPEN_WALNUT_HOME })}`)
  void standbyEnded()?.then((line) => { console.log(line); void stop() })
} catch (err) {
  console.error(`console-server: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
