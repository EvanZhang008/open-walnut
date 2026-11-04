/**
 * Feature-node ops: the connection journal of the server the call reaches
 * (GET /api/v1/feature-nodes/connections, src/web/routes/feature-nodes-v1.ts).
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

type Entry = { at: string; type: string; nodeId?: string | null; cause?: string; closeCode?: number; reason?: string }

function said(e: Entry): string {
  if (e.type === 'server_stopping') return `${e.at} server stopping (${e.reason ?? 'unknown'})`
  if (e.type === 'server_started') return `${e.at} server started`
  if (e.type === 'disconnected') return `${e.at} ${e.nodeId ?? 'a node'} disconnected (${e.cause}${e.closeCode !== undefined ? ` ${e.closeCode}` : ''})`
  return `${e.at} ${e.nodeId ?? 'a node'} ${e.type}`
}

defineOp({
  name: 'feature_node_connections',
  title: 'Read the feature-node connection journal',
  description:
    'When each read-only feature node connected to and disconnected from the Walnut server this call reaches, and why: '
    + 'server_stopping (this server stopped), replaced (the node attached again), closed_by_node (its close frame, with the code), '
    + 'abnormal (no close frame: network or crash), transport_error, refused, revoked (its credential no longer verifies), '
    + 'credential_check_failed (this server could not check it in time), protocol_error, send_failed. '
    + 'Also that server\'s server_started and server_stopping lines; a stop names its reason: deploy, companion-update, '
    + 'self-update, or the signal. Use it to tell a planned server restart from a node that failed. Oldest first, the newest '
    + '`limit` of the span; `current` is the node\'s live connection. Identifiers only: no account, token or data.',
  input: {
    node: z.string().optional().describe('A node id: only its events (the server lines always come along)'),
    since: z.string().optional().describe('An ISO time: only events at or after it'),
    limit: z.number().int().min(1).max(1000).optional().describe('At most this many events (default 200)'),
  },
  bind: { method: 'GET', path: '/feature-nodes/connections' },
  mapResult: ({ body }) => {
    const b = body as { events?: Entry[]; truncated?: boolean; current?: { nodeId: string; connectedAt: string } | null }
    const events = Array.isArray(b?.events) ? b.events : []
    const last = events.slice(-5).map(said).join('; ')
    return withOutcome(
      { ...(b as Record<string, unknown>) },
      `${events.length} journal events${b?.truncated ? ' (older ones cut)' : ''}${last ? `, latest: ${last}` : ''}.`
        + (b?.current ? ` ${b.current.nodeId} is connected since ${b.current.connectedAt}.` : ''),
      'A server_stopping right before a disconnect with cause server_stopping is a planned restart; narrow with node and since.',
    )
  },
  tags: { readonly: true, remote: 'allow' },
})
