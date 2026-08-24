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

/** Declare one core op. Throws on duplicate names — names are the public contract. */
export function defineOp(op: WalnutOp): WalnutOp {
  validateOp(op)
  if (ops.has(op.name)) throw new Error(`duplicate op name: ${op.name}`)
  ops.register('core', op.name, op)
  return op
}

export function definePluginOp(owner: string, op: WalnutOp): Disposable {
  validateOp(op)
  return ops.register(owner, op.name, op)
}

export function removePluginOps(owner: string): number {
  return ops.removeOwner(owner)
}

/** All ops, in declaration order. */
export function listOps(): WalnutOp[] {
  return ops.values()
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
