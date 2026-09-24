/**
 * Walnut operation registry — the ONE declaration of the agent-facing surface.
 *
 * Every operation (an "op") is declared once here and rendered everywhere:
 *   - the stdio MCP server (src/mcp/tools.ts registers each op as an MCP tool)
 *   - the CLI (`walnut tools list | help <op> | call <op> '{json}'`)
 *   - the in-session `walnut tools ...` gateway path (remote hosts, via the daemon)
 *   - generated docs (the walnut skill's command tables)
 *
 * Design (docs/plan/unified-cli-mcp.md): the registry deliberately duplicates
 * endpoint knowledge — that duplication IS the curation layer (LLM-friendly
 * names, descriptions, guidance). A parity test keeps the bindings honest
 * against the real Express route table, and the `api` passthrough op keeps
 * capability at 100% for anything not yet curated.
 *
 * Keep op modules PURE: declaring an op must not do I/O. Execution happens in
 * executor.ts against a transport (HTTP today, gateway relay in P2).
 */

import { z } from 'zod'
import { OwnedRegistry } from '../core/plugins/owned-registry.js'
import type { Disposable } from '../core/plugins/disposable.js'

/** How an op reaches the server when it has no custom handler. */
export interface HttpBinding {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /**
   * v1 path template. `:name` segments are filled from the op's input args
   * (URI-encoded); the SAME arg must exist in the input schema. Args not used
   * in the path become the query string (GET/DELETE) or the JSON body (POST/
   * PUT/PATCH) unless `query`/`body` overrides say otherwise.
   */
  path: string
  /** Args forced into the query string regardless of method. */
  query?: readonly string[]
  /** Args forced into the JSON body regardless of method. */
  body?: readonly string[]
}

export interface OpResultContext {
  /** Raw parsed response body from the server. */
  body: unknown
  /** Validated input args the op was called with. */
  args: Record<string, unknown>
}

export interface WalnutOp {
  /** Snake_case tool name, e.g. 'task_get'. Stable — it is the public contract. */
  name: string
  /** A compatibility call still runs, but the op no longer appears in the default tool catalog. */
  deprecated?: string
  /** Short human title (MCP `title`, CLI list column). */
  title: string
  /** LLM-facing description: what it does, when to use it, result shape hints. */
  description: string
  /**
   * Zod OBJECT shape (not z.object(...) itself) — the MCP SDK's registerTool
   * wants the raw shape, and the CLI builds its JSON validation from the same.
   */
  input: Record<string, z.ZodTypeAny>
  /** Default executor: one HTTP call against /api/v1. */
  bind?: HttpBinding
  /**
   * Custom executor for ops that one HTTP call can't express (multi-step,
   * result reshaping). Receives a `call` function that performs bound-style
   * requests. Wins over `bind` when both are present.
   */
  handler?: (
    args: Record<string, unknown>,
    call: (method: HttpBinding['method'], path: string, body?: unknown) => Promise<unknown>,
  ) => Promise<unknown>
  /** Reshape a successful bound result (e.g. attach the task-ref citation). */
  mapResult?: (ctx: OpResultContext) => unknown
  /** When a write partly succeeds the result is kept, but every entry point must clearly report the op as failed. */
  resultError?: (result: unknown) => string | undefined
  /**
   * Per-op HTTP timeout override (ms). Search ops need more than the 10s
   * default: a cold embedding model + semantic legs measured 10s+, and a
   * timeout there reads as "search is broken" when the answer was coming.
   */
  timeoutMs?: number
  tags: {
    /** Read-only ops are advertised in --readonly mode and never prompt. */
    readonly: boolean
    /**
     * Remote (gateway/daemon) policy. 'allow' = callable from a remote
     * session through the daemon relay; 'deny' = local HTTP only (destructive
     * ops). Reads default to allow; writes must choose explicitly.
     */
    remote: 'allow' | 'deny'
    /** MCP destructiveHint (irreversible data loss). */
    destructive?: boolean
    /** Its server route rejects replicas; exposed for discovery and generated docs. */
    primaryOnly?: boolean
  }
}

const ops = new OwnedRegistry<WalnutOp>()

function validateOp(op: WalnutOp): void {
  if (!op.bind && !op.handler) throw new Error(`op ${op.name} needs bind or handler`)
}

/**
 * Declare one core op. Throws on a core-vs-core duplicate — names are the public
 * contract, and two core declarations of one name is a programmer error.
 *
 * A name a PLUGIN holds is EVICTED instead, because core must win that name and
 * throwing here would take the whole process down with it: the op modules are
 * imported lazily on first use, and plugins load long before that, so a plugin
 * squatting `task_get` gets here FIRST. ESM caches a failed module evaluation, so
 * one throw at import time permanently breaks every later
 * `import('./index.js')` — the actions route, the gateway `walnut tools` path,
 * and the plugin op routes would all stay dead until restart.
 */
export function defineOp(op: WalnutOp): WalnutOp {
  validateOp(op)
  const existing = ops.getEntry(op.name)
  if (existing) {
    if (existing.owner === 'core') throw new Error(`duplicate op name: ${op.name}`)
    ops.remove(existing.owner, op.name)
    // Plain console on purpose: the structured logger would drag constants + the
    // log writer onto the CLI's and the MCP server's op-registry import path, and
    // both route every console channel to stderr anyway.
    console.warn(`walnut: evicted op "${op.name}" registered by plugin "${existing.owner}" — core owns that name`)
  }
  ops.register('core', op.name, op)
  return op
}

/**
 * Declare one op on behalf of a plugin. Dispose the handle to withdraw it.
 *
 * Refuses ANY name already taken, whatever the owner: an op name is the public
 * contract for every surface, so a plugin must never shadow `task_get` (nor a
 * second plugin's op) and quietly change what it means.
 */
export function definePluginOp(owner: string, op: WalnutOp): Disposable {
  validateOp(op)
  const existing = ops.getEntry(op.name)
  if (existing) throw new Error(`op "${op.name}" is already defined by ${existing.owner}`)
  return ops.register(owner, op.name, op)
}

/** Bulk withdrawal for one owner. The loader calls this when it tears a plugin down. */
export function removePluginOps(owner: string): number {
  return ops.removeOwner(owner)
}

/**
 * How many ops one owner currently holds. DERIVED, never a tally a caller keeps:
 * an owner sweep or a core eviction removes entries without telling the caller,
 * and a stale counter would refuse a legitimate registration forever.
 */
export function countOwnerOps(owner: string): number {
  return ops.ownedBy(owner).length
}

/** By default list only current ops; old names still run through getOp. */
export function listOps(options: { includeDeprecated?: boolean } = {}): WalnutOp[] {
  return ops.values().filter((op) => options.includeDeprecated || !op.deprecated)
}

/** Ops with their owner ('core', or the plugin id), in declaration order. */
export function listOpEntries(): Array<{ owner: string; op: WalnutOp }> {
  return ops.entries().map((entry) => ({ owner: entry.owner, op: entry.value }))
}

export function getOp(name: string): WalnutOp | undefined {
  return ops.get(name)
}

/** Names only — convenience for allowlists and tests. */
export function opNames(filter?: { readonly?: boolean }): string[] {
  return listOps()
    .filter((o) => filter?.readonly === undefined || o.tags.readonly === filter.readonly)
    .map((o) => o.name)
}

export function opInputJsonSchema(op: WalnutOp): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(op.input), { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}
