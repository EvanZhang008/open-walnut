/**
 * Read-only Walnut tools for an in-process model turn, rendered from the op
 * registry (src/ops/).
 *
 * One declaration, every surface: an op is already what the MCP server and
 * `walnut tools call` expose, so a tool belt built here can never drift from
 * what a session sees. Execution goes through executeOp — loopback HTTP to this
 * server's /api/v1 — for the same reason: one code path, one set of validations.
 *
 * READ-ONLY IS AN ALLOWLIST, not a denylist: only ops tagged `readonly` appear,
 * so a future write op is barred by default. The callers here are unattended
 * (a routine watcher polling a source hundreds of times a day); write paths must
 * stay with the caller's own outcome tools, which carry a budget.
 */

import { listOps, opNames, opInputJsonSchema, executeOp, type WalnutOp } from '../../ops/index.js';
import { getPluginTools } from '../plugins/plugin-tools.js';
import type { ToolDefinition } from '../../model/tools.js';

/** One op as a tool: JSON-schema'd input, JSON-stringified result. */
function opAsTool(op: WalnutOp): ToolDefinition {
  return {
    name: op.name,
    description: op.description,
    input_schema: opInputJsonSchema(op),
    // Read-only by definition, so a batch of them may run concurrently.
    parallelSafe: true,
    execute: async (params) => {
      const outcome = await executeOp(op.name, params ?? {});
      // "Error:" prefix is the loop's error signal — it marks the tool_result
      // `is_error` so the model retries or reports instead of trusting the text.
      return outcome.ok ? JSON.stringify(outcome.result, null, 2) : `Error: ${outcome.message}`;
    },
  };
}

/** Full ToolDefinitions for every read-only op. */
export function getReadOnlyTools(): ToolDefinition[] {
  return listOps().filter((op) => op.tags.readonly).map(opAsTool);
}

/**
 * The read-only allowlist as names. DERIVED from the registry, never a
 * hand-kept list: an op tagged readonly is in, everything else is out, so a new
 * write op cannot be added to this set by forgetting to update it.
 */
export function readOnlyToolNames(): ReadonlySet<string> {
  return new Set(opNames({ readonly: true }));
}

/**
 * Same set for callers that want a constant. Frozen at import time, so it covers
 * the CORE ops (declared by the ops/index import above) and not an op a plugin
 * registers later — call readOnlyToolNames() when that matters.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = readOnlyToolNames();

/**
 * Name/description/schema of everything an in-process turn can be given: the
 * read-only ops plus the installed plugins' tools. This is the vocabulary a
 * caller names tools from, so the two must be listed together.
 */
export function getToolSchemas(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return [...getReadOnlyTools(), ...getPluginTools()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
