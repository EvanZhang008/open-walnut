/**
 * The record a session's `walnut` CLI leaves of its own carded calls (core/op-cards.ts),
 * so its chat card shows the words however the arguments reached the CLI
 * (core/sessions/op-call-log.ts). Internal: the CLI calls it after the op it records,
 * through the same path that op took (the host daemon's gateway in a session, HTTP
 * from the hub's own CLI). Kept out of the catalog and the MCP tools, and free of the
 * gateway's write budget: it is display data, never a change anyone acts on.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'

defineOp({
  name: 'op_card_record',
  deprecated: 'internal: the walnut CLI records its own carded calls; never call it yourself',
  title: 'Record a session call for its chat card',
  description: 'Internal. The walnut CLI records what a carded call of this session said, for the session\'s chat card. Never call it yourself.',
  input: {
    op: z.string().min(1).max(80),
    form: z.enum(['inline', 'file', 'stdin', 'flags', 'none']).optional(),
    path: z.string().max(1000).optional(),
    ok: z.boolean().optional(),
    error: z.string().max(2000).optional(),
    fields: z.record(z.string(), z.unknown()),
    key: z.string().max(80).optional(),
  },
  bind: { method: 'POST', path: '/sessions/op-calls' },
  timeoutMs: 3_000,
  tags: { readonly: true, remote: 'allow' },
})
