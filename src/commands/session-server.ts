/**
 * CLI command: open-walnut session-server [--port 7890]
 * Starts the session server (WebSocket wrapping Claude Agent SDK).
 */

export async function runSessionServerCommand(options: {
  port?: string
  dataDir?: string
}): Promise<void> {
  const { runSessionServer } = await import('../session-server/index.js')
  await runSessionServer(options)
}
