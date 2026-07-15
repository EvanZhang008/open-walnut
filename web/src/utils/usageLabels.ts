/**
 * Display-only labels for usage breakdown rows.
 *
 * The stored `source` / `agent_id` values keep their internal IDs (no data
 * migration), but the cost dashboard shows friendlier names. In particular the
 * legacy "triage" agent/source is the post-turn session SUMMARY agent — it
 * records what a session did; it no longer drives the workflow — so it reads as
 * "Summary" for users. Keep this map display-only: never use it to look up or
 * write data.
 */
const USAGE_LABELS: Record<string, string> = {
  // sources
  triage: 'Turn summary',
  subagent: 'Subagent',
  agent: 'Main agent',
  'agent-cli': 'Main agent (CLI)',
  session: 'Claude Code session',
  compaction: 'Compaction',
  heartbeat: 'Heartbeat',
  cron: 'Cron',
  // agent ids — two summarizers exist and must read as distinct things:
  // turn-complete-triage = incremental per-turn task summary (cached, cheap each);
  // session-summarizer = end-of-session full-transcript gist (uncached, pricey each).
  'turn-complete-triage': 'Turn summary',
  'message-send-triage': 'Turn summary (retired per-message)',
  'note-agent': 'Note agent',
  'session-summarizer': 'Session gist (on end)',
  general: 'Main agent',
  unknown: 'Unknown',
  // agent_id-less legacy rows fall back to their source name; 'subagent' here
  // means "some subagent, recorded before per-agent attribution existed".
  'subagent-legacy': 'Subagent (unattributed)',
};

export function usageDisplayName(name: string): string {
  return USAGE_LABELS[name] ?? name;
}
