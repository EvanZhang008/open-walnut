/**
 * Making a VP or a project from the Org page, naming a VP, and the user's own instructions for
 * the CEO or a VP (src/core/org/org-node-edit.ts; 2026-10-26, the user: "in org chart should be
 * able to create VP or Project ... I can define VP name, some Instruction"). The instructions ride
 * the node's prompt, so a session spawned before an edit is told it with its next message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-node-edit'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask, deleteProject, getTask, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { buildSessionContext, defaultInstructions } from '../../src/core/sessions/session-context.js';
import { instructionNoticeForSession } from '../../src/core/sessions/instruction-notice.js';
import { createOrgNode, editOrgNode, editProjectVp } from '../../src/core/org/org-node-edit.js';
import { resolveOrgContact } from '../../src/core/org/org-store.js';
import { buildOrgTree, orgDisplayTitle } from '../../src/core/org/org-tree.js';
import { resetCache } from '../../src/core/session-message-queue.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

/** A session of `taskId` spawned on today's prompt. */
async function sessionOf(taskId: string, project: string): Promise<string> {
  const sid = randomUUID();
  await createSessionRecord(sid, taskId, project, WALNUT_HOME);
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext(taskId)).systemPrompt });
  return sid;
}

// The task store outlives a test's files: every test takes names of its own.
describe('making a VP or a project on the Org page', () => {
  it('a new project comes with its own VP, named as the user typed it; the title stays the session\'s', async () => {
    const lead = await createOrgNode({ name: 'Garden', vpName: 'Green Thumb VP', instructions: 'Water before nine.' }, false);
    expect(lead).toMatchObject({ org_role: 'lead', project: 'Garden', title: 'Garden lead', org_name: 'Green Thumb' });
    expect(lead.org_vp_only).toBeUndefined();
    expect(lead.org_instructions?.text).toBe('Water before nine.');
    expect(orgDisplayTitle({ ...lead, title: 'Garden lead · weekly watering plan' })).toBe('Green Thumb VP');
    const node = buildOrgTree(await listTasks()).projects.find((p) => p.project === 'Garden');
    expect(node?.lead?.id).toBe(lead.id);
    // A VP name that is the project's own is no name of its own.
    expect((await createOrgNode({ name: 'Herbs', vpName: 'herbs' }, false)).org_name).toBeUndefined();
  });

  it('a new VP has no project of its own to show; taken, reserved and bad names are refused', async () => {
    const vp = await createOrgNode({ name: 'Growth VP' }, true);
    expect(vp).toMatchObject({ org_role: 'lead', project: 'Growth', title: 'Growth lead', org_vp_only: true });
    await expect(createOrgNode({ name: 'growth' }, true)).rejects.toMatchObject({ code: 'project_exists', status: 409 });
    await addTask({ title: 'Plant the beds', project: 'Seeds' });
    await expect(createOrgNode({ name: 'Seeds' }, false)).rejects.toMatchObject({ code: 'project_exists' });
    // Another VP already goes by that name: two cards with one name read as one VP.
    await expect(createOrgNode({ name: 'Fern', vpName: 'Growth' }, false)).rejects.toMatchObject({ code: 'name_taken', status: 409 });
    await expect(createOrgNode({ name: '  ' }, true)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(createOrgNode({ name: 'Inbox' }, true)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(createOrgNode({ name: 'Ask Mentor' }, false)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(createOrgNode({ name: 'a/b' }, false)).rejects.toMatchObject({ code: 'bad_name', status: 400 });
    await expect(createOrgNode({ name: 'x'.repeat(61) }, true)).rejects.toMatchObject({ code: 'bad_name' });
    // A project named like a role word keeps its whole name.
    expect((await createOrgNode({ name: 'Supply lead' }, false)).project).toBe('Supply lead');
  });

  it('a deleted project comes back only on the user\'s own ask', async () => {
    await addTask({ title: 'Fix the gate', project: 'Fence' });
    await deleteProject('Fence');
    await expect(createOrgNode({ name: 'Fence' }, false)).rejects.toMatchObject({ code: 'project_unavailable', status: 409 });
    expect((await listTasks()).some((t) => t.org_role === 'lead' && t.project === 'Fence')).toBe(false);
    const lead = await createOrgNode({ name: 'Fence' }, false, { human: true });
    expect(lead).toMatchObject({ project: 'Fence', org_role: 'lead' });
  });

  it('a project\'s closed lead comes back with a clean slate', async () => {
    const first = await createOrgNode({ name: 'Pear VP', instructions: 'Old words.' }, true);
    await editOrgNode(first.id, { name: 'Fruit' });
    await updateTask(first.id, { phase: 'COMPLETE' }, { source: 'api' });
    const again = await createOrgNode({ name: 'Pear' }, false);
    expect(again.id).toBe(first.id);
    expect(again.phase).toBe('TODO');
    expect(again.org_vp_only).toBeUndefined();
    expect(again.org_name).toBeUndefined();
    // Cleared, not dropped: its old session's prompt still holds the old words.
    expect(again.org_instructions?.text).toBe('');
    expect(defaultInstructions(again)).toContain('Your user cleared their own instructions for your role');
  });

  it('a project whose own lead is open is refused, even with no work left', async () => {
    const lead = await createOrgNode({ name: 'Plum', vpName: 'Stone fruit', instructions: 'Keep these.' }, false);
    await expect(createOrgNode({ name: 'Plum' }, false)).rejects.toMatchObject({ code: 'project_exists' });
    expect((await getTask(lead.id)).org_instructions?.text).toBe('Keep these.');
    // A one-team project's name is taken too: two cards would read as one VP.
    await addTask({ title: 'Mow the lawn', project: 'Lawn' });
    await expect(editOrgNode(lead.id, { name: 'Lawn' })).rejects.toMatchObject({ code: 'name_taken' });
  });
});

describe('a lead made here reaches every open page', () => {
  type Seen = { id: string; org_role?: string; org_vp_only?: boolean; org_name?: string; org_leads?: string[] };
  /** What the browser hears: task:created and task:updated, in order. */
  function listen(): { created: Seen[]; last: (id: string) => Seen | undefined; stop: () => void } {
    const created: Seen[] = [];
    const all: Seen[] = [];
    bus.subscribe('web-ui', (event) => {
      const task = (event.data as { task?: Seen }).task;
      if (!task) return;
      if (event.name === EventNames.TASK_CREATED) created.push(task);
      if (event.name === EventNames.TASK_CREATED || event.name === EventNames.TASK_UPDATED) all.push(task);
    });
    return { created, last: (id) => all.filter((t) => t.id === id).at(-1), stop: () => bus.unsubscribe('web-ui') };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('a new project\'s lead, a new VP and a project\'s first VP are announced as created', async () => {
    // Subscribed where the browser listens: addTask announces nothing, so a page never saw a lead
    // with nothing else to write (2026-10-27: "+ New project" made no card until a reload).
    const heard = listen();
    try {
      const plain = await createOrgNode({ name: 'Meadow' }, false);
      const vp = await createOrgNode({ name: 'Harvest' }, true);
      await addTask({ title: 'Stack the hay', project: 'Barn' });
      const first = await editProjectVp('Barn', { name: 'Hay' });
      await settle();
      expect(heard.created.find((t) => t.id === plain.id)).toMatchObject({ org_role: 'lead' });
      expect(heard.created.find((t) => t.id === vp.id)).toMatchObject({ org_role: 'lead', org_vp_only: true });
      expect(heard.created.find((t) => t.id === first.id)).toMatchObject({ org_role: 'lead' });
      expect(heard.last(first.id)).toMatchObject({ org_name: 'Hay' });
      // An edit of a lead that exists is an update, not a second create.
      await editProjectVp('Barn', { instructions: 'Dry first.' });
      await settle();
      expect(heard.created.filter((t) => t.id === first.id)).toHaveLength(1);
    } finally {
      heard.stop();
    }
  });

  it('a closed VP letting go of a project, and a closed lead coming back, are heard too', async () => {
    // A closed VP still listing the project would keep its card from showing (pickLead picks it).
    const old = await createOrgNode({ name: 'Silo', vpName: 'Granary' }, false);
    await updateTaskRaw(old.id, { org_leads: ['Grain'] });
    await updateTask(old.id, { phase: 'COMPLETE' }, { source: 'api' });
    const heard = listen();
    try {
      await createOrgNode({ name: 'Grain' }, false);
      await settle();
      expect(heard.last(old.id)?.org_leads ?? []).not.toContain('Grain');
      // Brought back for an edit that writes nothing (its project's own name), it starts clean,
      // and the page hears the clean slate, not the old name.
      const back = await editProjectVp('Silo', { name: 'Silo' });
      await settle();
      expect(back).toMatchObject({ id: old.id, phase: 'TODO' });
      expect(back.org_name).toBeUndefined();
      expect(heard.last(old.id)).toMatchObject({ id: old.id });
      expect(heard.last(old.id)?.org_name).toBeUndefined();
    } finally {
      heard.stop();
    }
  });

  it('a refused edit of a project\'s VP leaves the closed VP it was under closed', async () => {
    const loft = await createOrgNode({ name: 'Loft' }, false);
    await addTask({ title: 'Sweep the attic', project: 'Attic' });
    await updateTaskRaw(loft.id, { org_leads: ['Attic'] });
    await updateTask(loft.id, { phase: 'COMPLETE' }, { source: 'api' });
    await expect(editProjectVp('Attic', { name: 'Attic' })).rejects.toMatchObject({ code: 'name_taken' });
    expect((await getTask(loft.id)).phase).toBe('COMPLETE');
  });
});

describe('the user\'s own instructions for the CEO or a VP', () => {
  it('ride the prompt after the role line, and a session spawned before an edit is told the whole set', async () => {
    const lead = await createOrgNode({ name: 'Orchard' }, false);
    const sid = await sessionOf(lead.id, 'Orchard');
    expect(await instructionNoticeForSession(sid)).toBeNull();

    await editOrgNode(lead.id, { name: 'Moss Keeper', instructions: 'Water before nine.\nAsk me before you buy seeds.' });
    const now = await getTask(lead.id);
    expect(now).toMatchObject({ title: 'Orchard lead', org_name: 'Moss Keeper' });
    const prompt = defaultInstructions(now);
    const version = /instructions for your role \((v[0-9a-f]{8}),/.exec(prompt)?.[1];
    expect(version).toBeTruthy();
    expect(prompt).toContain(`[${version}] Water before nine.\n[${version}] Ask me before you buy seeds.`);
    expect(prompt.indexOf('Your task is the lead of')).toBeLessThan(prompt.indexOf('Water before nine.'));
    const notice = (await instructionNoticeForSession(sid))?.text ?? '';
    expect(notice).toContain(`[${version}] Water before nine.`);
    expect(notice).toContain(`[${version}] Ask me before you buy seeds.`);

    // The session respawned on that set (one session per task), then an edit that keeps one line:
    // it hears the whole new set, so the line it kept is not read as dropped.
    const told = sid;
    await updateSessionRecord(told, { appliedAppendSystemPrompt: (await buildSessionContext(lead.id)).systemPrompt, taskRoutingNoted: undefined });
    expect(await instructionNoticeForSession(told)).toBeNull();
    // The VP's own name rides its prompt: it is how the user and the chart call it.
    expect(defaultInstructions(now)).toContain('The user calls you the "Moss Keeper" VP.');
    await new Promise((r) => setTimeout(r, 5));
    const edited = await editOrgNode(lead.id, { instructions: 'Water before nine.\nShip on Fridays only.' });
    const next = /instructions for your role \((v[0-9a-f]{8}),/.exec(defaultInstructions(edited))?.[1];
    expect(next).not.toBe(version);
    const retold = (await instructionNoticeForSession(told))?.text ?? '';
    expect(retold).toContain(`[${next}] Water before nine.`);
    expect(retold).toContain(`[${next}] Ship on Fridays only.`);
    expect(retold).toContain('They replace every earlier version');

    // The same words again write nothing; a cleared set says so, and null clears too: a stored
    // prompt may still hold the old words, and only a newer version tells it to drop them.
    expect((await editOrgNode(lead.id, { instructions: 'Water before nine.\nShip on Fridays only.' })).org_instructions?.at).toBe(edited.org_instructions?.at);
    await new Promise((r) => setTimeout(r, 5));
    const cleared = await editOrgNode(lead.id, { instructions: '' });
    expect(defaultInstructions(cleared)).toContain('Your user cleared their own instructions for your role');
    expect(defaultInstructions(cleared)).not.toContain('Water before nine.');
    expect((await instructionNoticeForSession(told))?.text ?? '').toContain('Your user cleared their own instructions for your role');
    await editOrgNode(lead.id, { instructions: 'Back again.' });
    await new Promise((r) => setTimeout(r, 5));
    const removed = await editOrgNode(lead.id, { instructions: null });
    expect(removed.org_instructions?.text).toBe('');
    expect(defaultInstructions(removed)).toContain('Your user cleared their own instructions for your role');
  });

  it('a VP\'s name: its project\'s name gives the name back, a taken one is refused', async () => {
    const a = await createOrgNode({ name: 'Lake' }, false);
    const b = await createOrgNode({ name: 'River', vpName: 'Water' }, false);
    await expect(editOrgNode(a.id, { name: 'water VP' })).rejects.toMatchObject({ code: 'name_taken', status: 409 });
    await expect(editOrgNode(a.id, { name: 'River' })).rejects.toMatchObject({ code: 'name_taken' });
    expect((await editOrgNode(b.id, { name: 'River' })).org_name).toBeUndefined();
    expect((await editOrgNode(a.id, { name: 'Water' })).org_name).toBe('Water');
    expect((await editOrgNode(a.id, { name: '' })).org_name).toBeUndefined();
  });

  it('a project\'s VP: refused edits leave no lead behind, a closed lead comes back clean, the Inbox has none', async () => {
    await addTask({ title: 'Paint the fence', project: 'Yard' });
    await createOrgNode({ name: 'Porch', vpName: 'Taken' }, false);
    await expect(editProjectVp('Yard', { name: 'Taken' })).rejects.toMatchObject({ code: 'name_taken' });
    expect((await listTasks()).some((t) => t.org_role === 'lead' && t.project === 'Yard')).toBe(false);
    const made = await editProjectVp('Yard', { name: 'Gardener', instructions: 'Weekly.' });
    expect(made).toMatchObject({ org_role: 'lead', project: 'Yard', org_name: 'Gardener', org_instructions: { text: 'Weekly.' } });
    await updateTask(made.id, { phase: 'COMPLETE' }, { source: 'api' });
    const back = await editProjectVp('Yard', { instructions: 'Daily.' });
    expect(back.id).toBe(made.id);
    expect(back.org_name).toBeUndefined();
    expect(back.org_instructions?.text).toBe('Daily.');
    await expect(editProjectVp('Inbox', { name: 'x' })).rejects.toMatchObject({ code: 'no_lead_for_inbox', status: 400 });
    await expect(editProjectVp('Nowhere', { name: 'x' })).rejects.toMatchObject({ code: 'unknown_project', status: 404 });
  });

  it('an agent reaches a VP by the name the user gave it', async () => {
    const lead = await createOrgNode({ name: 'Greenhouse', vpName: 'Glass' }, false);
    expect((await resolveOrgContact('Glass VP')).task.id).toBe(lead.id);
    expect((await resolveOrgContact('glass')).task.id).toBe(lead.id);
    expect((await resolveOrgContact('Greenhouse')).task.id).toBe(lead.id);
  });

  it('the CEO takes instructions but keeps its name; a worker has none in its prompt', async () => {
    const { task: main } = await addTask({ title: 'Main', project: 'Ask Walnut', org_role: 'main', walnut_agent: true });
    const set = await editOrgNode(main.id, { instructions: 'Keep the weekly plan short.' });
    expect(defaultInstructions(set)).toContain('Keep the weekly plan short.');
    await expect(editOrgNode(main.id, { name: 'Boss' })).rejects.toMatchObject({ code: 'bad_name' });
    const { task: worker } = await addTask({ title: 'Plant the beds', project: 'Seeds' });
    await expect(editOrgNode(worker.id, { instructions: 'x' })).rejects.toMatchObject({ code: 'not_org_node', status: 404 });
    expect(defaultInstructions({ ...worker, org_instructions: { text: 'Never shown', at: new Date().toISOString() } })).not.toContain('Never shown');
    await expect(editOrgNode(main.id, { instructions: 'y'.repeat(4001) })).rejects.toMatchObject({ code: 'bad_instructions' });
  });
});
