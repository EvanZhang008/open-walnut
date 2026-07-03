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
  triage: 'Summary',
  subagent: 'Subagent',
  agent: 'Main agent',
  'agent-cli': 'Main agent (CLI)',
  session: 'Claude Code session',
  compaction: 'Compaction',
  heartbeat: 'Heartbeat',
  cron: 'Cron',
  // agent ids
  'turn-complete-triage': 'Summary',
  'message-send-triage': 'Summary (retired per-message)',
  'note-agent': 'Note agent',
  'session-summarizer': 'Session summarizer',
  general: 'Main agent',
  unknown: 'Unknown',
};

export function usageDisplayName(name: string): string {
  return USAGE_LABELS[name] ?? name;
}
