import {
  capabilityKey, decodeFrame, failure, identifierSchema, immutableJson, MAX_READ_MS,
  type CapabilityRef, type Clock, type FailureCode, type JsonValue, type Outcome,
  type ReadFrame, type ResultFrame,
} from './protocol.js';
import {
  ContractRegistry, isAuthorized, readAuthority,
  type Authority, type AuthorityLookup, type InstalledContract,
} from './contracts.js';
import { sendFrame, type ReadTransport } from './connections.js';

export interface HandlerContext {
  readonly nodeId: string;
  readonly accountId: string;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
}
export interface ReadHandler {
  readonly capability: CapabilityRef;
  readonly handle: (input: JsonValue, context: HandlerContext) => unknown | Promise<unknown>;
}
interface InstalledHandler {
  contract: InstalledContract;
  handle: ReadHandler['handle'];
}
interface Execution {
  frame: ReadFrame;
  contract: InstalledContract;
  controller: AbortController;
  replied: boolean;
  timer?: unknown;
  timerSet?: boolean;
  release: () => void;
}

export class ReadScheduler {
  private readonly active = new Map<string, number>();

  acquire(nodeId: string): (() => void) | undefined {
    const count = this.active.get(nodeId) ?? 0;
    if (count >= 4 || (count === 0 && this.active.size >= 32)) return undefined;
    this.active.set(nodeId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.active.get(nodeId)! - 1;
      if (remaining) this.active.set(nodeId, remaining); else this.active.delete(nodeId);
    };
  }

  activeCount(nodeId: string): number { return this.active.get(nodeId) ?? 0; }
}

export class ReadRunner {
  private readonly authority: Authority;
  private readonly handlers = new Map<string, InstalledHandler>();
  private readonly executions = new Map<string, Execution>();
  private readonly seen = new Map<string, number>();
  private readonly listeners: Array<() => void> = [];
  private started = false;
  private closed = false;

  constructor(
    private readonly nodeId: string,
    private readonly accountId: string,
    private readonly generation: string,
    private readonly transport: ReadTransport,
    private readonly contracts: ContractRegistry,
    private readonly lookup: AuthorityLookup,
    private readonly clock: Clock,
    private readonly scheduler: ReadScheduler,
    handlers: readonly ReadHandler[],
  ) {
    identifierSchema.parse(generation);
    const authority = readAuthority(lookup, nodeId, accountId);
    if (!authority) throw new Error('Feature node authority is unavailable');
    this.authority = authority;
    if (handlers.length > 64) throw new Error('Too many feature node handlers');
    for (const handler of handlers) {
      const contract = contracts.get(handler.capability);
      if (!contract || typeof handler.handle !== 'function') throw new Error('A trusted read contract is required');
      const key = capabilityKey(contract.capability);
      if (this.handlers.has(key)) throw new Error('Feature node handler already registered');
      this.handlers.set(key, { contract, handle: handler.handle });
    }
  }

  start(): boolean {
    if (this.closed) return false;
    if (this.started) return true;
    this.started = true;
    const subscribe = (register: () => () => void) => {
      const dispose = register();
      if (this.closed) dispose(); else this.listeners.push(dispose);
    };
    try {
      subscribe(() => this.transport.onMessage((raw) => this.receive(raw)));
      subscribe(() => this.transport.onClose(() => this.close('offline')));
      subscribe(() => this.transport.onError(() => this.close('offline')));
    } catch { this.close('offline'); return false; }
    if (this.closed) return false;
    const sent = sendFrame(this.transport, {
      protocolVersion: 1, type: 'manifest',
      capabilities: [...this.handlers.values()].map(({ contract }) => contract.capability),
    });
    if (!sent) this.close('offline');
    return sent && !this.closed;
  }

  close(code: FailureCode = 'cancelled'): void {
    if (this.closed) return;
    this.closed = true;
    for (const dispose of this.listeners.splice(0)) {
      try { dispose(); } catch { /* A failed listener disposer cannot keep the runner open. */ }
    }
    for (const execution of this.executions.values()) {
      if (!execution.replied) this.respond(execution, failure(code));
      execution.controller.abort();
    }
    this.seen.clear();
    try { this.transport.close(); } catch { /* Handlers still own their permits until they settle. */ }
  }

  get activeCount(): number { return this.executions.size; }
  get listenerCount(): number { return this.listeners.length; }

  private receive(raw: unknown): void {
    if (this.closed) return;
    const decoded = decodeFrame(raw);
    if (!decoded.success) { this.close('malformed'); return; }
    const frame = decoded.payload;
    if (frame.type === 'cancel') {
      if (frame.generation !== this.generation) return;
      const execution = this.executions.get(frame.correlationId);
      if (execution && !execution.replied) {
        this.respond(execution, failure('cancelled'));
        execution.controller.abort();
      }
    } else if (frame.type === 'read') {
      try { this.dispatch(frame); } catch { this.reject(frame, 'internal'); }
    } else this.close('malformed');
  }

  private dispatch(frame: ReadFrame): void {
    if (frame.generation !== this.generation) return;
    const now = this.clock.now();
    for (const [id, until] of this.seen) {
      if (until <= now && !this.executions.has(id)) this.seen.delete(id);
    }
    if (this.seen.has(frame.correlationId) || this.executions.has(frame.correlationId)) {
      this.close('malformed'); return;
    }
    if (frame.nodeId !== this.nodeId || frame.accountId !== this.accountId) {
      this.reject(frame, 'denied'); return;
    }
    if (frame.expiresAt <= now || frame.expiresAt - now > MAX_READ_MS) {
      this.reject(frame, 'expired'); return;
    }
    const installed = this.handlers.get(capabilityKey(frame.capability));
    if (!installed || !this.contracts.isCurrent(installed.contract)) {
      this.reject(frame, 'unavailable'); return;
    }
    if (!this.allowed(frame, installed.contract)) { this.reject(frame, 'denied'); return; }
    if (this.executions.size >= 4 || this.seen.size >= 64) { this.reject(frame, 'busy'); return; }
    const input = this.contracts.validate(installed.contract, 'input', frame.input);
    if (!input.success) { this.reject(frame, 'invalid_input'); return; }
    const snapshot = immutableJson({ ...frame, input: input.payload });
    if (!snapshot.success) { this.reject(frame, 'invalid_input'); return; }
    const bound = snapshot.payload as unknown as ReadFrame;
    if (this.clock.now() >= bound.expiresAt) { this.reject(bound, 'expired'); return; }
    if (!this.allowed(bound, installed.contract)) { this.reject(bound, 'denied'); return; }
    if (this.closed) return;
    if (this.seen.has(bound.correlationId) || this.executions.has(bound.correlationId)) {
      this.close('malformed'); return;
    }
    if (this.executions.size >= 4 || this.seen.size >= 64) { this.reject(bound, 'busy'); return; }
    const release = this.scheduler.acquire(this.nodeId);
    if (!release) { this.reject(bound, 'busy'); return; }
    const execution: Execution = {
      frame: bound, contract: installed.contract, controller: new AbortController(), replied: false, release,
    };
    this.seen.set(bound.correlationId, bound.expiresAt);
    this.executions.set(bound.correlationId, execution);
    try {
      const timer = this.clock.setTimeout(() => {
        this.respond(execution, failure('expired'));
        execution.controller.abort();
      }, bound.expiresAt - this.clock.now());
      execution.timer = timer;
      execution.timerSet = true;
      if (execution.replied || this.closed) { this.finishExecution(execution); return; }
    } catch {
      this.respond(execution, failure('internal'));
      this.finishExecution(execution);
      return;
    }
    void this.execute(execution, installed.handle, input.payload);
  }

  private async execute(execution: Execution, handler: ReadHandler['handle'], input: JsonValue): Promise<void> {
    try {
      if (execution.replied || this.closed) return;
      if (this.clock.now() >= execution.frame.expiresAt) { this.respond(execution, failure('expired')); return; }
      if (!this.allowed(execution.frame, execution.contract)) { this.respond(execution, failure('denied')); return; }
      if (execution.replied || this.closed) return;
      const output = await handler(input, Object.freeze({
        nodeId: this.nodeId, accountId: this.accountId,
        signal: execution.controller.signal, expiresAt: execution.frame.expiresAt,
      }));
      if (execution.replied || this.closed) return;
      if (this.clock.now() >= execution.frame.expiresAt) { this.respond(execution, failure('expired')); return; }
      if (!this.allowed(execution.frame, execution.contract)) { this.respond(execution, failure('denied')); return; }
      const result = this.contracts.validate(execution.contract, 'output', output);
      if (!this.allowed(execution.frame, execution.contract)) { this.respond(execution, failure('denied')); return; }
      if (this.clock.now() >= execution.frame.expiresAt) { this.respond(execution, failure('expired')); return; }
      this.respond(execution, result);
    } catch {
      let code: FailureCode = 'internal';
      try {
        if (this.clock.now() >= execution.frame.expiresAt) code = 'expired';
        else if (!this.allowed(execution.frame, execution.contract)) code = 'denied';
      } catch { /* A failing clock cannot turn handler cleanup into a rejected promise. */ }
      if (!execution.replied) this.respond(execution, failure(code));
    } finally {
      // Cancellation ends the reply, not an ignored handler's execution permit.
      this.finishExecution(execution);
    }
  }

  private clearTimer(execution: Execution): void {
    if (!execution.timerSet) return;
    execution.timerSet = false;
    try { this.clock.clearTimeout(execution.timer); } catch { /* Cleanup still releases the execution permit. */ }
  }

  private finishExecution(execution: Execution): void {
    this.clearTimer(execution);
    if (this.executions.get(execution.frame.correlationId) === execution) {
      this.executions.delete(execution.frame.correlationId);
    }
    execution.release();
  }

  private allowed(frame: ReadFrame, contract: InstalledContract): boolean {
    return frame.fingerprint === contract.fingerprint && this.contracts.isCurrent(contract)
      && isAuthorized(this.lookup, this.authority, frame.capability, frame.fingerprint, frame.permissionVersion);
  }

  private reject(frame: ReadFrame, code: FailureCode): void {
    this.send({ protocolVersion: 1, type: 'result', correlationId: frame.correlationId,
      generation: frame.generation, success: false, code });
  }

  private respond(execution: Execution, result: Outcome<JsonValue>): void {
    if (execution.replied) return;
    execution.replied = true;
    this.clearTimer(execution);
    const frame: ResultFrame = {
      protocolVersion: 1, type: 'result', correlationId: execution.frame.correlationId,
      generation: execution.frame.generation, ...result,
    };
    const safe: ResultFrame = result.success && !immutableJson(frame).success
      ? { protocolVersion: 1, type: 'result', correlationId: frame.correlationId,
        generation: frame.generation, success: false, code: 'invalid_output' } : frame;
    if (!this.closed) this.send(safe);
  }

  private send(frame: ResultFrame): void {
    if (!sendFrame(this.transport, frame)) this.close('offline');
  }
}
