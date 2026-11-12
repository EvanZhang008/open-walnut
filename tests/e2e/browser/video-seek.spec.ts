import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TINY_SILENT_MP4_BASE64 } from './fixtures/tiny-video';
import { CHAT_CONTENT_SESSION } from './chat-content-helpers';
import { VIDEO_CONTROLS_JS } from '../../../src/lib/video-controls';

// Use a real portrait recording for local acceptance; CI has a decodable silent MP4.
const bytes = process.env.VIDEO_ACCEPTANCE_FILE
  ? readFileSync(process.env.VIDEO_ACCEPTANCE_FILE)
  : Buffer.from(TINY_SILENT_MP4_BASE64, 'base64');

test('video position stays visible and seeks by click, drag and keys in a short split', async ({ page }) => {
  const errors: string[] = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('pageerror', (e) => errors.push(e.message));
  // The fixture's walkthrough.mp4 is not decodable. A decodable copy is written
  // beside it and the real file route serves it, with its own byte ranges (a
  // route answered by the test loaded a long clip only some of the time).
  await page.route('**/api/file-raw/**walkthrough.mp4*', (route) => {
    const url = new URL(route.request().url());
    const onDisk = decodeURIComponent(url.pathname.replace(/^\/api\/file-raw\/[^/]+/, ''));
    const copy = onDisk.replace(/walkthrough\.mp4$/, `walkthrough-seek-${process.pid}.mp4`);
    if (!existsSync(copy)) writeFileSync(copy, bytes);
    url.pathname = url.pathname.replace(/walkthrough\.mp4$/, `walkthrough-seek-${process.pid}.mp4`);
    return route.continue({ url: url.toString() });
  });
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, CHAT_CONTENT_SESSION);
  // The initial document request is a launch, not SPA navigation. All subsequent
  // navigation and media controls are real input, including opening the file link.
  await page.request.get('/api/config');
  await page.evaluate(() => { window.location.href = 'http://localhost:3457/'; });
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CHAT_CONTENT_SESSION}"]`);
  await expect(panel.locator('.session-history')).toContainText('Video recorded and delivered', { timeout: 30_000 });
  await panel.locator('a.file-link', { hasText: 'walkthrough.mp4' }).first().click();
  const video = panel.locator('.fv-media-preview video');
  const seek = panel.getByRole('slider', { name: 'Video position' });
  const bar = panel.getByRole('group', { name: 'Video controls' });
  await expect(seek).toBeVisible();
  await expect(seek).toBeEnabled({ timeout: 20_000 });
  const duration = await video.evaluate((v) => (v as HTMLVideoElement).duration);
  expect(duration).toBeGreaterThan(0);
  const assertAt = async (fraction: number) => {
    await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime / (v as HTMLVideoElement).duration)).toBeCloseTo(fraction, 1);
  };
  let rect = (await seek.boundingBox())!;
  await page.mouse.click(rect.x + rect.width * .6, rect.y + rect.height / 2);
  await assertAt(.6);
  await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .4, rect.y + rect.height / 2, { steps: 8 });
  // Assert before release: the frame must follow a held drag, not only change.
  await assertAt(.4);
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).seeking)).toBe(false);
  await page.screenshot({ path: '/tmp/walnut-video-seek/held-drag-frame.png' });
  const heldFrame = await video.screenshot();
  await page.mouse.move(rect.x + rect.width * .25, rect.y + rect.height / 2, { steps: 8 });
  await assertAt(.25);
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).seeking)).toBe(false);
  // Still held: the picture itself followed the pointer, not only the clock.
  if (process.env.VIDEO_ACCEPTANCE_FILE) expect((await video.screenshot()).equals(heldFrame)).toBe(false);
  await page.mouse.up();
  await assertAt(.25);
  await seek.focus();
  await seek.press('Home');
  await seek.press('ArrowRight');
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeCloseTo(Math.min(duration, 10), 1);
  await seek.press('ArrowLeft');
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeCloseTo(Math.max(0, Math.min(duration, 10) - 3), 1);
  await seek.press('End');
  await assertAt(1);
  await seek.press('Home');
  await assertAt(0);
  await panel.getByRole('combobox', { name: 'Playback speed' }).selectOption('4');
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).playbackRate)).toBe(4);
  await panel.getByRole('button', { name: 'Forward 10 seconds', exact: true }).click();
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeCloseTo(Math.min(duration, 10), 1);
  await page.setViewportSize({ width: 960, height: 600 });
  await expect(seek).toBeVisible();
  const [barBox, paneBox] = await Promise.all([bar.boundingBox(), panel.locator('.file-content-view').boundingBox()]);
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height);
  rect = (await seek.boundingBox())!;
  expect(await seek.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  })).toBe(true);
  await page.mouse.click(rect.x + rect.width * .7, rect.y + rect.height / 2);
  await assertAt(.7);
  expect(await video.evaluate((v) => (v as HTMLVideoElement).controls)).toBe(false);
  await expect(bar.locator('.wn-video-time')).toContainText(' / ');
  // Automated browsers cannot play media. A blocked play must leave seek usable.
  await bar.getByRole('button', { name: 'Play video', exact: true }).click();
  await expect(bar.getByRole('status')).toContainText('Playback could not start');
  await expect(seek).toBeEnabled();
  await page.screenshot({ path: '/tmp/walnut-video-seek/webkit-seek.png' });
  expect(errors).toEqual([]);
});

test('dynamic videos reset metadata, recover from failures and keep one timeline when moved', async ({ page }) => {
  await page.setContent(`<div id="a"><video controls></video></div><div id="b"></div>`);
  await page.evaluate(VIDEO_CONTROLS_JS);
  const seek = page.getByRole('slider', { name: 'Video position' });
  await expect(seek).toBeDisabled();
  const media = async (duration: number, currentTime = 0) => page.locator('video').evaluate((el, args) => {
    const v = el as HTMLVideoElement;
    Object.defineProperty(v, 'duration', { value: args.duration, configurable: true });
    Object.defineProperty(v, 'readyState', { value: 1, configurable: true });
    Object.defineProperty(v, 'currentTime', { value: args.currentTime, writable: true, configurable: true });
    v.dispatchEvent(new Event('loadedmetadata'));
  }, { duration, currentTime });
  await media(7325, 3661);
  await expect(page.locator('.wn-video-time')).toHaveText('1:01:01 / 2:02:05');
  await expect(seek).toBeEnabled();
  await page.locator('video').evaluate((v) => v.dispatchEvent(new Event('error')));
  await expect(seek).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('could not load');
  await page.locator('video').evaluate((v) => v.dispatchEvent(new Event('loadstart')));
  await media(30);
  await expect(seek).toBeEnabled();
  await expect(page.getByRole('status')).toBeHidden();
  await media(Infinity);
  await expect(seek).toBeDisabled();
  await expect(page.locator('.wn-video-time')).toHaveText('0:00 / Live');
  await media(NaN);
  await expect(seek).toBeDisabled();
  await page.evaluate(() => document.getElementById('b')!.appendChild(document.querySelector('video')!));
  await expect(page.locator('#b .wn-video-controls')).toHaveCount(1);
  await page.evaluate(() => {
    const v = document.createElement('video'); v.controls = true;
    document.getElementById('a')!.appendChild(v);
  });
  await expect(page.locator('.wn-video-controls')).toHaveCount(2);
  await page.evaluate(VIDEO_CONTROLS_JS);
  await expect(page.locator('.wn-video-controls')).toHaveCount(2);
  await page.locator('#b video').evaluate((v) => v.remove());
  await expect(page.locator('.wn-video-controls')).toHaveCount(1);
  await page.evaluate(() => {
    const v = document.createElement('video'); v.autoplay = true; v.loop = true;
    document.body.appendChild(v);
  });
  await expect(page.locator('.wn-video-controls')).toHaveCount(1);
  // Authored video keeps its native captions/PiP controls alongside the timeline.
  expect(await page.locator('#a video').evaluate((v) => (v as HTMLVideoElement).controls)).toBe(true);
});
