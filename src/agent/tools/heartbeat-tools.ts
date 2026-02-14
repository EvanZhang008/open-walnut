/**
 * AI tools for reading and updating HEARTBEAT.md checklist.
 */
import type { ToolDefinition } from '../tools.js';
import { readHeartbeatChecklist, writeHeartbeatChecklist } from '../../heartbeat/checklist-io.js';

export const heartbeatTools: ToolDefinition[] = [
  {
    name: 'get_heartbeat_checklist',
    description:
      'Read the current HEARTBEAT.md checklist content. This file defines what the heartbeat system checks periodically.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      try {
        const content = await readHeartbeatChecklist();
        return content || '(HEARTBEAT.md is empty)';
      } catch (err) {
        return `Error reading HEARTBEAT.md: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: 'update_heartbeat_checklist',
    description:
      'Replace the HEARTBEAT.md checklist content. Use this to update what the heartbeat system should check.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The new markdown content for HEARTBEAT.md',
        },
      },
      required: ['content'],
    },
    async execute(params) {
      const content = params.content as string;
      try {
        await writeHeartbeatChecklist(content);
        return `HEARTBEAT.md updated (${content.length} chars).`;
      } catch (err) {
        return `Error writing HEARTBEAT.md: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
