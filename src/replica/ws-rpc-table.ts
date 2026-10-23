/**
 * The WebSocket RPC table of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 3): what each `/ws` RPC method does while the Mac is away. While the
 * Mac answers, `/ws` itself is spliced to it, so this table only serves the
 * replica's own sockets (away mode). The WS handler checks it before dispatch
 * (src/web/ws/handler.ts setRpcGate); a method missing here is a write that
 * needs the Mac. Ratchet: tests/replica/route-table-coverage.test.ts compares
 * it with the methods the real server registers.
 */

import type { AwayRule } from './route-table.js'

export interface RpcRow {
  kind: 'read' | 'write'
  away: AwayRule
  why?: string
}

export const WS_RPC_TABLE: Readonly<Record<string, RpcRow>> = {
  // The socket's own bookkeeping: always answered here.
  'auth': { kind: 'read', away: 'read' },
  'set-interest': { kind: 'read', away: 'read' },
  'browser:logs': { kind: 'read', away: 'read' },
  // Reads of a session (its stream, queue and team), from this replica.
  'session:stream-subscribe': { kind: 'read', away: 'read' },
  'session:get-queue': { kind: 'read', away: 'read' },
  'session:team-info': { kind: 'read', away: 'read' },
  'session:team-agent-subscribe': { kind: 'read', away: 'read' },
  'session:team-agent-unsubscribe': { kind: 'read', away: 'read' },
  // A message to a session that runs on this host goes to it through the daemon
  // (follower.send, ws-writes.ts); one to a Mac session needs the Mac (WP10).
  'session:send': { kind: 'write', away: 'host-write', why: 'session_on_mac' },
  // Writes: the Mac's until WP12 gives them a journal.
  'chat': { kind: 'write', away: 'needs-leader', why: 'ask_needs_mac' },
  'chat:stop': { kind: 'write', away: 'needs-leader', why: 'ask_needs_mac' },
  'session:start': { kind: 'write', away: 'needs-leader', why: 'session_writes_need_mac' },
  'session:interrupt': { kind: 'write', away: 'needs-leader', why: 'session_writes_need_mac' },
  'session:edit-queued': { kind: 'write', away: 'needs-leader', why: 'session_writes_need_mac' },
  'session:delete-queued': { kind: 'write', away: 'needs-leader', why: 'session_writes_need_mac' },
  'session:team-send': { kind: 'write', away: 'needs-leader', why: 'session_writes_need_mac' },
  // The terminal: the Mac serves it, a replica answers needs-leader.
  'terminal:open': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:attach': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:input': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:resize': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:close': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:kill': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
  'terminal:prewarm': { kind: 'write', away: 'needs-leader', why: 'terminal_needs_mac' },
}

/** What a method does away; a method the table does not name needs the Mac (plugin methods included). */
export function rpcAway(method: string): RpcRow {
  return WS_RPC_TABLE[method] ?? { kind: 'write', away: 'needs-leader', why: 'needs_mac' }
}
