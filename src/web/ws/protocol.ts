/**
 * WebSocket frame types for client-server communication.
 *
 * - "event": server pushes a bus event to clients (one-way)
 * - "req":   client sends an RPC request to the server
 * - "res":   server responds to an RPC request
 */

export type WsFrame =
  | { type: 'event'; name: string; data: unknown; seq: number }
  | { type: 'req'; id: string; method: string; payload: unknown }
  | { type: 'res'; id: string; ok: boolean; payload?: unknown; error?: string }
