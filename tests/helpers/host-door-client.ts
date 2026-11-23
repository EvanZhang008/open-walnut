/**
 * A raw host at the leader's door (src/core/session-channel/door-wire.ts, v2): dials with no secret,
 * sends its hello, reads the welcome (or the close code), and answers with its auth proof made with
 * `verifyKey` (a wrong key or `auth: 'none'` to test the refusals).
 */
import { WebSocket } from 'ws'
import { doorKeyId, hostDoorProof } from '../../src/core/session-channel/door-wire.js'

export const HOST_NONCE = 'cd'.repeat(32)

export interface DoorClient {
  ws: WebSocket
  /** The welcome, when the door sent one. */
  welcome?: any
  /** The close code, when the door closed before a welcome. */
  code?: number
  /** Resolves with the close code whenever the socket closes. */
  closed: Promise<number>
  /** Frames after the welcome. */
  frames: any[]
}

export async function doorHandshake(url: string, o: { walnutId: string; machineId: string; verifyKey?: string; nonce?: string; auth?: 'good' | 'none'; headers?: Record<string, string> }): Promise<DoorClient> {
  const ws = new WebSocket(url, o.headers ? { headers: o.headers } : {})
  const frames: any[] = []
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  ws.on('error', () => {})
  const nonce = o.nonce ?? HOST_NONCE
  const first = await new Promise<{ welcome?: any; code?: number }>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 2, walnutId: o.walnutId, machineId: o.machineId, nonce })))
    ws.once('message', (m) => resolve({ welcome: JSON.parse(String(m)) }))
    void closed.then((code) => resolve({ code }))
  })
  ws.on('message', (m) => { try { frames.push(JSON.parse(String(m))) } catch { /* not JSON */ } })
  if (first.welcome && o.verifyKey && (o.auth ?? 'good') === 'good') {
    const proof = hostDoorProof(o.verifyKey, { nonceH: nonce, nonceD: first.welcome.nonce, walnutId: o.walnutId, machineId: o.machineId })
    ws.send(JSON.stringify({ ch: 'door', op: 'auth', keyId: doorKeyId(o.verifyKey), proof }))
  }
  return { ws, ...first, closed, frames }
}
