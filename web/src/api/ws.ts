/** WebSocket frame types matching the server protocol. */
export interface WsEventFrame {
  type: 'event';
  name: string;
  data: unknown;
  seq: number;
}

export interface WsReqFrame {
  type: 'req';
  id: string;
  method: string;
  payload: unknown;
}

export interface WsResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

type WsFrame = WsEventFrame | WsResFrame;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type EventCallback = (data: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

let reqCounter = 0;
function nextReqId(): string {
  return `r${++reqCounter}-${Date.now().toString(36)}`;
}

// Compact event log — suppress noisy high-frequency streaming events
const SUPPRESSED_EVENTS = new Set([
  'session:text-delta',
  'agent:text-delta',
  'agent:thinking',
]);

function logPrefix(): string {
  return `[ws ${new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]`;
}

class WsClient {
  private ws: WebSocket | null = null;
  private eventListeners = new Map<string, Set<EventCallback>>();
  private connectionListeners = new Set<ConnectionCallback>();
  private pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _state: ConnectionState = 'disconnected';
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private eventCount = 0;

  get state() {
    return this._state;
  }

  connect() {
    if (this.ws) return;
    this.disposed = false;
    this.setState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    console.debug(`${logPrefix()} connecting to ${url}`);
    const ws = new WebSocket(url);

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setState('connected');
      console.debug(`${logPrefix()} connected`);
    };

    ws.onclose = (ev) => {
      console.debug(`${logPrefix()} disconnected (code=${ev.code}, reason=${ev.reason || 'none'})`);
      this.ws = null;
      this.setState('disconnected');
      this.rejectPending('WebSocket disconnected');
      if (!this.disposed) this.scheduleReconnect();
    };

    ws.onerror = (ev) => {
      console.warn(`${logPrefix()} error`, ev);
    };

    ws.onmessage = (ev) => {
      try {
        const frame: WsFrame = JSON.parse(ev.data);
        if (frame.type === 'event') {
          this.dispatchEvent(frame as WsEventFrame);
        } else if (frame.type === 'res') {
          this.handleResponse(frame);
        } else {
          console.warn(`${logPrefix()} unknown frame type`, frame);
        }
      } catch (err) {
        console.warn(`${logPrefix()} malformed frame`, ev.data, err);
      }
    };

    this.ws = ws;
  }

  disconnect() {
    console.debug(`${logPrefix()} disconnect() called`);
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
    this.rejectPending('WebSocket disposed');
  }

  onEvent(name: string, cb: EventCallback) {
    let set = this.eventListeners.get(name);
    if (!set) {
      set = new Set();
      this.eventListeners.set(name, set);
    }
    set.add(cb);
    console.debug(`${logPrefix()} listener added: "${name}" (${set.size} total)`);
  }

  offEvent(name: string, cb: EventCallback) {
    const set = this.eventListeners.get(name);
    set?.delete(cb);
    console.debug(`${logPrefix()} listener removed: "${name}" (${set?.size ?? 0} remaining)`);
  }

  onConnectionChange(cb: ConnectionCallback) {
    this.connectionListeners.add(cb);
  }

  offConnectionChange(cb: ConnectionCallback) {
    this.connectionListeners.delete(cb);
  }

  sendRpc<T = unknown>(method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn(`${logPrefix()} RPC failed — not connected: ${method}`);
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = nextReqId();
      const frame: WsReqFrame = { type: 'req', id, method, payload };
      this.pendingRpc.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      console.debug(`${logPrefix()} RPC → ${method} (id=${id})`, payload);
      this.ws.send(JSON.stringify(frame));
    });
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    console.debug(`${logPrefix()} state: ${prev} → ${state}`);
    for (const cb of this.connectionListeners) {
      try { cb(state); } catch (err) {
        console.error(`${logPrefix()} connectionChange callback error`, err);
      }
    }
  }

  private dispatchEvent(frame: WsEventFrame) {
    this.eventCount++;
    const cbs = this.eventListeners.get(frame.name);
    const listenerCount = cbs?.size ?? 0;

    if (!SUPPRESSED_EVENTS.has(frame.name)) {
      // Log all non-streaming events with their data
      const summary = this.summarizeEventData(frame.name, frame.data);
      if (listenerCount === 0) {
        console.debug(`${logPrefix()} #${frame.seq} "${frame.name}" — NO LISTENERS`, summary);
      } else {
        console.debug(`${logPrefix()} #${frame.seq} "${frame.name}" → ${listenerCount} listener(s)`, summary);
      }
    }

    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(frame.data);
      } catch (err) {
        console.error(`${logPrefix()} event callback error for "${frame.name}"`, err);
      }
    }
  }

  /** Extract key fields for compact logging */
  private summarizeEventData(name: string, data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object') return { data };
    const d = data as Record<string, unknown>;
    // For session events, show the most useful fields
    if (name.startsWith('session:')) {
      const summary: Record<string, unknown> = {};
      if (d.sessionId) summary.sessionId = (d.sessionId as string).slice(0, 12) + '…';
      if (d.taskId) summary.taskId = d.taskId;
      if (d.process_status) summary.process_status = d.process_status;
      if (d.work_status) summary.work_status = d.work_status;
      if (d.mode) summary.mode = d.mode;
      if (d.activity) summary.activity = d.activity;
      if (d.planCompleted !== undefined) summary.planCompleted = d.planCompleted;
      if (d.title) summary.title = d.title;
      return Object.keys(summary).length > 0 ? summary : d;
    }
    // For task events, show id + title
    if (name.startsWith('task:') || name.startsWith('subtask:')) {
      const summary: Record<string, unknown> = {};
      if (d.id) summary.id = d.id;
      if (d.title) summary.title = d.title;
      if (d.phase) summary.phase = d.phase;
      return Object.keys(summary).length > 0 ? summary : d;
    }
    return d;
  }

  private handleResponse(frame: WsResFrame) {
    const pending = this.pendingRpc.get(frame.id);
    if (!pending) {
      console.warn(`${logPrefix()} RPC response for unknown id=${frame.id}`, frame);
      return;
    }
    this.pendingRpc.delete(frame.id);
    if (frame.ok) {
      console.debug(`${logPrefix()} RPC ← ${frame.id} OK`, frame.payload);
      pending.resolve(frame.payload);
    } else {
      console.warn(`${logPrefix()} RPC ← ${frame.id} ERROR: ${frame.error}`);
      pending.reject(new Error(frame.error ?? 'RPC error'));
    }
  }

  private rejectPending(reason: string) {
    if (this.pendingRpc.size > 0) {
      console.warn(`${logPrefix()} rejecting ${this.pendingRpc.size} pending RPCs: ${reason}`);
    }
    for (const [, p] of this.pendingRpc) {
      p.reject(new Error(reason));
    }
    this.pendingRpc.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.debug(`${logPrefix()} reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

/** Singleton WS client instance */
export const wsClient = new WsClient();
