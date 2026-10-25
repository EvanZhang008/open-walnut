import type { Task } from '@open-walnut/core';
import { apiPost } from './client';

/**
 * The main agent's task, made by the server on first use (POST /api/v1/org/main).
 * Null where only the primary can make it (a replica answers 501): the caller then
 * starts an ordinary ask instead of failing the send.
 */
export async function ensureMainTask(): Promise<Task | null> {
  try {
    const res = await apiPost<{ task: Task }>('/api/v1/org/main', undefined, { quietStatuses: [501] });
    return res.task;
  } catch (err) {
    if ((err as { status?: number }).status === 501) return null;
    throw err;
  }
}

export interface OrgContactAnswer {
  task: { id: string; title: string; project: string; phase: string; org_role?: string };
  kind: 'lead' | 'team' | 'task';
  project: string;
  started: boolean;
  /** Where a lead with no session would start (host null = this Mac); absent when it has no place yet. */
  launch?: { cwd: string; host: string | null };
}

/** Who answers for a project (its lead, made here when it has 2+ teams, or its one team). */
export async function resolveOrgContact(to: string): Promise<OrgContactAnswer> {
  return apiPost<OrgContactAnswer>('/api/v1/org/contact', { to });
}
