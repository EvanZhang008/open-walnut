/**
 * Child for tests/web/exit-detail.test.ts, run on bun as the server is. It
 * prints what the server's exit log would record if it died, or that it lived.
 *
 * Mode `refused`: a connect to a loopback port that was just closed, with no
 * 'error' listener. On bun that error is uncaught and kills the process: the
 * record case. Mode `reset`: a loopback server answers the client's first bytes
 * with a TCP reset, again with no listener. On Node that killed the server on
 * 2026-10-24 (`read ECONNRESET`); on bun the socket ends and closes, and the
 * process lives. Mode `secret`: an uncaught error whose message and stack carry
 * URL credentials, to prove the redaction.
 * Only loopback sockets this process opens; no signal to any other process.
 */
import net from 'node:net'
import { exitDetail } from '../../../src/web/exit-detail.js'

process.on('uncaughtException', (err) => {
  process.stdout.write(JSON.stringify(exitDetail(err)))
  process.exit(1)
})

const mode = process.argv[2]
if (mode === 'secret') {
  setTimeout(() => { throw new Error('fetch failed for https://tester:hunter2-not-a-real-one@sync.example.test/repo') }, 0)
} else if (mode === 'refused') {
  // A port that was free a moment ago: listen, read the port, close, then connect.
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo
    // No 'error' listener on purpose: the uncaught error is what gets recorded.
    server.close(() => { net.connect(port, '127.0.0.1') })
  })
} else {
  // `reset`. Alive and quiet after the client closed: no record, exit 0. A guard
  // answers too if the client never closes, so a hang reads as a failure, not a pass.
  const lived = (clientClosed: boolean) => { process.stdout.write(JSON.stringify({ alive: true, clientClosed })); process.exit(0) }
  const guard = setTimeout(() => lived(false), 10_000)
  // Reset only after the first bytes arrive, so the CLIENT'S READ fails (not its connect).
  const server = net.createServer((sock) => { sock.once('data', () => sock.resetAndDestroy()) })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo
    // No 'error' listener on purpose: that is the defect that killed Node.
    const client = net.connect(port, '127.0.0.1')
    client.on('connect', () => client.write('hello'))
    // A second after the close, long enough for a late error to arrive first.
    client.on('close', () => { clearTimeout(guard); server.close(); setTimeout(() => lived(true), 1_000) })
  })
}
