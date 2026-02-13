/**
 * Command CRUD tools — list, get, create, update, delete slash commands.
 * These tools only operate on user commands (built-in are read-only).
 */

import type { ToolDefinition } from '../tools.js';
import {
  listCommands,
  getCommand,
  createCommand,
  updateCommand,
  deleteCommand,
} from '../../core/command-store.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export const listCommandsTool: ToolDefinition = {
  name: 'list_commands',
  description: 'List all available slash commands (built-in and user-defined).',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const commands = await listCommands();
    if (commands.length === 0) return 'No commands defined.';
    return json(commands.map((c) => ({
      name: c.name,
      description: c.description,
      source: c.source,
    })));
  },
};

export const getCommandTool: ToolDefinition = {
  name: 'get_command',
  description: 'Get full details of a slash command by name, including its content.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Command name (without the / prefix)' },
    },
    required: ['name'],
  },
  async execute(params) {
    const cmd = await getCommand(params.name as string);
    if (!cmd) return `Error: Command "${params.name}" not found.`;
    return json(cmd);
  },
};

export const createCommandTool: ToolDefinition = {
  name: 'create_command',
  description: 'Create a new user slash command. Stored in ~/.walnut/commands/ as a .md file.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Command name — lowercase slug (e.g. "code-review", "deploy-check")' },
      content: { type: 'string', description: 'The instruction/prompt text for the command' },
      description: { type: 'string', description: 'Short description shown in autocomplete' },
    },
    required: ['name', 'content'],
  },
  async execute(params) {
    try {
      const cmd = await createCommand(
        params.name as string,
        params.content as string,
        params.description as string | undefined,
      );
      return `Command created: /${cmd.name} — ${cmd.description || '(no description)'}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const updateCommandTool: ToolDefinition = {
  name: 'update_command',
  description: 'Update an existing user slash command. Cannot modify built-in commands.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Command name to update' },
      content: { type: 'string', description: 'New instruction/prompt text' },
      description: { type: 'string', description: 'New description' },
    },
    required: ['name'],
  },
  async execute(params) {
    try {
      const cmd = await updateCommand(params.name as string, {
        content: params.content as string | undefined,
        description: params.description as string | undefined,
      });
      return `Command updated: /${cmd.name}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const deleteCommandTool: ToolDefinition = {
  name: 'delete_command',
  description: 'Delete a user slash command. Cannot delete built-in commands.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Command name to delete' },
    },
    required: ['name'],
  },
  async execute(params) {
    try {
      await deleteCommand(params.name as string);
      return `Command "${params.name}" deleted.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** All command CRUD tools as an array for easy import. */
export const commandCrudTools: ToolDefinition[] = [
  listCommandsTool,
  getCommandTool,
  createCommandTool,
  updateCommandTool,
  deleteCommandTool,
];
