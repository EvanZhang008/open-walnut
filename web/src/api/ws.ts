/**
 * WebSocket client — singleton, auto-reconnects, dispatches events.
 *
 * Uses the structured `log` helper so every WS log line can be traced
 * across browser ↔ server by grepping a full sessionId / rpcId.
 */

import { log } from '@/utils/log';
import { getDeviceToken } from './device-token';

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
type AnyEventCallback = (name: string, data: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

let reqCounter = 0;
function nextReqId(): string {
  return `r${++reqCounter}-${Date.now().toString(36)}`;
}

// Suppress noisy high-frequency streaming events from logging
const SUPPRESSED_EVENTS = new Set([
  'session:text-delta',
  'session:thinking-delta',
  'agent:text-delta',
  'agent:thinking',
]);

/**
 * RPC methods whose `→` / `← OK` lines are logged at debug instead of info.
 *
 * `browser:logs` is the load-bearing one: it is the transport the browser logger
 * uses to ship console output to the server. Logging its own send at info made it
 * SELF-FEEDING — one flush logs "RPC → browser:logs", which the console patch
 * captures as a new entry, which the next flush ships, forever. Measured
 * 2026-08-10 on a normal day: 28,640 of 146,461 production log lines (~20%) were
 * the logger reporting on itself, plus a matching `← OK` each. That volume is
 * paid in main-thread JSON work and synchronous server-side appends on every
 * flush — i.e. it degrades the very event loop the logs get used to diagnose.
 *
 * The others are per-keystroke/per-frame terminal traffic: one `terminal:input`
 * RPC per typed character, each previously worth two info lines. Nothing reads
 * these lines (no scripts/walnut-logs.sh query matches them) — failures still
 * surface, since `← ERROR` is logged at warn regardless of this set.
 */
const LOW_VALUE_RPC_METHODS = new Set([
  'browser:logs',
  'terminal:input',
  'terminal:resize',
]);

/** Human-readable labels for WebSocket close codes (RFC 6455). */
const WS_CLOSE_CODES: Record<number, string> = {
  1000: 'normal', 1001: 'going away', 1002: 'protocol error',
  1003: 'unsupported', 1006: 'abnormal (no close frame)',
  1011: 'server error', 1012: 'server restart', 1013: 'try again later',
};

/**
 * Largest RPC frame we will put on the wire.
 *
 * The server caps a frame (`attachWss` maxPayload, 32MB) and the `ws` library
 * enforces that by CLOSING the connection with code 1009 — the frame never
 * reaches a handler, so the caller gets no error, just "WebSocket disconnected"
 * for this RPC *and every other one in flight*, followed by a reconnect that
 * re-sends and dies again. Failing the one oversized RPC locally is strictly
 * better: the socket survives and the caller sees a real message.
 *
 * Deliberately MUCH tighter than the server's 32MB: nothing legitimate is this
 * big — images ride HTTP as refs (image-upload.ts) and oversized pastes spill
 * to disk (paste-spill.ts) — so a frame past this size is a bug, and a loud
 * local error beats megabytes of head-of-line blocking on the shared socket.
 */
const MAX_RPC_FRAME_BYTES = 3.5 * 1024 * 1024;

/** Max RPCs buffered while the socket is still opening before we start rejecting. */
const PRE_OPEN_QUEUE_CAP = 50;
/** How long a buffered pre-open RPC waits for the socket before it rejects. */
const PRE_OPEN_RPC_TIMEOUT_MS = 10_000;

interface QueuedRpc {
  method: string;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class WsClient {
  private ws: WebSocket | null = null;
  private eventListeners = new Map<string, Set<EventCallback>>();
  // Wildcard listeners — see subscribeAll(). Deliberately separate from
  // eventListeners so the named path stays a plain Map lookup.
  private anyEventListeners = new Set<AnyEventCallback>();
  private connectionListeners = new Set<ConnectionCallback>();
  private pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; lowValue?: boolean }>();
  // RPCs issued before the socket reaches OPEN (cold-load race: useChat/session
  // hooks fire RPCs in the first ~200-500ms while the lazy WS handshake is still
  // in flight). Instead of rejecting immediately ("RPC failed — not connected"),
  // buffer them here and flush on open. Bounded + per-item timeout so a socket
  // that never opens can't leak.
  private preOpenQueue: QueuedRpc[] = [];
  private _state: ConnectionState = 'disconnected';
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private eventCount = 0;
  // Distinguishes cold first-connect from subsequent reconnects.
  // `_ws:reconnected` only fires on reconnects, not the initial page load.
  private hasConnectedBefore = false;
  /** Last close event, kept for crash/bug reports (onclose otherwise discards it). */
  lastClose: { code: number; codeDesc: string; reason: string; at: string } | null = null;

  get state() {
    return this._state;
  }

  connect() {
    if (this.ws) return;
    this.disposed = false;
    this.setState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Cloud-mode auth: browsers can't set an Authorization header on a
    // WebSocket, so the device token (when stored) rides a query param.
    // Trusted LAN → no token stored → bare /ws, unchanged.
    const deviceToken = getDeviceToken();
    const url = `${proto}://${window.location.host}/ws${deviceToken ? `?token=${encodeURIComponent(deviceToken)}` : ''}`;
    log.info('ws', 'connecting', { url: `${proto}://${window.location.host}/ws` });
    const ws = new WebSocket(url);

    ws.onopen = () => {
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectDelay = 1000;
      this.setState('connected');
      log.info('ws', isReconnect ? 'connected (reconnect)' : 'connected');
      // Flush any RPCs buffered while the socket was opening (cold-load race).
      this.flushPreOpenQueue();
      // On reconnect, emit a synthetic event so components can re-fetch stale data.
      // Events during the disconnect window are permanently lost — the server has
      // no event buffer/replay; events are fire-and-forget over the live socket.
      // This lets SessionPanel re-fetch status and SessionChatHistory re-fetch history.
      if (isReconnect) {
        // seq: -1 is a sentinel meaning client-synthetic event, not a server-sequenced frame.
        this.dispatchEvent({ type: 'event', name: '_ws:reconnected', data: {}, seq: -1 });
      }
    };

    ws.onclose = (ev) => {
      this.lastClose = {
        code: ev.code,
        codeDesc: WS_CLOSE_CODES[ev.code] ?? 'unknown',
        reason: ev.reason || 'none',
        at: new Date().toISOString(),
      };
      log.info('ws', 'disconnected', {
        code: ev.code,
        codeDesc: WS_CLOSE_CODES[ev.code] ?? 'unknown',
        reason: ev.reason || 'none',
      });
      this.ws = null;
      this.setState('disconnected');
      this.rejectPending('WebSocket disconnected');
      if (!this.disposed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      log.warn('ws', 'error', {
        readyState: this.ws?.readyState,
        url: `${proto}://${window.location.host}/ws`,
      });
    };

    ws.onmessage = (ev) => {
      try {
        const frame: WsFrame = JSON.parse(ev.data);
        if (frame.type === 'event') {
          this.dispatchEvent(frame as WsEventFrame);
        } else if (frame.type === 'res') {
          this.handleResponse(frame);
        } else {
          log.warn('ws', 'unknown frame type', { frame: frame as Record<string, unknown> });
        }
      } catch {
        log.warn('ws', 'malformed frame');
      }
    };

    this.ws = ws;
  }

  disconnect() {
    log.info('ws', 'disconnect() called');
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
    log.debug('ws', `listener added: "${name}"`, { count: set.size });
  }

  offEvent(name: string, cb: EventCallback) {
    const set = this.eventListeners.get(name);
    set?.delete(cb);
    log.debug('ws', `listener removed: "${name}"`, { remaining: set?.size ?? 0 });
  }

  /**
   * Subscribe to EVERY inbound event (name + data). Additive to onEvent, which
   * stays the normal path — a component that knows its event names must use it.
   *
   * This exists for the plugin-app bridge: an app declares interest as name
   * PREFIXES, so the host cannot enumerate the concrete names up front. The
   * callback runs for every frame, so it must stay cheap (the bridge does one
   * `startsWith` per registered prefix and drops non-matches). Returns an
   * unsubscribe.
   */
  subscribeAll(cb: AnyEventCallback): () => void {
    this.anyEventListeners.add(cb);
    log.debug('ws', 'wildcard listener added', { count: this.anyEventListeners.size });
    return () => {
      this.anyEventListeners.delete(cb);
    };
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
        // Not open yet. Rather than fail (the cold-load race), buffer and flush
        // on open — UNLESS we're disposed or the buffer is full.
        if (this.disposed) {
          reject(new Error('WebSocket disposed'));
          return;
        }
        if (this.preOpenQueue.length >= PRE_OPEN_QUEUE_CAP) {
          log.warn('ws', 'RPC dropped — pre-open queue full', { method, cap: PRE_OPEN_QUEUE_CAP });
          reject(new Error('WebSocket not connected (queue full)'));
          return;
        }
        const timer = setTimeout(() => {
          // Still not sent after the timeout — give up on this one.
          const idx = this.preOpenQueue.findIndex((q) => q.timer === timer);
          if (idx !== -1) this.preOpenQueue.splice(idx, 1);
          log.warn('ws', 'RPC timed out waiting for connection', { method });
          reject(new Error('WebSocket not connected (timeout)'));
        }, PRE_OPEN_RPC_TIMEOUT_MS);
        this.preOpenQueue.push({ method, payload, resolve: resolve as (v: unknown) => void, reject, timer });
        log.info('ws', 'RPC queued (pre-open)', { method, queued: this.preOpenQueue.length });
        // Kick off a connect if nothing is in flight (lazy handshake).
        if (!this.ws && !this.disposed) this.connect();
        return;
      }
      this.dispatchRpc(method, payload, resolve as (v: unknown) => void, reject);
    });
  }

  /**
   * Opt this connection into a delivery mode on the server.
   *
   * - `setInterest('lightweight', [sessionId])` → the server only forwards events
   *   for the listed entity ids (plus entity-less lifecycle events). Used by pop-out
   *   windows so they don't receive the full event firehose.
   * - `setInterest('global')` → restore the default firehose (every broadcast).
   *
   * Goes through `sendRpc`, so it's queued until the socket opens and is re-applied
   * by the caller after reconnect (listen for `_ws:reconnected`).
   */
  setInterest(mode: 'global' | 'lightweight', ids: string[] = []): Promise<{ mode: string; ids: string[] }> {
    return this.sendRpc<{ mode: string; ids: string[] }>('set-interest', { mode, ids });
  }

  /** Send an RPC over the live OPEN socket. Caller guarantees readyState===OPEN. */
  private dispatchRpc(method: string, payload: unknown, resolve: (v: unknown) => void, reject: (e: Error) => void): void {
    const id = nextReqId();
    const frame: WsReqFrame = { type: 'req', id, method, payload };
    const body = JSON.stringify(frame);
    // Oversized frame guard — see MAX_RPC_FRAME_BYTES. Measure encoded bytes,
    // not string length: non-ASCII text (e.g. Chinese) is up to 3 bytes/char.
    const frameBytes = new Blob([body]).size;
    if (frameBytes > MAX_RPC_FRAME_BYTES) {
      log.error('ws', 'RPC too large — refusing to send', { method, frameBytes, cap: MAX_RPC_FRAME_BYTES });
      reject(new Error(
        `Message too large for the live connection (${Math.round(frameBytes / 1024 / 1024 * 10) / 10}MB). `
        + 'Attachments should be uploaded over HTTP first.',
      ));
      return;
    }
    // Remember whether this id's lines are low-value, so the response side can
    // match the request side without re-deriving it from the method name.
    const lowValue = LOW_VALUE_RPC_METHODS.has(method);
    this.pendingRpc.set(id, { resolve, reject, lowValue });
    // Extract IDs from payload for traceability
    const rpcLog: Record<string, unknown> = { rpcId: id, method };
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.sessionId) rpcLog.sessionId = p.sessionId;
      if (p.taskId) rpcLog.taskId = p.taskId;
    }
    // debug (not info) for the high-frequency methods — see LOW_VALUE_RPC_METHODS.
    if (lowValue) log.debug('ws', `RPC:${id} →`, rpcLog);
    else log.info('ws', `RPC:${id} →`, rpcLog);
    this.ws!.send(body);
  }

  /** Flush RPCs buffered while the socket was opening. Called from onopen. */
  private flushPreOpenQueue(): void {
    if (this.preOpenQueue.length === 0) return;
    const queued = this.preOpenQueue;
    this.preOpenQueue = [];
    log.info('ws', 'flushing pre-open RPC queue', { count: queued.length });
    for (const q of queued) {
      clearTimeout(q.timer);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.dispatchRpc(q.method, q.payload, q.resolve, q.reject);
      } else {
        // Socket went away between open and flush — fail the buffered RPC.
        q.reject(new Error('WebSocket not connected'));
      }
    }
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    log.info('ws', `state ${prev} → ${state}`);
    for (const cb of this.connectionListeners) {
      try { cb(state); } catch (err) {
        log.error('ws', 'connectionChange callback error', { error: String(err) });
      }
    }
  }

  private dispatchEvent(frame: WsEventFrame) {
    this.eventCount++;
    const cbs = this.eventListeners.get(frame.name);
    const listenerCount = cbs?.size ?? 0;

    if (!SUPPRESSED_EVENTS.has(frame.name)) {
      // debug: fires per inbound WS event. tool-use/result/system-event/usage
      // on a large session are a hot path; at info they flood the server log via
      // the browser-logger forwarder. Surface via the frontend debug gate.
      const summary = this.summarizeEventData(frame.name, frame.data);
      log.debug('ws', `event "${frame.name}"`, { seq: frame.seq, listeners: listenerCount, ...summary });
    }

    // Wildcard listeners run regardless of whether a named listener exists.
    for (const cb of this.anyEventListeners) {
      try {
        cb(frame.name, frame.data);
      } catch (err) {
        log.error('ws', `wildcard callback error for "${frame.name}"`, { error: String(err) });
      }
    }

    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(frame.data);
      } catch (err) {
        log.error('ws', `event callback error for "${frame.name}"`, { error: String(err) });
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
      if (d.sessionId) summary.sessionId = d.sessionId;
      if (d.taskId) summary.taskId = d.taskId;
      if (d.process_status) summary.process_status = d.process_status;
      if (d.phase) summary.phase = d.phase;
      if (d.mode) summary.mode = d.mode;
      if (d.activity) summary.activity = d.activity;
      if (d.planCompleted !== undefined) summary.planCompleted = d.planCompleted;
      if (d.title) summary.title = d.title;
      // DUP-DEBUG: include toolUseId for tool events so duplicates are obvious in
      // the browser-forwarded logs (`grep <toolUseId>` shows every layer that touched it).
      if (d.toolUseId) summary.toolUseId = d.toolUseId;
      if (d.toolName) summary.toolName = d.toolName;
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
      log.warn('ws', `RPC:${frame.id} ← orphan response`);
      return;
    }
    this.pendingRpc.delete(frame.id);
    if (frame.ok) {
      // Mirror the request side's level so a low-value RPC costs zero log lines
      // on the happy path. Failures below stay at warn regardless.
      if (pending.lowValue) log.debug('ws', `RPC:${frame.id} ← OK`);
      else log.info('ws', `RPC:${frame.id} ← OK`);
      pending.resolve(frame.payload);
    } else {
      log.warn('ws', `RPC:${frame.id} ← ERROR`, { error: frame.error });
      pending.reject(new Error(frame.error ?? 'RPC error'));
    }
  }

  private rejectPending(reason: string) {
    if (this.pendingRpc.size > 0) {
      log.warn('ws', 'rejecting pending RPCs', { count: this.pendingRpc.size, reason });
    }
    for (const [, p] of this.pendingRpc) {
      p.reject(new Error(reason));
    }
    this.pendingRpc.clear();
    // On dispose, also drain the pre-open queue (no reconnect will flush it).
    // On a transient disconnect we leave it intact: the scheduled reconnect's
    // onopen will flush it, and each item's own timeout caps the wait.
    if (this.disposed && this.preOpenQueue.length > 0) {
      log.warn('ws', 'rejecting queued pre-open RPCs', { count: this.preOpenQueue.length, reason });
      for (const q of this.preOpenQueue) {
        clearTimeout(q.timer);
        q.reject(new Error(reason));
      }
      this.preOpenQueue = [];
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    log.info('ws', 'reconnecting', { delayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

/** Singleton WS client instance */
export const wsClient = new WsClient();
