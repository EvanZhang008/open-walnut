/**
 * Subagent context builders:
 * - buildSubagentSystemPrompt(): system prompt for embedded subagents
 * - buildSubagentToolSet(): filtered tool set per agent definition
 * - buildAgentsSection(): section for main agent's system prompt
 */

import { tools, type ToolDefinition } from './tools.js';
import { getAllAgents } from '../core/agent-registry.js';
import { getConfig } from '../core/config-manager.js';
import type { AgentDefinition } from '../core/types.js';

// Tools that subagents are never allowed to use (prevent recursion / privilege escalation)
const ALWAYS_DENIED_TOOLS = [
  'start_session',
  'send_to_session',
  'create_agent',
  'update_agent',
  'delete_agent',
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
  const globalDenied = config.agent?.subagent?.denied_tools ?? [];

  if (agentDef.allowed_tools && agentDef.allowed_tools.length > 0) {
    // Whitelist mode: only explicitly allowed tools (still filter out always-denied)
    const allowed = new Set(agentDef.allowed_tools);
    return tools.filter(
      (t) => allowed.has(t.name) && !ALWAYS_DENIED_TOOLS.includes(t.name),
    );
  }

  // Denylist mode: start with all tools, subtract denied sets
  const denied = new Set([
    ...ALWAYS_DENIED_TOOLS,
    ...(agentDef.denied_tools ?? []),
    ...(perCallDenied ?? []),
    ...globalDenied,
  ]);

  return tools.filter((t) => !denied.has(t.name));
}

/**
 * Build the agents section for the main agent's system prompt.
 * Summarizes available agent definitions so the main agent knows
 * what agents it can dispatch via start_session.
 */
export async function buildAgentsSection(): Promise<string> {
  const agents = await getAllAgents();
  if (agents.length === 0) return '';

  const lines = agents.map((a) => {
    const parts = [`- **${a.name}** (id: \`${a.id}\`, runner: ${a.runner})`];
    if (a.description) parts.push(`  ${a.description}`);
    if (a.model) parts.push(`  Model: ${a.model}`);
    return parts.join('\n');
  });

  return `## Available agents
You can dispatch tasks to these agents using start_session with runner="embedded" and agent_id:
${lines.join('\n')}`;
}
