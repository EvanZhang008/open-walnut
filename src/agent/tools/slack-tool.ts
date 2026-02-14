/**
 * Slack messaging tool for the agent.
 * Supports sending messages, reading channel history, reactions, and pinning.
 */
import type { ToolDefinition } from '../tools.js';
import { getConfig } from '../../core/config-manager.js';
import { log } from '../../logging/index.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

async function getSlackClient() {
  const { WebClient } = await import('@slack/web-api');
  const config = await getConfig();
  const token = config.tools?.slack?.bot_token;
  const resolvedToken = token || process.env.SLACK_BOT_TOKEN;
  if (!resolvedToken) {
    return null;
  }
  return new WebClient(resolvedToken);
}

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  type?: string;
}

function formatMessages(messages: SlackMessage[]): string {
  return messages
    .map((m) => ({
      user: m.user ?? 'unknown',
      text: m.text ?? '',
      timestamp: m.ts,
      thread_ts: m.thread_ts,
    }))
    .map((m) => json(m))
    .join('\n');
}

export const slackTool: ToolDefinition = {
  name: 'slack',
  description:
    'Interact with Slack. Actions: "send_message" (send to channel/thread), "read_messages" (read channel history), "react" (add emoji reaction), "pin" (pin a message).',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send_message', 'read_messages', 'react', 'pin'],
        description: 'The Slack action to perform',
      },
      channel: {
        type: 'string',
        description: 'Channel ID or name (e.g. C01234567 or #general)',
      },
      text: {
        type: 'string',
        description: 'Message text (for send_message)',
      },
      limit: {
        type: 'number',
        description: 'Max messages to retrieve (for read_messages, default 10)',
      },
      timestamp: {
        type: 'string',
        description: 'Message timestamp (for react/pin)',
      },
      emoji: {
        type: 'string',
        description: 'Emoji name without colons (for react, e.g. "thumbsup")',
      },
      thread_ts: {
        type: 'string',
        description: 'Thread timestamp to reply in (for send_message)',
      },
    },
    required: ['action', 'channel'],
  },
  async execute(params) {
    const action = params.action as string;
    const channel = params.channel as string;

    const client = await getSlackClient();
    if (!client) {
      return 'Error: Slack not configured. Set tools.slack.bot_token in config or SLACK_BOT_TOKEN env var.';
    }

    try {
      if (action === 'send_message') {
        const text = params.text as string;
        if (!text) return 'Error: text is required for send_message.';
        const threadTs = params.thread_ts as string | undefined;
        const result = await client.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
        });
        log.agent.info('slack message sent', { channel, ok: result.ok });
        return json({
          ok: result.ok,
          channel: result.channel,
          ts: result.ts,
          message: result.message?.text,
        });
      }

      if (action === 'read_messages') {
        const limit = (params.limit as number) ?? 10;
        const result = await client.conversations.history({
          channel,
          limit,
        });
        const messages = (result.messages ?? []) as SlackMessage[];
        if (messages.length === 0) return 'No messages found in channel.';
        return json(
          messages.map((m) => ({
            user: m.user ?? 'unknown',
            text: m.text ?? '',
            timestamp: m.ts,
            thread_ts: m.thread_ts,
          })),
        );
      }

      if (action === 'react') {
        const timestamp = params.timestamp as string;
        const emoji = params.emoji as string;
        if (!timestamp) return 'Error: timestamp is required for react.';
        if (!emoji) return 'Error: emoji is required for react.';
        const result = await client.reactions.add({
          channel,
          timestamp,
          name: emoji,
        });
        return json({ ok: result.ok });
      }

      if (action === 'pin') {
        const timestamp = params.timestamp as string;
        if (!timestamp) return 'Error: timestamp is required for pin.';
        const result = await client.pins.add({
          channel,
          timestamp,
        });
        return json({ ok: result.ok });
      }

      return `Error: Unknown action "${action}". Use send_message, read_messages, react, or pin.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.error('slack tool error', { action, error: msg });
      return `Error: Slack API error — ${msg}`;
    }
  },
};
