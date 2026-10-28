import { randomUUID } from 'node:crypto'
import {
  capabilityKey, decodeFrame, encodeFrame, MAX_PENDING_BYTES, MAX_READ_MS,
  type CapabilityRef, type Clock, type FailureCode, type Outcome, type ReadFrame, type ResultFrame,
} from '../../core/feature-nodes/protocol.js'
import { sendFrame, type ReadTransport } from '../../core/feature-nodes/connections.js'
import { readAuthority, type Authority } from '../../core/feature-nodes/contracts.js'

export interface FeatureNodeIdentity {
  authority: Authority
  verify(): Promise<Authority | undefined>
}
export interface FeatureNodeStatus {
  authority: Authority
  generation: string
  capabilities: readonly CapabilityRef[]
}
interface Peer {
  identity: FeatureNodeIdentity
  generation: string
  transport: ReadTransport
  capabilities: readonly CapabilityRef[]
  listeners: Array<() => void>
  pending: Map<string, Pending>
  closed: boolean
}
interface Pending {
  frame: ReadFrame
  original: ReadFrame
  bytes: number
  timer?: unknown
  settling: boolean
  resolve(frame: ResultFrame): void
}
interface Verification {
  peer: Peer
  result: Promise<Authority | undefined>
}

export class FeatureNodeHub {
  private readonly peers = new Map<string, Peer>()
  private readonly verification = new Map<string, Verification>()
  private listing?: Promise<FeatureNodeStatus[]>
  private sequence = 0
  private callSequence = 0
  private readonly nonce = randomUUID()
  private pendingCount = 0
  private pendingBytes = 0
  private closed = false

  constructor(private readonly clock: Clock) {}

  attach(identity: FeatureNodeIdentity, transport: ReadTransport): Outcome<FeatureNodeStatus> {
    const authority = readAuthority(() => identity.authority, identity.authority.nodeId, identity.authority.accountId)
    if (!authority) return { success: false, code: 'denied' }
    if (this.closed || this.sequence >= Number.MAX_SAFE_INTEGER) return { success: false, code: 'offline' }
    try { if (transport.state() !== 'open') return { success: false, code: 'offline' } }
    catch { return { success: false, code: 'offline' } }
    if (!this.peers.has(authority.nodeId) && this.peers.size >= 32) return { success: false, code: 'busy' }
    const peer: Peer = { identity: { authority, verify: () => identity.verify() }, transport,
      generation: `${this.nonce}:${++this.sequence}`, capabilities: [], listeners: [], pending: new Map(), closed: false }
    const prior = this.peers.get(authority.nodeId)
    this.peers.set(authority.nodeId, peer)
    if (prior) this.drop(prior, 'offline')
    const subscribe = (register: () => () => void) => {
      if (peer.closed) return
      const dispose = register()
      if (peer.closed) dispose(); else peer.listeners.push(dispose)
    }
    try {
      subscribe(() => transport.onMessage((raw) => this.receive(peer, raw)))
      subscribe(() => transport.onClose(() => this.drop(peer, 'offline')))
      subscribe(() => transport.onError(() => this.drop(peer, 'offline')))
    } catch { this.drop(peer, 'offline') }
    return this.current(peer) ? { success: true, payload: this.status(peer) } : { success: false, code: 'offline' }
  }

  private status(peer: Peer): FeatureNodeStatus {
    return { authority: peer.identity.authority, generation: peer.generation, capabilities: peer.capabilities }
  }

  async check(nodeId: string, generation: string): Promise<boolean> {
    const peer = this.peers.get(nodeId)
    return !!peer && peer.generation === generation && !!await this.valid(peer)
  }

  list(): Promise<FeatureNodeStatus[]> {
    if (this.listing) return this.listing
    const peers = [...this.peers.values()]
    const result = Promise.all(peers.map(async (peer) => await this.valid(peer) ? this.status(peer) : null))
      .then((values) => values.filter((value): value is FeatureNodeStatus => value !== null))
    this.listing = result
    void result.finally(() => { if (this.listing === result) this.listing = undefined }).catch(() => {})
    return result
  }

  async page(after: string | null): Promise<{ items: FeatureNodeStatus[]; nextCursor: string | null }> {
    const keys = [...this.peers.keys()].sort().filter((key) => after === null || key > after)
    const nodeId = keys[0]
    if (!nodeId) return { items: [], nextCursor: null }
    const peer = this.peers.get(nodeId)!
    const valid = await this.valid(peer)
    return { items: valid ? [this.status(peer)] : [], nextCursor: keys.length > 1 ? nodeId : null }
  }

  async lookup(nodeId: string): Promise<FeatureNodeStatus | null> {
    const peer = this.peers.get(nodeId)
    return peer && await this.valid(peer) ? this.status(peer) : null
  }

  private current(peer: Peer): boolean {
    return !peer.closed && this.peers.get(peer.identity.authority.nodeId) === peer
  }

  private async fresh(peer: Peer): Promise<Authority | undefined> {
    const before = this.verification.get(peer.identity.authority.nodeId)
    if (before) {
      await before.result
      if (!this.current(peer) || this.verification.get(peer.identity.authority.nodeId) === before) return undefined
    }
    // A concurrent result may have started a newer check while this one waited.
    return this.valid(peer)
  }

  private valid(peer: Peer): Promise<Authority | undefined> {
    if (!this.current(peer)) return Promise.resolve(undefined)
    const nodeId = peer.identity.authority.nodeId
    const existing = this.verification.get(nodeId)
    if (existing) return existing.peer === peer ? existing.result : Promise.resolve(undefined)
    if (this.verification.size >= 32) return Promise.resolve(undefined)
    let settle!: (value: Authority | undefined) => void
    const result = new Promise<Authority | undefined>((resolve) => { settle = resolve })
    const flight = { peer, result }
    this.verification.set(nodeId, flight)
    let timer: unknown
    const finish = (value: Authority | undefined) => {
      const bound = peer.identity.authority
      const parsed = readAuthority(() => value, bound.nodeId, bound.accountId)
      if (!parsed || parsed.permissionVersion !== bound.permissionVersion) {
        this.drop(peer, 'denied')
        settle(undefined)
      } else settle(this.current(peer) ? parsed : undefined)
    }
    try {
      timer = this.clock.setTimeout(() => finish(undefined), 1000)
      const source = Promise.resolve().then(() => peer.identity.verify())
      const settled = (value: Authority | undefined) => {
        if (this.verification.get(nodeId) === flight) this.verification.delete(nodeId)
        finish(value)
      }
      void source.then(settled, () => settled(undefined)).finally(() => {
        if (timer !== undefined) { try { this.clock.clearTimeout(timer) } catch {} }
      }).catch(() => {})
    } catch {
      finish(undefined)
      this.verification.delete(nodeId)
    }
    return result
  }

  private allowed(peer: Peer, frame: ReadFrame, current: Authority): boolean {
    const bound = peer.identity.authority
    const matches = (grant: Authority['grants'][number]) => capabilityKey(grant.capability) === capabilityKey(frame.capability)
      && grant.fingerprint === frame.fingerprint
    return frame.accountId === bound.accountId && frame.permissionVersion === bound.permissionVersion
      && frame.generation === peer.generation && bound.grants.some(matches) && current.grants.some(matches)
  }

  async read(raw: unknown): Promise<ResultFrame | { success: false; code: FailureCode }> {
    const decoded = decodeFrame(raw)
    if (!decoded.success || decoded.payload.type !== 'read') return { success: false, code: 'malformed' }
    const original = decoded.payload
    const rejected = (code: FailureCode): ResultFrame => ({ protocolVersion: 1, type: 'result',
      correlationId: original.correlationId, generation: original.generation, success: false, code })
    const peer = this.peers.get(original.nodeId)
    if (!peer) return rejected('offline')
    const remaining = original.expiresAt - this.clock.now()
    if (remaining <= 0 || remaining > MAX_READ_MS) return rejected('expired')
    if (this.callSequence >= Number.MAX_SAFE_INTEGER) return rejected('unavailable')
    const frame = { ...original, correlationId: `${this.nonce}:read:${++this.callSequence}` }
    const encoded = encodeFrame(frame)
    if (!encoded.success) return rejected('malformed')
    const bytes = Buffer.byteLength(encoded.payload)
    if ([...peer.pending.values()].some((pending) => pending.original.correlationId === original.correlationId)) return rejected('malformed')
    if (peer.pending.size >= 4 || this.pendingCount >= 64 || this.pendingBytes + bytes > MAX_PENDING_BYTES) return rejected('busy')
    return new Promise((resolve) => {
      const pending: Pending = { frame, original, bytes, resolve, settling: false }
      peer.pending.set(frame.correlationId, pending)
      this.pendingCount++
      this.pendingBytes += bytes
      try {
        const timer = this.clock.setTimeout(() => {
          this.end(peer, pending, rejected('expired'))
          sendFrame(peer.transport, { protocolVersion: 1, type: 'cancel', generation: frame.generation, correlationId: frame.correlationId })
        }, remaining)
        pending.timer = timer
        if (peer.pending.get(frame.correlationId) !== pending) {
          this.clock.clearTimeout(timer)
          return
        }
        void this.fresh(peer).then((current) => {
          if (peer.pending.get(frame.correlationId) !== pending) return
          if (!current || !this.allowed(peer, frame, current)) { this.end(peer, pending, rejected('denied')); return }
          if (this.clock.now() >= frame.expiresAt) { this.end(peer, pending, rejected('expired')); return }
          if (!peer.capabilities.some((ref) => capabilityKey(ref) === capabilityKey(frame.capability))) {
            this.end(peer, pending, rejected('unavailable')); return
          }
          if (!sendFrame(peer.transport, frame)) this.drop(peer, 'offline')
        }).catch(() => this.end(peer, pending, rejected('internal')))
      } catch { this.end(peer, pending, rejected('internal')) }
    })
  }

  private receive(peer: Peer, raw: unknown): void {
    if (!this.current(peer)) return
    const decoded = decodeFrame(raw)
    if (!decoded.success) { this.drop(peer, 'malformed'); return }
    const frame = decoded.payload
    if (frame.type === 'manifest') {
      peer.capabilities = Object.freeze(frame.capabilities.map((ref) => Object.freeze({ ...ref })))
      return
    }
    if (frame.type !== 'result') { this.drop(peer, 'malformed'); return }
    if (frame.generation !== peer.generation) return
    const pending = peer.pending.get(frame.correlationId)
    if (!pending || pending.settling) return
    pending.settling = true
    void this.fresh(peer).then((current) => {
      if (peer.pending.get(frame.correlationId) !== pending) return
      if (!current || !this.allowed(peer, pending.frame, current)) {
        this.end(peer, pending, { protocolVersion: 1, type: 'result',
          generation: frame.generation, correlationId: frame.correlationId, success: false, code: 'denied' })
      } else if (this.clock.now() >= pending.frame.expiresAt) {
        this.end(peer, pending, { protocolVersion: 1, type: 'result',
          generation: frame.generation, correlationId: frame.correlationId, success: false, code: 'expired' })
      } else this.end(peer, pending, frame)
    }).catch(() => this.drop(peer, 'denied'))
  }

  private end(peer: Peer, pending: Pending, result: ResultFrame): void {
    if (peer.pending.get(pending.frame.correlationId) !== pending) return
    peer.pending.delete(pending.frame.correlationId)
    this.pendingCount--
    this.pendingBytes -= pending.bytes
    if (pending.timer !== undefined) { try { this.clock.clearTimeout(pending.timer) } catch {} }
    pending.resolve({ ...result, generation: pending.original.generation, correlationId: pending.original.correlationId })
  }

  private drop(peer: Peer, code: FailureCode): void {
    if (peer.closed) return
    peer.closed = true
    if (this.peers.get(peer.identity.authority.nodeId) === peer) this.peers.delete(peer.identity.authority.nodeId)
    for (const pending of peer.pending.values()) this.end(peer, pending, {
      protocolVersion: 1, type: 'result', generation: pending.frame.generation,
      correlationId: pending.frame.correlationId, success: false, code,
    })
    for (const dispose of peer.listeners.splice(0)) { try { dispose() } catch {} }
    try { peer.transport.close() } catch {}
  }

  close(): void {
    this.closed = true
    for (const peer of [...this.peers.values()]) this.drop(peer, 'offline')
  }

  get size(): number { return this.peers.size }
  get resources(): { calls: number; bytes: number; verification: number } {
    return { calls: this.pendingCount, bytes: this.pendingBytes, verification: this.verification.size }
  }
}
