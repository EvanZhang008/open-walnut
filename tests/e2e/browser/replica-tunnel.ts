/**
 * A fake `ssh -R` tunnel in front of a host replica, for the browser specs
 * (replica-server.ts, replica-smoke.spec.ts), with no proxy header added, as the
 * real tunnel does (the shape of browser-access-tunnel.spec.ts). Two modes:
 *
 *   pagePort given   /api and /ws go to the replica's public port, every other
 *                    path to that page server (Vite: the SPA in dev mode)
 *   no pagePort      EVERY path goes to the replica, as the real tunnel sends it:
 *                    the page and its assets are the replica's own (a cluster
 *                    with app 'built', the replica dev:false over a real build)
 */
import http from 'node:http'
import net from 'node:net'

export interface FakeTunnel { port: number; close(): Promise<void> }

export async function startFakeTunnel(o: { port: number; replicaPort: number; pagePort?: number }): Promise<FakeTunnel> {
  const pagePort = o.pagePort
  const toReplica = (url: string | undefined) => pagePort === undefined || (url ?? '').startsWith('/api') || (url ?? '').startsWith('/ws')
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: toReplica(req.url) ? o.replicaPort : pagePort!, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(up)
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(toReplica(req.url) ? o.replicaPort : pagePort!, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      up.write(raw + '\r\n')
      if (head.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    sockets.add(up)
    up.on('close', () => sockets.delete(up))
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
