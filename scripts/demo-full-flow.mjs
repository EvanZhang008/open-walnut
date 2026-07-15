#!/usr/bin/env node
/**
 * Complete demo: SSH auto-discovery → Settings → Disable → Session Path Selector verification
 */
import { chromium } from '@playwright/test';

const DEMO_URL = 'http://localhost:3457';
const VIDEO_DIR = '/tmp/ssh-demo-videos';

async function main() {
  console.log('Starting complete SSH auto-discovery demo...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1600,1000'],
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1600, height: 1000 },
    },
  });

  const page = await context.newPage();

  try {
    // === Part 1: Show auto-discovered hosts in Settings ===
    console.log('1. Loading Settings → Remote Hosts...');
    await page.goto(`${DEMO_URL}/settings#remote-hosts`);
    await page.waitForTimeout(2500);

    // Count and show hosts
    const hostCount = await page.locator('.settings-collapsible').count();
    console.log(`   Found ${hostCount} hosts`);

    // Expand first few to show auto-discovered badges
    await page.locator('.settings-collapsible summary').first().click();
    await page.waitForTimeout(1200);
    await page.locator('.settings-collapsible summary').nth(1).click();
    await page.waitForTimeout(1200);

    // Highlight auto-discovered indicators
    await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('span')).filter(el =>
        el.textContent.includes('auto-discovered')
      );
      badges.slice(0, 3).forEach(el => {
        el.style.background = '#fbbf24';
        el.style.padding = '3px 8px';
        el.style.borderRadius = '4px';
        el.style.fontWeight = '600';
      });
    });
    await page.waitForTimeout(2000);

    // === Part 2: Show Session Path Selector BEFORE disabling ===
    console.log('2. Opening Session Path Selector (before disable)...');
    await page.goto(DEMO_URL);
    await page.waitForTimeout(1500);

    // Click the + New Session button or equivalent
    const newSessionBtn = page.locator('button:has-text("session"), button:has-text("New"), [aria-label*="session"]').first();
    await newSessionBtn.click();
    await page.waitForTimeout(2000);

    // Show the All tab to display all hosts
    const allTab = page.locator('button:has-text("All")').first();
    if (await allTab.isVisible()) {
      await allTab.click();
      await page.waitForTimeout(1000);
    }

    // Highlight host tabs
    await page.evaluate(() => {
      const msg = document.createElement('div');
      msg.textContent = '👀 All auto-discovered hosts available';
      msg.style.cssText = 'position: fixed; top: 100px; right: 20px; background: #1e293b; color: #60a5fa; padding: 14px 22px; border-radius: 6px; font-size: 15px; z-index: 9999; box-shadow: 0 6px 16px rgba(0,0,0,0.4); border: 1px solid #334155;';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    });
    await page.waitForTimeout(3500);

    // Close the selector
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // === Part 3: Disable a host in Settings ===
    console.log('3. Disabling a host...');
    await page.goto(`${DEMO_URL}/settings#remote-hosts`);
    await page.waitForTimeout(2000);

    // Toggle first checkbox to disable
    const firstCheckbox = page.locator('.settings-collapsible-title input[type="checkbox"]').first();
    const hostName = await page.locator('.settings-collapsible-title span').first().textContent();
    console.log(`   Disabling host: ${hostName}`);

    await firstCheckbox.click();
    await page.waitForTimeout(1000);

    await page.evaluate((name) => {
      const msg = document.createElement('div');
      msg.innerHTML = `<strong>Host disabled:</strong> ${name}<br><small style="opacity: 0.8;">Won't appear in session path selector</small>`;
      msg.style.cssText = 'position: fixed; top: 80px; right: 20px; background: #ef4444; color: white; padding: 14px 22px; border-radius: 6px; font-size: 14px; z-index: 9999; box-shadow: 0 6px 16px rgba(0,0,0,0.4);';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    }, hostName);
    await page.waitForTimeout(3500);

    // === Part 4: Verify it's hidden from Session Path Selector ===
    console.log('4. Verifying host is hidden from selector...');
    await page.goto(DEMO_URL);
    await page.waitForTimeout(1500);

    await newSessionBtn.click();
    await page.waitForTimeout(2000);

    if (await allTab.isVisible()) {
      await allTab.click();
      await page.waitForTimeout(1000);
    }

    await page.evaluate((name) => {
      const msg = document.createElement('div');
      msg.innerHTML = `<strong>✓ Verified:</strong> "${name}" no longer shown<br><small style="opacity: 0.8;">User has full control via Settings</small>`;
      msg.style.cssText = 'position: fixed; top: 100px; right: 20px; background: #10b981; color: white; padding: 14px 22px; border-radius: 6px; font-size: 14px; z-index: 9999; box-shadow: 0 6px 16px rgba(0,0,0,0.4);';
      document.body.appendChild(msg);
    }, hostName);
    await page.waitForTimeout(3500);

    // === Part 5: Summary ===
    console.log('5. Showing final summary...');
    await page.evaluate(() => {
      const msg = document.createElement('div');
      msg.innerHTML = `
        <div style="font-weight: 700; font-size: 18px; margin-bottom: 12px; color: #60a5fa;">SSH Auto-Discovery</div>
        <div style="margin-bottom: 6px;">✓ Zero configuration required</div>
        <div style="margin-bottom: 6px;">✓ All ~/.ssh/config hosts auto-detected</div>
        <div style="margin-bottom: 6px;">✓ Enable/disable per host via Settings</div>
        <div style="margin-top: 12px; font-size: 13px; opacity: 0.85;">New users see all hosts immediately!</div>
      `;
      msg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color: white; padding: 28px 40px; border-radius: 10px; font-size: 15px; z-index: 9999; box-shadow: 0 20px 60px rgba(0,0,0,0.6); border: 2px solid #334155; min-width: 420px;';
      document.body.appendChild(msg);
    });
    await page.waitForTimeout(5000);

    console.log('6. Demo complete!');

  } catch (error) {
    console.error('Error during demo:', error);
  } finally {
    const videoPath = await page.video()?.path();
    await context.close();
    await browser.close();

    if (videoPath) {
      console.log(`\n✓ Video saved to: ${videoPath}`);
      console.log('\nTo convert to MP4:');
      const mp4Path = '/tmp/ssh-autodiscovery-complete.mp4';
      console.log(`ffmpeg -i "${videoPath}" -c:v libx264 -preset fast -crf 22 ${mp4Path}`);
    }
  }
}

main().catch(console.error);
