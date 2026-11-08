/**
 * Where a new "Imported from <host>" project goes on the Org page (external-session-import.ts
 * makes one such project per host).
 *
 *  1. Under the VP its sibling import projects are under. 2026-11-03: a machine joined over the
 *     host network, and ten minutes later the importer made "Imported from <that machine>" with
 *     no VP, so it floated alone on the Org page while "Imported from this Mac" and the SSH
 *     hosts' import projects sat under the user's Operations VP.
 *  2. With no sibling under a VP, under the Others VP (OTHERS_VP_NAME): the VP the user keeps for
 *     what no other VP owns. 2026-11-12, the user, on a new install whose first run made
 *     "Imported from this Mac" its own VP: "the import xxx should default under others". When
 *     there is no Others VP yet and this is the install's first import project, Walnut makes one
 *     (a VP made only to put projects under, as the Org page's New VP makes). An install whose
 *     earlier import projects already stand on their own keeps that: no Others VP is made for
 *     it and nothing it has is moved. A closed Others VP is never reopened for it.
 *
 * Only the run that MADE the project places it (the project registry had no row for it
 * before that run), never a later one: a project the user gives back its own VP, or
 * moves under another one, keeps that. Primary only (org writes are the leader's, as in
 * org-v1.ts), never from a test run (its project is a test object, and a real VP must
 * not lead it), and never under a closed VP, which the move would reopen.
 *
 * The vote reads the org outside its lock, so the move carries what the vote saw
 * (setProjectVp's guard): when the lead it resolves under the lock is another one, is
 * closed, or is missing, or the project got a lead meanwhile, nothing moves.
 * tests/core/first-run-no-own-vp-guard.test.ts lists every place that may make a VP.
 */
import { log } from '../../logging/index.js';
import { role } from '../server-role.js';
import type { Task } from '../types.js';

/** The VP for what no other VP owns: where a new install's imports go. */
export const OTHERS_VP_NAME = 'Others';

/** The Others VP: a lead the user named Others, or whose own project is Others (an open one first). */
export function othersVp<T extends Pick<Task, 'org_role' | 'org_name' | 'project' | 'phase'>>(tasks: readonly T[]): T | undefined {
  const key = OTHERS_VP_NAME.toLowerCase();
  // Either one: a renamed Others VP keeps its own project, and a closed one must stay found so it
  // is never made again (createOrgNode would reopen it).
  const is = (v: string | undefined) => (v ?? '').trim().toLowerCase() === key;
  const named = tasks.filter((t) => t.org_role === 'lead' && (is(t.org_name) || is(t.project)));
  return named.find((t) => t.phase !== 'COMPLETE') ?? named[0];
}

/** Does the project registry already hold `project` (names compare without case)? */
export async function projectRegistered(project: string): Promise<boolean> {
  const { getStoreProjects } = await import('../task-manager.js');
  const key = project.trim().toLowerCase();
  return Object.keys(await getStoreProjects()).some((name) => name.trim().toLowerCase() === key);
}

/**
 * Put `project`, just made by an import, under the VP that leads the other import
 * projects (`importProjects`: every name the importer can make on this install, so a
 * user's own "Imported from Japan" never votes); with several VPs, the one leading the
 * most import projects, a tie going to the sibling first by name. With no other import
 * project under an open VP, under the Others VP (made for a first import, see the module
 * note). Nothing when it already has a lead or a VP.
 * Returns the VP's own project, or null. Never throws: a failure only logs.
 */
export async function placeNewImportProject(project: string, importProjects: Iterable<string>): Promise<string | null> {
  try {
    if (role() !== 'leader') return null;
    const { ambientTestRun } = await import('../test-run.js');
    const testRun = ambientTestRun();
    if (testRun !== undefined) {
      log.session.info('external import: a test run\'s new import project is not put under a VP', { project, testRun });
      return null;
    }
    const { orgTasks, setProjectVp } = await import('../org/org-store.js');
    const { leadsAlso, pickLead, pickOwnLead, projectKey } = await import('../org/org-tree.js');
    const isImport = new Set([...importProjects].map(projectKey));
    const tasks = await orgTasks();
    const key = projectKey(project);
    // The import filed its tasks elsewhere (a project renamed meanwhile): nothing to place.
    if (!tasks.some((t) => projectKey(t.project) === key && t.phase !== 'COMPLETE')) return null;
    if (pickOwnLead(tasks, project) || tasks.some((t) => leadsAlso(t, project))) return null;

    const siblings = new Map<string, string>();
    for (const t of tasks) {
      if (t.org_role !== 'lead') continue;
      for (const p of t.org_leads ?? []) {
        const k = projectKey(p);
        if (isImport.has(k) && k !== key && !siblings.has(k)) siblings.set(k, p.trim());
      }
    }
    // Each sibling votes for the VP that leads it now; siblings in name order keep a tie stable.
    const votes = new Map<string, { leadId: string; sibling: string; count: number }>();
    for (const [, sibling] of [...siblings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const lead = pickLead(tasks, sibling);
      if (!lead || lead.phase === 'COMPLETE' || !leadsAlso(lead, sibling)) continue;
      const vote = votes.get(lead.id);
      if (vote) vote.count++;
      else votes.set(lead.id, { leadId: lead.id, sibling, count: 1 });
    }
    // A stable sort: among equal counts the first sibling's VP wins.
    const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) return await placeUnderOthers(project, tasks, isImport);
    const res = await setProjectVp(project, best.sibling, {
      expectLeadId: best.leadId, noCreate: true, noReopen: true, unledOnly: true,
    });
    if (res.refused) {
      log.session.info('external import: new import project left where it is, the org changed since the vote', {
        project, sibling: best.sibling, leadId: best.leadId, refused: res.refused,
      });
      return null;
    }
    log.session.info('external import: new import project put under the VP of the other import projects', {
      project, vp: res.vp, leadId: res.lead?.id, sibling: best.sibling,
    });
    return res.vp || null;
  } catch (err) {
    log.session.warn('external import: new import project not put under a VP', {
      project, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * No sibling votes: `project` goes under the Others VP. One is made only for an install's
 * first import project (no other import project in the registry), so an older install whose
 * imports stand on their own is left as it is. A closed Others VP stays closed.
 */
async function placeUnderOthers(project: string, tasks: readonly Task[], isImport: ReadonlySet<string>): Promise<string | null> {
  const { setProjectVp } = await import('../org/org-store.js');
  const { projectKey } = await import('../org/org-tree.js');
  let others = othersVp(tasks);
  if (others?.phase === 'COMPLETE') {
    log.session.info('external import: the Others VP is closed, the new import project stands on its own', { project, leadId: others.id });
    return null;
  }
  if (!others) {
    const { getStoreProjects } = await import('../task-manager.js');
    const key = projectKey(project);
    const earlier = Object.keys(await getStoreProjects()).filter((name) => isImport.has(projectKey(name)) && projectKey(name) !== key);
    if (earlier.length) return null;
    others = (await makeOthersVp(project)) ?? undefined;
    if (!others) return null;
  }
  const res = await setProjectVp(project, others.project ?? '', {
    expectLeadId: others.id, noCreate: true, noReopen: true, unledOnly: true,
  });
  if (res.refused) {
    log.session.info('external import: new import project left where it is, the Others VP changed', { project, leadId: others.id, refused: res.refused });
    return null;
  }
  log.session.info('external import: new import project put under the Others VP', { project, vp: res.vp, leadId: others.id });
  return res.vp || null;
}

/** Make the Others VP (a VP only to put projects under); null when that name is taken another way. */
async function makeOthersVp(forProject: string): Promise<Task | null> {
  const { createOrgNode } = await import('../org/org-node-edit.js');
  const { orgTasks } = await import('../org/org-store.js');
  try {
    const lead = await createOrgNode({ name: OTHERS_VP_NAME }, true, { writer: { by: 'agent', byName: 'Walnut' } });
    log.session.info('external import: made the Others VP for the first import project', { project: forProject, leadId: lead.id });
    return lead;
  } catch (err) {
    // Made meanwhile (another host's import in the same moment), or a project of the user's
    // own is named Others: take an open Others VP when there is one now, else leave it.
    const now = othersVp(await orgTasks());
    if (now && now.phase !== 'COMPLETE') return now;
    log.session.info('external import: no Others VP made, the new import project stands on its own', {
      project: forProject, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
