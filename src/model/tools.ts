/**
 * Tool shapes a model turn can call.
 *
 * Types only — a tool DEFINITION lives next to whatever it wraps (read-only ops
 * in core/tools/, plugin contributions in core/plugins/, a routine's outcome
 * tools next to the routine). This module exists so those places, and the loop
 * in micro-agent.ts that runs them, agree on one contract without importing
 * each other.
 *
 * The block shapes mirror the Anthropic API's `ToolResultBlockParam.content`,
 * because that is what the adapters send verbatim.
 */

export type ToolTextBlock = { type: 'text'; text: string };
export type ToolImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ToolContentBlock = ToolTextBlock | ToolImageBlock;

/** Content returned by a tool: plain string or structured content blocks (text + image). */
export type ToolResultContent = string | ToolContentBlock[];

/** Metadata passed to tool execute functions (e.g. toolUseId for correlation). */
export interface ToolExecuteMeta {
  toolUseId?: string;
  /** Caller identity of the turn that called this tool (e.g. 'cron'). Used for
   *  write provenance: a memory entry written by an unattended background run
   *  carries weaker evidence than one written while the user was present. */
  source?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>, meta?: ToolExecuteMeta) => Promise<ToolResultContent>;
  /** Mark ONLY read-only tools with no ordering contract. When the model
   *  batches several tool_use blocks in one reply and EVERY tool in the batch
   *  is parallelSafe, the loop executes them concurrently instead of one
   *  await at a time. Side-effecting tools (writes, shell) must stay unset —
   *  parallel execution would let them race. */
  parallelSafe?: boolean;
}
