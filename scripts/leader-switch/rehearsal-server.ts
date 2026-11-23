/**
 * One server of the leader-switch rehearsal (scripts/leader-switch-rehearsal.ts and
 * tests/e2e/leader-switch-real.test.ts): a real Walnut server on a synthetic home, started by
 * the switch's LocalSide (leader_switch.machines[].start_command) with its environment from
 * the machine's `env` (HOME, OPEN_WALNUT_HOME, WALNUT_MACHINE_ID_FILE, ... all inside the
 * rehearsal's own folder).
 *
 * It runs with ephemeral semantics (no shared daemon, no session pick-up), with the standby
 * copy and the leader permit allowed on an ephemeral server (WALNUT_EPHEMERAL_STANDBY,
 * WALNUT_EPHEMERAL_LEADER_SWITCH). A SIGTERM is the planned stop of `walnut web`.
 *
 *   bun scripts/leader-switch/rehearsal-server.ts --port <n>
 */
const portArg = process.argv.indexOf('--port')
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
if (!Number.isInteger(port) || port <= 0 || port === 3456) {
  console.error('rehearsal-server: --port <n> (never 3456)')
  process.exit(2)
}
if (!process.env.OPEN_WALNUT_HOME || !process.env.HOME || !process.env.OPEN_WALNUT_HOME.startsWith(process.env.HOME)) {
  console.error('rehearsal-server: OPEN_WALNUT_HOME must be set inside HOME (the rehearsal folder)')
  process.exit(2)
}
process.env.WALNUT_EPHEMERAL_STANDBY = '1'
process.env.WALNUT_EPHEMERAL_LEADER_SWITCH = '1'
process.env.WALNUT_DISABLE_SEARCH ??= '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI ??= '1'
process.env.WALNUT_DAEMON_DIR ??= `${process.env.HOME}/daemon`
process.env.WALNUT_STREAMS_DIR ??= `${process.env.HOME}/daemon-streams`
process.argv.push('--_ephemeral-child')

// WALNUT_REHEARSAL_LOAD_TRAP=<file>: every module of src/core/leader/{switch,permit}/ this server
// loads is written to <file>, one path a line: the proof that a Walnut with the experiment on
// and no witnesses set up never reaches the permit (rehearsal.ts rehearseNoWitnesses).
const trap = process.env.WALNUT_REHEARSAL_LOAD_TRAP
if (trap) {
  const fs = await import('node:fs')
  Bun.plugin({
    name: 'leader-load-trap',
    setup(build) {
      build.onLoad({ filter: /src\/core\/leader\/(switch|permit)\/[^/]+\.ts$/ }, (args) => {
        fs.appendFileSync(trap, `${args.path}\n`)
        return { contents: fs.readFileSync(args.path, 'utf8'), loader: 'ts' }
      })
    },
  })
}

const { startServer, stopServer, armGracefulSignalExit } = await import('../../src/web/server.js')
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  const bail = setTimeout(() => process.exit(1), 15_000)
  try { await stopServer({ reason: 'SIGTERM' }) } catch { /* exit anyway */ }
  clearTimeout(bail)
  process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
// As `walnut web` does: the handler first, then the server's boot-time signal handling defers to it.
armGracefulSignalExit()
try {
  await startServer({ port, dev: true })
  console.log(`REHEARSAL_SERVER_READY ${JSON.stringify({ pid: process.pid, port, home: process.env.OPEN_WALNUT_HOME })}`)
  // As `walnut web` does: a standby with nothing left to stand by for (its home leads again) stops.
  const { standbyEnded } = await import('../../src/web/server.js')
  void standbyEnded()?.then((line) => { console.log(line); void stop() })
} catch (err) {
  console.error(`rehearsal-server: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
