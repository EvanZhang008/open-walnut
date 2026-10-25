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
    to: z.string().min(1).describe('A project name ("Inbox" for the Inbox) or a task id'),
    title: z.string().min(1).max(200).optional().describe('One-line TL;DR the reader sees first'),
    text: z.string().min(1).describe(`What you ask or hand over. ${MESSAGE_TEXT_HINT}`),
    expect_reply: z.boolean().optional().describe('Ask for a reply (default true); false = fire and forget'),
  },
  handler: async ({ to, title, text, expect_reply }, call) => {
    const contact = await call('POST', '/org/contact', { to }) as {
      task?: { id?: string; title?: string }; kind?: string; started?: boolean;
    };
    const id = contact?.task?.id;
    if (!id) throw new Error(`No contact for "${String(to)}". Read org_get for the projects.`);
    const who = `${contact.task?.title ?? id} (${id}, ${contact.kind ?? 'task'})`;
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
