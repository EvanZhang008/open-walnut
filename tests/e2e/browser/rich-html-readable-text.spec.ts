/**
 * A rich reply that paints a light background and no text colour stays readable.
 *
 * 2026-10-22 report: a reply drew its code samples as
 * `<pre style="background:#f6f8fa">` and `<pre style="background:#fff8c5">`. An
 * assistant code block carries light text for its dark fill (#cdd6f4), the inline
 * background replaced the fill but not the text, and the code read as pale grey on
 * white. The DOMPurify hook (`ensureReadableText`, web/src/utils/html-contrast.ts)
 * gives such a box the text colour its background needs; a plain markdown fence
 * keeps its own dark look.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { withCssColor } from './css-color';

const SESSION_ID = 'pw-rich-readable';
const TASK_ID = 'pw-task-rich-readable';
const SHOT_DIR = '/tmp/rich-readable/e2e';

const REPLY = [
  'Two sides of the call:',
  '',
  '<div style="display:flex;gap:12px">',
  '<pre data-probe="grey" style="flex:1.4;margin:0;padding:10px;font-size:12px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;white-space:pre-wrap"><b>C++ side</b>',
  'napi_value Get(napi_env env, napi_callback_info info) {',
  '  return row;',
  '}</pre>',
  '<pre data-probe="yellow" style="flex:1;margin:0;padding:10px;font-size:12px;background:#fff8c5;border:1px solid #d4a72c;border-radius:8px;white-space:pre-wrap"><b>JS side</b>',
  "const addon = require('./sqlite_addon.node')",
  'console.log(addon.get(42).title)</pre>',
  '</div>',
  '',
  '<div data-probe="dark" style="padding:8px;background:#1e1e2e">dark card, no colour given, with <code data-probe="chip">inline_code</code></div>',
  '',
  '<pre data-probe="precode" style="padding:8px;background:#fff5f5"><code data-probe="precode-c">inside_pre()</code></pre>',
  '',
  '<div data-probe="author" style="padding:8px;background:#fff;color:#8250df">author colour kept</div>',
  '',
  '```js',
  'const plain = "markdown fence";',
  '```',
].join('\n');

const history = [
  { role: 'user', text: 'How is a .node file called from JS?', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: REPLY, timestamp: '2026-01-01T00:00:01.000Z' },
];

async function openSession(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    return route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle',
      mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
      messageCount: 2, title: 'Readable rich reply',
    } } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
    return route.fulfill({ json: { messages: history, cursor: history.length, delta: false } });
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  const origin = test.info().project.use.baseURL;
  await page.setContent(`<a href="${origin}/sessions?id=${SESSION_ID}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-probe="grey"]')).toBeVisible({ timeout: 15000 });
}

/** WCAG contrast ratio between an element's computed text colour and the background it paints. */
async function contrastOf(page: Page, selector: string) {
  return page.evaluate(withCssColor((toRgba) => (sel: string) => {
    const el = document.querySelector(sel)!;
    const cs = getComputedStyle(el);
    const rgb = (v: string) => toRgba(v).slice(0, 3);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = lum(rgb(cs.color)); const b = lum(rgb(cs.backgroundColor));
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), color: cs.color, bg: cs.backgroundColor };
  }), selector);
}

test('a light box with no text colour gets dark text; author colours and fences keep theirs', async ({ page }) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  await openSession(page);

  for (const probe of ['grey', 'yellow', 'dark']) {
    const c = await contrastOf(page, `[data-probe="${probe}"]`);
    expect(c.ratio, `${probe}: ${c.color} on ${c.bg}`).toBeGreaterThan(7);
  }
  expect((await contrastOf(page, '[data-probe="grey"]')).color).toBe('rgb(31, 35, 40)');
  expect((await contrastOf(page, '[data-probe="dark"]')).color).toBe('rgb(240, 243, 246)');
  expect((await contrastOf(page, '[data-probe="author"]')).color).toBe('rgb(130, 80, 223)');
  // An inline code chip paints the theme's own fill, so it keeps the theme's text, not the box's ink.
  const chip = await contrastOf(page, '[data-probe="chip"]');
  expect(chip.ratio, `chip: ${chip.color} on ${chip.bg}`).toBeGreaterThan(7);
  // Code inside a painted <pre> paints no fill of its own: it follows the block's ink.
  expect((await contrastOf(page, '[data-probe="precode-c"]')).color).toBe('rgb(31, 35, 40)');
  // The markdown fence is Walnut's own dark block: untouched.
  const fence = page.locator('.session-msg-assistant .markdown-body pre:not([style])').first();
  const fenceStyle = await fence.evaluate((el) => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  expect(fenceStyle.color).not.toBe('rgb(31, 35, 40)');
  await page.locator('[data-probe="grey"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-light.png` });

  // The dark theme: the inherited text would be light everywhere; the boxes stay dark-on-light.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  for (const probe of ['grey', 'yellow', 'dark', 'chip']) {
    const c = await contrastOf(page, `[data-probe="${probe}"]`);
    expect(c.ratio, `dark theme ${probe}: ${c.color} on ${c.bg}`).toBeGreaterThan(7);
  }
  await page.screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-dark.png` });
});
