#!/usr/bin/env node
/**
 * Record a crisp 4K walkthrough of Open Walnut's first-run onboarding against a
 * clean-room server, telling the 3-path story:
 *   1. land on a fresh install → "Get Walnut talking" onboarding banner
 *   2. highlight the hero paste-into-Claude-Code block (path 2)
 *   3. open Settings → AI Provider (path 3, the manual Bedrock form)
 *
 * Reuses the proven record-webapp-video skill recorder (CDP screencast → ffmpeg,
 * injected cursor, requestAnimationFrame repaint, wallclock timestamps) so the
 * output is sharp and the static holds actually produce frames.
 *
 * Usage: node scripts/onboarding-record.mjs --url http://localhost:3457 --out demo/onboarding.mp4
 */
import path from 'node:path';
import os from 'node:os';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const URL = arg('url', 'http://localhost:3457');
const OUT = arg('out', 'demo/onboarding.mp4');

const RECORDER = path.join(os.homedir(), '.claude/skills/record-webapp-video/scripts/recorder.mjs');
const { launchBrowser, recordSegment, smoothMove, smoothClick, beat } = await import(RECORDER);

const log = (...a) => console.log('[onboarding-record]', ...a);

const browser = await launchBrowser();
const outDir = path.dirname(OUT);
const name = path.basename(OUT).replace(/\.mp4$/, '');

const result = await recordSegment(browser, {
  name,
  baseUrl: URL,
  outDir,
  run: async (page) => {
    log('loading onboarding …');
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await beat(3000); // let the banner settle from the health WebSocket

    // Beat 1: hold on the onboarding banner so a viewer can read it.
    await page.waitForSelector('text=Get Walnut talking', { timeout: 15_000 }).catch(() => {});
    await beat(3000);

    // Beat 2: move the cursor to the hero paste block and dwell.
    const hero = page.locator('.setup-command-multiline').first();
    if (await hero.count()) {
      await smoothMove(page, hero).catch(() => {});
      await beat(3000);
    }

    // Beat 3: click the manual path — Settings → AI Provider — and show the form.
    const settingsBtn = page.locator('text=Settings → AI Provider').first();
    if (await settingsBtn.count()) {
      await smoothClick(page, settingsBtn).catch(() => {});
      await beat(4000); // let the AI Provider settings render
    }
    await beat(1500);
  },
});

log(`recorded → ${result.mp4}  (${result.frames} frames / ${result.secs?.toFixed(1)}s)`);
await browser.close();
