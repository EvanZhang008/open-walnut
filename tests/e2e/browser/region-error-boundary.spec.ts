// A part of a session's window that crashes keeps its crash to itself.
//
// 2026-11-18: one looping control in the composer replaced the whole session panel,
// with no way back but closing it. Every part named in ERROR_REGIONS
// (web/src/components/common/RegionErrorBoundary.tsx) is crashed here on purpose
// (its test hook), and each time: the error and its Retry show in that part only,
// the conversation and the other column keep working, and Retry brings the part
// back. A region added there with no scenario here fails the first test.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession, directControl,
} from './composer-controls-overflow-helpers';

const REGIONS_SOURCE = path.resolve(process.cwd(), 'web/src/components/common/RegionErrorBoundary.tsx');

function declaredRegions(): string[] {
  const source = fs.readFileSync(REGIONS_SOURCE, 'utf8');
  const block = /export const ERROR_REGIONS = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s*'?([\w-]+)'?\s*:/gm)].map((m) => m[1]);
}

async function crash(page: Page, region: string, key: string): Promise<void> {
  await page.evaluate(({ region, key }) => {
    window.dispatchEvent(new CustomEvent('walnut:test-crash', { detail: { region, key } }));
  }, { region, key });
}

async function open(page: Page): Promise<{ panel: Locator; other: Locator }> {
  // The crash hook listens only on a page that turned it on before it loaded.
  await page.addInitScript(() => { (window as { __walnutTestCrashHooks?: boolean }).__walnutTestCrashHooks = true; });
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true, width: 1280 });
  const other = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_FILLER}"]`);
  await expect(other.locator('.session-history')).toContainText('Answer 5.');
  return { panel, other };
}

/** The other column still reads and takes text. */
async function expectOtherColumnWorks(other: Locator): Promise<void> {
  await expect(other.locator('[data-error-region]')).toHaveCount(0);
  await expect(other.locator('.session-history')).toContainText('Answer 5.');
  const box = other.locator('.session-panel-input textarea').first();
  await box.fill('the other column still types');
  await expect(box).toHaveValue('the other column still types');
}

const SCENARIOS: Record<string, (page: Page) => Promise<void>> = {
  'session-panel': async (page) => {
    const { panel, other } = await open(page);
    await crash(page, 'session-panel', CTRL_SESSION);
    const column = page.locator('.main-page-session-column').filter({ has: page.locator(`[data-error-region="session-panel"]`) });
    const error = page.locator('[data-error-region="session-panel"]');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('Something went wrong loading this session.');
    await expect(error.getByRole('button', { name: 'Close panel' })).toBeVisible();
    await expect(column).toHaveCount(1);
    await expectOtherColumnWorks(other);
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.locator('.session-history')).toContainText('Answer 5.');
    await expect(page.locator('[data-error-region]')).toHaveCount(0);
  },
  composer: async (page) => {
    const { panel, other } = await open(page);
    await crash(page, 'composer', CTRL_SESSION);
    const error = panel.locator('[data-error-region="composer"]');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('The message box hit an error.');
    // The conversation above it stays.
    await expect(panel.locator('.session-history')).toContainText('Answer 5.');
    await expectOtherColumnWorks(other);
    await error.getByRole('button', { name: 'Retry' }).click();
    const box = panel.locator('.session-panel-input textarea').first();
    await box.fill('typing again after Retry');
    await expect(box).toHaveValue('typing again after Retry');
    await expect(page.locator('[data-error-region]')).toHaveCount(0);
  },
  'side-threads': async (page) => {
    const { panel, other } = await open(page);
    await directControl(panel, 'btw').click();
    const popover = panel.locator('.session-panel-input .side-question-popover--threads');
    await expect(popover).toBeVisible();
    await crash(page, 'side-threads', CTRL_SESSION);
    // The drawer's error sits where btw does; the open drawer goes with the crash.
    const error = panel.locator('.session-panel-input [data-error-region="side-threads"]');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('Side chats hit an error.');
    await expect(popover).toHaveCount(0);
    // The main composer and the conversation stay.
    await expect(panel.locator('[data-error-region="composer"], [data-error-region="session-panel"]')).toHaveCount(0);
    await expect(panel.locator('.session-history')).toContainText('Answer 5.');
    const box = panel.locator('.session-panel-input textarea').first();
    await box.fill('the main composer still types');
    await expect(box).toHaveValue('the main composer still types');
    await expectOtherColumnWorks(other);
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('[data-error-region]')).toHaveCount(0);
    await directControl(panel, 'btw').click();
    await expect(popover.locator('.side-question-popover-title')).toHaveText('Side chats');
    await expect(popover.locator('.side-question-composer textarea')).toBeVisible();
  },
};

test('every error region has a crash scenario here', () => {
  const regions = declaredRegions();
  expect(regions.length).toBeGreaterThan(0);
  expect(Object.keys(SCENARIOS).sort()).toEqual([...regions].sort());
});

for (const region of declaredRegions()) {
  test(`a crash in ${region} stays in it, the rest of the page works, and Retry brings it back`, async ({ page }) => {
    const scenario = SCENARIOS[region];
    test.skip(!scenario, `no scenario for ${region} (the first test fails for it)`);
    await scenario!(page);
  });
}
