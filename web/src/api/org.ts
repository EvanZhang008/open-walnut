import type { Task } from '@open-walnut/core';
import { apiGet, apiPost, apiPut } from './client';

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

export interface ProjectVpAnswer {
  project: string;
  /** The project whose lead leads it now; '' = its own. */
  vp: string;
  lead?: { id: string; title: string };
  closed: string[];
  handover: string[];
  moved: string[];
  unchanged?: boolean;
}

/** Put a project under another project's VP (its lead), or back under its own (`vp` ''). No task moves. */
export async function setProjectVp(project: string, vp: string): Promise<ProjectVpAnswer> {
  return apiPost<ProjectVpAnswer>('/api/v1/org/vp', { project, vp });
}

/** The org's own names (config.yaml `org`): its name on the Org page, the user's role on the chart. */
export interface OrgSettings {
  name: string;
  founderTitle: string;
}

export async function fetchOrgSettings(): Promise<OrgSettings> {
  return apiGet<OrgSettings>('/api/v1/org/settings');
}

/** A blank name goes back to the default. */
export async function saveOrgSettings(patch: Partial<OrgSettings>): Promise<OrgSettings> {
  return apiPut<OrgSettings>('/api/v1/org/settings', patch);
}

/** An org node as the org routes answer it. */
export interface OrgNodeBrief {
  id: string; title: string; project: string; phase: string; org_role?: string; org_name?: string; org_vp_only?: boolean;
  /** Who wrote its instructions, and when (additive). */
  org_instructions?: Task['org_instructions'];
}

/** A new project with its own VP, or a new VP to put projects under (`kind` 'vp'). Returns its lead. */
export async function createOrgNode(
  kind: 'project' | 'vp',
  input: { name: string; vpName?: string; instructions?: string },
): Promise<OrgNodeBrief> {
  const res = await apiPost<{ task: OrgNodeBrief }>(kind === 'vp' ? '/api/v1/org/vps' : '/api/v1/org/projects', input);
  return res.task;
}

/** Rename a VP ('' gives it its project's name), or set the CEO's or a VP's own instructions ('' clears them). */
export async function editOrgNode(taskId: string, edit: { name?: string; instructions?: string }): Promise<OrgNodeBrief> {
  const res = await apiPut<{ task: OrgNodeBrief }>(`/api/v1/org/nodes/${encodeURIComponent(taskId)}`, edit);
  return res.task;
}

/** A project's VP: its name and instructions, its lead made first when the project has none yet. */
export async function editProjectVp(project: string, edit: { name?: string; instructions?: string }): Promise<OrgNodeBrief> {
  const res = await apiPut<{ task: OrgNodeBrief }>(`/api/v1/org/projects/${encodeURIComponent(project)}/vp`, edit);
  return res.task;
}
