import {
  encodeFrame, failure, identifierSchema, MAX_PENDING_BYTES, MAX_READ_MS, tightenedLimit,
  type CapabilityRef, type Clock, type FailureCode, type JsonValue, type Outcome, type ReadFrame,
} from './protocol.js';
import { ContractRegistry, isAuthorized, type AuthorityLookup, type InstalledContract } from './contracts.js';
import { ConnectionRegistry, type ConnectionEvent, type NodeConnection } from './connections.js';

export interface ReadCall {
  readonly nodeId: string;
  readonly accountId: string;
  readonly capability: CapabilityRef;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
interface Pending {
  connection: NodeConnection;
  contract: InstalledContract;
  frame: ReadFrame;
  bytes: number;
  resolve: (result: Outcome<JsonValue>) => void;
  timer?: unknown;
  timerSet?: boolean;
  release: () => void;
  removeAbort?: () => void;
}

export class ReadCaller {
  private readonly pending = new Map<string, Pending>();
  private readonly disposeSubscription: () => void;
  private readonly maxPending: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly contracts: ContractRegistry,
    private readonly lookup: AuthorityLookup,
    private readonly clock: Clock,
    instanceId: string,
    options: { maxPending?: number; maxPendingBytes?: number } = {},
  ) {
    identifierSchema.max(96).parse(instanceId);
    this.maxPending = tightenedLimit(options.maxPending, 64);
    this.maxBytes = tightenedLimit(options.maxPendingBytes, MAX_PENDING_BYTES);
    this.disposeSubscription = connections.subscribe((event) => this.receive(event));
  }

  read(call: ReadCall): Promise<Outcome<JsonValue>> {
    try { return this.begin(call); } catch { return Promise.resolve(failure('internal')); }
  }

  private begin(call: ReadCall): Promise<Outcome<JsonValue>> {
    if (this.closed) return Promise.resolve(failure('offline'));
    if (call.signal?.aborted) return Promise.resolve(failure('cancelled'));
    const connection = this.connections.get(call.nodeId);
    if (!connection) return Promise.resolve(failure('offline'));
    if (call.accountId !== connection.accountId) return Promise.resolve(failure('denied'));
    let contract: InstalledContract | undefined;
    try { contract = this.contracts.get(call.capability); } catch { return Promise.resolve(failure('invalid_input')); }
    if (!contract || !this.connections.supports(connection, contract.capability)) return Promise.resolve(failure('unavailable'));
    if (!isAuthorized(this.lookup, connection.authority, contract.capability,
      contract.fingerprint, connection.authority.permissionVersion)) return Promise.resolve(failure('denied'));
    const input = this.contracts.validate(contract, 'input', call.input);
    if (!input.success) return Promise.resolve(input);
    let timeout: number;
    try { timeout = tightenedLimit(call.timeoutMs, MAX_READ_MS); } catch { return Promise.resolve(failure('invalid_input')); }
    if (this.pending.size >= this.maxPending) return Promise.resolve(failure('busy'));
    const correlation = this.connections.allocateCorrelation();
    if (!correlation.success) return Promise.resolve(correlation);
    const frame: ReadFrame = Object.freeze({
      protocolVersion: 1, type: 'read', correlationId: correlation.payload,
      generation: connection.generation, nodeId: connection.nodeId, accountId: connection.accountId,
      capability: contract.capability, fingerprint: contract.fingerprint,
      permissionVersion: connection.authority.permissionVersion, expiresAt: this.clock.now() + timeout,
      input: input.payload,
    });
    const encoded = encodeFrame(frame);
    if (!encoded.success) return Promise.resolve(failure('invalid_input'));
    const bytes = Buffer.byteLength(encoded.payload, 'utf8');
    if (this.bytes + bytes > this.maxBytes) return Promise.resolve(failure('busy'));
    if (!this.allowed(connection, contract, frame)) return Promise.resolve(failure('denied'));
    if (this.closed) return Promise.resolve(failure('offline'));
    if (this.pending.size >= this.maxPending || this.bytes + bytes > this.maxBytes) return Promise.resolve(failure('busy'));
    const reservation = this.connections.reserveRead(connection, bytes);
    if (!reservation.success) return Promise.resolve(reservation);
    return new Promise((resolve) => {
      const pending: Pending = { connection, contract: contract!, frame, bytes, resolve, release: reservation.payload };
      this.pending.set(frame.correlationId, pending);
      this.bytes += bytes;
      try {
        const timer = this.clock.setTimeout(() => this.end(pending, failure('expired'), true), timeout);
        pending.timer = timer;
        pending.timerSet = true;
        // An injected timer may fire before returning its handle.
        if (!this.pending.has(frame.correlationId)) { this.clearTimer(pending); return; }
        const abort = () => this.end(pending, failure('cancelled'), true);
        if (call.signal) {
          const signal = call.signal;
          pending.removeAbort = () => signal.removeEventListener('abort', abort);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }
        if (!this.pending.has(frame.correlationId)) return;
        if (this.clock.now() >= frame.expiresAt) { this.end(pending, failure('expired')); return; }
        if (!this.allowed(connection, contract!, frame)) { this.end(pending, failure('denied')); return; }
        if (!this.pending.has(frame.correlationId)) return;
        // A synchronous transport reply must find its pending call before send starts.
        if (!this.connections.send(connection, frame)) this.end(pending, failure('offline'));
      } catch { this.end(pending, failure('internal'), true); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) this.end(pending, failure('cancelled'), true);
    this.disposeSubscription();
  }

  get pendingCount(): number { return this.pending.size; }
  get pendingBytes(): number { return this.bytes; }

  private allowed(connection: NodeConnection, contract: InstalledContract, frame: ReadFrame): boolean {
    return this.contracts.isCurrent(contract) && isAuthorized(this.lookup,
      connection.authority, frame.capability, frame.fingerprint, frame.permissionVersion);
  }

  private receive(event: ConnectionEvent): void {
    if (event.type === 'closed') {
      for (const pending of [...this.pending.values()]) {
        if (pending.connection === event.connection) this.end(pending, failure(event.code));
      }
      return;
    }
    const pending = this.pending.get(event.frame.correlationId);
    if (!pending || pending.connection !== event.connection
      || pending.frame.generation !== event.frame.generation) return;
    try {
      if (this.clock.now() >= pending.frame.expiresAt) { this.end(pending, failure('expired'), true); return; }
      if (!this.allowed(pending.connection, pending.contract, pending.frame)) {
        this.end(pending, failure('denied'), true); return;
      }
      if (!event.frame.success) { this.end(pending, failure(event.frame.code)); return; }
      const output = this.contracts.validate(pending.contract, 'output', event.frame.payload);
      if (!this.allowed(pending.connection, pending.contract, pending.frame)) {
        this.end(pending, failure('denied')); return;
      }
      if (this.clock.now() >= pending.frame.expiresAt) { this.end(pending, failure('expired'), true); return; }
      this.end(pending, output);
    } catch { this.end(pending, failure('internal'), true); }
  }

  private clearTimer(pending: Pending): void {
    if (!pending.timerSet) return;
    pending.timerSet = false;
    try { this.clock.clearTimeout(pending.timer); } catch { /* The call and its reservation still end. */ }
  }

  private end(pending: Pending, result: Outcome<JsonValue>, cancel = false): void {
    if (this.pending.get(pending.frame.correlationId) !== pending) return;
    this.pending.delete(pending.frame.correlationId);
    this.bytes -= pending.bytes;
    pending.release();
    this.clearTimer(pending);
    try { pending.removeAbort?.(); } catch { /* A disposer cannot keep a completed read pending. */ }
    pending.resolve(result);
    if (cancel && this.connections.isCurrent(pending.connection)) this.connections.send(pending.connection, {
      protocolVersion: 1, type: 'cancel', correlationId: pending.frame.correlationId,
      generation: pending.frame.generation,
    });
  }
}
