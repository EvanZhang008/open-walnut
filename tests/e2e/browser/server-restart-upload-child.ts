/**
 * The Walnut server of server-restart-upload-server.ts: one real production-mode
 * server (the built web app, no vite in front) on PW_TEST_PORT, run as its own
 * process so the fixture can stop it and start it again the way a deploy restarts
 * the Mac's server. Its home, daemon and data are the parent's, so the second
 * server finds the first one's sessions and daemon.
 */
import fs from 'node:fs'
import path from 'node:path'

const port = Number(process.env.PW_TEST_PORT ?? 3542)
if (port === 3456) throw new Error('Production port is forbidden')
const daemonBin = process.env.RESTART_FIXTURE_DAEMON_BIN
if (!daemonBin || !fs.existsSync(daemonBin)) throw new Error('RESTART_FIXTURE_DAEMON_BIN is required')
process.argv.push('--_ephemeral-child')

const { localDaemon } = await import('../../../src/providers/local-daemon.js')
;(localDaemon as unknown as { findDaemonBinary: () => string }).findDaemonBinary = () => daemonBin

const { startServer, stopServer, armGracefulSignalExit } = await import('../../../src/web/server.js')
await startServer({ port, dev: false })
console.log(`RESTART_CHILD_READY ${port} ${path.basename(daemonBin)}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  // The daemon stays: a deploy restarts the server, never the sessions' daemon.
  await stopServer().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
armGracefulSignalExit()
