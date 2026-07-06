/**
 * Agent tool: history_search
 * Full-text search over ALL past conversations (every agent, every
 * conversation) via the history.db FTS5 index. Three calling shapes,
 * mirroring Hermes session_search: discovery / scroll / browse.
 */
import type { ToolDefinition } from '../tools.js';
import {
  searchHistory,
  scrollHistory,
  browseHistory,
  ensureHistoryDbPopulated,
} from '../../core/history-db.js';

export const historySearchTool: ToolDefinition = {
  name: 'history_search',
  description: `Search past CONVERSATIONS (raw chat transcripts across all agents and conversations). Use when the user references something previously discussed that isn't in current context: "we talked about X", "what did I say about Y last month", "did the tracker log Z".

This searches the conversation transcript index — NOT curated knowledge. For skills / project overview history / notes use memory_notes_search instead. Claude Code coding sessions are not here (they have their own transcripts).

## Three shapes

1. DISCOVERY — pass "query": keyword search (exact-match BM25, AND across terms). Returns the best-matching message per conversation with ids for follow-up. Keep queries to 1-3 CONCRETE terms likely to appear verbatim (names, error strings, topics). Chinese terms need 3+ characters for indexed search; shorter terms fall back to a slower scan automatically.
2. SCROLL — pass "conversation_id" + "around_message_id" (from a discovery hit): returns surrounding messages so you can read the actual exchange. ALWAYS scroll before quoting a past conversation — a lone snippet lacks context.
3. BROWSE — pass neither: lists recent conversations (agent, last activity, message count).

Machine chatter (subagent/triage) is hidden unless include_hidden. Cron messages are searchable but ranked below organic chat. Time-scope with after/before (ISO dates) when the user says "last week"/"in June".`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Discovery keywords, 1-3 concrete terms (e.g. "migration plan Alpha"). Omit for scroll/browse.',
      },
      conversation_id: {
        type: 'string',
        description: 'Scroll shape: conversation to read (from a discovery hit).',
      },
      around_message_id: {
        type: 'number',
        description: 'Scroll shape: message id to center the window on (from a discovery hit).',
      },
      agent_id: {
        type: 'string',
        description: 'Limit to one agent (e.g. "general" for the butler). Required for scroll (comes with the hit); optional filter for discovery/browse.',
      },
      after: { type: 'string', description: 'Only messages at/after this ISO date, e.g. "2026-06-01".' },
      before: { type: 'string', description: 'Only messages at/before this ISO date.' },
      include_hidden: {
        type: 'boolean',
        description: 'Include subagent/triage machine messages in discovery. Default false.',
      },
      limit: { type: 'number', description: 'Max results. Default: 5 (discovery) / 10 (browse).' },
    },
  },
  async execute(params) {
    await ensureHistoryDbPopulated();

    const query = (params.query as string | undefined)?.trim();
    const conversationId = params.conversation_id as string | undefined;
    const aroundId = params.around_message_id as number | undefined;

    // SCROLL shape
    if (conversationId && aroundId !== undefined) {
      const agentId = (params.agent_id as string | undefined) || 'general';
      const messages = scrollHistory(agentId, conversationId, aroundId);
      if (messages.length === 0) return 'No messages found for that conversation/message id.';
      return JSON.stringify(messages.map((m) => ({
        id: m.id,
        role: m.role,
        source: m.source,
        ts: m.ts,
        content: m.content.slice(0, 2000),
      })), null, 2);
    }

    const opts = {
      agentId: params.agent_id as string | undefined,
      includeHidden: (params.include_hidden as boolean | undefined) ?? false,
      after: params.after as string | undefined,
      before: params.before as string | undefined,
      limit: params.limit as number | undefined,
    };

    // DISCOVERY shape
    if (query) {
      const hits = searchHistory(query, opts);
      if (hits.length === 0) return 'No results found. Try fewer or different keywords (exact matching).';
      return JSON.stringify(hits.map((h) => ({
        agent_id: h.agentId,
        conversation_id: h.conversationId,
        message_id: h.id,
        role: h.role,
        source: h.source,
        ts: h.ts,
        snippet: h.snippet,
      })), null, 2);
    }

    // BROWSE shape
    const recent = browseHistory({ ...opts, limit: opts.limit ?? 10 });
    if (recent.length === 0) return 'No conversation history indexed yet.';
    return JSON.stringify(recent.map((c) => ({
      agent_id: c.agentId,
      conversation_id: c.conversationId,
      last_activity: c.lastTs,
      message_count: c.messageCount,
      last_snippet: c.lastSnippet,
    })), null, 2);
  },
};
