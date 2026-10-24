/**
 * Child for tests/web/exit-detail.test.ts: dies the way the server did on
 * 2026-10-24, of a socket 'error' event nothing listens for, and prints what
 * the server's exit log would record for it.
 *
 * Mode `reset`: a loopback server answers the client's first bytes with a TCP
 * reset, so the client's read fails with ECONNRESET. Mode `secret`: an uncaught error
 * whose message and stack carry URL credentials, to prove the redaction.
 * Only loopback sockets this process opens; no signal to any other process.
 */
import net from 'node:net'
import { exitDetail } from '../../../src/web/exit-detail.js'

process.on('uncaughtException', (err) => {
  process.stdout.write(JSON.stringify(exitDetail(err)))
  process.exit(1)
})

if (process.argv[2] === 'secret') {
  setTimeout(() => { throw new Error('fetch failed for https://tester:hunter2-not-a-real-one@sync.example.test/repo') }, 0)
} else {
  // Reset only after the first bytes arrive, so the CLIENT'S READ fails (not its connect).
  const server = net.createServer((sock) => { sock.once('data', () => sock.resetAndDestroy()) })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo
    // No 'error' listener on purpose: that is the defect being recorded.
    const client = net.connect(port, '127.0.0.1')
    client.on('connect', () => client.write('hello'))
  })
}
