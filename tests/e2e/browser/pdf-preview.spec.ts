import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isolateUiPrefs } from './todo-panel-helpers';

async function openPdf(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForLoadState('networkidle');
  await page.locator('.todo-search-input').fill('pw-vscode-session');
  const task = page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]');
  await expect(task).toBeVisible({ timeout: 30_000 });
  await task.locator('.todo-item-title').click();
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]');
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  const explorer = panel.locator('.session-file-explorer');
  await expect(explorer).toBeVisible();
  await explorer.locator('.session-file-explorer-node[title$="/contract.pdf"]').click();
  return explorer;
}

async function scale(explorer: Locator) {
  return Number(await explorer.locator('.fv-pdf-preview').getAttribute('data-scale'));
}

function densePdf(options: { pages?: number; rotation?: number; userUnit?: number; width?: number; height?: number; splitWord?: boolean } = {}) {
  const count = options.pages ?? 3;
  const font = 3 + count * 2;
  const kids = Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${kids}]/Count ${count}>>`];
  for (let page = 0; page < count; page++) {
    const text = options.splitWord ? ['BT /F1 10 Tf 40 750 Td (inter) Tj /F2 10 Tf (operability) Tj ET', 'BT /F1 10 Tf 40 720 Td'] : ['BT /F1 10 Tf 40 750 Td'];
    for (let row = 0; row < 48; row++) text.push(`(Page ${page + 1}, row ${row + 1}: Document detail for readable zoom verification.) Tj 0 -14 Td`);
    text.push('ET');
    const stream = text.join('\n') + '\n';
    const width = options.width ?? (page === 1 ? 792 : 612);
    const height = options.height ?? (page === 1 ? 612 : 792);
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Rotate ${options.rotation ?? 0}/UserUnit ${options.userUnit ?? 1}/Resources<</Font<</F1 ${font} 0 R/F2 ${font + 1} 0 R>>>>/Contents ${4 + page * 2} 0 R>>`);
    objects.push(`<</Length ${stream.length}>>stream\n${stream}endstream`);
  }
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${pdf}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${start}\n%%EOF\n`;
}

test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 1 });
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page); });

test('PDF auxiliary assets remain reachable in the compiled and development servers', async ({ request }) => {
  for (const asset of ['cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) {
    const response = await request.get(`/pdf-assets/6.4.299/${asset}`);
    expect(response.ok()).toBe(true);
    expect((await response.body()).length).toBeGreaterThan(100);
    if (asset.endsWith('.wasm')) expect(response.headers()['content-type']).toContain('application/wasm');
  }
});

test('PDF fills the available pane without dead space underneath', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const explorer = await openPdf(page);
  const view = explorer.locator('.file-content-view');
  const preview = explorer.locator('.fv-pdf-preview, .fv-doc-preview');
  await expect(preview).toBeVisible({ timeout: 20_000 });
  const outer = (await view.boundingBox())!;
  const inner = (await preview.boundingBox())!;
  expect(Math.abs(outer.y + outer.height - inner.y - inner.height)).toBeLessThan(3);
  await expect(explorer.locator('.fv-pdf-text')).toContainText('WALNUT PDF', { timeout: 20_000 });
  await expect.poll(() => explorer.locator('.fv-pdf-page canvas').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 !== 3 && value < 200);
  })).toBe(true);
  const raw = await explorer.locator('a.fv-download-btn').getAttribute('href');
  expect((await page.request.get(raw!)).headers()['content-type']).toContain('application/pdf');
});

test('trackpad pinch zooms only the PDF and normal scrolling still works', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({ contentType: 'application/pdf', body: densePdf() }));
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-page')).toHaveCount(3, { timeout: 20_000 });
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Document detail', { timeout: 20_000 });
  const scroll = explorer.locator('.fv-pdf-scroll');
  const start = await scale(explorer);
  const box = (await scroll.boundingBox())!;
  const anchor = await explorer.locator('.fv-pdf-page').first().evaluate((el, point) => {
    const rect = el.getBoundingClientRect();
    return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
  }, { x: box.x + box.width / 2, y: box.y + 120 });
  for (let i = 0; i < 6; i++) {
    await scroll.dispatchEvent('wheel', { ctrlKey: true, deltaY: -15, clientX: box.x + box.width / 2, clientY: box.y + 120, bubbles: true, cancelable: true });
  }
  await expect.poll(() => scale(explorer)).toBeGreaterThan(start * 1.5);
  const afterAnchor = await explorer.locator('.fv-pdf-page').first().evaluate((el, point) => {
    const rect = el.getBoundingClientRect();
    return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
  }, { x: box.x + box.width / 2, y: box.y + 120 });
  expect(Math.abs(anchor.x - afterAnchor.x)).toBeLessThan(0.02);
  expect(Math.abs(anchor.y - afterAnchor.y)).toBeLessThan(0.02);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  const beforeGesture = await scale(explorer);
  for (const [type, value] of [['gesturestart', 1], ['gesturechange', 1.3], ['gestureend', 1.3]] as const) {
    await scroll.evaluate((el, data) => {
      const event = new Event(data.type, { bubbles: true, cancelable: true });
      Object.assign(event, { scale: data.value, clientX: data.x, clientY: data.y });
      el.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('Pinch must suppress whole-window zoom');
    }, { type, value, x: box.x + box.width / 2, y: box.y + 120 });
  }
  await expect.poll(() => scale(explorer)).toBeCloseTo(beforeGesture * 1.3, 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const beforeScroll = await scale(explorer);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  expect(await scale(explorer)).toBe(beforeScroll);
  await explorer.getByRole('button', { name: 'Fit width', exact: true }).click();
  await expect.poll(() => scale(explorer)).toBeCloseTo(start, 2);
  await explorer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => scale(explorer)).toBeGreaterThan(start);
  await explorer.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(() => scale(explorer)).toBeCloseTo(start, 2);
  await page.screenshot({ path: '/tmp/pdf-review-fixes/multipage.png' });
});

test('PDF survives narrow and fullscreen layouts, file changes and failure retry', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  let fail = true;
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => fail
    ? route.fulfill({ status: 503, body: 'Unavailable' })
    : route.continue());
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-error')).toContainText('Retry', { timeout: 20_000 });
  fail = false;
  await explorer.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(explorer.locator('.fv-pdf-text')).toContainText('WALNUT PDF', { timeout: 20_000 });
  for (let round = 0; round < 3; round++) {
    await explorer.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await explorer.locator('.fv-fullscreen-btn').click();
    await expect(explorer.locator('.file-content-view')).toHaveClass(/fv-fullscreen/);
    await page.keyboard.press('Escape');
    await expect(explorer.locator('.file-content-view')).not.toHaveClass(/fv-fullscreen/);
    await explorer.locator('.session-file-explorer-node[title$="/diagram.png"]').click();
    await expect(explorer.locator('.fv-image-preview img')).toBeVisible();
    await explorer.locator('.session-file-explorer-node[title$="/contract.pdf"]').click();
    await expect(explorer.locator('.fv-pdf-text')).toContainText('WALNUT PDF', { timeout: 20_000 });
  }
  await page.setViewportSize({ width: 800, height: 600 });
  const scroll = explorer.locator('.fv-pdf-scroll');
  await expect.poll(() => scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThan(3);
  const rect = (await scroll.boundingBox())!;
  expect(rect.height).toBeGreaterThan(150);
});

for (const rotation of [0, 90, 180, 270]) {
  test(`PDF text geometry matches the canvas at rotation ${rotation} and custom page units`, async ({ page, baseURL }) => {
    await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
    await page.getByRole('link', { name: 'Open Walnut' }).click();
    await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({
      contentType: 'application/pdf', body: densePdf({ pages: 1, rotation, userUnit: 2 }),
    }));
    const explorer = await openPdf(page);
    await expect(explorer.locator('.fv-pdf-text')).toContainText('Document detail', { timeout: 20_000 });
    const geometry = await explorer.locator('.fv-pdf-page').evaluate((el) => {
      const page = el.getBoundingClientRect();
      const text = el.querySelector('.fv-pdf-text')!.getBoundingClientRect();
      const span = el.querySelector('.fv-pdf-text span')!;
      return { width: Math.abs(page.width - text.width), height: Math.abs(page.height - text.height),
        x: Math.abs(page.x - text.x), y: Math.abs(page.y - text.y), fontSize: parseFloat(getComputedStyle(span).fontSize) };
    });
    expect(geometry.width).toBeLessThan(2);
    expect(geometry.height).toBeLessThan(2);
    expect(geometry.x).toBeLessThan(2);
    expect(geometry.y).toBeLessThan(2);
    expect(geometry.fontSize).toBeCloseTo(20 * await scale(explorer), 1);
  });
}

for (const width of [40, 10_000]) {
  test(`PDF zoom controls stay monotonic for page width ${width}`, async ({ page, baseURL }) => {
    await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
    await page.getByRole('link', { name: 'Open Walnut' }).click();
    await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({
      contentType: 'application/pdf', body: densePdf({ pages: 1, width }),
    }));
    const explorer = await openPdf(page);
    // The tiny crop box intentionally clips almost all text.
    await expect(explorer.locator('.fv-pdf-text span').first()).toBeAttached({ timeout: 20_000 });
    const start = await scale(explorer);
    const out = explorer.getByRole('button', { name: 'Zoom out', exact: true });
    const into = explorer.getByRole('button', { name: 'Zoom in', exact: true });
    if (width === 40) {
      const dimensions = await explorer.locator('.fv-pdf-scroll').evaluate((el) => ({
        pane: el.clientWidth - 32, page: el.querySelector('.fv-pdf-page')!.getBoundingClientRect().width,
      }));
      expect(Math.abs(dimensions.pane - dimensions.page)).toBeLessThan(2);
    }
    if (await out.isEnabled()) {
      await out.click();
      await expect.poll(() => scale(explorer)).toBeLessThan(start);
      const smaller = await scale(explorer);
      await into.click();
      await expect.poll(() => scale(explorer)).toBeGreaterThan(smaller);
    } else {
      await into.click();
      await expect.poll(() => scale(explorer)).toBeGreaterThan(start);
      const larger = await scale(explorer);
      await out.click();
      await expect.poll(() => scale(explorer)).toBeLessThan(larger);
    }
  });
}

test('password-protected PDFs accept a corrected password without reopening', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const body = await readFile(new URL('./fixtures/password.pdf', import.meta.url));
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({ contentType: 'application/pdf', body }));
  const explorer = await openPdf(page);
  const password = explorer.getByLabel('PDF password');
  await expect(password).toBeVisible({ timeout: 20_000 });
  await password.fill('wrong-password');
  await explorer.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(explorer.getByRole('alert')).toContainText('Incorrect password');
  await password.fill('test-password');
  await explorer.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(explorer.locator('.fv-pdf-text')).toContainText('ENCRYPTED PDF MARKER', { timeout: 20_000 });
  await expect(password).toHaveCount(0);
});

test('a long PDF shows its first page without loading every page', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    (window as unknown as { pdfPageRequests: number }).pdfPageRequests = 0;
    Worker.prototype.postMessage = function (message: unknown, ...args: unknown[]) {
      if ((message as { action?: string })?.action === 'GetPage') {
        (window as unknown as { pdfPageRequests: number }).pdfPageRequests++;
      }
      return Reflect.apply(original, this, [message, ...args]);
    };
  });
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({
    contentType: 'application/pdf', body: densePdf({ pages: 150 }),
  }));
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-page')).toHaveCount(150, { timeout: 20_000 });
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Document detail', { timeout: 20_000 });
  const active = await explorer.locator('.fv-pdf-page canvas').evaluateAll((els) => els.filter((el) => (el as HTMLCanvasElement).width > 0).length);
  expect(active).toBeLessThan(15);
  expect(await page.evaluate(() => (window as unknown as { pdfPageRequests: number }).pdfPageRequests)).toBeLessThan(15);
  await explorer.locator('.fv-pdf-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(explorer.locator('.fv-pdf-text').last()).toContainText('Page 150', { timeout: 20_000 });
  await expect.poll(() => explorer.locator('.fv-pdf-page canvas').first().evaluate((el) => (el as HTMLCanvasElement).width)).toBe(0);
  await explorer.locator('.fv-pdf-scroll').evaluate((el) => { el.scrollTop = 0; });
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Page 1', { timeout: 20_000 });
});

test('a malformed later page does not prevent the first page from rendering', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const body = densePdf({ pages: 3 }).replace('/Kids[3 0 R 5 0 R 7 0 R]', '/Kids[3 0 R 5 0 R 0 0 R]');
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({ contentType: 'application/pdf', body }));
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Page 1', { timeout: 20_000 });
  await explorer.locator('.fv-pdf-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(explorer.locator('.fv-pdf-page').last().getByRole('alert')).toContainText('could not render', { timeout: 20_000 });
  await explorer.locator('.fv-pdf-scroll').evaluate((el) => { el.scrollTop = 0; });
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Page 1', { timeout: 20_000 });
});

test('PDF Find searches unrendered pages and cancels old queries', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({
    contentType: 'application/pdf', body: densePdf({ pages: 150 }),
  }));
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-text').first()).toContainText('Page 1', { timeout: 20_000 });
  await explorer.getByRole('button', { name: 'Find', exact: true }).click();
  const input = explorer.getByRole('searchbox', { name: 'Find in PDF' });
  await input.fill('Page 149,');
  await input.fill('Page 150,');
  await expect(explorer.locator('.fv-pdf-find [role="status"]')).toHaveText('1 / 1 pages', { timeout: 30_000 });
  await expect(explorer.locator('.fv-pdf-text').last()).toContainText('Page 150', { timeout: 20_000 });
  await input.fill('not-present-anywhere');
  await expect(explorer.locator('.fv-pdf-find [role="status"]')).toHaveText('No matches', { timeout: 30_000 });
  await input.fill('Page 1,');
  await expect(explorer.locator('.fv-pdf-find [role="status"]')).toHaveText('1 / 1 pages', { timeout: 30_000 });
  await input.press('Escape');
  await expect(input).toHaveCount(0);
});

test('PDF Find matches a word split across fonts', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({
    contentType: 'application/pdf', body: densePdf({ pages: 1, splitWord: true }),
  }));
  const explorer = await openPdf(page);
  await expect(explorer.locator('.fv-pdf-text')).toContainText('operability', { timeout: 20_000 });
  await explorer.getByRole('button', { name: 'Find', exact: true }).click();
  await explorer.getByRole('searchbox', { name: 'Find in PDF' }).fill('interoperability');
  await expect(explorer.locator('.fv-pdf-find [role="status"]')).toHaveText('1 / 1 pages', { timeout: 20_000 });
});

test('PDF links remain clickable and unsafe URLs are excluded', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const body = densePdf().replace('/Contents 4 0 R>>',
    '/Annots[<</Type/Annot/Subtype/Link/Rect[40 720 400 740]/A<</S/URI/URI(https://example.com/)>>>> '
    + '<</Type/Annot/Subtype/Link/Rect[40 680 400 700]/Dest[5 0 R /XYZ 0 300 null]>> '
    + '<</Type/Annot/Subtype/Link/Rect[40 640 400 660]/A<</S/URI/URI(javascript:alert%281%29)>>>>]/Contents 4 0 R>>');
  await page.route(/api\/file-raw\/.*contract\.pdf/, (route) => route.fulfill({ contentType: 'application/pdf', body }));
  const explorer = await openPdf(page);
  const external = explorer.locator('.fv-pdf-link[href="https://example.com/"]');
  await expect(external).toBeVisible({ timeout: 20_000 });
  await expect(explorer.locator('.fv-pdf-link')).toHaveCount(2);
  expect(await external.getAttribute('rel')).toContain('noopener');
  const popup = page.waitForEvent('popup');
  await external.click();
  await (await popup).close();
  await explorer.getByRole('link', { name: 'Go to linked page' }).click();
  await expect(explorer.locator('.fv-pdf-text').nth(1)).toContainText('Page 2', { timeout: 20_000 });
  await expect(explorer.locator('.fv-pdf-page-count')).toHaveText('2 / 3');
  const offset = await explorer.locator('.fv-pdf-scroll').evaluate((el) => {
    const page = el.querySelector('[data-page="2"]')!.getBoundingClientRect();
    return el.getBoundingClientRect().top - page.top;
  });
  expect(offset).toBeGreaterThan(200 * await scale(explorer));
});

test('a stalled PDF load reaches Retry and the next attempt renders', async ({ page, baseURL }) => {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  let stalled = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/api\/file-raw\/.*contract\.pdf/, async (route) => {
    if (stalled) { await held; await route.abort().catch(() => {}); }
    else await route.fulfill({ contentType: 'application/pdf', body: densePdf({ pages: 1 }) });
  });
  await page.clock.install();
  try {
    const explorer = await openPdf(page);
    await expect(explorer.locator('.fv-pdf-status')).toBeVisible();
    await page.clock.fastForward(120_001);
    await expect(explorer.locator('.fv-pdf-error')).toContainText('too long');
    stalled = false;
    release();
    await explorer.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(explorer.locator('.fv-pdf-text')).toContainText('Document detail', { timeout: 20_000 });
  } finally { release(); }
});
