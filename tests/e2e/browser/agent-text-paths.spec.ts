import fs from 'node:fs/promises';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { discoverBrowserFixture } from './codex-test-audit';
import { TINY_SILENT_MP4_BASE64 } from './fixtures/tiny-video';
import { press as click } from './real-press';
import { closeLinkedLetter, dragSelect, openSessionBoard, showPointer, tabTo } from './agent-text-entry-helpers';

const stamp = Date.now().toString(36);
const project = `Agent links ${stamp}`;
const base = process.env.AGENT_TEXT_URL ?? 'http://localhost:3457';
const copiedOwner = process.env.AGENT_TEXT_COPIED_OWNER;
const ownerKey = process.env.AGENT_TEXT_OWNER ?? `project:${project.toLowerCase()}`;
let owner = '', picture = '', document = '', movie = '', missing = '', letter = '', workerId = '', threadId = '';
const made: string[] = [];
const letters: string[] = [];
test.setTimeout(180_000);
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: 'on' });

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }); });
  await showPointer(page);
});

async function enter(page: Page) {
  await page.setContent(`<a href="${base}/">Open Walnut</a>`);
  await click(page, page.getByRole('link', { name: 'Open Walnut', exact: true }));
  await expect(page.getByTestId('sidebar-org')).toBeVisible({ timeout: 30_000 });
}
async function threads(page: Page) {
  await enter(page);
  await click(page, page.getByTestId('sidebar-org'));
  const row = page.locator(`[data-testid="org-channel"][data-key="${ownerKey}"]`);
  await click(page, row);
  const tab = page.getByTestId('org-top-threads');
  // The side bar's switch is on screen as soon as the node is; the tab is only checked once it says the bar is open.
  const rail = page.getByTestId('org-rail-toggle');
  await expect(rail).toBeVisible({ timeout: 30_000 });
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await click(page, rail);
  await expect(rail).toHaveAttribute('aria-pressed', 'true');
  await click(page, tab);
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'threads');
}
async function expectImage(page: Page) {
  const image = page.locator('.file-viewer-overlay img').first();
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
}
async function closeFile(page: Page) {
  if (process.env.AGENT_TEXT_SHOTS) {
    await fs.mkdir(process.env.AGENT_TEXT_SHOTS, { recursive: true });
    const slug = test.info().title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 100);
    await page.screenshot({ path: `${process.env.AGENT_TEXT_SHOTS}/${slug}-viewer.png` });
  }
  await click(page, page.locator('.file-viewer-close'));
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0);
}

const shown = (url: string) => url.replace(/([#?&](?:token|t)=)[^&#]*/gi, '$1<set>');
const heard: string[] = [];

// Tokens and href values must stay out of hand-off diagnostics.
async function traceChannels(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { BroadcastChannel?: typeof BroadcastChannel; __bcTrace?: unknown[] };
    const Native = w.BroadcastChannel;
    if (!Native || w.__bcTrace) return;
    const trace: unknown[] = (w.__bcTrace = []);
    const pick = (d: unknown) => {
      if (!d || typeof d !== 'object') return { type: typeof d };
      const o = d as Record<string, unknown>;
      return { ask: o.ask, answer: o.answer, id: o.id, letterId: o.letterId, taskId: o.taskId, kind: o.kind, token: Boolean(o.token), href: Boolean(o.href), keys: Object.keys(o).sort() };
    };
    const note = (row: Record<string, unknown>) => {
      const entry = { t: Math.round(performance.now()), page: location.pathname, ...row };
      trace.push(entry);
      console.log(`[bc-trace] ${JSON.stringify(entry)}`);
    };
    let count = 0;
    class Traced extends Native {
      readonly ch = ++count;
      constructor(name: string) {
        super(name);
        note({ ev: 'open', name, ch: this.ch });
        this.addEventListener('message', (m) => note({ ev: 'message', name, ch: this.ch, data: pick((m as MessageEvent).data) }));
      }
      postMessage(data: unknown) { note({ ev: 'post', name: this.name, ch: this.ch, data: pick(data) }); super.postMessage(data); }
      close() { note({ ev: 'close', name: this.name, ch: this.ch }); super.close(); }
    }
    w.BroadcastChannel = Traced;
  });
  const hear = (p: Page) => p.on('console', (m) => heard.push(`[${shown(p.url())}] ${m.type()}: ${m.text()}`));
  context.pages().forEach(hear);
  context.on('page', hear);
}

/** Every page of the context as it is now: its address, a screenshot, its channel trace. Closes none. */
async function dumpPages(context: BrowserContext, label: string) {
  const info = test.info();
  const pages = context.pages();
  const lines = [`${label}: ${pages.length} page(s)`];
  for (const [i, p] of pages.entries()) {
    const trace = await p.evaluate(() => (window as unknown as { __bcTrace?: unknown[] }).__bcTrace ?? null).catch(() => null);
    lines.push(`page ${i}: ${shown(p.url())} title=${JSON.stringify(await p.title().catch(() => ''))}`, `  bc-trace ${JSON.stringify(trace)}`);
    const shot = info.outputPath(`${label}-page-${i}.png`);
    await p.screenshot({ path: shot }).catch((e) => lines.push(`  screenshot failed: ${String(e)}`));
    await info.attach(`${label}-page-${i}`, { path: shot, contentType: 'image/png' }).catch(() => {});
    if (process.env.AGENT_TEXT_SHOTS) await fs.copyFile(shot, `${process.env.AGENT_TEXT_SHOTS}/${label}-page-${i}.png`).catch(() => {});
  }
  lines.push('console:', ...heard);
  console.log(lines.join('\n'));
  await info.attach(`${label}-diagnostics.txt`, { body: lines.join('\n'), contentType: 'text/plain' });
}

test.beforeAll(async ({ request }) => {
  if (new URL(base).port === '3456') throw new Error('Agent text acceptance must use an isolated server');
  const { fixtureRoot } = process.env.AGENT_TEXT_FIXTURE_ROOT
    ? { fixtureRoot: process.env.AGENT_TEXT_FIXTURE_ROOT }
    : await discoverBrowserFixture(3457);
  await fs.mkdir(`${fixtureRoot}/projects/walnut`, { recursive: true });
  picture = `${fixtureRoot}/projects/walnut/agent-links.png`;
  document = `${fixtureRoot}/projects/walnut/agent-links.txt`;
  movie = `${fixtureRoot}/projects/walnut/agent-links.mp4`;
  missing = `${fixtureRoot}/projects/walnut/agent-missing.png`;
  await fs.writeFile(movie, Buffer.from(TINY_SILENT_MP4_BASE64, 'base64'));
  await fs.copyFile(process.env.AGENT_TEXT_PATH ?? `${process.cwd()}/web/public/icon-192.png`, picture);
  await fs.writeFile(document, 'Agent link file\nLine two\nLine three\nLine four\n');
  const worker = await request.post('/api/tasks', { data: { title: `Output worker ${stamp}`, project, source: 'local' } });
  workerId = (await worker.json()).task.id;
  made.push(workerId);
  const other = await request.post('/api/tasks', { data: { title: `Other output ${stamp}`, project, source: 'local' } });
  expect(other.ok(), await other.text()).toBeTruthy();
  made.push((await other.json()).task.id);
  if (copiedOwner) owner = copiedOwner;
  else {
    const res = await request.post('/api/v1/org/contact', { data: { to: project } });
    owner = (await res.json()).task.id;
    made.push(owner);
  }
  expect((await (await request.get(`/api/tasks/${owner}`)).json()).task.org_role).toBe('lead');
  const envelope = await request.post('/api/v1/human-inbox', { data: { subject: project, type: 'info', text: `Design: ${picture}`, markdown: `Design: ${picture}` } });
  expect(envelope.ok(), await envelope.text()).toBeTruthy();
  letter = (await envelope.json()).id;
  letters.push(letter);
  const opened = await request.post(`/api/v1/tasks/${owner}/threads/open`, { data: {
    title: 'Clickable agent output', from: 'node', state: 'answered',
    text: `Answer image: ${picture}\n\nFile: ${document}:2-3\n\n${'Long answer. '.repeat(140)}\n\nAt the end: ${document}:4`,
  } });
  expect(opened.ok(), await opened.text()).toBeTruthy();
  const thread = (await opened.json()).thread;
  threadId = thread.id;
  const updated = await request.patch(`/api/v1/tasks/${owner}/threads/${thread.id}`, { data: {
    reply: `Design: ${picture}\n\nFile: ${document}:2-3\n\nVideo: ${movie}\n\nMissing: ${missing}\n\n[Website](https://example.com/design) <task-ref id="${workerId}" label="Worker"/> ${letter}`,
  } });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const brief = await request.put(`/api/v1/tasks/${owner}/brief`, { data: { content: `### Needs you\n\nNone.\n\n### Working\n\nDesign: ${picture}\n\n### Waiting / snoozed\n\nNone.` } });
  expect(brief.ok(), await brief.text()).toBeTruthy();
});

test('video asks to play after a pointer click; missing files recover without a page reload', async ({ page }) => {
  await threads(page);
  const card = page.getByTestId('org-thread').filter({ hasText: 'Clickable agent output' });
  await click(page, card.locator(`a.file-link[data-file-path="${movie}"]`));
  const video = page.locator('.file-viewer-overlay video');
  await expect(video).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBeGreaterThan(0);
  // A test browser never plays media (src/lib/automation-silence.ts counts every play it
  // refuses), so the click is proven by its ask to play, and the video stays paused.
  const plays = () => page.evaluate(() => (window as unknown as { __walnutAudio?: { plays: number } }).__walnutAudio?.plays ?? -1);
  const before = await plays();
  expect(before, 'the page silencer runs').toBeGreaterThanOrEqual(0);
  // The person presses the controls' Play: Chromium's headless build draws its controls as a
  // row of buttons and a click on the picture asks nothing (nightly 43447259774); WebKit has
  // no such button, and its picture takes the click.
  const playButton = page.locator('.file-viewer-overlay').getByRole('button', { name: /^Play( video)?$/ });
  await click(page, (await playButton.count()) ? playButton.first() : video);
  await expect.poll(plays).toBeGreaterThan(before);
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await page.waitForTimeout(750);
  await closeFile(page);
  const absent = card.locator(`a.file-link[data-file-path="${missing}"]`);
  await click(page, absent);
  await expect(page.getByTestId('file-viewer-missing')).toContainText("Couldn't find", { timeout: 30_000 });
  await closeFile(page);
  await fs.copyFile(picture, missing);
  await click(page, absent);
  await expectImage(page);
  await closeFile(page);
});

test('task, letter and external URL links activate through pointer and keyboard input', async ({ page, context }) => {
  await threads(page);
  const summary = page.getByTestId('org-thread').filter({ hasText: 'Clickable agent output' }).getByTestId('org-thread-reply');
  await click(page, summary.locator('a.letter-link'));
  await expect(page.locator('.hib-reader')).toContainText(project);
  // A letter a link opened closes the Notifications panel it opened with it: one press returns to the link.
  await closeLinkedLetter(page);
  await context.route('https://example.com/design', route => route.fulfill({ contentType: 'text/html', body: '<h1>External design</h1>' }));
  const website = summary.locator('a[href="https://example.com/design"]');
  await expect(website).toHaveAttribute('target', '_blank');
  const popup = context.waitForEvent('page', { timeout: 15_000 });
  await click(page, website);
  const external = await popup;
  await expect(external.getByRole('heading', { name: 'External design' })).toBeVisible();
  await external.close();
  await click(page, summary.locator('a.task-link'));
  const openedTask = page.getByRole('complementary', { name: 'Opened task', exact: true });
  await expect(openedTask.getByRole('heading', { name: `Output worker ${stamp}`, exact: true })).toBeVisible();
  await click(page, openedTask.getByRole('button', { name: 'Close', exact: true }));
  await expect(openedTask).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: /^Send a message to this session/ }).first();
  await tabTo(page, composer, summary.locator('a.letter-link'));
  await page.keyboard.press('Enter');
  await expect(page.locator('.hib-reader')).toContainText(project);
  await closeLinkedLetter(page);
  await tabTo(page, composer, summary.locator('a.task-link'));
  await page.keyboard.press('Enter');
  await expect(openedTask.getByRole('heading', { name: `Output worker ${stamp}`, exact: true })).toBeVisible();
  await click(page, openedTask.getByRole('button', { name: 'Close', exact: true }));
  await tabTo(page, composer, website);
  const keyboardPopup = context.waitForEvent('page', { timeout: 15_000 });
  await page.keyboard.press('Enter');
  const keyboardExternal = await keyboardPopup;
  await expect(keyboardExternal.getByRole('heading', { name: 'External design' })).toBeVisible();
  await keyboardExternal.close();
  await threads(page);
  const link = page.getByTestId('org-thread').filter({ hasText: 'Clickable agent output' }).getByTestId('org-thread-reply').locator(`a.file-link[data-file-path="${document}"]`);
  await click(page, link);
  await closeFile(page);
  // The node's own chat composer: the Threads side bar follows it in Tab order.
  await tabTo(page, page.getByRole('textbox', { name: /^Send a message to this session/ }).first(), link);
  await page.keyboard.press('Enter');
  await expect(page.locator('.file-viewer-overlay .cm-content')).toContainText('Line two', { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0);
});

test('long agent output keeps links after scrolling, window resizing and text selection', async ({ page }) => {
  await threads(page);
  const card = page.getByTestId('org-thread').filter({ hasText: 'Clickable agent output' });
  await click(page, card.getByTestId('org-thread-history'));
  await page.setViewportSize({ width: 1024, height: 720 });
  const answer = card.getByTestId('org-thread-answer-body');
  const unfold = card.getByTestId('org-thread-answer-body-more');
  if (await unfold.isVisible() && await unfold.getAttribute('aria-expanded') !== 'true') await click(page, unfold);
  const caption = answer.locator('a.inline-image-path');
  await click(page, caption);
  await expectImage(page);
  await closeFile(page);
  const text = answer.getByText('Long answer.', { exact: false }).last();
  expect((await dragSelect(page, text, 160)).length).toBeGreaterThan(0);
  await page.mouse.wheel(0, -500);
  await page.setViewportSize({ width: 1280, height: 900 });
  await click(page, caption);
  await expectImage(page);
  await closeFile(page);
  const tail = answer.locator(`a.file-link[data-file-path="${document}"][data-file-line="4"]`);
  const scroll = await answer.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: Math.min(innerHeight - 70, box.top + 160) };
  });
  await page.mouse.move(scroll.x, scroll.y);
  await page.mouse.wheel(0, 2400);
  await expect(tail).toBeVisible();
  await click(page, tail);
  await expect(page.locator('.file-viewer-overlay .cm-content')).toContainText('Line four', { timeout: 30_000 });
  await closeFile(page);
});

for (const deferred of [false, true]) test(`HTML letter references open in the original window, deferred=${deferred}`, async ({ page, request, context }) => {
  const subject = `HTML agent links ${deferred} ${stamp}`;
  const html = `<html lang="en"><head><title>Agent output</title></head><body data-layout="report"><p>Literal * stars and # words.</p><p>Picture: ${picture}</p><p>File: ${document}:2-3</p><p>Letter: ${letter}</p><p><task-ref id="${workerId}" label="Output worker"/></p><img src="https://example.com/tracker.png"><button class="wn-del">Plain button</button>${deferred ? '<p>' + 'Long report. '.repeat(100000) + '</p>' : ''}</body></html>`;
  const sent = await request.post('/api/v1/human-inbox', { data: { subject, type: 'info', text: 'HTML reference acceptance', html } });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const id = (await sent.json()).id;
  letters.push(id);
  await traceChannels(context);
  try {
    await enter(page);
    await click(page, page.getByRole('button', { name: 'Notifications', exact: true }));
    const center = page.locator('.notification-panel');
    await click(page, center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }));
    await click(page, center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject'));
    const frame = page.frameLocator('.hib-reader .hib-html-frame');
    await expect(frame.locator('body')).toHaveAttribute('data-layout', 'report');
    await expect(frame.getByText('Literal * stars and # words.', { exact: true })).toBeVisible();
    for (const wanted of [picture, document, picture]) {
      await click(page, frame.locator('a[data-walnut-ref="file"]').filter({ hasText: wanted }));
      const viewer = page.locator('.file-viewer-overlay');
      await expect(viewer).toBeVisible({ timeout: 30_000 });
      if (wanted === picture) {
        await expectImage(page);
        await page.setViewportSize({ width: 380, height: 740 });
        const image = viewer.locator('img').first();
        await expect.poll(() => image.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(180);
        // The file page keeps Download in its ⋯ menu: reachable at this width, then the menu row.
        const more = viewer.getByRole('button', { name: 'More file actions' });
        await expect(more).toBeVisible();
        await click(page, more);
        const download = page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Download' });
        await expect(download).toBeVisible();
        await expect.poll(() => download.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return r.left >= 0 && r.right <= innerWidth && !!hit && (hit === el || el.contains(hit));
        })).toBe(true);
        const saved = page.waitForEvent('download');
        await click(page, download);
        expect((await saved).suggestedFilename()).toBe(picture.split('/').pop());
        await page.setViewportSize({ width: 1280, height: 900 });
      } else await expect(viewer.locator('.cm-content')).toContainText('Line two');
      await closeFile(page);
      await expect(page.locator('.hib-reader')).toContainText(subject);
    }
    await expect(frame.locator('img')).toHaveJSProperty('naturalWidth', 0);
    await click(page, frame.locator('a[data-walnut-ref="letter"]'));
    await expect(page.locator('.hib-reader')).toContainText(project);
    await expect.poll(() => context.pages().length, { timeout: 10_000 }).toBe(1);
  } catch (err) {
    // Kept before the failure is reported: every page as it is (none closed), with its trace.
    await dumpPages(context, `html-deferred-${deferred}`);
    throw err;
  }
});

test('Board page and stored posts use the same file and letter links after typing and resizing', async ({ page, request }) => {
  const task = copiedOwner ?? 'pw-task-codepath';
  const path = `/api/v1/tasks/${task}/board`;
  const html = `<h1>Agent references</h1><section id="outputs"><p>Picture: ${picture}</p><p><a href="${document}:2-3">Source lines</a></p><p>Letter: ${letter}</p><walnut-thread id="outputs" title="Outputs"></walnut-thread></section>`;
  expect((await request.put(path, { data: { html } })).ok()).toBeTruthy();
  expect((await request.post(`${path}/threads/outputs`, { data: { text: `Picture: ${picture}\n\nFile: ${document}:2-3\n\nLetter: ${letter}` }, headers: { 'x-walnut-caller-sid': process.env.AGENT_TEXT_COPIED_SESSION ?? 'pw-codepath-session' } })).ok()).toBeTruthy();
  try {
    if (copiedOwner) {
      await threads(page);
      await click(page, page.getByTestId('org-top-task'));
      await click(page, page.getByTestId('org-task-mode-board'));
    } else {
      await enter(page);
      const search = page.locator('.todo-search-input');
      await click(page, search);
      await page.keyboard.type('Code block paths fixture', { delay: 20 });
      const row = page.locator(`.todo-panel-item[data-task-id="${task}"]`);
      await click(page, row.locator('.todo-item-title'));
      const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-codepath-session"]');
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await openSessionBoard(page, panel);
    }
    const pane = page.getByTestId('task-board-pane');
    await click(page, pane.getByTestId('board-view-custom'));
    const frame = page.frameLocator('.task-board-frame');
    for (const [link, wanted] of [[frame.locator('p a[data-walnut-ref="file"]').first(), picture], [frame.getByRole('link', { name: 'Source lines' }), document], [frame.locator('walnut-thread a.file-link').first(), picture]] as const) {
      await click(page, link);
      await expect(page.getByRole('dialog', { name: "Choose the path's source", exact: true })).toHaveCount(0);
      const viewer = page.locator('.file-viewer-overlay');
      await expect(viewer).toBeVisible({ timeout: 30_000 });
      if (wanted === picture) await expectImage(page);
      else await expect(viewer.locator('.cm-content')).toContainText('Line two');
      await closeFile(page);
    }
    await click(page, frame.locator('walnut-thread .wn-reply'));
    const draft = pane.getByPlaceholder('Reply in Outputs. It goes to the leader.');
    await expect(draft).toBeVisible();
    await click(page, draft);
    await page.keyboard.type('Keep this Board reply while I resize.', { delay: 12 });
    await page.setViewportSize({ width: 1024, height: 720 });
    await expect(draft).toHaveValue('Keep this Board reply while I resize.');
    await click(page, frame.locator('walnut-thread a.letter-link'));
    await expect(page.locator('.hib-reader')).toContainText(project);
    await closeLinkedLetter(page);
    await expect(frame.locator('walnut-thread')).toBeVisible();
    await expect(draft).toHaveValue('Keep this Board reply while I resize.');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.phone-topbar[data-layer="board"]')).toBeVisible();
    await expect(pane.locator('xpath=ancestor::*[contains(@class, "session-panel-split")]')).toHaveClass(/is-chat-collapsed/);
    await expect(frame.locator('walnut-thread')).toBeVisible();
    await expect(draft).toHaveValue('Keep this Board reply while I resize.');
    const boardFrameBox = await page.locator('.task-board-frame').boundingBox();
    expect(boardFrameBox).not.toBeNull();
    await page.mouse.move(boardFrameBox!.x + boardFrameBox!.width / 2, boardFrameBox!.y + 100);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => {
      const linkBox = await frame.locator('walnut-thread a.letter-link').boundingBox();
      const replyBox = await pane.getByTestId('board-reply-dock').boundingBox();
      return !!linkBox && !!replyBox && linkBox.y + linkBox.height <= replyBox.y;
    }).toBe(true);
    await expect(draft).toHaveValue('Keep this Board reply while I resize.');
    await click(page, frame.locator('walnut-thread a.letter-link'));
    await expect(page.locator('.hib-reader')).toContainText(project);
    // On a phone-width page the Notifications layer the link opened goes with the reader as well.
    await closeLinkedLetter(page);
    await expect(page.locator('.phone-topbar[data-layer="notifications"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 720 });
    await expect(frame.locator('walnut-thread')).toBeVisible();
    await expect(draft).toHaveValue('Keep this Board reply while I resize.');
  } finally {
    await request.delete(path);
  }
});

test('a tokenless reference never opens a file without an explicit user click', async ({ page }) => {
  await page.setContent(`<a href="${base}/open-ref?kind=file&path=${encodeURIComponent(document)}">Open reference</a>`);
  await click(page, page.getByRole('link', { name: 'Open reference', exact: true }));
  await expect(page.getByRole('heading', { name: 'Open in Walnut', exact: true })).toBeVisible();
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0);
  await click(page, page.getByRole('button', { name: 'Open', exact: true }));
  await expect(page.locator('.file-viewer-overlay .cm-content')).toContainText('Line two', { timeout: 30_000 });
  await closeFile(page);
});

test('an expired document file reference asks for its source again and never reads a guessed copy', async ({ page }) => {
  const files: string[] = [];
  page.on('request', (req) => { if (/\/api\/(?:files\/|file-content|file-raw|local-image)/.test(req.url())) files.push(req.url()); });
  await page.setContent(`<a href="${base}/open-ref#token=0123456789abcdef0123456789abcdef&kind=file&path=${encodeURIComponent(document)}">Open old reference</a>`);
  await click(page, page.getByRole('link', { name: 'Open old reference', exact: true }));
  await expect(page.getByRole('status').filter({ hasText: 'Waiting for the source document' })).toContainText('reopen it and click the path again');
  await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0);
  expect(files).toEqual([]);
});

test.afterEach(async ({ page, context }, info) => {
  if (process.env.AGENT_TEXT_SHOTS) {
    await fs.mkdir(process.env.AGENT_TEXT_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.AGENT_TEXT_SHOTS}/${info.title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 100)}.png` });
  }
  // The channel trace of every page the test left open (only the tests that armed traceChannels have one).
  for (const p of context.pages()) {
    const trace = await p.evaluate(() => (window as unknown as { __bcTrace?: unknown[] }).__bcTrace ?? null).catch(() => null);
    if (trace) console.log(`[bc-trace] ${info.title} ${shown(p.url())} ${JSON.stringify(trace)}`);
  }
  heard.length = 0;
});

test.afterAll(async ({ request }) => {
  if (copiedOwner && threadId) await request.delete(`/api/v1/tasks/${owner}/threads/${threadId}`);
  for (const id of letters) await request.delete(`/api/v1/human-inbox/${id}`);
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`);
});

test('thread summary paths and answer captions open without navigating; repeat, close and reopen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await threads(page);
  const card = page.getByTestId('org-thread').filter({ hasText: 'Clickable agent output' });
  const summary = card.getByTestId('org-thread-reply');
  const link = summary.locator(`a.file-link[data-file-path="${picture}"]`);
  await expect(link).toBeVisible();
  await expect(summary.locator('img')).toHaveCount(0);
  await expect(summary.locator('a.task-link')).toHaveCount(1);
  await expect(summary.locator('a.letter-link')).toHaveCount(1);
  await expect(summary.locator('a[href="https://example.com/design"]')).toHaveCount(1);
  for (let i = 0; i < 2; i++) {
    await click(page, link);
    await expect(page.locator('.file-viewer-overlay')).toBeVisible();
    await expectImage(page);
    await closeFile(page);
    await expect(card).toBeVisible();
  }
  const fileLink = summary.locator(`a.file-link[data-file-path="${document}"]`);
  await click(page, fileLink);
  await expect(page.locator('.file-viewer-overlay .cm-content')).toContainText('Line two', { timeout: 30_000 });
  await closeFile(page);
  await click(page, card.getByTestId('org-thread-history'));
  const unfold = card.getByTestId('org-thread-answer-body-more');
  if (await unfold.isVisible() && await unfold.getAttribute('aria-expanded') !== 'true') await click(page, unfold);
  const caption = card.getByTestId('org-thread-answer-body').locator('a.inline-image-path');
  await expect(caption).toBeVisible();
  await click(page, caption);
  await expectImage(page);
  await closeFile(page);
  await click(page, card.getByTestId('org-thread-history'));
  expect(new URL(page.url()).pathname).toBe('/org');
  expect(errors).toEqual([]);
});

test('Brief and inbox preview open the same path; the preview does not open the letter as well', async ({ page }) => {
  await threads(page);
  await click(page, page.getByTestId('org-top-brief'));
  const brief = page.getByTestId('org-brief-body');
  await click(page, brief.locator(`a.file-link[data-file-path="${picture}"]`));
  await expectImage(page);
  await closeFile(page);
  await click(page, page.getByRole('button', { name: 'Notifications', exact: true }));
  const center = page.locator('.notification-panel');
  await click(page, center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }));
  const row = center.locator('.hib-row').filter({ hasText: project });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await click(page, row.locator('a.file-link'));
  await expectImage(page);
  await expect(page.locator('.hib-reader')).toHaveCount(0);
  await closeFile(page);
  await click(page, row.locator('.hib-subject'));
  await expect(page.locator('.hib-reader')).toBeVisible();
  await click(page, page.locator('.hib-reader a.inline-image-path'));
  await expectImage(page);
});
