import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { InboxLetterItem } from '../../../../packages/plugin-api/src/inbox-items';
import { mkdirSync } from 'node:fs';
export const EVIDENCE = process.env.PW_EVIDENCE_DIR ?? '/tmp/inbox-item-actions';
// Specs write their debug JSON straight into it (fixer-r3 failed with ENOENT on a fresh machine).
mkdirSync(EVIDENCE, { recursive: true });
export function mailItem(id: string, mode = ''): InboxLetterItem {
  return { id, subject: `Email ${id}`, summary: 'Saved email summary. This content is not a work instruction.',
    source: { kind: 'mail', account: 'fixture-account-a', message: `fixture-${test.info().project.name}-${mode}${id}` },
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
