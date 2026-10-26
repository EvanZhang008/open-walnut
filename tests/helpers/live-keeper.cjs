/**
 * The parent of a daemon a live e2e test starts itself (tests/e2e/leader-takeover-live-e2e.test.ts),
 * inside the same walls (tests/helpers/live-isolation.ts). The daemon's parent watchdog
 * (WALNUT_DAEMON_PARENT_PID) asks this process with signal 0, which the walls allow only inside them,
 * so the daemon can stay behind the signal wall instead of asking the test process outside it.
 *
 * argv: <command> [args...]. Prints {"daemon": <pid>} once it spawned the command. It never signals
 * the daemon: it ends when the daemon ends (with its code), or when the test process is gone (its
 * stdin closes), after which the daemon's own watchdog ends the daemon. TERM and INT are ignored, so
 * the test stops the daemon, and this ends after it.
 */
'use strict'
const { spawn } = require('node:child_process')

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) { process.stderr.write('live keeper: no command\n'); process.exit(64) }
const child = spawn(cmd, args, {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WALNUT_DAEMON_PARENT_PID: String(process.pid) },
})
child.once('error', (err) => { process.stderr.write(`live keeper: ${err.message}\n`); process.exit(70) })
process.stdout.write(JSON.stringify({ daemon: child.pid ?? null }) + '\n')
child.once('exit', (code, sig) => process.exit(code ?? (sig ? 128 : 1)))
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
