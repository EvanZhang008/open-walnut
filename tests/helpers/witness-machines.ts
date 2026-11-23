/**
 * Real witness machines on one computer for the leader switch's tests: each is a real leader door
 * (src/replica/leader-door.ts) behind a real TCP loopback listener, serving its witness route from
 * its own state root on disk. `loopbackCall` is a RemoteCall that sends the request as real HTTP
 * bytes over a fresh loopback connection, the way the daemon's relayed stream carries it (one
 * request per stream, host-server/request-over.ts). It is every layer of a witness call but the
 * daemon and the ssh hop.
 */
import net from 'node:net'
import { createLeaderDoor } from '../../src/replica/leader-door.js'
import { requestOver } from '../../src/core/host-server/request-over.js'
import type { DeviceCopy } from '../../src/host-server/device-copy.js'
import type { RemoteCall } from '../../src/core/leader/switch/witness-transport.js'

export interface WitnessMachine {
  host: string
  port: number
  root: string
  /** The experiment `switchable_leader` on this machine (a host's config copy of the leader's). */
  enabled: boolean
  /** The Walnut this machine's service follows. */
  walnutId: string | null
  /** Refuse new connections from now on (the machine is down); true brings it back. */
  setUp(up: boolean): void
  close(): Promise<void>
}

export async function startWitnessMachine(o: { host: string; root: string; walnutId: string | null; enabled?: boolean }): Promise<WitnessMachine> {
  const m: WitnessMachine = {
    host: o.host, port: 0, root: o.root, enabled: o.enabled ?? true, walnutId: o.walnutId,
    setUp: (up) => { down = !up; if (down) for (const s of sockets) s.destroy() },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); await door.close() },
  }
  let down = false
  const sockets = new Set<net.Socket>()
  const door = createLeaderDoor({
    devices: { put: async () => ({}) } as unknown as DeviceCopy,
    witness: { enabled: async () => m.enabled, walnutId: () => m.walnutId, root: () => m.root },
  })
  const server = net.createServer((sock) => {
    if (down) { sock.destroy(); return }
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    door.accept(sock)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  m.port = (server.address() as net.AddressInfo).port
  return m
}

/** A call to `machines[place.host]` over a fresh loopback connection (a witness whose host is not a machine here: no answer). */
export function loopbackCall(machines: Record<string, { port: number }>, opts: { delayMs?: number; timeoutMs?: number } = {}): RemoteCall {
  return (place, path, body, done) => {
    const m = place.host ? machines[place.host] : undefined
    if (!m) { done(null); return }
    let sock: net.Socket | null = null
    let gone = false
    const go = (): void => {
      if (gone) return
      sock = net.connect(m.port, '127.0.0.1')
      sock.on('error', () => done(null))
      requestOver(sock, 'POST', path, Buffer.from(JSON.stringify(body)), opts.timeoutMs ?? 5_000)
        .then(async (res) => done({ status: res.status, body: await res.json().catch(() => null) }))
        .catch(() => done(null))
    }
    if (opts.delayMs) setTimeout(go, opts.delayMs); else go()
    return () => { gone = true; sock?.destroy() }
  }
}

/** Setup evidence of a Walnut that never had a record: every other witness seen blank. */
export function blankEvidence(list: string[], target: string): Array<{ witness: string; seen: 'blank' }> {
  return list.filter((w) => w !== target).map((witness) => ({ witness, seen: 'blank' as const }))
}
