/**
 * The composer's Draw with the drawing_app experiment on: the drawing workspace in a dialog, on
 * the real editor, with real pointer and keyboard input. Runs on its own server with the real
 * Drawing plugin (plugin-mic-server.ts, PW_PLUGIN_FIXTURE=drawing); with the experiment off the classic
 * pad is covered by session-drawing.spec.ts and drawing-pad-lifecycle.spec.ts.
 *
 * Covers: the first stroke saves a file in Notes without a Save press, shapes, text (several
 * lines, CJK), arrow, pen and eraser, select and move, undo and redo, zoom and pan that save
 * nothing, PNG and SVG export with the fonts loaded from this Walnut (no request leaves it),
 * dark theme, close and reopen on the same file, a change elsewhere taken in while clean, a 409
 * with Keep mine, resize, and Attach PNG letting go of the file.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { seedColumns } from './draft-helpers';
import { startSessionAt, panelFor, openPlusMenu } from './engine-settings-popover-helpers';
import { useDrawingFixture } from './plugin-fixture';

const SHOTS = '/tmp/drawing-composer';
/** Two CJK characters (test data): the text tool and the SVG export must keep them. */
const CJK = '\u4f60\u597d';
const fixture = useDrawingFixture();
// One server per worker: the file's tests run in order on it.
test.describe.configure({ mode: 'default', timeout: 240_000 });
test.use({ viewport: { width: 1280, height: 900 } });

interface Doc { path: string; title: string; revision: string; scene: { elements: Array<{ id: string; type: string; x: number; text?: string; isDeleted?: boolean }> } }

async function shot(page: Page, name: string) {
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' });
}

async function openSession(page: Page) {
  const sid = await startSessionAt(page.request, path.join(fixture.home(), 'projects'), 'claude');
  await seedColumns(page, [sid]);
  await page.evaluate((url) => { location.href = url; }, `${fixture.base()}/`);
  const panel = panelFor(page, sid);
  await expect(panel.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });
  return panel;
}

async function openDraw(page: Page, panel: Locator) {
  const menu = await openPlusMenu(panel);
  await menu.getByRole('menuitem', { name: 'Draw', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Drawing', exact: true });
  await expect(dialog.locator('.drawing-workspace')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('canvas.excalidraw__canvas.interactive')).toBeVisible({ timeout: 60_000 });
  return dialog;
}

const status = (dialog: Locator) => dialog.locator('.drawing-workspace-status');
const ws = (dialog: Locator) => dialog.locator('.drawing-workspace');

async function canvasBox(dialog: Locator) {
  return (await dialog.locator('canvas.excalidraw__canvas.interactive').boundingBox())!;
}

/**
 * Every x below is measured from LEFT, not from the canvas edge: a picked tool opens
 * Excalidraw's properties panel over the canvas's left 220 px and its menu button sits in the
 * top-left corner, so a pointer there lands on the panel and never draws.
 */
const LEFT = 260;

/** Focus the canvas with a click on an empty spot, clear of the panel and the toolbar. */
async function focusCanvas(dialog: Locator) {
  await dialog.locator('canvas.excalidraw__canvas.interactive').click({ position: { x: LEFT, y: 300 } });
}

/** A tool by its shortcut, then a drag from (x1,y1) to (x2,y2) in canvas pixels (x from LEFT). */
async function drag(page: Page, dialog: Locator, key: string, [x1, y1]: [number, number], [x2, y2]: [number, number]) {
  const box = await canvasBox(dialog);
  await page.keyboard.press(key);
  await page.mouse.move(box.x + LEFT + x1, box.y + y1);
  await page.mouse.down();
  // A person's press rests a moment before it moves; WebKit otherwise ran the first moves before
  // the editor had taken the press (a move by 5 px of the 60 asked for).
  await page.waitForTimeout(60);
  await page.mouse.move(box.x + LEFT + x2, box.y + y2, { steps: 12 });
  await page.mouse.up();
}

/** An item of the drawing's own menu (the editor's hamburger). */
async function fromMenu(dialog: Locator, name: string) {
  await dialog.getByTestId('main-menu-trigger').click();
  await dialog.locator('.dropdown-menu').getByText(name, { exact: true }).click();
}

/** The view the editor shows, from the data attributes its box carries (ExcalidrawCanvas.tsx). */
async function viewOf(dialog: Locator) {
  const host = dialog.locator('.drawing-canvas-host');
  return {
    instance: await host.getAttribute('data-editor-instance'),
    zoom: await host.getAttribute('data-zoom'),
    scrollX: await host.getAttribute('data-scroll-x'),
    scrollY: await host.getAttribute('data-scroll-y'),
  };
}

async function saved(dialog: Locator) {
  await expect(status(dialog)).toHaveText('Saved', { timeout: 30_000 });
  await expect(ws(dialog)).toHaveAttribute('data-save-state', 'saved');
}

async function onServer(page: Page, dialog: Locator): Promise<Doc> {
  const p = await ws(dialog).getAttribute('data-drawing-path');
  expect(p).toBeTruthy();
  const res = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(p!)}`);
  expect(res.ok(), await res.text()).toBe(true);
  return await res.json() as Doc;
}

test.describe('Draw in the composer (drawing_app)', () => {
  test('draw, edit, export, theme, reopen, change elsewhere, conflict and attach', async ({ page }) => {
    const errors: string[] = [];
    const outside: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http')) outside.push(r.url()); });
    await page.route(/esm\.sh|unpkg\.com|jsdelivr\.net/, (route) => route.abort());

    const panel = await openSession(page);
    const dialog = await openDraw(page, panel);
    await expect(status(dialog)).toHaveText('Saved to Notes when you draw');
    expect(await ws(dialog).getAttribute('data-drawing-path')).toBeNull();

    // The first shape makes the file, in the session's task, with no Save press.
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [300, 220]);
    await saved(dialog);
    let doc = await onServer(page, dialog);
    expect(doc.path).toMatch(/\.excalidraw$/);
    expect(doc.scene.elements.map((e) => e.type)).toEqual(['rectangle']);

    // Text: several lines, CJK (test data in escapes).
    const box = await canvasBox(dialog);
    await page.keyboard.press('t');
    await page.mouse.click(box.x + LEFT + 420, box.y + 140);
    const editor = dialog.locator('textarea.excalidraw-wysiwyg');
    await expect(editor).toBeVisible();
    await editor.fill(`Order -> review\nrating, user\n${CJK}`);
    await editor.press('Escape');
    // Arrow, pen, then the eraser across the pen stroke.
    await drag(page, dialog, 'a', [300, 170], [420, 170]);
    await drag(page, dialog, 'p', [150, 320], [320, 360]);
    await saved(dialog);
    doc = await onServer(page, dialog);
    expect(doc.scene.elements.map((e) => e.type).sort()).toEqual(['arrow', 'freedraw', 'rectangle', 'text']);
    expect(doc.scene.elements.find((e) => e.type === 'text')?.text).toContain(CJK);
    await drag(page, dialog, 'e', [140, 340], [330, 340]);
    await saved(dialog);
    doc = await onServer(page, dialog);
    expect(doc.scene.elements.some((e) => e.type === 'freedraw')).toBe(false);

    // Undo brings the stroke back, redo erases it again.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+z`);
    await saved(dialog);
    expect((await onServer(page, dialog)).scene.elements.some((e) => e.type === 'freedraw')).toBe(true);
    await page.keyboard.press(`${mod}+Shift+z`);
    await saved(dialog);
    expect((await onServer(page, dialog)).scene.elements.some((e) => e.type === 'freedraw')).toBe(false);

    // Select and move the rectangle.
    const x0 = doc.scene.elements.find((e) => e.type === 'rectangle')!.x;
    await drag(page, dialog, 'v', [200, 121], [260, 151]);
    await saved(dialog);
    doc = await onServer(page, dialog);
    expect(doc.scene.elements.find((e) => e.type === 'rectangle')!.x).toBeGreaterThan(x0 + 30);

    // Zoom and pan change the view only: no new revision.
    await page.keyboard.press(`${mod}+=`);
    const b = await canvasBox(dialog);
    await page.mouse.move(b.x + 600, b.y + 400);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(2_000);
    expect((await onServer(page, dialog)).revision).toBe(doc.revision);

    // Fonts come from this Walnut; exports work with them, and nothing left the machine.
    expect(await page.evaluate(() => document.fonts.check('20px Excalifont'))).toBe(true);
    // Export lives in the drawing's menu; the header has no PNG or SVG button.
    await expect(dialog.locator('.drawing-workspace-bar').getByRole('button', { name: /^(PNG|SVG)$/ })).toHaveCount(0);
    const [png] = await Promise.all([page.waitForEvent('download'), fromMenu(dialog, 'Download PNG')]);
    const pngBytes = await fs.readFile((await png.path())!);
    expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
    const [svg] = await Promise.all([page.waitForEvent('download'), fromMenu(dialog, 'Download SVG')]);
    const svgText = await fs.readFile((await svg.path())!, 'utf8');
    expect(svgText).toContain('<svg');
    expect(svgText).toContain('@font-face');
    expect(svgText).toContain(CJK);
    expect(outside).toEqual([]);

    // Dark theme follows the console's.
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expect(dialog.locator('.excalidraw.theme--dark')).toBeVisible();
    await shot(page, 'dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    // Resize: the editor keeps filling the dialog.
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(async () => (await canvasBox(dialog)).width).toBeGreaterThan(500);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Close and Draw again: the same file.
    const filePath = doc.path;
    await dialog.getByRole('button', { name: 'Close drawing' }).click();
    await expect(dialog).toHaveCount(0);
    const again = await openDraw(page, panel);
    await expect(ws(again)).toHaveAttribute('data-drawing-path', filePath);
    await saved(again);

    // Changed elsewhere while clean (an agent's append, the server's own op): the editor itself
    // takes it in, not only the server: its revision is the new one.
    const current = await onServer(page, again);
    const appended = await page.request.post('/api/drawings/append', {
      data: { path: filePath, revision: current.revision, elements: [{ type: 'rectangle', x: 600, y: 400, width: 80, height: 60 }] },
    });
    expect(appended.ok(), await appended.text()).toBe(true);
    const changed = await appended.json() as Doc;
    expect(changed.scene.elements.length).toBe(current.scene.elements.length + 1);
    const added = changed.scene.elements.find((e) => !current.scene.elements.some((c) => c.id === e.id))!;
    await expect(ws(again)).toHaveAttribute('data-drawing-revision', changed.revision, { timeout: 20_000 });
    await expect(ws(again)).toHaveAttribute('data-save-state', 'saved');

    // A 409 on a shape both sides changed: the person moves every shape, and while that save is
    // on its way (held here) an agent moves the appended one too, then the save goes on. A shape
    // only one side changed merges by itself (drawing-merge.ts); this one waits for Keep mine.
    const THEIRS_X = 999;
    const addedX = async () => (await onServer(page, again)).scene.elements.find((e) => e.id === added.id)?.x;
    let raced = false;
    await page.route('**/api/drawings/file', async (route) => {
      const sent = route.request().method() === 'PUT' ? route.request().postDataJSON() as { scene: Doc['scene'] } : null;
      const moved = sent?.scene.elements.find((e) => e.id === added.id);
      if (!raced && moved && moved.x !== added.x) {
        raced = true;
        const latest = await (await page.request.get(`/api/drawings/file?path=${encodeURIComponent(filePath)}`)).json() as Doc;
        const other = await page.request.post('/api/drawings/update', {
          data: { path: filePath, revision: latest.revision, update: [{ id: added.id, x: THEIRS_X }] },
        });
        expect(other.ok(), await other.text()).toBe(true);
      }
      await route.continue();
    });
    await focusCanvas(again);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => raced, { timeout: 20_000 }).toBe(true);
    const conflict = again.locator('.drawing-workspace-conflict');
    await expect(conflict).toBeVisible({ timeout: 20_000 });
    await expect(conflict).toContainText('One shape was changed both here and somewhere else');
    await shot(page, 'conflict');
    expect(await addedX()).toBe(THEIRS_X);
    await page.unroute('**/api/drawings/file');
    await again.getByRole('button', { name: 'Keep mine', exact: true }).click();
    await saved(again);
    const mine = await addedX();
    expect(mine).toBeGreaterThan(added.x);
    expect(mine).not.toBe(THEIRS_X);

    // Attach PNG: the picture joins the message, the file stays, the next Draw is new.
    await again.getByRole('button', { name: 'Attach PNG', exact: true }).click();
    await expect(again).toHaveCount(0);
    await expect(panel.locator('.chat-image-preview')).toHaveCount(1);
    const fresh = await openDraw(page, panel);
    await expect(status(fresh)).toHaveText('Saved to Notes when you draw');
    await shot(page, 'fresh-after-attach');
    const kept = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(filePath)}`);
    expect(kept.ok()).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a failed save retries, and edits a reload interrupted come back and are saved', async ({ page }) => {
    const panel = await openSession(page);
    let dialog = await openDraw(page, panel);
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [300, 220]);
    await saved(dialog);
    const filePath = (await onServer(page, dialog)).path;

    // Saves fail: the edit is kept and said to be retrying.
    await page.route('**/api/drawings/file', (route) => (route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.continue()));
    await drag(page, dialog, 'o', [400, 120], [520, 220]);
    await expect(status(dialog)).toHaveText('Not saved, retrying', { timeout: 20_000 });
    await shot(page, 'offline-retrying');
    // The page reloads before any save got through.
    await page.reload();
    await page.unroute('**/api/drawings/file');
    // The panel's locator names the session, so it finds the column again after the reload.
    await expect(panel.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });
    dialog = await openDraw(page, panel);
    await expect(ws(dialog)).toHaveAttribute('data-drawing-path', filePath);
    await saved(dialog);
    const doc = await onServer(page, dialog);
    expect(doc.scene.elements.map((e) => e.type).sort()).toEqual(['ellipse', 'rectangle']);
    await shot(page, 'recovered-after-reload');
  });
  // 2026-11-17, the user: "the drawing should be wider by default, like a regular session window".
  test('the Draw dialog opens as wide and tall as a session window in full screen, and fits a phone', async ({ page }) => {
    const panel = await openSession(page);
    const dialog = await openDraw(page, panel);
    // The session window's full-screen size (globals.css --sheet-*, which .open-walnut-fullscreen
    // reads: tests/web/sheet-size-one-rule.test.ts): 95% of the window, at most 1400 wide.
    const sheet = async () => page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:min(var(--sheet-width),var(--sheet-max-width));height:var(--sheet-height)';
      document.body.appendChild(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    });
    const size = async () => { const b = (await dialog.boundingBox())!; return { width: Math.round(b.width), height: Math.round(b.height) }; };
    expect(await size()).toEqual(await sheet());
    expect((await size()).width).toBe(Math.round(1280 * 0.95));
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [420, 300]);
    await drag(page, dialog, 'o', [560, 140], [820, 320]);
    await drag(page, dialog, 'a', [430, 210], [560, 220]);
    await saved(dialog);
    await shot(page, 'dialog-wide');
    // A wide screen: as wide as the session sheet, which stops at 1400.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(size).toEqual(await sheet());
    expect((await size()).width).toBe(1400);
    await shot(page, 'dialog-wide-1920');
    // A phone: the whole screen, nothing past its edges.
    await page.setViewportSize({ width: 390, height: 760 });
    await expect.poll(async () => { const b = (await dialog.boundingBox())!; return b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 760; }).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('full screen in the dialog keeps the editor and its view, both ways', async ({ page }) => {
    const panel = await openSession(page);
    const dialog = await openDraw(page, panel);
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [300, 220]);
    await saved(dialog);
    // The toolbar shows each tool's letter shortcut, not the editor's digit; the tooltip names it too.
    const rectKey = dialog.locator('input[data-testid="toolbar-rectangle"] + .ToolIcon__icon .ToolIcon__keybinding');
    expect(await rectKey.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el, '::after').content])).toEqual(['0px', '"R"']);
    await expect(dialog.locator('label[title*="Rectangle"]').first()).toHaveAttribute('title', /R|2/);
    // Zoom in and pan, so the view is not the default one.
    await page.keyboard.press('ControlOrMeta+=');
    await page.keyboard.press('ControlOrMeta+=');
    await page.mouse.move((await canvasBox(dialog)).x + LEFT + 200, (await canvasBox(dialog)).y + 300);
    await page.mouse.wheel(0, 120);
    await expect(dialog.locator('.drawing-canvas-host')).not.toHaveAttribute('data-zoom', '1');
    const before = await viewOf(dialog);
    await shot(page, 'fullscreen-before');

    await dialog.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(ws(dialog)).toHaveAttribute('data-fullscreen', 'true');
    const box = (await ws(dialog).boundingBox())!;
    expect(box).toMatchObject({ x: 0, y: 0, width: 1280, height: 900 });
    expect(await viewOf(dialog)).toEqual(before);
    await shot(page, 'fullscreen-on');
    // Escape in the editor is the editor's (deselect), not a way out of full screen.
    await focusCanvas(dialog);
    await page.keyboard.press('Escape');
    await expect(ws(dialog)).toHaveAttribute('data-fullscreen', 'true');
    // The shortcut toggles it back.
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect(ws(dialog)).toHaveAttribute('data-fullscreen', 'false');
    expect(await viewOf(dialog)).toEqual(before);
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect(ws(dialog)).toHaveAttribute('data-fullscreen', 'true');
    await dialog.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    await expect(ws(dialog)).toHaveAttribute('data-fullscreen', 'false');
    expect(await viewOf(dialog)).toEqual(before);
    await shot(page, 'fullscreen-after');
  });

  test('a press outside closes the dialog only when it starts and ends outside, and everything is saved', async ({ page }) => {
    const panel = await openSession(page);
    const dialog = await openDraw(page, panel);
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [300, 220]);
    await saved(dialog);

    // A stroke that starts on the canvas and ends outside the dialog keeps it open.
    const cb = await canvasBox(dialog);
    await page.keyboard.press('p');
    await page.mouse.move(cb.x + LEFT + 200, cb.y + 400);
    await page.mouse.down();
    await page.mouse.move(4, 4, { steps: 16 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await saved(dialog);
    const doc = await onServer(page, dialog);
    expect(doc.scene.elements.some((e) => e.type === 'freedraw')).toBe(true);
    await shot(page, 'outside-drag-kept-open');
    // A press that starts outside and ends inside keeps it open too.
    await page.mouse.move(6, 450);
    await page.mouse.down();
    await page.mouse.move(cb.x + LEFT + 300, cb.y + 300, { steps: 8 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();

    // A press that begins and ends outside closes it; the file has everything.
    await page.mouse.click(6, 450);
    await expect(dialog).toHaveCount(0);
    const res = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(doc.path)}`);
    const kept = await res.json() as Doc;
    expect(kept.scene.elements.filter((e) => !e.isDeleted).map((e) => e.type).sort()).toEqual(['freedraw', 'rectangle']);
    // Draw again opens the same file.
    const again = await openDraw(page, panel);
    await expect(ws(again)).toHaveAttribute('data-drawing-path', doc.path);
  });

  // 2026-11-20, the user: "each session has its own drawing open by default please not always open
  // this one", then "I click this new but doesn't work" (over a "Changed elsewhere" bar).
  test("each task's session opens its own drawing; New drawing works over a conflict, which comes back with its edits", async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const start = async (message: string) => {
      const res = await page.request.post('/api/sessions/quick-start', {
        data: { cwd: path.join(fixture.home(), 'projects'), message, project: 'Drawing Fixture', engine: 'claude' },
      });
      expect(res.ok(), await res.text()).toBe(true);
      return await res.json() as { sessionId: string; taskId: string };
    };
    const a = await start('Sketch the order service');
    const b = await start('Sketch the review service');
    expect(a.taskId).not.toBe(b.taskId);
    await seedColumns(page, [a.sessionId, b.sessionId]);
    await page.evaluate((url) => { location.href = url; }, `${fixture.base()}/`);
    const panelA = panelFor(page, a.sessionId);
    const panelB = panelFor(page, b.sessionId);
    await expect(panelA.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });
    await expect(panelB.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });

    // A draws: its drawing is A's.
    const inA = await openDraw(page, panelA);
    await focusCanvas(inA);
    await drag(page, inA, 'r', [120, 120], [320, 240]);
    await saved(inA);
    const fileA = (await ws(inA).getAttribute('data-drawing-path'))!;
    expect(fileA).toContain(a.taskId);
    await inA.getByRole('button', { name: 'Close drawing' }).click();
    await expect(inA).toHaveCount(0);

    // B's Draw is B's own: a new one, with A's under "Other drawings" a click away.
    const inB = await openDraw(page, panelB);
    await expect(status(inB)).toHaveText('Saved to Notes when you draw');
    await expect(ws(inB)).not.toHaveAttribute('data-drawing-path', /./);
    await inB.getByRole('button', { name: 'Show drawings list' }).click();
    await expect(inB.locator('.drawing-workspace-files')).toContainText('No drawings in this task yet');
    await expect(inB.getByRole('list', { name: 'Other drawings' })).toBeVisible();
    await shot(page, 'own-drawing-b');
    await inB.getByRole('button', { name: 'Close drawing' }).click();
    await expect(inB).toHaveCount(0);

    // A again: its own drawing. Then a save meets a change made elsewhere to the same shape.
    const againA = await openDraw(page, panelA);
    await expect(ws(againA)).toHaveAttribute('data-drawing-path', fileA);
    await saved(againA);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    let raced = false;
    await page.route('**/api/drawings/file', async (route) => {
      if (!raced && route.request().method() === 'PUT') {
        raced = true;
        const latest = await (await page.request.get(`/api/drawings/file?path=${encodeURIComponent(fileA)}`)).json() as Doc;
        const other = await page.request.post('/api/drawings/update', {
          data: { path: fileA, revision: latest.revision, update: latest.scene.elements.map((e) => ({ id: e.id, x: 900 })) },
        });
        expect(other.ok(), await other.text()).toBe(true);
      }
      await route.continue();
    });
    await focusCanvas(againA);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press('Shift+ArrowRight');
    await expect(againA.locator('.drawing-workspace-conflict')).toBeVisible({ timeout: 20_000 });
    await page.unroute('**/api/drawings/file');
    await shot(page, 'conflict-before-new');

    // New drawing over the conflict opens a blank one at once.
    await againA.getByRole('button', { name: 'Show drawings list' }).click();
    await againA.locator('.drawing-workspace-files').getByRole('button', { name: 'New drawing' }).click();
    await expect(status(againA)).toHaveText('Saved to Notes when you draw', { timeout: 20_000 });
    await expect(againA.locator('.drawing-workspace-conflict')).toHaveCount(0);
    await shot(page, 'new-over-conflict');
    // The drawing left behind kept my edits: opening it asks again.
    await againA.locator('.drawing-workspace-file-list').first().locator('.drawing-workspace-file').first().click();
    await expect(ws(againA)).toHaveAttribute('data-drawing-path', fileA, { timeout: 20_000 });
    await expect(againA.locator('.drawing-workspace-conflict')).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test('Draw in a task session saves in Notes under Projects/<project>/<task>/, named from its first text; rename from the title', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.request.post('/api/sessions/quick-start', {
      data: { cwd: path.join(fixture.home(), 'projects'), message: 'Plan the review service', project: 'Drawing Fixture', engine: 'claude' },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { sessionId, taskId } = await res.json() as { sessionId: string; taskId: string };
    expect(taskId).toBeTruthy();
    await seedColumns(page, [sessionId]);
    await page.evaluate((url) => { location.href = url; }, `${fixture.base()}/`);
    const panel = panelFor(page, sessionId);
    await expect(panel.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });
    const dialog = await openDraw(page, panel);
    await expect(status(dialog)).toHaveText('Saved to Notes when you draw');

    // The first content is text: the file is named from it, in the task's folder of its project.
    await focusCanvas(dialog);
    const box = await canvasBox(dialog);
    await page.keyboard.press('t');
    await page.mouse.click(box.x + LEFT + 200, box.y + 200);
    const editor = dialog.locator('textarea.excalidraw-wysiwyg');
    await expect(editor).toBeVisible();
    await editor.fill('Order -> review\nrating, user');
    await editor.press('Escape');
    await saved(dialog);
    // The auto name renames the file right after its first save: a moment where the path on screen is gone.
    await expect.poll(async () => {
      const p = await ws(dialog).getAttribute('data-drawing-path');
      const res = p ? await page.request.get(`/api/drawings/file?path=${encodeURIComponent(p)}`) : null;
      return res?.ok() ? (await res.json() as Doc).title : '';
    }, { timeout: 30_000 }).toMatch(/^Order/);
    const named = await onServer(page, dialog);
    expect(named.path).toMatch(/^Projects\/Drawing Fixture\/[^/]+\/Order[^/]*\.excalidraw$/);
    expect(path.basename(path.dirname(named.path))).toMatch(new RegExp(`\\(${taskId.replace(/[^A-Za-z0-9_-]/g, '-')}\\)$`));
    const bar = dialog.locator('.drawing-workspace-bar');
    await expect(bar.locator('.drawing-workspace-title')).toHaveText(named.title);
    await shot(page, 'task-named');

    // Rename from the title: Enter saves, the file moves in the same folder.
    await bar.getByRole('button', { name: /^Rename drawing/ }).click();
    const input = bar.getByRole('textbox', { name: 'Drawing name' });
    await input.fill('Review service');
    await input.press('Enter');
    await expect(bar.locator('.drawing-workspace-title')).toHaveText('Review service', { timeout: 30_000 });
    await expect(ws(dialog)).toHaveAttribute('data-drawing-path', /Review service\.excalidraw$/);
    const renamed = await onServer(page, dialog);
    expect(path.dirname(renamed.path)).toBe(path.dirname(named.path));
    expect((await page.request.get(`/api/drawings/file?path=${encodeURIComponent(named.path)}`)).status()).toBe(404);
    // Escape in the name field cancels; the name stays.
    await bar.getByRole('button', { name: /^Rename drawing/ }).click();
    await bar.getByRole('textbox', { name: 'Drawing name' }).fill('Not this');
    await bar.getByRole('textbox', { name: 'Drawing name' }).press('Escape');
    await expect(bar.locator('.drawing-workspace-title')).toHaveText('Review service');
    await expect(dialog).toBeVisible();
    await shot(page, 'task-renamed');

    // Closed, it is in Notes under the project and the task's folder.
    await dialog.getByRole('button', { name: 'Close drawing' }).click();
    await expect(dialog).toHaveCount(0);
    if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
    await page.getByTestId('sidebar-core-app-notes').click();
    const folders = ['Projects', 'Projects/Drawing Fixture', path.dirname(renamed.path)];
    for (const folder of folders) {
      const node = page.locator(`.notes-tree-folder[data-node-path="${folder}"]`);
      await expect(node).toBeVisible({ timeout: 30_000 });
      if (!(await node.locator('.notes-tree-arrow.expanded').count())) await node.click();
    }
    await expect(page.locator('.notes-tree-name').filter({ hasText: 'Review service.excalidraw' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot(page, 'task-in-notes');
    expect(errors).toEqual([]);
  });

  /**
   * Outside the App page (here the composer's sketch) Make a diagram stays the editor's one call to
   * the model: its answer lands to the right of the selection as one undo step. In the App page the
   * same button goes to the drawing's own session (drawing-app-integration.spec.ts).
   */
  test('Make a diagram in the composer adds the answer beside the sketch, and one undo takes it out', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let sent: { mode?: string; elements?: unknown[] } | null = null;
    await page.route('**/api/drawings/diagram', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { elements: [
        { type: 'rectangle', id: 'd-order', x: 0, y: 0, width: 160, height: 60, label: { text: 'Order' } },
        { type: 'rectangle', id: 'd-review', x: 260, y: 0, width: 160, height: 60, label: { text: 'Review' } },
        { type: 'arrow', x: 160, y: 30, start: { id: 'd-order' }, end: { id: 'd-review' } },
      ] } });
    });
    const panel = await openSession(page);
    const dialog = await openDraw(page, panel);
    await focusCanvas(dialog);
    await drag(page, dialog, 'r', [120, 120], [260, 200]);
    await drag(page, dialog, 'r', [360, 120], [500, 200]);
    await saved(dialog);
    const before = (await onServer(page, dialog)).scene.elements.filter((e) => !e.isDeleted);
    expect(before).toHaveLength(2);
    await page.keyboard.press('v');
    await page.keyboard.press('ControlOrMeta+a');
    await dialog.getByRole('button', { name: 'Make a diagram' }).click();
    // The answer's words can rename an auto-named sketch: a read between the rename and the path
    // the dialog shows next is retried, not failed.
    const liveCount = async () => { try { return (await onServer(page, dialog)).scene.elements.filter((e) => !e.isDeleted).length; } catch { return -1; } };
    await expect.poll(liveCount, { timeout: 30_000 }).toBeGreaterThan(2);
    await saved(dialog);
    expect(sent!.mode).toBe('tidy');
    expect(sent!.elements).toHaveLength(2);
    const right = Math.max(...before.map((e) => e.x));
    const added = (await onServer(page, dialog)).scene.elements.filter((e) => !e.isDeleted && !before.some((b) => b.id === e.id));
    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...added.map((e) => e.x))).toBeGreaterThan(right);
    // No assistant here: the composer's dialog keeps the one call.
    await expect(dialog.getByRole('complementary', { name: 'Drawing assistant' })).toHaveCount(0);
    await shot(page, 'composer-diagram');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(liveCount, { timeout: 30_000 }).toBe(2);
    expect(errors).toEqual([]);
  });
});
