/**
 * The Inbox is a VP like every other project (2026-11-21, the user: now that the Inbox is a
 * project, it is a VP itself; the Inbox became a real project the same day). Its lead,
 * the Inbox VP, is made on first contact; the Inbox can go under another VP and back, and the
 * Inbox VP can lead other projects. The org keeps the Inbox's node at the key '' it always had.
 *
 * The guard at the end scans the org's code for the refusals that kept the Inbox lead-less, so a
 * new one does not come back unnoticed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-inbox-vp'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, listTasks } from '../../../src/core/task-manager.js';
import { ensureProjectLead, resolveOrgContact, setProjectVp } from '../../../src/core/org/org-store.js';
import { editProjectVp } from '../../../src/core/org/org-node-edit.js';
import { buildOrgTree, findProjectNode, orgDisplayTitle } from '../../../src/core/org/org-tree.js';
import { pinNodeName } from '../../../src/core/org/org-pins.js';
import { briefVpOf } from '../../../src/core/sessions/brief-structure.js';
import { resetCache } from '../../../src/core/session-message-queue.js';

beforeAll(() => { process.env.WALNUT_ORG_AUTOSTART = '0'; });

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

const leadsOf = async (project: string) => (await listTasks()).filter((t) => t.org_role === 'lead' && t.project === project && t.phase !== 'COMPLETE');
const inboxNode = async () => findProjectNode(buildOrgTree(await listTasks()), '')!;

describe('the Inbox VP', () => {
  it('is made on first contact, by "Inbox" or "", once, filed in the Inbox, at the node key ""', async () => {
    const a = (await addTask({ title: 'Renew the passport', project: '' })).task;
    await addTask({ title: 'Call the plumber', project: 'Inbox' });
    // Two teams and no lead: needs one, as any project would.
    expect(await inboxNode()).toMatchObject({ project: '', needsLead: true });

    const lead = await ensureProjectLead('Inbox');
    expect(lead).toMatchObject({ org_role: 'lead', project: 'Inbox', title: 'Inbox VP' });
    expect(orgDisplayTitle(lead)).toBe('Inbox VP');
    expect((await ensureProjectLead('')).id).toBe(lead.id);
    expect((await ensureProjectLead('inbox')).id).toBe(lead.id);
    expect(await leadsOf('Inbox')).toHaveLength(1);

    expect(await inboxNode()).toMatchObject({ project: '', lead: { id: lead.id }, contactId: lead.id });
    const contact = await resolveOrgContact('Inbox');
    expect(contact).toMatchObject({ task: { id: lead.id }, kind: 'lead', project: '' });
    // Named where a project's VP is named: a pin's node, a task's VP on a Brief line.
    const tasks = await listTasks();
    expect(pinNodeName('project:', tasks)).toBe('the Inbox VP');
    expect(briefVpOf(await getTask(a.id), tasks)?.id).toBe(lead.id);
  });

  it('a lead-less Inbox reached by name gets its VP, and its VP is edited like any project\'s', async () => {
    await addTask({ title: 'Book the dentist', project: '' });
    await addTask({ title: 'Return the parcel', project: '' });
    const contact = await resolveOrgContact('inbox');
    expect(contact).toMatchObject({ kind: 'lead', task: { project: 'Inbox', org_role: 'lead' } });
    const edited = await editProjectVp('', { name: 'Errands' });
    expect(edited).toMatchObject({ id: contact.task.id, org_name: 'Errands' });
    expect(orgDisplayTitle(edited)).toBe('Errands VP');
  });

  it('the Inbox goes under another VP and comes back; the Inbox VP leads other projects too', async () => {
    await addTask({ title: 'Water the beds', project: 'Garden' });
    await addTask({ title: 'Buy seeds', project: 'Garden' });
    await addTask({ title: 'Pay the bill', project: '' });
    await addTask({ title: 'Sort the mail', project: 'Inbox' });
    const garden = await ensureProjectLead('Garden');
    const inbox = await ensureProjectLead('Inbox');

    const moved = await setProjectVp('Inbox', 'Garden');
    expect(moved).toMatchObject({ project: 'Inbox', vp: 'Garden', lead: { id: garden.id } });
    // The Inbox VP never talked: it is closed at once, nothing to hand over.
    expect(moved.closed).toEqual([inbox.id]);
    expect((await getTask(garden.id)).org_leads).toEqual(['Inbox']);
    expect(await inboxNode()).toMatchObject({ project: '', vp: 'Garden', lead: { id: garden.id }, contactId: garden.id });

    const back = await setProjectVp('', '');
    expect(back).toMatchObject({ project: 'Inbox', vp: '', lead: { id: inbox.id } });
    expect((await getTask(garden.id)).org_leads ?? []).toEqual([]);
    expect(await inboxNode()).toMatchObject({ lead: { id: inbox.id }, contactId: inbox.id });
    expect((await inboxNode()).vp).toBeUndefined();

    // The other way: Garden under the Inbox VP, named `Inbox` as a VP ('' would mean its own).
    const under = await setProjectVp('Garden', 'Inbox');
    expect(under).toMatchObject({ project: 'Garden', vp: 'Inbox', lead: { id: inbox.id } });
    expect((await getTask(inbox.id)).org_leads).toEqual(['Garden']);
    const tree = buildOrgTree(await listTasks());
    expect(findProjectNode(tree, 'Garden')).toMatchObject({ vp: 'Inbox', lead: { id: inbox.id } });
    expect(findProjectNode(tree, '')!.vp).toBeUndefined();
  });
});

describe('no Inbox-only refusal comes back in the org', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const DIRS = ['src/core/org', 'src/web/routes', 'web/src/components/org', 'web/src/pages'];
  // What kept the Inbox lead-less before 2026-11-21: refusal codes, and the words the page and the
  // errors said. A new one fails here; the fix is the ordinary project path, not another exception.
  const RETIRED = [/no_lead_for_inbox/, /no_vp_for_inbox/, /Inbox has no (VP|lead)/i, /Inbox is not a VP/i, /Inbox is no one's/i];

  it('names none of them', () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = fs.readFileSync(path.join(abs, name), 'utf8');
        for (const re of RETIRED) if (re.test(text)) hits.push(`${dir}/${name}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
