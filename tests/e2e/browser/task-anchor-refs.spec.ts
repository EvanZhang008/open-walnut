import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { keepTaskFramesTo } from './task-list-stub';

const sid = 'pw-idref-session';
const targetId = 'mpwidref-7c2e';
const targetTitle = 'Quarterly invoice reconciliation src/billing/check.ts';
const shots = '/tmp/walnut-tools-links';
const ref = `<task-ref id="${targetId}" label="Old task name"/>`;
const anchor = `<a href="/tasks/${targetId}" class="task-link" data-task-id="${targetId}">Old task name</a>`;
const reply = [
  'Tool errors and task links',
  `Assigned to ${ref}.`,
  `A citation in backticks: \`${ref}\`.`,
  `Model-written anchor: ${anchor}.`,
  `Escaped citation: \`${anchor}\`.`,
  `<div>Rich reply: ${ref}</div>`,
  'Source example stays source:',
  '```xml',
  ref,
  '```',
].join('\n\n');

test.setTimeout(120_000);

async function pointerClick(page: Page, locator: Locator) {
  let last = 'no measurement';
  let stuck = 0;
  let lastY = Number.NaN;
  for (let i = 0; i < 40; i++) {
    const box = await locator.boundingBox();
    if (!box) {
      last = 'the target has no box';
      await page.waitForTimeout(150);
      continue;
    }
    // A reloaded timeline keeps settling after its first paint (scroll to the latest row, late fonts), so act only on a position that held still.
    await page.waitForTimeout(150);
    const again = await locator.boundingBox();
    if (!again || Math.abs(again.x - box.x) > 1 || Math.abs(again.y - box.y) > 1) {
      last = 'the target kept moving';
      continue;
    }
    // The part of the target a person sees: inside its scrolling list and inside the window (the list can reach below the window).
    const probe = await locator.evaluate((el) => {
      let area = { x: 0, y: 0, width: innerWidth, height: innerHeight };
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(p).overflowY) || p.scrollHeight <= p.clientHeight) continue;
        const r = p.getBoundingClientRect();
        area = { x: r.x, y: r.y, width: r.width, height: r.height };
        break;
      }
      const band = {
        top: Math.max(area.y, 0), bottom: Math.min(area.y + area.height, innerHeight),
        left: Math.max(area.x, 0), right: Math.min(area.x + area.width, innerWidth),
      };
      const seen = [...el.getClientRects()]
        .map((r) => ({ top: Math.max(r.top, band.top), bottom: Math.min(r.bottom, band.bottom), left: Math.max(r.left, band.left), right: Math.min(r.right, band.right) }))
        .filter((v) => v.bottom - v.top >= 6 && v.right - v.left >= 6)
        .sort((a, b) => (b.bottom - b.top) * (b.right - b.left) - (a.bottom - a.top) * (a.right - a.left));
      const best = seen[0];
      return { band, hit: best ? { x: (best.left + best.right) / 2, y: (best.top + best.bottom) / 2 } : null, innerHeight };
    });
    const { band, hit } = probe;
    if (band.bottom - band.top < 20 || band.right - band.left < 20) {
      last = 'the list is outside the window';
      await locator.scrollIntoViewIfNeeded();
      continue;
    }
    if (hit) {
      await page.mouse.move(hit.x, hit.y, { steps: 8 });
      const underPointer = await locator.evaluate((el, p) => {
        const top = document.elementFromPoint(p.x, p.y);
        return !!top && el.contains(top);
      }, hit);
      if (underPointer) {
        await page.mouse.down();
        await page.mouse.up();
        return;
      }
      last = 'something else covers or replaced the target under the pointer';
    } else {
      last = JSON.stringify({ targetY: again.y + again.height / 2, ...probe });
    }
    // Scroll like a person: the wheel over the visible part of the list, which hands over to the page when the list has no more to give.
    const y = again.y + again.height / 2;
    const middle = (band.top + band.bottom) / 2;
    stuck = Math.abs(y - lastY) < 1 ? stuck + 1 : 0;
    lastY = y;
    if (stuck >= 2) await locator.scrollIntoViewIfNeeded();
    await page.mouse.move((band.left + band.right) / 2, middle);
    const room = band.bottom - band.top;
    await page.mouse.wheel(0, Math.max(-room * 0.8, Math.min(room * 0.8, y - middle)));
    await page.waitForTimeout(100);
  }
  throw new Error(`The target did not scroll into view: ${last}`);
}

async function openHome(page: Page) {
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`);
  await pointerClick(page, page.getByRole('link', { name: 'Open Walnut', exact: true }));
  await page.waitForLoadState('networkidle');
}

test('task references stay readable, clickable and stable after reopening', async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const cursor = document.createElement('div');
      cursor.style.cssText = 'position:fixed;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#a04020;z-index:2147483647;pointer-events:none;left:0;top:0';
      document.body.appendChild(cursor);
      document.addEventListener('pointermove', (e) => { cursor.style.left = `${e.clientX - 6}px`; cursor.style.top = `${e.clientY - 6}px`; });
    });
  });
  const errors: string[] = [];
  let reloading = false;
  page.on('pageerror', (e) => {
    if (reloading && /due to access control checks\.$/.test(e.message)) return;
    errors.push(e.message);
  });
  const messages = [
    { role: 'user', text: 'Who owns this follow-up?', timestamp: '2026-01-01T00:00:00.000Z', msgId: 'task-anchor-user' },
    { role: 'assistant', text: reply, timestamp: '2026-01-01T00:00:01.000Z', msgId: 'task-anchor-reply' },
  ];
  await page.route(`**/api/sessions/${sid}/history**`, (route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }));
  await page.route('**/api/sessions/pw-idref-target-session/history**', (route) => route.fulfill({
    json: { messages: [{ role: 'assistant', text: 'Target conversation opened.', timestamp: '2026-01-01T00:00:02.000Z' }], cursor: 1, delta: false },
  }));
  const ours = new Set<string>();
  await keepTaskFramesTo(page, ours);
  await page.route('**/api/tasks?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const tasks = Array.isArray(body) ? body : body.tasks;
    for (const task of tasks) {
      ours.add(task.id);
      if (task.id === targetId) task.title = targetTitle;
    }
    await route.fulfill({ response, json: body });
  });
  await openHome(page);
  const search = page.locator('.todo-search-input');
  await pointerClick(page, search);
  await page.keyboard.type('Task id refs fixture');
  await pointerClick(page, page.locator('.todo-panel-item[data-task-id="pw-task-idref"] .todo-item-title'));
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
  const row = panel.locator('.session-msg-assistant', { hasText: 'Tool errors and task links' });
  const pills = row.locator(`a.task-link[data-task-id="${targetId}"]:not(.task-link-code)`);
  await expect(pills).toHaveCount(5);
  for (const pill of await pills.all()) await expect(pill).toHaveText(targetTitle);
  const sample = row.locator('pre');
  await expect(sample).toContainText('<task-ref');
  expect(await row.textContent()).not.toContain('<a href=');
  expect(await row.textContent()).not.toContain('Old task name</a>');
  await row.screenshot({ path: `${shots}/task-anchors-${test.info().project.name}.png` });
  const targetPanel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-idref-target-session"]');
  await pointerClick(page, pills.nth(1));
  await expect(targetPanel).toBeVisible();
  await expect(targetPanel).toContainText('Target conversation opened.');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(errors).toEqual([]);
  reloading = true;
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(pills).toHaveCount(5);
  await expect(targetPanel).toContainText('Target conversation opened.');
  reloading = false;
  await pointerClick(page, pills.nth(3));
  await expect(targetPanel).toBeVisible();
  await expect(targetPanel).toContainText('Target conversation opened.');
  expect(errors).toEqual([]);
});

// The helper above clicked only a link fully inside the window, so a list taller than the window (its lower part below the fold) or a
// timeline still settling after a reload left it with "No visible hit region" on a slow runner.
const tallLink = '<a id="t" href="#" onclick="this.dataset.n=String((Number(this.dataset.n) || 0) + 1);return false">Quarterly invoice reconciliation src/billing/check.ts</a>';
const tallList = (pad: number) => `<!doctype html><body style="margin:0"><div style="height:60px">top</div>
<div style="height:1400px;overflow:auto;border:1px solid"><div style="height:${pad}px">pad</div><p>Model-written anchor: ${tallLink}.</p><div style="height:900px">tail</div></div></body>`;
const settlingList = `<!doctype html><body style="margin:0"><div style="height:200px">top</div>
<div id="list" style="height:300px;overflow:auto;border:1px solid"><div id="pad" style="height:30px">a</div><p>Model-written anchor: ${tallLink}.</p><div style="height:1800px">tail</div></div>
<div style="height:1500px">page bottom</div>
<script>
const list = document.getElementById('list');
setTimeout(() => { list.scrollTop = 1800; }, 350);
setTimeout(() => { list.scrollTop = 0; document.getElementById('pad').style.height = '240px'; }, 900);
setTimeout(() => { window.scrollTo(0, 80); }, 1300);
</script></body>`;

const listCases: Record<string, string> = {
  'just below the window': tallList(650),
  'further below the window': tallList(700),
  'far inside the list': tallList(1700),
  'in a list that keeps moving': settlingList,
};
for (const [name, html] of Object.entries(listCases)) {
  test(`pointerClick reaches a link ${name}`, async ({ page }) => {
    await page.setContent(html);
    await pointerClick(page, page.locator('#t'));
    await expect(page.locator('#t')).toHaveAttribute('data-n', '1');
  });
}
