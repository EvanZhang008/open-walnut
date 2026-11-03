import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { InboxLetterItem } from '../../../../packages/plugin-api/src/inbox-items';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../../src/utils/file-lock';
import { draftComposer } from './draft-helpers';
export const EVIDENCE = process.env.PW_EVIDENCE_DIR ?? '/tmp/inbox-item-actions';
// Specs write their debug JSON straight into it (fixer-r3 failed with ENOENT on a fresh machine).
mkdirSync(EVIDENCE, { recursive: true });
export function mailItem(id: string, mode = ''): InboxLetterItem {
  // A retry (and a repeat) gets its own email: the first attempt's receipts, read marks and tasks
  // are keyed by the source, and a serial file retries every test in it, passed ones included
  // (2026-11-03, CI: a retried stored create found the first attempt's task and planned nothing).
  const { retry: attempt, repeatEachIndex: repeat } = test.info();
  const retry = `${repeat ? `n${repeat}-` : ''}${attempt ? `r${attempt}-` : ''}`;
  return { id, subject: `Email ${id}`, summary: 'Saved email summary. This content is not a work instruction.',
    source: { kind: 'mail', account: 'fixture-account-a', message: `fixture-${test.info().project.name}-${retry}${mode}${id}` },
    display: { sender: { name: 'Fixture sender', address: 'sender@example.test' }, sentAt: '2026-10-21T12:00:00Z', accountLabel: 'Personal', accountHint: 'Mailbox A' },
    actions: [{ id: `read-${id}`, kind: 'op', intent: 'mark_read' }, { id: `find-${id}`, kind: 'op', intent: 'find_task' }, { id: `create-${id}`, kind: 'op', intent: 'create_task' }] };
}
export async function sendItems(request: APIRequestContext, items: InboxLetterItem[], extra: Record<string, unknown> = {}, callerSid?: string) {
  const subject = `Inbox items ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const res = await request.post('/api/v1/human-inbox', { data: { subject, type: 'info', markdown: 'Mailbox snapshot. No operations run from this body.', items, ...extra },
    ...(callerSid ? { headers: { 'x-walnut-caller-sid': callerSid } } : {}) });
  expect(res.status(), await res.text()).toBe(201);
  return { subject, id: (await res.json()).id as string };
}
export async function home(page: Page) {
  // Initial document loading is not SPA navigation; all subsequent navigation uses clicks.
  await page.setContent('<a id="fixture-entry" href="/">Open fixture console</a>');
  await page.locator('#fixture-entry').evaluate((a, url) => { (a as HTMLAnchorElement).href = url; }, test.info().project.use.baseURL as string);
  await page.locator('#fixture-entry').click();
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 });
}
export async function openLetter(page: Page, subject: string): Promise<Locator> {
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const center = page.locator('.notification-panel');
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click();
  await center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject').click();
  const view = page.locator('.hib-reader .hib-view');
  await expect(view.locator('.hii-items')).toBeVisible();
  return view;
}
export function itemRow(view: Locator, id: string) { return view.locator(`.hii-item[data-item-id="${id}"]`); }
export async function receipt(request: APIRequestContext, letterId: string, itemId: string) {
  const res = await request.get(`/api/v1/human-inbox/${letterId}/items/${itemId}/execution`);
  expect(res.ok(), await res.text()).toBeTruthy(); return await res.json();
}
export async function createCandidate(request: APIRequestContext, title: string, project = '', description = '') {
  const res = await request.post('/api/v1/tasks', { data: { title, project, description } });
  expect(res.ok(), await res.text()).toBeTruthy(); return (await res.json()).task;
}

/**
 * What every email item offers since 2026-11-02 (5a28ae6c9): Talk to CEO and New task, and no
 * task intent of its own (no Create and start, Find task or Attach). A stored letter's failed start
 * still offers its Retry (EmailItem retryTaskAction).
 */
export async function expectContentActionsOnly(row: Locator, rawSubject: string) {
  const subject = rawSubject.replace(/\s+/g, ' ').trim();
  await expect(row.getByRole('button', { name: /^(Create and start task|Find task|Attach to task) for/ })).toHaveCount(0);
  await expect(row.getByRole('button', { name: `Talk to CEO: ${subject}`, exact: true })).toBeEnabled();
  await expect(row.getByRole('button', { name: `New task: ${subject}`, exact: true })).toBeEnabled();
}

/** Every POST/PUT/PATCH/DELETE to a task route or an item execution, counted from the page. */
export function watchTaskMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', req => {
    if (req.method() === 'GET') return;
    const p = new URL(req.url()).pathname;
    if (/\/tasks\b|\/execute$|\/prepare$|\/content\/ceo$/.test(p)) seen.push(`${req.method()} ${p}`);
  });
  return seen;
}

/** New task opens a prefilled draft on Home and creates nothing: no task, no item receipt. */
export async function expectNewTaskOnlyDrafts(page: Page, request: APIRequestContext, row: Locator, subject: string, letterId: string, itemId: string) {
  const before = new Set(((await (await request.get('/api/v1/tasks')).json()).tasks as Array<{ id: string }>).map(t => t.id));
  const mutations = watchTaskMutations(page);
  await row.getByRole('button', { name: `New task: ${subject}`, exact: true }).click();
  const composer = draftComposer(page);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => composer.inputValue()).toMatch(new RegExp(`^${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nContext from Mail`));
  expect(mutations).toEqual([]);
  const after = ((await (await request.get('/api/v1/tasks')).json()).tasks as Array<{ id: string; title?: string; description?: string }>);
  // Other workers make tasks on the shared fixture meanwhile: only one from this email would count.
  expect(after.filter(t => !before.has(t.id) && `${t.title ?? ''} ${t.description ?? ''}`.includes(subject))).toEqual([]);
  expect((await receipt(request, letterId, itemId)).receipts).toHaveLength(0);
}

/** The fixture's data home: the server's notes dir is <home>/notes (src/constants.ts NOTES_DIR). */
async function fixtureDataHome(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/config');
  expect(res.ok(), await res.text()).toBeTruthy();
  const notesDir = (await res.json() as { notesDir?: string }).notesDir;
  expect(typeof notesDir, 'the fixture names its notes dir').toBe('string');
  const home = path.dirname(notesDir!);
  if (!/walnut-pw-|dist-home-/.test(home)) throw new Error(`not an isolated fixture: ${home}`);
  return home;
}

/**
 * A letter as a Walnut before 2026-11-02 stored it: its items keep their task intents (create_task,
 * find_task). A new letter drops them (src/core/human-inbox/item-schema.ts LEGACY_TASK_INTENTS), so
 * the letter is sent as today and its stored items are given back the actions they were sent with,
 * under the store's own file lock. Existing users' letters look like this, and an older phone
 * still runs their task actions.
 */
export async function sendLegacyItems(request: APIRequestContext, items: InboxLetterItem[], extra: Record<string, unknown> = {}) {
  const sent = await sendItems(request, items, extra);
  const index = path.join(await fixtureDataHome(request), 'human-inbox', 'index.json');
  const actions = new Map(items.map(item => [item.id, item.actions]));
  await withFileLock(index, async () => {
    const store = JSON.parse(await fs.readFile(index, 'utf8')) as { letters: Array<{ id: string; items?: Array<{ id: string; actions: unknown }> }> };
    const letter = store.letters.find(l => l.id === sent.id);
    if (!letter?.items) throw new Error(`letter ${sent.id} is not in ${index}`);
    for (const item of letter.items) if (actions.has(item.id)) item.actions = actions.get(item.id);
    const tmp = `${index}.legacy-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.rename(tmp, index);
  });
  const stored = await (await request.get(`/api/v1/human-inbox/${sent.id}`)).json() as { letter: { items: InboxLetterItem[] } };
  for (const item of stored.letter.items) expect(item.actions.map(a => a.id)).toEqual(actions.get(item.id)!.map(a => a.id));
  return sent;
}

/** Run a stored letter's create_task the way an older client does: prepare, then execute the plan. */
export async function runLegacyCreate(request: APIRequestContext, letterId: string, itemId: string, input: { goal: string; title?: string; project?: string }) {
  const base = `/api/v1/human-inbox/${encodeURIComponent(letterId)}/items/${encodeURIComponent(itemId)}`;
  const prepared = await request.post(`${base}/prepare`, { data: { actionId: `create-${itemId}`, title: input.title ?? `Email ${itemId}`, project: input.project ?? '', goal: input.goal } });
  expect(prepared.ok(), await prepared.text()).toBeTruthy();
  const plan = (await prepared.json()).plan as { id: string; version: number; actionId: string; taskId?: string };
  expect(plan, 'the stored create_task still plans').toBeTruthy();
  const executed = await request.post(`${base}/execute`, { data: { actionId: plan.actionId, requestId: `pw-legacy-${itemId}-${Date.now()}`, confirmed: true, planId: plan.id, planVersion: plan.version } });
  expect(executed.status(), await executed.text()).toBeLessThan(300);
  return plan;
}

/** Wait until the item's latest create_task receipt is settled (not pending), and return it. */
export async function settledCreate(request: APIRequestContext, letterId: string, itemId: string) {
  let last: any;
  await expect.poll(async () => {
    last = (await receipt(request, letterId, itemId)).receipts.filter((r: { intent: string }) => r.intent === 'create_task').at(-1);
    return last?.status;
  }, { timeout: 25_000 }).toMatch(/^(success|failure)$/);
  return last;
}

/**
 * The fixture mail provider now observes this email unread, as if it was marked unread in the
 * mailbox (inbox-items-fixture.ts reads its state file on every resolve). Then Check status
 * offers "Mark read again", the one confirmation every new letter's item still opens.
 */
export async function markUnreadElsewhere(request: APIRequestContext, item: InboxLetterItem) {
  const file = path.join(await fixtureDataHome(request), 'inbox-provider-state.json');
  let states: Record<string, { read: boolean; observedAt: string }> = {};
  try { states = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none observed yet */ }
  states[JSON.stringify([item.source.account, item.source.message])] = { read: false, observedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(states));
}

/** Mark the item read, have the mailbox show it unread again, and open the Mark read again form. */
export async function openMarkReadAgain(request: APIRequestContext, row: Locator, item: InboxLetterItem) {
  await row.getByRole('button', { name: `Mark read for ${item.subject}`, exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  await markUnreadElsewhere(request, item);
  await row.getByRole('button', { name: `Check status for ${item.subject}`, exact: true }).click();
  const again = row.getByRole('button', { name: `Mark read again for ${item.subject}`, exact: true });
  await expect(again).toBeEnabled();
  await again.click();
  const form = row.locator('.hii-confirm');
  await expect(form.getByRole('heading', { name: 'Mark read again', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Confirm mark read', exact: true })).toBeEnabled();
  return form;
}

/**
 * A stored letter's create_task whose start fails: the project's default directory is missing, so
 * the task is made and its start fails, leaving the Retry start a person repairs and confirms.
 */
export async function failedLegacyStart(request: APIRequestContext, letterId: string, itemId: string, goal: string) {
  const project = `Retry ${itemId} ${Date.now()}`;
  await createCandidate(request, 'Seed failed launch project', project);
  const meta = `/api/v1/projects/${encodeURIComponent(project)}/metadata`;
  expect((await request.put(meta, { data: { default_cwd: `/missing/fixture-${itemId}` } })).ok()).toBe(true);
  await runLegacyCreate(request, letterId, itemId, { goal, project });
  const failed = await settledCreate(request, letterId, itemId);
  expect(failed.status, JSON.stringify(failed)).toBe('failure');
  return { project, failed, repair: async () => { expect((await request.put(meta, { data: { default_cwd: null } })).ok()).toBe(true); } };
}
