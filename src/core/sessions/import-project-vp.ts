/**
 * A new "Imported from <host>" project goes under the VP its sibling import projects
 * are under (external-session-import.ts makes one such project per host).
 *
 * 2026-11-03: a machine joined over the host network, and ten minutes later the
 * importer made "Imported from <that machine>" with no VP, so it floated alone on the
 * Org page while "Imported from this Mac" and the SSH hosts' import projects sat under
 * the user's Operations VP.
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
 */
import { log } from '../../logging/index.js';
import { role } from '../server-role.js';

/** Does the project registry already hold `project` (names compare without case)? */
export async function projectRegistered(project: string): Promise<boolean> {
  const { getStoreProjects } = await import('../task-manager.js');
  const key = project.trim().toLowerCase();
  return Object.keys(await getStoreProjects()).some((name) => name.trim().toLowerCase() === key);
}

/**
 * Put `project`, just made by an import, under the VP that leads the other import
 * projects (`importProjects`: every name the importer can make on this install, so a
 * user's own "Imported from Japan" never votes). Nothing when it already has a lead or
 * a VP, or when no other import project is under an open VP; with several VPs, the one
 * leading the most import projects, a tie going to the sibling first by name.
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
    if (!best) return null;
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
