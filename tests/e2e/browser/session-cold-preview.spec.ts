import { test, expect } from '@playwright/test';

test('first open shows the latest preview while the ten-turn refresh is still held', async ({ page, baseURL }) => {
  // Keep panel boot backed by the fixture's persisted session, not an unknown id.
  const sid = 'pw-normal-session';
  const rows = [{ role: 'assistant', text: 'Newest preview answer', timestamp: '2026-01-01T00:00:01Z', msgId: 'last' }];
  const held: Array<() => Promise<void>> = [];
  let fullReads = 0;
  const openRecords: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.text().includes('[session-open] first content')) openRecords.push(message.text());
  });
  await page.route(`**/api/sessions/${sid}`, route => route.fulfill({ json: { session: {
    claudeSessionId: sid, title: 'Cold preview', process_status: 'stopped', mode: 'bypass',
    startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:01Z', host: 'remote-dev',
  } } }));
  await page.route(`**/api/sessions/${sid}/history**`, async route => {
    if (new URL(route.request().url()).searchParams.get('source') === 'streams') {
      await route.fulfill({ json: { messages: rows, total: 1, windowed: true } });
      return;
    }
    fullReads++;
    await new Promise<void>(resolve => held.push(async () => {
      await route.fulfill({ json: { messages: [
        { role: 'user', text: 'Earlier question', timestamp: '2026-01-01T00:00:00Z', msgId: 'first' }, ...rows,
      ], cursor: 2, windowed: true } }).catch(() => {});
      resolve();
    }));
  });
  try {
    // Cold Vite boot is not the preview's paint: wait for its response, then
    // keep the normal content deadline while the complete refresh stays held.
    const preview = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/sessions/${sid}/history` && url.searchParams.get('source') === 'streams';
    });
    await page.setContent(`<a href="${baseURL}/sessions?id=${sid}">Open the conversation</a>`);
    await page.getByRole('link', { name: 'Open the conversation' }).click();
    await preview;
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    await expect(panel).toContainText('Newest preview answer');
    expect(pageErrors).toEqual([]);
    await expect.poll(() => fullReads).toBeGreaterThan(0);
    await expect(panel.getByText('Loading remote session...', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.chat-input-textarea')).toBeEnabled();
    // The first paint must precede completion, not merely make the same full fetch faster.
    expect(held.length).toBeGreaterThan(0);
    await expect.poll(() => openRecords.length).toBe(1);
    expect(openRecords[0]).toContain(sid);
    for (const release of held.splice(0)) await release();
    await expect(panel).toContainText('Earlier question');
    await expect(panel.getByText('Newest preview answer', { exact: true })).toHaveCount(1);
  } finally {
    for (const release of held.splice(0)) await release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
