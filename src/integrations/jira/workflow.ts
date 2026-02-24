/**
 * Phase ↔ Jira status mapping + transition resolution.
 *
 * Jira doesn't allow direct status assignment — you must discover available
 * transitions via GET /transitions and execute one. This module handles that.
 */

import type { TaskPhase } from '../../core/types.js';
import type { JiraTransition } from './types.js';

// ── Phase → Jira target status name ──

export const PHASE_TO_JIRA_STATUS: Record<TaskPhase, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'In Progress',
  AWAIT_HUMAN_ACTION: 'In Progress',
  PEER_CODE_REVIEW: 'In Review',
  RELEASE_IN_PIPELINE: 'Done',
  COMPLETE: 'Done',
};

// ── Jira status name → default Walnut phase (for new tasks pulled from Jira) ──

export const JIRA_STATUS_TO_PHASE: Record<string, TaskPhase> = {
  'Backlog': 'TODO',
  'To Do': 'TODO',
  'Open': 'TODO',
  'Reopened': 'TODO',
  'Selected for Development': 'TODO',
  'In Progress': 'IN_PROGRESS',
  'In Development': 'IN_PROGRESS',
  'In Review': 'PEER_CODE_REVIEW',
  'Code Review': 'PEER_CODE_REVIEW',
  'Done': 'COMPLETE',
  'Closed': 'COMPLETE',
  'Resolved': 'COMPLETE',
};

// ── Phase groups for pull preservation ──
// When Jira reports a status, any local phase in the same group is preserved.

export const JIRA_PHASE_GROUPS: Record<string, TaskPhase[]> = {
  'Backlog': ['TODO'],
  'To Do': ['TODO'],
  'Open': ['TODO'],
  'Reopened': ['TODO'],
  'Selected for Development': ['TODO'],
  'In Progress': ['IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION'],
  'In Development': ['IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION'],
  'In Review': ['PEER_CODE_REVIEW'],
  'Code Review': ['PEER_CODE_REVIEW'],
  'Done': ['RELEASE_IN_PIPELINE', 'COMPLETE'],
  'Closed': ['RELEASE_IN_PIPELINE', 'COMPLETE'],
  'Resolved': ['RELEASE_IN_PIPELINE', 'COMPLETE'],
};

// ── Status category fallback ──
// Jira status categories: 'new', 'indeterminate', 'done'

const STATUS_CATEGORY_TO_PHASE: Record<string, TaskPhase> = {
  'new': 'TODO',
  'indeterminate': 'IN_PROGRESS',
  'done': 'COMPLETE',
};

/**
 * Map a Jira status to a Walnut phase.
 * First checks exact status name match, then falls back to status category.
 */
export function phaseFromJiraStatus(
  statusName: string,
  statusCategoryKey?: string,
): TaskPhase {
  // Exact name match (case-insensitive)
  const nameKey = Object.keys(JIRA_STATUS_TO_PHASE).find(
    (k) => k.toLowerCase() === statusName.toLowerCase(),
  );
  if (nameKey) return JIRA_STATUS_TO_PHASE[nameKey];

  // Fall back to status category
  if (statusCategoryKey) {
    return STATUS_CATEGORY_TO_PHASE[statusCategoryKey] ?? 'TODO';
  }
  return 'TODO';
}

/**
 * Determine if the local phase should be preserved during a Jira pull.
 * Returns true if localPhase and the remote status belong to the same phase group.
 */
export function shouldPreserveLocalPhaseJira(
  localPhase: TaskPhase,
  jiraStatusName: string,
): boolean {
  // Check exact name match first
  const nameKey = Object.keys(JIRA_PHASE_GROUPS).find(
    (k) => k.toLowerCase() === jiraStatusName.toLowerCase(),
  );
  const group = nameKey ? JIRA_PHASE_GROUPS[nameKey] : undefined;
  if (!group) return false;
  return group.includes(localPhase);
}

/**
 * Find the right transition to move an issue to the target status.
 * Returns the transition ID or null if no matching transition found.
 */
export function resolveTransition(
  transitions: JiraTransition[],
  targetStatusName: string,
): string | null {
  // Exact match on target status name
  const exact = transitions.find(
    (t) => t.to.name.toLowerCase() === targetStatusName.toLowerCase(),
  );
  if (exact) return exact.id;

  // Fall back: match by status category key
  const targetCategory = statusNameToCategory(targetStatusName);
  if (targetCategory) {
    const catMatch = transitions.find(
      (t) => t.to.statusCategory.key === targetCategory,
    );
    if (catMatch) return catMatch.id;
  }

  return null;
}

/** Map a target status name to its expected Jira status category key. */
function statusNameToCategory(statusName: string): string | null {
  const lower = statusName.toLowerCase();
  if (['to do', 'backlog', 'open', 'reopened'].includes(lower)) return 'new';
  if (['in progress', 'in review', 'in development', 'code review'].includes(lower)) return 'indeterminate';
  if (['done', 'closed', 'resolved'].includes(lower)) return 'done';
  return null;
}
