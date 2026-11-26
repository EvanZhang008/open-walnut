/**
 * Plugin-contributed tools (manifest capability `tools` → api.registerTool),
 * resolved LIVE from the integration registry so a plugin-store soft reload is
 * picked up without a server restart.
 *
 * Who consumes them: an in-process model turn that is given a tool belt by name
 * (a routine watcher allowlists `mail_list, mail_read`). A spawned CLI session
 * reaches a plugin through its MCP mount instead, never through this list.
 *
 * An op definition always WINS over a tool spec of the same name. The loader
 * namespaces plugin tool names `<pluginId>_<name>`, so a collision with a core op
 * means a plugin picked a name a later Walnut version shipped as core, and
 * silently shadowing it is the one outcome that must never happen (the caller
 * merges the two lists into a name-keyed map, where whoever comes last would
 * win). A plugin that publishes the same name through BOTH `api.tool` and
 * `api.op` (the mail plugin does, for every tool) is not shadowing anything: the
 * op is the canonical definition and already reaches the belt through the
 * read-only pool, so the spec is dropped quietly.
 */

import { registry } from '../integration-registry.js';
// Through ops/index.js, not ops/registry.js: importing the index is what RUNS the
// core op declarations. Reading the registry directly could see an empty core set
// and let a plugin tool through under a core op's name.
import { listOpEntries } from '../../ops/index.js';
import { log } from '../../logging/index.js';
import type { ToolDefinition, ToolImageBlock, ToolResultContent } from '../../model/tools.js';
import { frameOutsideText } from '../outside-content.js';

export function getPluginTools(): ToolDefinition[] {
  let specs: Array<{ owner: string; spec: import('../integration-types.js').PluginToolSpec }>;
  try {
    specs = registry.getAll().flatMap((p) => (p.tools ?? []).map((spec) => ({ owner: p.id, spec })));
  } catch (err) {
    log.agent.debug('plugin tools unavailable', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (specs.length === 0) return [];
  const opOwners = new Map(listOpEntries().map((e) => [e.op.name, e.owner] as const));
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const { owner, spec } of specs) {
    const opOwner = opOwners.get(spec.name);
    if (opOwner === 'core') {
      log.agent.warn('plugin tool shadows a core op — plugin tool ignored', { tool: spec.name, plugin: owner });
      continue;
    }
    if (opOwner === owner) {
      log.agent.debug('plugin tool is also a plugin op — the op is canonical', { tool: spec.name, plugin: owner });
      continue;
    }
    if (opOwner !== undefined) {
      log.agent.warn('plugin tool collides with another plugin\'s op — plugin tool ignored', { tool: spec.name, plugin: owner, opOwner });
      continue;
    }
    if (seen.has(spec.name)) {
      log.agent.warn('duplicate plugin tool name across plugins — first wins', { tool: spec.name });
      continue;
    }
    seen.add(spec.name);
    out.push({
      name: spec.name,
      description: spec.description,
      input_schema: spec.input_schema,
      execute: async (params, meta) => {
        const result = await spec.execute(params, meta) as ToolResultContent;
        return spec.framesOwnAnswer === true ? result : framedToolResult(owner, spec.name, result);
      },
    });
  }
  return out;
}

/** What model/micro-agent.ts isToolResultError reads as an error, with the space after it. */
const ERROR_PREFIX = /^Error[:\s]\s*/i;

/**
 * A plugin tool's result as the model reads it: its text framed as outside data (a plugin's data
 * comes from outside Walnut), always. Never skipped for text that looks framed: an outside party can
 * write a look-alike tag, and framing twice is safe (the inner tag is escaped). An image block is no
 * text and stays as it is. An `Error...` result keeps its first word, the loop's error signal, and
 * the rest is framed: a remote API's error body is a stranger's words too. A legacy result that is
 * neither a string nor a block list (a plugin returning an object) is framed as its JSON.
 */
export function framedToolResult(owner: string, tool: string, result: ToolResultContent): ToolResultContent {
  const from = { source: `${owner} plugin`, attrs: { tool } };
  // The loop's own test for an error (model/micro-agent.ts isToolResultError) still holds after the frame.
  const frame = (text: string): string => {
    const error = ERROR_PREFIX.exec(text);
    return error ? `Error: ${frameOutsideText(from, text.slice(error[0].length))}` : frameOutsideText(from, text);
  };
  if (typeof result === 'string') return frame(result);
  if (Array.isArray(result)) {
    return result.map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? { ...block, text: frame(block.text) } : block));
  }
  const legacy: unknown = result;
  if (isImageBlock(legacy)) return [legacy];
  if (legacy === undefined || legacy === null) return frame('');
  return frame(JSON.stringify(legacy));
}

function isImageBlock(value: unknown): value is ToolImageBlock {
  const v = value as { type?: unknown; source?: { type?: unknown; data?: unknown } } | null;
  return !!v && typeof v === 'object' && v.type === 'image' && !!v.source && typeof v.source.data === 'string';
}
