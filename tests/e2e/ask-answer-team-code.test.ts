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
