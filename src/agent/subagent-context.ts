/**
 * Subagent context builders:
 * - buildSubagentSystemPrompt(): system prompt for embedded subagents
 * - buildSubagentToolSet(): filtered tool set per agent definition
 */

import { tools, type ToolDefinition } from './tools.js';
import { migrateToolNames } from '../core/agent-registry.js';
import { getConfig } from '../core/config-manager.js';
import type { AgentDefinition } from '../core/types.js';

// Tools that subagents are never allowed to use (prevent recursion / privilege escalation)
const ALWAYS_DENIED_TOOLS = [
  'session_start',
  'session_send',
  'agent_create',
  'agent_update',
  'agent_delete',
];

/**
 * Build a system prompt for a subagent run.
 */
export function buildSubagentSystemPrompt(
  agentDef: AgentDefinition,
  task: string,
  extraContext?: string,
): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const sections = [
    `You are ${agentDef.name} — a focused Walnut subagent.`,
    `Current date/time: ${dateStr}, ${timeStr}`,
    '',
    '## Your Task',
    task,
    '',
    '## Rules',
    '- Focus on the task above. Complete it, then stop.',
    '- Use tools as needed. Be efficient.',
    '- Provide a clear summary of what you accomplished.',
    '- You cannot start sessions or spawn further agents.',
  ];

  if (agentDef.system_prompt) {
    sections.push('', '## Agent Instructions', agentDef.system_prompt);
  }

  if (extraContext) {
    sections.push('', '## Additional Context', extraContext);
  }

  return sections.join('\n');
}

/**
 * Build a filtered tool set for a subagent based on its definition.
 *
 * Filtering logic:
 * 1. If allowed_tools is set → only those tools (whitelist)
 * 2. Otherwise: all global tools minus always-denied, minus agentDef.denied_tools,
 *    minus per-call denied_tools, minus config.agent.subagent.denied_tools
 */
export async function buildSubagentToolSet(
  agentDef: AgentDefinition,
  perCallDenied?: string[],
): Promise<ToolDefinition[]> {
  const config = await getConfig();
  const globalDenied = migrateToolNames(config.agent?.subagent?.denied_tools) ?? [];

  const agentId = agentDef.id;

  /** Wrap file_* tools to inject _agentId so they write to agent-specific dirs. */
  function injectAgentId(filtered: ToolDefinition[]): ToolDefinition[] {
    if (!agentId || agentId === 'general') return filtered;
    return filtered.map((t) => {
      if (t.name.startsWith('file_')) {
        return {
          ...t,
          execute: (params: Record<string, unknown>) => t.execute({ ...params, _agentId: agentId }),
        };
      }
      return t;
    });
  }

  if (agentDef.allowed_tools && agentDef.allowed_tools.length > 0) {
    // Whitelist mode: only explicitly allowed tools (still filter out always-denied)
    const allowed = new Set(agentDef.allowed_tools);
    const filtered = tools.filter(
      (t) => allowed.has(t.name) && !ALWAYS_DENIED_TOOLS.includes(t.name),
    );
    return injectAgentId(filtered);
  }

  // Denylist mode: start with all tools, subtract denied sets
  const denied = new Set([
    ...ALWAYS_DENIED_TOOLS,
    ...(agentDef.denied_tools ?? []),
    ...(perCallDenied ?? []),
    ...globalDenied,
  ]);

  return injectAgentId(tools.filter((t) => !denied.has(t.name)));
}
