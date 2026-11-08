import type { Task } from '@open-walnut/core';
import type { SystemHealth } from '@/hooks/useSystemHealth';

export function firstUseNeedsSetup(tasks: readonly Task[], completedHidden: number, health: SystemHealth, loading: boolean): boolean {
  if (loading || health.hasReadyProvider === undefined) return false;
  if (completedHidden || tasks.some(t => !t.plugin_only && (!t.org_role || !!t.session_id || !!t.exec_session_id || !!t.session_ids?.length))) return false;
  if (health.claudeCodeNeeded === false) return !health.hasReadyProvider;
  return !health.hasReadyProvider || health.claudeCliAvailable === false || !health.localClaude?.checkedAt
    || health.localClaude?.claude.auth !== 'ok' || !!health.localClaude?.checkError
    || health.localClaude?.problems.some(p => ['claude_missing', 'claude_needs_node', 'claude_error', 'claude_not_logged_in', 'claude_outdated'].includes(p.kind)) === true;
}

export function firstUseCanStartMain(health: SystemHealth): boolean {
  if (health.hasReadyProvider !== true) return false;
  if (health.claudeCodeNeeded === false) return true;
  return health.claudeCliAvailable === true && !!health.localClaude?.checkedAt
    && health.localClaude.claude.auth === 'ok' && !health.localClaude.checkError && !health.localClaude.problems.some(p =>
    ['claude_missing', 'claude_needs_node', 'claude_error', 'claude_not_logged_in', 'claude_outdated'].includes(p.kind));
}

export function foundHostsToAsk(hosts: Record<string, { discovered?: boolean; connect?: string; label?: string }> | undefined): Array<{ host: string; label: string }> {
  return Object.entries(hosts ?? {}).filter(([, h]) => h.discovered && h.connect === 'ask')
    .map(([host, h]) => ({ host, label: h.label?.trim() || host }));
}
