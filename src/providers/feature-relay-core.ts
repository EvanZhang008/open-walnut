export interface FeatureRelaySocket { send(text: string): boolean }
interface Waiting {
  source: FeatureRelaySocket
  target: FeatureRelaySocket
  id: number
  timer: ReturnType<typeof setTimeout>
  bytes: number
  authorized: () => boolean
}

export function createFeatureRelay(nonce: string) {
  const pending = new Map<string, Waiting>()
  let sequence = 0
  let bytes = 0
  const finish = (requestId: string, result: unknown) => {
    const one = pending.get(requestId)
    if (!one) return
    pending.delete(requestId)
    bytes -= one.bytes
    clearTimeout(one.timer)
    one.source.send(JSON.stringify({ id: one.id, ok: true,
      result: one.authorized() ? result : { success: false, code: 'denied' } }))
  }
  return {
    request(source: FeatureRelaySocket, id: number, target: FeatureRelaySocket | null, frame: unknown, authorized: () => boolean): void {
      if (!Number.isSafeInteger(id) || id < 0 || frame !== null && typeof frame !== 'string'
        || typeof frame === 'string' && Buffer.byteLength(frame) > 65536) {
        source.send(JSON.stringify({ id, ok: false, error: 'Invalid feature relay request' }))
        return
      }
      if (!authorized()) { source.send(JSON.stringify({ id, ok: true, result: { success: false, code: 'denied' } })); return }
      if (!target) { source.send(JSON.stringify({ id, ok: true, result: { success: false, code: 'offline' } })); return }
      const size = typeof frame === 'string' ? Buffer.byteLength(frame) : 4
      if (pending.size >= 64 || bytes + size > 1024 * 1024 || sequence >= Number.MAX_SAFE_INTEGER) { source.send(JSON.stringify({ id, ok: true, result: { success: false, code: 'busy' } })); return }
      const requestId = `${nonce}:${++sequence}`
      const timer = setTimeout(() => finish(requestId, { success: false, code: 'expired' }), 10000)
      pending.set(requestId, { source, id, target, timer, bytes: size, authorized })
      bytes += size
      if (!target.send(JSON.stringify({ ev: 'feature-request', requestId, frame }))) finish(requestId, { success: false, code: 'offline' })
    },
    result(target: FeatureRelaySocket, requestId: unknown, raw: unknown): boolean {
      if (typeof requestId !== 'string') return false
      const one = pending.get(requestId)
      if (!one || one.target !== target) return false
      let text: string
      try { text = JSON.stringify(raw) } catch { return false }
      if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) return false
      finish(requestId, raw)
      return true
    },
    disconnect(socket: FeatureRelaySocket): void {
      for (const [requestId, one] of pending) {
        if (one.target === socket) finish(requestId, { success: false, code: 'offline' })
        else if (one.source === socket) { pending.delete(requestId); bytes -= one.bytes; clearTimeout(one.timer) }
      }
    },
    get pendingCount(): number { return pending.size },
  }
}
