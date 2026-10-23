// The box's front door, standing in for Caddy (scripts/cloud/setup.sh): every
// connection on :8080 is passed to the server on 127.0.0.1:3456, where a
// replica server listens on loopback only. Plain Node, node: builtins only.
import net from 'node:net'

const PORT = Number(process.env.FRONT_DOOR_PORT || 8080)
const UPSTREAM = Number(process.env.FRONT_DOOR_UPSTREAM || 3456)

net.createServer((client) => {
  const server = net.connect(UPSTREAM, '127.0.0.1')
  client.pipe(server)
  server.pipe(client)
  const end = () => { client.destroy(); server.destroy() }
  client.on('error', end)
  server.on('error', end)
  client.on('close', end)
  server.on('close', end)
}).listen(PORT, '0.0.0.0', () => console.log(`[front-door] :${PORT} -> 127.0.0.1:${UPSTREAM}`))
