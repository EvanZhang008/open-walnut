import { test, expect } from '@playwright/test';
import { MailDigest } from '../../../src/integrations/mail/digest';
import type { MailStore } from '../../../src/integrations/mail/store';
import type { MailEvents } from '../../../src/integrations/mail/events';
import type { MailAccountDto } from '../../../src/integrations/mail/contract';
import { EVIDENCE, home, itemRow, receipt } from './inbox-items-helpers';

test('a generated digest exposes thirty exact sources and executes only the clicked email', async ({ page, request }, info) => {
  const now = Date.now();
  const account = { accountId: 'fixture-digest-account', displayName: 'Digest mailbox', address: 'reader@example.test' } as MailAccountDto;
  const rows = Array.from({ length: 30 }, (_, n) => ({ account_id: account.accountId,
    message_id: `fixture-digest-${info.project.name}-${now}-${n}`, subject: `Digest source ${n}`,
    from_addr: `sender-${n}@example.test`, sent_at: now - n * 60_000, updated_at: now,
    flags_json: '[]', payload: JSON.stringify({ summary: `Stored summary ${n}. ` + 'Reference data only. '.repeat(12) }) }));
  let sent: { id: string; subject: string; items: any[] } | undefined;
  const digest = new MailDigest({
    store: { unreadByAccount: async () => new Map([[account.accountId, { inbox: 30 }]]),
      tasks: { unreadInboxMessages: async (id: string, limit: number) => {
        expect(id).toBe(account.accountId); return rows.slice(0, limit);
      } } } as unknown as MailStore,
    events: { digestSent() {} } as unknown as MailEvents,
    accounts: async () => [account], config: { get: async () => ({ digest_max_items: 30 }) as any },
    log: { debug() {}, info() {}, warn() {} }, now: () => now,
    letters: { send: async input => {
      const response = await request.post('/api/v1/human-inbox', { data: { ...input, type: 'review' } });
      expect(response.status(), await response.text()).toBe(201);
      sent = { id: (await response.json()).id, subject: input.subject, items: input.items! };
      return { letterId: sent.id };
    } },
  });
  expect((await digest.sendNow()).unread).toBe(30);
  expect(sent!.items).toHaveLength(30);
  await page.setViewportSize({ width: 1280, height: 800 });
  await home(page);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const center = page.locator('.notification-panel');
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click();
  const envelope = center.locator('.hib-row.hib-unread').filter({ hasText: sent!.subject });
  await expect(envelope).toHaveCount(1);
  await envelope.locator('.hib-subject').click();
  const view = page.locator('.hib-reader .hib-view');
  await expect(view.locator('.hii-items')).toBeVisible();
  await expect(view.locator('.hii-item')).toHaveCount(30);
  const first = itemRow(view, sent!.items[0].id);
  await expect(first).toContainText('Stored summary 0');
  await expect(first).toContainText(account.address);
  await first.getByRole('button', { name: /^Mark read for/ }).click();
  await expect(first.locator('.hii-receipts')).toContainText('Marked read', { timeout: 15_000 });
  const result = await receipt(request, sent!.id, sent!.items[0].id);
  expect(result.receipts[0]).toMatchObject({ status: 'success', intent: 'mark_read',
    source: { kind: 'mail', account: account.accountId, message: rows[0].message_id } });
  const next = itemRow(view, sent!.items[1].id);
  await expect(next.getByRole('button', { name: /^Mark read for/ })).toBeEnabled();
  expect((await receipt(request, sent!.id, sent!.items[1].id)).receipts).toEqual([]);
  await page.screenshot({ path: `${EVIDENCE}/generated-digest-${info.project.name}.png`, scale: 'css' });
});
