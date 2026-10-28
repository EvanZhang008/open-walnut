import { z } from 'zod';
import { defineOp } from './registry.js';
import { startTask } from './task-execution.js';
import { REPLY_ARRIVES_HINT, withOutcome } from './outcome.js';
import { MESSAGE_TEXT_HINT } from '../core/team-charter.js';

defineOp({
  name: 'org_get',
  title: 'Read the org',
  description:
    'The org above the work, one level at a time. For the main agent (or with no task): one row per project, '
    + 'with its counts (open, running, needs_you = waiting on the user, waiting = parked), the few tasks waiting on '
    + 'the user, and its `contact`: the project\'s lead, or its one team, the one to talk to with org_send. '
    + 'For a project lead: its teams (the project\'s open top-level tasks). For any other task: its workers. '
    + 'Pass `of` to read another node. Read this before reading tasks one by one.',
  input: {
    of: z.string().min(1).optional().describe('Task id whose reports to list; default: your own task'),
  },
  handler: async ({ of }, call) => {
    const body = await call('GET', `/org/reports${of ? `?of=${encodeURIComponent(String(of))}` : ''}`) as {
      of?: string; rows?: unknown[];
    };
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    return withOutcome(
      { ...body, rows },
      rows.length ? `${rows.length} report${rows.length === 1 ? '' : 's'}.` : 'Nothing open reports here.',
      'For detail on a project, org_send to it; read one task with task_get.',
    );
  },
  routes: [{ method: 'GET', path: '/org/reports' }],
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'org_send',
  title: 'Talk to a project or a team',
  description:
    'Message the one who answers for a project (its lead, or its only team) or any task by id, the way the main '
    + 'agent talks to its org. A project with two or more teams gets a lead the first time (Walnut makes it, hidden '
    + 'from the board); a contact with no session yet is started with your text, one with a session gets it as a '
    + 'message. Use it for status, coordination or a short evidence handoff, not to send an independent goal into '
    + 'the old team\'s conversation: task_create gives that goal a fresh task and session. A contact\'s project or '
    + 'area does not prove it owns the same deliverable. Asks for a reply by default.',
  input: {
    to: z.string().min(1).describe('A project name ("Inbox" for the Inbox), the name the user gave a VP, or a task id'),
    title: z.string().min(1).max(200).optional().describe('One-line TL;DR the reader sees first'),
    text: z.string().min(1).describe(`What you ask or hand over. ${MESSAGE_TEXT_HINT}`),
    expect_reply: z.boolean().optional().describe('Ask for a reply (default true); false = fire and forget'),
  },
  handler: async ({ to, title, text, expect_reply }, call) => {
    const contact = await call('POST', '/org/contact', { to }) as {
      task?: { id?: string; title?: string }; kind?: string; started?: boolean; project?: string;
      handedOverBy?: { id: string; title: string };
    };
    const id = contact?.task?.id;
    if (!id) throw new Error(`No contact for "${String(to)}". Read org_get for the projects.`);
    // A lead that handed its project over: the message goes to the lead that took it, and the caller is told.
    const who = `${contact.task?.title ?? id} (${id}, ${contact.kind ?? 'task'})`
      + (contact.handedOverBy ? `, which took ${contact.project ?? 'the project'} over from "${contact.handedOverBy.title}" (${contact.handedOverBy.id})` : '');
    if (!contact.started) {
      const started = await startTask(id, {
        message: title ? `${String(title)}\n\n${String(text)}` : String(text),
        ...(expect_reply !== undefined ? { expect_reply } : {}),
      }, call);
      return withOutcome({ ...started, contact }, `Started ${who} with your message.`, REPLY_ARRIVES_HINT);
    }
    const sent = await call('POST', '/messages', {
      to: id, text, ...(title ? { title } : {}), ...(expect_reply !== undefined ? { expect_reply } : {}),
    }) as Record<string, unknown>;
    return withOutcome({ ...(sent ?? {}), contact }, `Message queued for ${who}. Do NOT resend.`, REPLY_ARRIVES_HINT);
  },
  routes: [
    { method: 'POST', path: '/org/contact' },
    { method: 'POST', path: '/messages' },
    { method: 'POST', path: '/tasks/:id/start' },
  ],
  timeoutMs: 40_000,
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'org_vp_set',
  title: 'Put a project under another VP',
  description:
    'One VP (a project lead) may lead several projects: the user does this by dragging a project onto another '
    + 'in the org chart. `vp` names the project whose lead takes this project over; "" gives the project back its '
    + 'own lead. No task changes project. On a take-over, the project\'s own lead is closed and its open workers '
    + 'report to the new lead; giving it back reopens that lead and returns the workers in its project. It changes '
    + 'who answers for the project, so do it only when the user asked for it or agreed to it.',
  input: {
    project: z.string().min(1).describe('The project to move'),
    vp: z.string().describe('The project whose lead leads it from now on; "" = its own lead again'),
  },
  handler: async ({ project, vp }, call) => {
    const body = await call('POST', '/org/vp', { project, vp }) as {
      project?: string; vp?: string; lead?: { title?: string }; moved?: string[]; unchanged?: boolean;
    };
    const name = body?.project ?? String(project);
    const outcome = body?.unchanged
      ? `Nothing changed: ${name} was already so.`
      : body?.vp
        ? `${name} is now led by ${body.lead?.title ?? `${body.vp}'s lead`}; ${body.moved?.length ?? 0} worker(s) moved to it.`
        : `${name} has its own lead again; ${body?.moved?.length ?? 0} worker(s) went back to it.`;
    return withOutcome(body ?? {}, outcome, 'org_get shows the projects and who leads them.');
  },
  routes: [{ method: 'POST', path: '/org/vp' }],
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

// The org chart's "+ New VP", "+ New project" and a node's "Name and instructions", for agents as for
// the user (2026-10-27, the user: "all human action can be done by agent also"). The write records
// who made it; the Org page shows it, and the user may change it back.
defineOp({
  name: 'org_node_create',
  title: 'Make a VP or a project on the org chart',
  description:
    'Makes a new project with its own VP (kind "project"), or a VP with no project of its own yet (kind "vp"), '
    + 'which projects are then put under with org_vp_set. `instructions` are the VP\'s standing instructions: its '
    + 'session prompt carries Walnut\'s default for a VP and then them (write only what to add), and the Org page shows '
    + 'that you wrote them. A name another VP or project uses is refused. A closed VP of that project comes back with a '
    + 'clean slate; when the user wrote its instructions, pass `override_user: true` (else 409 user_wrote), only when the '
    + 'user asked for it.',
  input: {
    kind: z.enum(['project', 'vp']).describe('"project": a project with its own VP; "vp": a VP to put projects under'),
    name: z.string().min(1).describe('The project\'s name, or the VP\'s'),
    vp_name: z.string().optional().describe('kind "project" only: its VP\'s name, when not the project\'s'),
    instructions: z.string().optional().describe('The VP\'s standing instructions (at most 4000 characters, Walnut\'s default included for an agent\'s own lines)'),
    override_user: z.boolean().optional().describe('The user asked for this: bring back a closed VP whose instructions the user wrote, and your words count as the user\'s (they replace Walnut\'s default)'),
  },
  handler: async ({ kind, name, vp_name, instructions, override_user }, call) => {
    const body = await call('POST', kind === 'vp' ? '/org/vps' : '/org/projects', {
      name, ...(vp_name ? { vpName: vp_name } : {}), ...(instructions !== undefined ? { instructions } : {}),
      ...(override_user ? { override_user: true } : {}),
    }) as { task?: { id?: string; title?: string; project?: string } };
    const lead = body?.task;
    return withOutcome(body ?? {}, `Made ${lead?.title ?? name} (${lead?.id ?? 'no id'}).`, 'org_get shows it; org_node_edit names or instructs it.');
  },
  routes: [{ method: 'POST', path: '/org/vps' }, { method: 'POST', path: '/org/projects' }],
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'org_node_edit',
  title: 'Name or instruct the CEO or a VP',
  description:
    'Renames a VP or writes the standing instructions of the CEO or a VP, as the user does on the org chart. '
    + 'Name the node by `task_id` (the CEO\'s or a VP\'s task), or by `project` for that project\'s VP (made first '
    + 'when the project has none). `instructions` replace the earlier ones whole; "" clears them. Walnut\'s default '
    + 'for the role always comes first and your words are added after it, below it: write only what to add. The node\'s '
    + 'session reads them with its next message, and the Org page shows who wrote them and when. With '
    + '`override_user: true`, passed only when the user asked for the change, your words count as the user\'s: they '
    + 'replace Walnut\'s default, and they may replace or clear words the user wrote (else 409 user_wrote).',
  input: {
    task_id: z.string().optional().describe('The CEO\'s or a VP\'s task id'),
    project: z.string().optional().describe('Or: the project whose VP this is'),
    name: z.string().optional().describe('A VP\'s new name; its project\'s name or "" gives it back'),
    instructions: z.string().optional().describe('The new standing instructions, whole; "" clears them (at most 4000 characters, Walnut\'s default included for an agent\'s own lines)'),
    override_user: z.boolean().optional().describe('The user asked for this change: your words count as the user\'s (they replace Walnut\'s default), and may replace or clear words the user wrote'),
  },
  handler: async ({ task_id, project, name, instructions, override_user }, call) => {
    if (!task_id === !project) throw new Error('Name the node by task_id or by project, one of them.');
    const edit = {
      ...(name !== undefined ? { name } : {}), ...(instructions !== undefined ? { instructions } : {}),
      ...(override_user ? { override_user: true } : {}),
    };
    const path = task_id ? `/org/nodes/${encodeURIComponent(String(task_id))}` : `/org/projects/${encodeURIComponent(String(project))}/vp`;
    const body = await call('PUT', path, edit) as { task?: { id?: string; title?: string; org_name?: string } };
    const who = body?.task?.org_name ? `the ${body.task.org_name} VP` : body?.task?.title ?? 'the node';
    return withOutcome(body ?? {}, `Saved for ${who}.`, 'Its session reads new instructions with its next message.');
  },
  routes: [{ method: 'PUT', path: '/org/nodes/:id' }, { method: 'PUT', path: '/org/projects/:project/vp' }],
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
