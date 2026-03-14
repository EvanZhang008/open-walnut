/**
 * Session Server — entry point.
 *
 * Usage:
 *   node dist/session-server.js [--port 7890] [--data-dir ~/.open-walnut]
 *
 * Or via CLI:
 *   open-walnut session-server [--port 7890]
 */

import { SessionServer } from './server.js'

export interface SessionServerCLIOptions {
  port: number
  dataDir: string
}

const DEFAULT_PORT = 7890

/**
 * Start the session server with the given options.
 * Returns the actual port (may differ if 0 was passed).
 */
export async function startSessionServer(options: SessionServerCLIOptions): Promise<{
  port: number
  server: SessionServer
}> {
  // The Agent SDK spawns `claude` as a child process. If CLAUDECODE is set
  // (e.g. when this server is started from inside a Claude Code session),
  // the child claude process refuses to run ("cannot launch inside another
  // Claude Code session"). Remove it so SDK sessions work unconditionally.
  delete process.env.CLAUDECODE

  const server = new SessionServer({
    port: options.port,
    dataDir: options.dataDir,
  })

  const actualPort = await server.start()
  return { port: actualPort, server }
}

/**
 * CLI entry point — parse args and start.
 */
export async function runSessionServer(options: {
  port?: string
  dataDir?: string
}): Promise<void> {
  const { WALNUT_HOME } = await import('../constants.js')

  const port = parseInt(options.port ?? String(DEFAULT_PORT), 10)
  const dataDir = options.dataDir ?? WALNUT_HOME

  const { port: actualPort } = await startSessionServer({ port, dataDir })

  console.log(JSON.stringify({ port: actualPort, pid: process.pid }))

  // Keep alive until SIGINT/SIGTERM
  const shutdown = () => {
    console.error('Session server shutting down...')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// When run directly as a standalone script, parse CLI args and start.
const isMainModule = process.argv[1]?.endsWith('session-server/index.js') ||
  process.argv[1]?.endsWith('session-server/index.mjs')

if (isMainModule) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const dataDirIdx = args.indexOf('--data-dir')
  const options: { port?: string; dataDir?: string } = {}
  if (portIdx !== -1 && args[portIdx + 1]) options.port = args[portIdx + 1]
  if (dataDirIdx !== -1 && args[dataDirIdx + 1]) options.dataDir = args[dataDirIdx + 1]
  runSessionServer(options).catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
}
