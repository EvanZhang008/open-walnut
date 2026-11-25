/**
 * A forward like ssh -L for tests: a local port onto a mock daemon's, which `cut()` ends as the
 * relay does. Wrap it in pacedForward() for a paced own connection.
 */
import net from 'node:net'
import type { LaneForward } from '../../src/providers/stream-lane.js'

export async function proxyForward(daemonPort: number): Promise<LaneForward & { cut(): void; accepted: () => number }> {
  const sockets = new Set<net.Socket>()
  let accepted = 0
  const server = net.createServer((client) => {
    accepted++
    const up = net.connect(daemonPort, '127.0.0.1')
    sockets.add(client); sockets.add(up)
    client.pipe(up); up.pipe(client)
    const end = () => { client.destroy(); up.destroy() }
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  const exitCbs: Array<(why: string) => void> = []
  let exited: string | null = null
  const finish = (why: string) => {
    if (exited !== null) return
    exited = why
    server.close()
    for (const s of sockets) s.destroy()
    for (const cb of exitCbs.splice(0)) cb(why)
  }
  return {
    port,
    onExit: (cb) => { if (exited !== null) cb(exited); else exitCbs.push(cb) },
    stop: () => finish('stopped'),
    cut: () => finish('code 255: client_loop: send disconnect: Broken pipe'),
    accepted: () => accepted,
  }
}
