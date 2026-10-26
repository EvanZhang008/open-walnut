import { randomUUID } from 'node:crypto';
import {
  capabilityKey, decodeFrame, encodeFrame, failure, identifierSchema, MAX_PENDING_BYTES, tightenedLimit,
  type CapabilityRef, type Frame, type FailureCode, type Outcome,
} from './protocol.js';
import { readAuthority, type Authority, type AuthorityLookup } from './contracts.js';

export interface ReadTransport {
  state(): 'open' | 'closing' | 'closed';
  bufferedBytes(): number;
  send(text: string): boolean | number;
  onMessage(listener: (text: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: () => void): () => void;
  close(): void;
}
export interface NodeConnection {
  readonly nodeId: string;
  readonly accountId: string;
  readonly generation: string;
  readonly authority: Authority;
}
interface Entry {
  connection: NodeConnection;
  transport: ReadTransport;
  supported: Set<string>;
  listeners: Array<() => void>;
  closed: boolean;
}
export type ConnectionEvent =
  | { type: 'result'; connection: NodeConnection; frame: Extract<Frame, { type: 'result' }> }
  | { type: 'closed'; connection: NodeConnection; code: FailureCode };

export function sendFrame(transport: ReadTransport, frame: Frame): boolean {
  const encoded = encodeFrame(frame);
  if (!encoded.success) return false;
  try {
    if (transport.state() !== 'open' || transport.bufferedBytes() !== 0) return false;
    const sent = transport.send(encoded.payload);
    return sent === true || (typeof sent === 'number' && Number.isFinite(sent) && sent > 0);
  } catch {
    return false;
  }
}

export class ConnectionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: ConnectionEvent) => void>();
  private readonly maxNodes: number;
  private readonly nonce = randomUUID();
  private readonly readsByNode = new Map<string, number>();
  private reads = 0;
  private bytes = 0;
  private sequence = 0;
  private correlationSequence = 0;
  private closed = false;

  constructor(
    private readonly lookup: AuthorityLookup,
    instanceId: string,
    options: { maxNodes?: number } = {},
  ) {
    identifierSchema.max(96).parse(instanceId);
    this.maxNodes = tightenedLimit(options.maxNodes, 32);
  }

  attach(nodeId: string, accountId: string, transport: ReadTransport): Outcome<NodeConnection> {
    if (this.closed) return { success: false, code: 'offline' };
    const authority = readAuthority(this.lookup, nodeId, accountId);
    if (!authority) return { success: false, code: 'denied' };
    if (!this.entries.has(nodeId) && this.entries.size >= this.maxNodes) return { success: false, code: 'busy' };
    try {
      if (transport.state() !== 'open' || transport.bufferedBytes() !== 0) return { success: false, code: 'offline' };
    } catch { return { success: false, code: 'offline' }; }
    if (this.sequence >= Number.MAX_SAFE_INTEGER) return { success: false, code: 'offline' };
    const previous = this.entries.get(nodeId);
    const connection: NodeConnection = Object.freeze({
      nodeId, accountId, authority, generation: `${this.nonce}:${++this.sequence}`,
    });
    const entry: Entry = { connection, transport, supported: new Set(), listeners: [], closed: false };
    this.entries.set(nodeId, entry);
    if (previous) this.disposeEntry(previous, 'offline');
    const subscribe = (register: () => () => void) => {
      const dispose = register();
      if (entry.closed) dispose(); else entry.listeners.push(dispose);
    };
    try {
      subscribe(() => transport.onMessage((raw) => this.receive(entry, raw)));
      subscribe(() => transport.onClose(() => this.disposeEntry(entry, 'offline')));
      subscribe(() => transport.onError(() => this.disposeEntry(entry, 'offline')));
    } catch { this.disposeEntry(entry, 'offline'); }
    return this.isCurrent(connection) ? { success: true, payload: connection } : { success: false, code: 'offline' };
  }

  get(nodeId: string): NodeConnection | undefined {
    return this.entries.get(nodeId)?.connection;
  }

  isCurrent(connection: NodeConnection): boolean {
    const entry = this.entries.get(connection.nodeId);
    return entry?.connection === connection && !entry.closed;
  }

  supports(connection: NodeConnection, capability: CapabilityRef): boolean {
    return this.isCurrent(connection) && this.entries.get(connection.nodeId)!.supported.has(capabilityKey(capability));
  }

  send(connection: NodeConnection, frame: Frame): boolean {
    if (!this.isCurrent(connection)) return false;
    const entry = this.entries.get(connection.nodeId)!;
    if (sendFrame(entry.transport, frame)) return this.isCurrent(connection);
    this.disposeEntry(entry, 'offline');
    return false;
  }

  allocateCorrelation(): Outcome<string> {
    if (this.closed || this.correlationSequence >= Number.MAX_SAFE_INTEGER) return failure('offline');
    return { success: true, payload: `${this.nonce}:read:${++this.correlationSequence}` };
  }

  reserveRead(connection: NodeConnection, bytes: number): Outcome<() => void> {
    if (!this.isCurrent(connection)) return failure('offline');
    const count = this.readsByNode.get(connection.nodeId) ?? 0;
    if (!Number.isInteger(bytes) || bytes < 1 || count >= 4 || this.reads >= 64
      || this.bytes + bytes > MAX_PENDING_BYTES) return failure('busy');
    this.readsByNode.set(connection.nodeId, count + 1);
    this.reads++;
    this.bytes += bytes;
    let released = false;
    return { success: true, payload: () => {
      if (released) return;
      released = true;
      const remaining = this.readsByNode.get(connection.nodeId)! - 1;
      if (remaining) this.readsByNode.set(connection.nodeId, remaining);
      else this.readsByNode.delete(connection.nodeId);
      this.reads--;
      this.bytes -= bytes;
    } };
  }

  subscribe(listener: (event: ConnectionEvent) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  disconnect(connection: NodeConnection): void {
    if (this.isCurrent(connection)) this.disposeEntry(this.entries.get(connection.nodeId)!, 'offline');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) this.disposeEntry(entry, 'offline');
    this.listeners.clear();
  }

  get size(): number { return this.entries.size; }
  get listenerCount(): number { return this.listeners.size; }

  private receive(entry: Entry, raw: unknown): void {
    if (!this.isCurrent(entry.connection)) return;
    const decoded = decodeFrame(raw);
    if (!decoded.success) { this.disposeEntry(entry, 'malformed'); return; }
    const frame = decoded.payload;
    if (frame.type === 'manifest') {
      entry.supported = new Set(frame.capabilities.map(capabilityKey));
    } else if (frame.type === 'result') {
      if (frame.generation === entry.connection.generation) this.emit({ type: 'result', connection: entry.connection, frame });
    } else this.disposeEntry(entry, 'malformed');
  }

  private emit(event: ConnectionEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* A consumer must not prevent other pending calls from ending. */ }
    }
  }

  private disposeEntry(entry: Entry, code: FailureCode): void {
    if (entry.closed) return;
    entry.closed = true;
    if (this.entries.get(entry.connection.nodeId) === entry) this.entries.delete(entry.connection.nodeId);
    for (const dispose of entry.listeners.splice(0)) {
      try { dispose(); } catch { /* Cleanup remains best effort for a failing transport. */ }
    }
    this.emit({ type: 'closed', connection: entry.connection, code });
    try { entry.transport.close(); } catch { /* The connection is already unusable. */ }
  }
}
