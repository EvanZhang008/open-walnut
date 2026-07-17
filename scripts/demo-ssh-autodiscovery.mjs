#!/usr/bin/env node
/**
 * Demo video: SSH config auto-discovery feature
 * Records the full flow: Settings page → Remote Hosts → auto-discovered hosts → toggle disable
 */
import { chromium } from '@playwright/test';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const DEMO_URL = 'http://localhost:3457';
const VIDEO_DIR = '/tmp/ssh-demo-videos';

async function main() {
  console.log('Starting SSH auto-discovery demo recording...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1440,900'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();

  try {
    // 1. Navigate to homepage
    console.log('1. Loading homepage...');
    await page.goto(DEMO_URL);
    await page.waitForTimeout(2000);

    // 2. Navigate to Settings
    console.log('2. Opening Settings...');
    await page.click('[href="/settings"]');
    await page.waitForTimeout(1500);

    // 3. Scroll to Remote Hosts section
    console.log('3. Navigating to Remote Hosts...');
    await page.click('text=Remote Hosts');
    await page.waitForTimeout(2000);

    // 4. Show the auto-discovered hosts
    console.log('4. Highlighting auto-discovered hosts...');
    // Expand a few hosts to show the details
    const hostSummaries = await page.locator('.settings-collapsible summary').all();

    if (hostSummaries.length > 0) {
      // Expand first auto-discovered host
      await hostSummaries[0].click();
      await page.waitForTimeout(1500);

      // Highlight the "auto-discovered" badge
      await page.evaluate(() => {
        const badges = Array.from(document.querySelectorAll('.text-xs.text-muted'));
        badges.forEach(el => {
          if (el.textContent.includes('auto-discovered')) {
            el.style.background = 'yellow';
            el.style.padding = '2px 6px';
            el.style.borderRadius = '3px';
            setTimeout(() => {
              el.style.background = '';
            }, 2000);
          }
        });
      });
      await page.waitForTimeout(2500);
    }

    // 5. Expand another host
    if (hostSummaries.length > 1) {
      await hostSummaries[1].click();
      await page.waitForTimeout(1500);
    }

    // 6. Toggle disable a host
    console.log('5. Demonstrating toggle disable...');
    const firstCheckbox = page.locator('.settings-collapsible-title input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(1000);

    // Show visual feedback
    await page.evaluate(() => {
      const msg = document.createElement('div');
      msg.textContent = '✓ Host disabled — will not appear in session path selector';
      msg.style.cssText = 'position: fixed; top: 80px; right: 20px; background: #2d2d2d; color: #4ade80; padding: 12px 20px; border-radius: 6px; font-size: 14px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    });
    await page.waitForTimeout(3500);

    // 7. Toggle it back on
    await firstCheckbox.click();
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const msg = document.createElement('div');
      msg.textContent = '✓ Host enabled — now appears in session path selector';
      msg.style.cssText = 'position: fixed; top: 80px; right: 20px; background: #2d2d2d; color: #4ade80; padding: 12px 20px; border-radius: 6px; font-size: 14px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    });
    await page.waitForTimeout(3500);

    // 8. Show count at the top
    console.log('6. Showing summary...');
    await page.evaluate(() => {
      const hostCount = document.querySelectorAll('.settings-collapsible').length;
      const discoveredCount = Array.from(document.querySelectorAll('.text-xs.text-muted')).filter(el => el.textContent.includes('auto-discovered')).length;
      const msg = document.createElement('div');
      msg.innerHTML = `<div style="font-weight: 600; margin-bottom: 8px;">SSH Auto-Discovery Summary</div>
        <div>Total hosts: ${hostCount}</div>
        <div>Auto-discovered: ${discoveredCount}</div>
        <div style="margin-top: 8px; font-size: 12px; opacity: 0.8;">Zero configuration required!</div>`;
      msg.style.cssText = 'position: fixed; top: 100px; left: 50%; transform: translateX(-50%); background: #1e293b; color: white; padding: 20px 30px; border-radius: 8px; font-size: 14px; z-index: 9999; box-shadow: 0 8px 24px rgba(0,0,0,0.4); border: 1px solid #334155;';
      document.body.appendChild(msg);
    });
    await page.waitForTimeout(4000);

    console.log('7. Recording complete!');
    await page.waitForTimeout(1000);

  } catch (error) {
    console.error('Error during recording:', error);
  } finally {
    const videoPath = await page.video()?.path();
    await context.close();
    await browser.close();

    if (videoPath) {
      console.log(`✓ Video saved to: ${videoPath}`);
      console.log('\nTo convert to MP4:');
      console.log(`ffmpeg -i "${videoPath}" -c:v libx264 -preset fast -crf 22 /tmp/ssh-autodiscovery-demo.mp4`);
    }
  }
}

main().catch(console.error);
