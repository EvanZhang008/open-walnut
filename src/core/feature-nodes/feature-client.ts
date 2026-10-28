import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ContractRegistry, readAuthority, type Authority, type ReadContract } from './contracts.js'
import {
  capabilitySchema, decodeFrame, encodeFrame, identifierSchema, immutableJson,
  MAX_PENDING_BYTES, MAX_READ_MS, failureCodes, type JsonValue, type Outcome,
} from './protocol.js'
import type { ReadCall } from './calls.js'

export interface FeatureRelayConnection {
  hasCapability(name: string): boolean
  send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}
export interface FeatureNodeStatus {
  authority: Authority
  generation: string
  capabilities: readonly z.infer<typeof capabilitySchema>[]
}
const relayFailureSchema = z.strictObject({ success: z.literal(false), code: z.enum(failureCodes) })
const statusSchema = z.strictObject({
  authority: z.unknown(), generation: identifierSchema,
  capabilities: z.array(capabilitySchema).max(64).refine((values) =>
    new Set(values.map((value) => `${value.id}/${value.version}`)).size === values.length),
})
const pageSchema = z.strictObject({ success: z.literal(true), payload: z.strictObject({
  items: z.array(statusSchema).max(1), nextCursor: identifierSchema.nullable(),
}) })
function nodeStatus(raw: unknown): FeatureNodeStatus | undefined {
  const checked = statusSchema.safeParse(raw)
  if (!checked.success) return undefined
  const value = checked.data
  const untrusted = value.authority as Authority | undefined
  const authority = readAuthority(() => value.authority as Authority, untrusted?.nodeId ?? '', untrusted?.accountId ?? '')
  return authority ? { authority, generation: value.generation, capabilities: value.capabilities } : undefined
}

export class FeatureNodeClient {
  private readonly contracts = new ContractRegistry()
  private readonly nonce = randomUUID()
  private readonly perNode = new Map<string, number>()
  private readonly cancellations = new Set<() => void>()
  private readonly flights = new Set<Promise<unknown>>()
  private sequence = 0
  private pending = 0
  private bytes = 0
  private closed = false
  private listing?: Promise<Outcome<FeatureNodeStatus[]>>
  constructor(
    private readonly connection: () => FeatureRelayConnection | undefined,
    private readonly prepare: () => Promise<void> = async () => {},
  ) {}

  register(contract: ReadContract): () => void {
    if (this.closed) throw new Error('Feature client unavailable')
    return this.contracts.register(contract)
  }

  private relay(): FeatureRelayConnection | undefined {
    if (this.closed) return undefined
    const value = this.connection()
    return value?.hasCapability('feature-relay-v1') ? value : undefined
  }

  list(): Promise<Outcome<FeatureNodeStatus[]>> {
    if (this.closed) return Promise.resolve({ success: false, code: 'unavailable' })
    if (this.listing) return this.listing
    const underlying = this.track(this.fetchNodes())
    const result = this.bounded(underlying, MAX_READ_MS)
    this.listing = result
    // A timed-out transport still holds the listing permit until it actually settles.
    void underlying.finally(() => { if (this.listing === result) this.listing = undefined }).catch(() => {})
    return result
  }

  private async fetchNodes(): Promise<Outcome<FeatureNodeStatus[]>> {
    const deadline = Date.now() + MAX_READ_MS
    try {
      await this.prepare()
      const connection = this.relay()
      if (!connection) return { success: false, code: 'unavailable' }
      const nodes: FeatureNodeStatus[] = []
      let after: string | null = null
      for (let page = 0; page < 32; page++) {
        if (this.closed || Date.now() >= deadline) return { success: false, code: 'expired' }
        const reply = await connection.send('feature.request', { frame: after === null ? null : JSON.stringify({ type: 'list', after }) }, 11000)
        if (connection !== this.relay()) return { success: false, code: 'offline' }
        const copied = immutableJson(reply.result)
        if (!copied.success) return { success: false, code: 'invalid_output' }
        const failed = relayFailureSchema.safeParse(copied.payload)
        if (failed.success) return failed.data
        const checked = pageSchema.safeParse(copied.payload)
        if (!checked.success) return { success: false, code: 'invalid_output' }
        for (const raw of checked.data.payload.items) {
          const node = nodeStatus(raw)
          if (!node || after !== null && node.authority.nodeId <= after || nodes.some((prior) => prior.authority.nodeId === node.authority.nodeId)) return { success: false, code: 'invalid_output' }
          nodes.push(node)
        }
        const cursor = checked.data.payload.nextCursor
        if (cursor === null) return { success: true, payload: nodes }
        if (after !== null && cursor <= after) return { success: false, code: 'invalid_output' }
        after = cursor
      }
      return { success: false, code: 'busy' }
    } catch { return { success: false, code: 'offline' } }
  }

  private async lookup(nodeId: string, deadline: number, signal?: AbortSignal): Promise<Outcome<FeatureNodeStatus | null>> {
    try {
      await this.prepare()
      if (this.closed || signal?.aborted) return { success: false, code: 'cancelled' }
      if (Date.now() >= deadline) return { success: false, code: 'expired' }
      const connection = this.relay()
      if (!connection) return { success: false, code: 'unavailable' }
      const reply = await connection.send('feature.request', { frame: JSON.stringify({ type: 'lookup', nodeId }) }, 11000)
      if (connection !== this.relay()) return { success: false, code: 'offline' }
      const copied = immutableJson(reply.result)
      if (!copied.success) return { success: false, code: 'invalid_output' }
      const failed = relayFailureSchema.safeParse(copied.payload)
      if (failed.success) return failed.data
      const value = z.strictObject({ success: z.literal(true), payload: statusSchema.nullable() }).safeParse(copied.payload)
      if (!value.success) return { success: false, code: 'invalid_output' }
      if (value.data.payload === null) return { success: true, payload: null }
      const node = nodeStatus(value.data.payload)
      return node?.authority.nodeId === nodeId ? { success: true, payload: node } : { success: false, code: 'invalid_output' }
    } catch { return { success: false, code: 'offline' } }
  }

  read(call: ReadCall): Promise<Outcome<JsonValue>> {
    try { return this.begin(call) } catch { return Promise.resolve({ success: false, code: 'invalid_input' }) }
  }

  private begin(call: ReadCall): Promise<Outcome<JsonValue>> {
    if (this.closed) return Promise.resolve({ success: false, code: 'unavailable' })
    const nodeId = identifierSchema.parse(call.nodeId)
    const accountId = identifierSchema.parse(call.accountId)
    const timeout = call.timeoutMs ?? MAX_READ_MS
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_READ_MS) return Promise.resolve({ success: false, code: 'invalid_input' })
    if (call.signal?.aborted) return Promise.resolve({ success: false, code: 'cancelled' })
    const contract = this.contracts.get(call.capability)
    if (!contract) return Promise.resolve({ success: false, code: 'unavailable' })
    const input = this.contracts.validate(contract, 'input', call.input)
    if (!input.success) return Promise.resolve(input)
    const bytes = Buffer.byteLength(JSON.stringify(input.payload)) + 1024
    const held = this.perNode.get(nodeId) ?? 0
    if (this.pending >= 64 || held >= 4 || this.bytes + bytes > MAX_PENDING_BYTES) return Promise.resolve({ success: false, code: 'busy' })
    this.pending++
    this.bytes += bytes
    this.perNode.set(nodeId, held + 1)
    const deadline = Date.now() + timeout
    const signal = call.signal
    const perform = async (): Promise<Outcome<JsonValue>> => {
      try {
        const listed = await this.lookup(nodeId, deadline, signal)
        if (!listed.success) return listed
        const connection = this.relay()
        if (!connection) return { success: false, code: 'unavailable' }
        if (signal?.aborted || this.closed) return { success: false, code: 'cancelled' }
        if (Date.now() >= deadline) return { success: false, code: 'expired' }
        if (!this.contracts.isCurrent(contract)) return { success: false, code: 'unavailable' }
        const node = listed.payload
        if (!node) return { success: false, code: 'offline' }
        if (accountId !== node.authority.accountId || !node.authority.grants.some((grant) =>
          grant.capability.id === contract.capability.id && grant.capability.version === contract.capability.version
          && grant.fingerprint === contract.fingerprint)) return { success: false, code: 'denied' }
        if (!node.capabilities.some((ref) => ref.id === contract.capability.id && ref.version === contract.capability.version)) return { success: false, code: 'unavailable' }
        if (connection !== this.relay()) return { success: false, code: 'offline' }
        if (this.sequence >= Number.MAX_SAFE_INTEGER) return { success: false, code: 'unavailable' }
        const correlationId = `${this.nonce}:read:${++this.sequence}`
        const encoded = encodeFrame({ protocolVersion: 1, type: 'read', nodeId, accountId,
          generation: node.generation, correlationId, capability: contract.capability, fingerprint: contract.fingerprint,
          permissionVersion: node.authority.permissionVersion, expiresAt: deadline, input: input.payload })
        if (!encoded.success) return { success: false, code: 'invalid_input' }
        const reply = await connection.send('feature.request', { frame: encoded.payload }, 11000)
        if (signal?.aborted || this.closed) return { success: false, code: 'cancelled' }
        if (Date.now() >= deadline) return { success: false, code: 'expired' }
        if (connection !== this.relay()) return { success: false, code: 'offline' }
        const copied = immutableJson(reply.result)
        if (!copied.success) return { success: false, code: 'invalid_output' }
        const failed = relayFailureSchema.safeParse(copied.payload)
        if (failed.success) return failed.data
        const decoded = decodeFrame(JSON.stringify(copied.payload))
        if (!decoded.success || decoded.payload.type !== 'result' || decoded.payload.generation !== node.generation
          || decoded.payload.correlationId !== correlationId) return { success: false, code: 'invalid_output' }
        if (!decoded.payload.success) return { success: false, code: decoded.payload.code }
        if (!this.contracts.isCurrent(contract)) return { success: false, code: 'unavailable' }
        const output = this.contracts.validate(contract, 'output', decoded.payload.payload)
        if (!this.contracts.isCurrent(contract)) return { success: false, code: 'unavailable' }
        if (signal?.aborted || this.closed) return { success: false, code: 'cancelled' }
        return Date.now() >= deadline ? { success: false, code: 'expired' } : output
      } catch { return { success: false, code: 'offline' } }
      finally {
        this.pending--
        this.bytes -= bytes
        const remaining = (this.perNode.get(nodeId) ?? 1) - 1
        if (remaining) this.perNode.set(nodeId, remaining); else this.perNode.delete(nodeId)
      }
    }
    return this.bounded(this.track(perform()), timeout, signal)
  }

  private bounded<T>(source: Promise<Outcome<T>>, timeout: number, signal?: AbortSignal): Promise<Outcome<T>> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: Outcome<T>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.cancellations.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish({ success: false, code: 'cancelled' })
      const timer = setTimeout(() => finish({ success: false, code: 'expired' }), timeout)
      this.cancellations.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted || this.closed) cancel()
      void source.then(finish, () => finish({ success: false, code: 'offline' }))
    })
  }

  private track<T>(source: Promise<T>): Promise<T> {
    this.flights.add(source)
    void source.finally(() => this.flights.delete(source)).catch(() => {})
    return source
  }

  async quiet(): Promise<void> {
    while (this.flights.size) await Promise.allSettled([...this.flights])
  }

  dispose(): void {
    this.closed = true
    for (const cancel of [...this.cancellations]) cancel()
  }

  get resources(): { calls: number; bytes: number } { return { calls: this.pending, bytes: this.bytes } }
}
