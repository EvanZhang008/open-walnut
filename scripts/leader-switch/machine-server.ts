/**
 * A real, NOT ephemeral Walnut server of a rehearsal machine, on a synthetic home, started by the
 * switch's LocalSide (leader_switch.machines[].start_command) like rehearsal-server.ts: the console
 * rehearsal's new leader (console-world.ts) and both leaders of the cross-machine rehearsal
 * (remote-world.ts). It is not ephemeral because a leader must reach other machines' daemons as its
 * hosts (an ephemeral server only reads remote hosts), and its whole world stays inside the rehearsal
 * folder (HOME, the data home, the daemon dirs; checked below).
 *
 * The one test seam: the other machines' daemons are reached on loopback ports (daemon-routes.ts,
 * WALNUT_REHEARSAL_DAEMON_ROUTES), never ssh; this server's own code decides when it dials.
 *
 *   bun scripts/leader-switch/machine-server.ts --port <n> [--dev]
 */
import path from 'node:path'

const portArg = process.argv.indexOf('--port')
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
if (!Number.isInteger(port) || port <= 0 || port === 3456) {
  console.error('machine-server: --port <n> (never 3456)')
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
  console.error('machine-server: HOME must be a folder of the rehearsal, never the account\'s own home')
  process.exit(2)
}
const inside = (p: string | undefined) => !!p && !!home && path.resolve(p).startsWith(path.resolve(home) + path.sep)
if (!inside(process.env.OPEN_WALNUT_HOME) || !inside(process.env.WALNUT_DAEMON_DIR) || !inside(process.env.WALNUT_STREAMS_DIR)) {
  console.error('machine-server: OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR and WALNUT_STREAMS_DIR must be set inside HOME (the rehearsal folder)')
  process.exit(2)
}
process.env.WALNUT_DISABLE_SEARCH ??= '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI ??= '1'
process.env.WALNUT_LOCAL_CLAUDE_PROBE ??= '0'
process.env.WALNUT_NO_AUTO_UPDATE ??= '1'

const c = await import('../../src/constants.js')
if (c.WALNUT_HOME !== path.resolve(process.env.OPEN_WALNUT_HOME!) || c.CLOUD_MODE || c.IS_EPHEMERAL) {
  console.error(`machine-server: REFUSING the home ${c.WALNUT_HOME}`)
  process.exit(3)
}

const routes = process.env.WALNUT_REHEARSAL_DAEMON_ROUTES
if (routes) await (await import('./daemon-routes.js')).routeDaemonLinks(JSON.parse(routes))
await (await import('./witness-links.js')).linkRehearsalWitnesses()

const { startServer, armGracefulSignalExit, standbyEnded } = await import('../../src/web/server.js')
const { stop } = await (await import('./server-stops.js')).wireServerStops({ bailMs: 15_000 })
armGracefulSignalExit()
try {
  await startServer({ port, dev: process.argv.includes('--dev') })
  console.log(`REHEARSAL_SERVER_READY ${JSON.stringify({ pid: process.pid, port, home: process.env.OPEN_WALNUT_HOME })}`)
  void standbyEnded()?.then((line) => { console.log(line); void stop() })
} catch (err) {
  console.error(`machine-server: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
