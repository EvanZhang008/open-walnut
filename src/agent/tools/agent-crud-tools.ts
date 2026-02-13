/**
 * Agent CRUD tools — list, get, create, update, delete agent definitions.
 * These tools are only available to the main agent (not subagents).
 */

import type { ToolDefinition } from '../tools.js';
import {
  getAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
} from '../../core/agent-registry.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export const listAgentsTool: ToolDefinition = {
  name: 'list_agents',
  description: 'List all available agent definitions (builtin and config-defined).',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const agents = await getAllAgents();
    if (agents.length === 0) return 'No agents defined.';
    return json(agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      runner: a.runner,
      model: a.model,
      source: a.source,
    })));
  },
};

export const getAgentTool: ToolDefinition = {
  name: 'get_agent',
  description: 'Get full details of an agent definition by ID.',
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID' },
    },
    required: ['agent_id'],
  },
  async execute(params) {
    const agent = await getAgent(params.agent_id as string);
    if (!agent) return `Error: Agent "${params.agent_id}" not found.`;
    return json(agent);
  },
};

export const createAgentTool: ToolDefinition = {
  name: 'create_agent',
  description: 'Create a new agent definition. Persisted to config.yaml.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique agent ID (e.g. "researcher", "coder")' },
      name: { type: 'string', description: 'Display name (e.g. "Research Agent")' },
      description: { type: 'string', description: 'What this agent is for' },
      runner: { type: 'string', enum: ['embedded', 'cli'], description: 'Runner type. Default: embedded.' },
      model: { type: 'string', description: 'Model override (e.g. "global.anthropic.claude-sonnet-4-20250514-v1")' },
      max_tokens: { type: 'number', description: 'Max output tokens' },
      max_tool_rounds: { type: 'number', description: 'Max tool execution rounds' },
      system_prompt: { type: 'string', description: 'Custom system prompt instructions for this agent' },
      denied_tools: { type: 'array', items: { type: 'string' }, description: 'Tools this agent cannot use' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'If set, only these tools are available (whitelist)' },
      working_directory: { type: 'string', description: 'Working directory for CLI runner' },
      context_sources: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' }, token_budget: { type: 'number' } }, required: ['id', 'enabled'] }, description: 'Context sources to inject when invoked with a task' },
    },
    required: ['id', 'name'],
  },
  async execute(params) {
    try {
      const agent = await createAgent({
        id: params.id as string,
        name: params.name as string,
        description: params.description as string | undefined,
        runner: (params.runner as 'embedded' | 'cli') ?? 'embedded',
        model: params.model as string | undefined,
        max_tokens: params.max_tokens as number | undefined,
        max_tool_rounds: params.max_tool_rounds as number | undefined,
        system_prompt: params.system_prompt as string | undefined,
        denied_tools: params.denied_tools as string[] | undefined,
        allowed_tools: params.allowed_tools as string[] | undefined,
        working_directory: params.working_directory as string | undefined,
        context_sources: params.context_sources as import('../../core/types.js').ContextSourceConfig[] | undefined,
      });
      return `Agent created: ${agent.name} (id: ${agent.id}, runner: ${agent.runner})`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const updateAgentTool: ToolDefinition = {
  name: 'update_agent',
  description: 'Update an agent definition. Only config-defined agents can be updated.',
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID to update' },
      name: { type: 'string', description: 'New display name' },
      description: { type: 'string', description: 'New description' },
      runner: { type: 'string', enum: ['embedded', 'cli'], description: 'New runner type' },
      model: { type: 'string', description: 'New model' },
      max_tokens: { type: 'number', description: 'New max tokens' },
      max_tool_rounds: { type: 'number', description: 'New max tool rounds' },
      system_prompt: { type: 'string', description: 'New system prompt instructions' },
      denied_tools: { type: 'array', items: { type: 'string' }, description: 'New denied tools list' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'New allowed tools list' },
      working_directory: { type: 'string', description: 'New working directory' },
      context_sources: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' }, token_budget: { type: 'number' } }, required: ['id', 'enabled'] }, description: 'Context sources to inject when invoked with a task' },
    },
    required: ['agent_id'],
  },
  async execute(params) {
    try {
      const { agent_id, ...updates } = params;
      const agent = await updateAgent(agent_id as string, {
        name: updates.name as string | undefined,
        description: updates.description as string | undefined,
        runner: updates.runner as 'embedded' | 'cli' | undefined,
        model: updates.model as string | undefined,
        max_tokens: updates.max_tokens as number | undefined,
        max_tool_rounds: updates.max_tool_rounds as number | undefined,
        system_prompt: updates.system_prompt as string | undefined,
        denied_tools: updates.denied_tools as string[] | undefined,
        allowed_tools: updates.allowed_tools as string[] | undefined,
        working_directory: updates.working_directory as string | undefined,
        context_sources: updates.context_sources as import('../../core/types.js').ContextSourceConfig[] | undefined,
      });
      return `Agent updated: ${agent.name} (id: ${agent.id})`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const deleteAgentTool: ToolDefinition = {
  name: 'delete_agent',
  description: 'Delete an agent definition. Only config-defined agents can be deleted.',
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID to delete' },
    },
    required: ['agent_id'],
  },
  async execute(params) {
    try {
      await deleteAgent(params.agent_id as string);
      return `Agent "${params.agent_id}" deleted.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** All agent CRUD tools as an array for easy import. */
export const agentCrudTools: ToolDefinition[] = [
  listAgentsTool,
  getAgentTool,
  createAgentTool,
  updateAgentTool,
  deleteAgentTool,
];
