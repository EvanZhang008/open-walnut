/** Team code reviews are team decisions; real outward and other approval kinds still need words. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-team-code'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { APPROVAL_KINDS } from '../../src/core/same-ask.js';
import { refuseSameAsk } from '../../src/core/same-ask-tree.js';
import { LOCAL_DRAFT_ASKS, PROTECTED_DRAFT_ASKS } from '../helpers/local-draft-asks.js';
import { setAskMe } from '../../src/core/approvals/ask-me.js';
import { SWITCH_OFF_SETTLES } from '../../src/core/approval-kinds.js';

const PROJECT = 'Orchid';
const LEAD_SID = 'ffffffff-3333-4bbb-8ccc-dddddddddddd';
const OWN = "It publishes a change request in the team's own package";
const LOG_ASK = '\u6211\u6765\u5f00\u4e2a\u5c0f\u6539\u52a8\uff0c\u628a Meadow Widget \u65e5\u5fd7\u91cc\u7684\u8c03\u8bd5\u914d\u7f6e\u53bb\u6389\uff08\u53ea\u6539\u65e5\u5fd7\uff0c\u4e0d\u6539\u5224\u65ad\u903b\u8f91\uff09\uff0c\u53ef\u4ee5\u5417\uff1f';
let base = '';
let lead = '';
let n = 0;

async function asking(ask: string, kind: string, why = OWN, more?: string): Promise<string> {
  const id = (await addTask({ title: `Code question ${++n}`, project: PROJECT, parent_task_id: lead })).task.id;
  await updateTaskRaw(id, {
    phase: 'NEED_ACTION',
    status_report: { state: 'needs', ask, ask_own: { kind, why }, ...(more ? { ask_more: more } : {}), at: new Date().toISOString() },
    user_status: { state: 'needs', source: 'session', ask },
  } as never, { source: 'test' });
  return id;
}

async function answer(id: string, words?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
    body: JSON.stringify({ to: id, title: 'Team decision', text: 'Proceed with the code review only.', answers_ask: true, expect_reply: false, ...(words ? { user_words: words } : {}) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  lead = (await ensureProjectLead(PROJECT)).id;
  await createSessionRecord(LEAD_SID, lead, PROJECT, WALNUT_HOME);
  await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never);
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('answers_ask for the team own code', () => {
  it.each([
    LOG_ASK,
    "Open a change request in the team's own package?",
    'Publish the CR in our own repository?',
    'Commit the logging fix in our own repo?',
  ])('records a team decision without user words despite an old outward label: %s', async (ask) => {
    const id = await asking(ask, 'outward');
    const r = await answer(id);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ delivery: 'recorded' });
    expect((await getTask(id)).ask_answered).toMatchObject({ by: lead, ask });
    expect((await getTask(id)).ask_answered?.userWords).toBeUndefined();
    // A repeated answer is still recorded, not a request to start a stopped task.
    const again = await answer(id);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body).toMatchObject({ delivery: 'recorded' });
  });

  it.each(LOCAL_DRAFT_ASKS)('records a local unpublished decision despite an old outward label: %s', async (ask) => {
    const id = await asking(ask, 'outward', 'The eventual publication needs user review.', 'Keep this draft local and unpublished for now.');
    const r = await answer(id);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ delivery: 'recorded' });
    expect((await getTask(id)).ask_answered).toMatchObject({ by: lead, ask });
    const again = await answer(id);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
  });

  it.each(PROTECTED_DRAFT_ASKS.filter(Boolean))('keeps a draft mention from approving an outward step: %s', async (ask) => {
    const id = await asking(ask, 'outward', 'It sends work outside the team.');
    const r = await answer(id);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('user_words');
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('protects a later publish when the same draft task asks again', async () => {
    const id = await asking('Draft a CR locally for review?', 'outward');
    expect((await answer(id)).status).toBe(202);
    const ask = 'Publish the CR now?';
    await updateTaskRaw(id, {
      status_report: { state: 'needs', ask, ask_own: { kind: 'outward', why: 'It publishes outside the team.' }, at: new Date().toISOString() },
      user_status: { state: 'needs', source: 'session', ask },
    } as never, { source: 'test' });
    expect((await answer(id)).status).toBe(409);
    expect((await getTask(id)).ask_answered?.ask).not.toBe(ask);
    expect((await answer(id, 'yes publish that prepared change request now')).status).toBe(202);
    expect((await getTask(id)).ask_answered?.ask).toBe(ask);
  });

  it('lets a changed draft report reach the user when details or options add a send', async () => {
    const ask = 'Draft an email to the customer?';
    const id = await asking(ask, 'outward');
    expect((await answer(id)).status).toBe(202);
    for (const shape of [
      { ask_more: 'Then send it to the customer.' },
      { ask_kind: 'single', ask_options: [{ id: 'draft', label: 'Keep the draft local' }, { id: 'send', label: 'Send the email' }] },
    ]) {
      const res = await fetch(`${base}/api/v1/tasks/${id}/report`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
        body: JSON.stringify({ state: 'needs', ask, user_kind: 'outward', user_kind_why: 'It sends the email outside the team.', ...shape }),
      });
      expect(res.status, JSON.stringify(await res.json())).toBe(200);
      expect((await answer(id)).status).toBe(409);
    }
    // Other ask paths carry the full context too, rather than treating one safe part as approval.
    await expect(refuseSameAsk(id, ask, 'letter', undefined, [ask], { more: 'Then send it to the customer.' })).resolves.toBeUndefined();
  });

  it('refuses a draft-only summary whose full details include a send', async () => {
    const id = await asking('Draft an email locally for review?', 'outward', 'It sends an email.', `${'Draft description. '.repeat(400)}Then send it to the customer.`);
    expect((await answer(id)).status).toBe(409);
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('refuses a draft choice with a send option and a mismatched report', async () => {
    const id = await asking('Draft an email locally for review?', 'outward');
    const task = await getTask(id);
    await updateTaskRaw(id, { status_report: { ...task.status_report!, ask_kind: 'single', ask_options: [
      { id: 'draft', label: 'Keep a local draft' }, { id: 'send', label: 'Send the email' },
    ] } }, { source: 'test' });
    expect((await answer(id)).status).toBe(409);
    await updateTaskRaw(id, { status_report: { ...task.status_report!, ask: 'Send the draft email?' } }, { source: 'test' });
    expect((await answer(id)).status).toBe(409);
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('keeps other approval kinds protected for local drafts', async () => {
    for (const kind of APPROVAL_KINDS) {
      if (kind === 'outward') continue;
      const id = await asking('Draft a CR locally for review?', kind);
      expect((await answer(id)).status, kind).toBe(409);
      expect((await getTask(id)).ask_answered).toBeUndefined();
    }
  });

  it('refuses a real outward send, leaves it unanswered, and takes the user words on retry', async () => {
    const ask = 'Open the CR in our own repo and email the customer?';
    const id = await asking(ask, 'outward');
    const refused = await answer(id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('user_words');
    expect((await getTask(id)).ask_answered).toBeUndefined();
    const ok = await answer(id, 'yes send that customer email');
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect((await getTask(id)).ask_answered).toMatchObject({ by: lead, userWords: 'yes send that customer email' });
  });

  it('checks a protected step in the full details, not only the short ask', async () => {
    const id = await asking('Open the CR?', 'outward', OWN, 'Then push the patch to public GitHub.');
    const refused = await answer(id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('user_words');
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('does not ignore a protected choice hidden under a code-only question', async () => {
    const id = await asking('Open the CR in our own repo?', 'outward');
    const task = await getTask(id);
    await updateTaskRaw(id, { status_report: { ...task.status_report!, ask_kind: 'single', ask_options: [
      { id: 'local', label: 'Code review only' }, { id: 'send', label: 'Also send the vendor email' },
    ] } }, { source: 'test' });
    const refused = await answer(id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('user_words');
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('keeps the gate when the shown ask and the current report disagree', async () => {
    const id = await asking('Open the CR in our own repo?', 'outward');
    const task = await getTask(id);
    await updateTaskRaw(id, { status_report: { ...task.status_report!, ask: 'Open the CR in our own repo and email the vendor?' } }, { source: 'test' });
    const refused = await answer(id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('user_words');
    expect((await getTask(id)).ask_answered).toBeUndefined();
  });

  it('keeps every other approval kind protected even when the wording names owned code work', async () => {
    for (const kind of APPROVAL_KINDS) {
      if (kind === 'outward') continue;
      const id = await asking(`Open the ${kind} CR in our own repo?`, kind);
      const refused = await answer(id);
      expect(refused.status, `${kind}: ${JSON.stringify(refused.body)}`).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('user_words');
      expect((await getTask(id)).ask_answered).toBeUndefined();
    }
  });
});

// 2026-11-12, two VPs: with approvals off the prompt told leads an outward step is
// no longer the user's decision, yet answers_ask refused each outward ask with user_words (a reply
// reply mail, a post) and it stayed on his Needs you.
describe('answers_ask with approvals off', () => {
  beforeAll(async () => { await setAskMe(false, { unsigned: 'test' }); });
  afterAll(async () => { await setAskMe(true, { person: true }); });

  it.each([
    'Send the follow-up mail to the vendor?',
    'Post the release notes to the public channel?',
  ])('a lead settles an outward ask without the user\'s words: %s', async (ask) => {
    const id = await asking(ask, 'outward', 'It sends a message outside the team.');
    const r = await answer(id);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await getTask(id)).ask_answered).toMatchObject({ by: lead, ask });
    expect((await getTask(id)).ask_answered?.userWords).toBeUndefined();
  });

  it('every kind the switch does not settle still needs the user\'s words', async () => {
    for (const kind of APPROVAL_KINDS) {
      if (SWITCH_OFF_SETTLES.has(kind)) continue;
      const id = await asking(`Pay the ${kind} invoice?`, kind, 'It spends or changes access.');
      const refused = await answer(id);
      expect(refused.status, `${kind}: ${JSON.stringify(refused.body)}`).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('user_words');
      expect((await getTask(id)).ask_answered).toBeUndefined();
    }
  });
});
