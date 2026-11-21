/**
 * The model picker's fold bar (PickerFoldBar), as the user asked for it on 2026-11-21: model on
 * the left, effort on the right, and under them only "Cost $X", "Speed N tok/s" and "Details";
 * each opens its own part, one at a time, and every open starts with all of them closed.
 * ("把它放到一个 collapse 里面，不要显示那么多 information ... cost 点开之后 ... 包括 budget ...
 * token speed ... 点开之后再显示详细的", then "spped is token /s nto just time".)
 *
 * The session is a Codex one shaped like the user's own screenshot (GPT-6.2-Sol at Max, $102,
 * context 767.6K of 828.4K); its last turn is a real Codex turn's numbers (137 output tokens of
 * the last model call in 573 ms, so 239 tok/s; first token 2.6 s; the turn 52.9 s). Its Speed toggle
 * reads the session's average on GPT-6.2-Sol (12,800 tokens over 100 s of generation in 42 turns:
 * 128 tok/s), the user's ask of 2026-11-21 ("can we show the avg speed").
 */
import fs from 'node:fs/promises';
import { test, expect, type Page, type Route } from '@playwright/test';

const PORT = Number(process.env.PW_TEST_PORT ?? 3457);
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/model-picker-folds`;
const SID = '7e1b2026-1121-4000-8000-0000000000f1';

const FAMILIES = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CATALOG = {
  currentModelId: 'openai.gpt-6.2-sol[max]',
  models: FAMILIES.flatMap((f) => LEVELS
    .filter((l) => !(f === 'gpt-6-luna' && l === 'ultra') && !(f === 'gpt-5.5' && (l === 'max' || l === 'ultra')))
    .map((l) => ({ modelId: `openai.${f}[${l}]`, name: `${f.replace(/^gpt/, 'GPT').replace(/-(sol|astra|luna)$/, (m) => m.replace(/-(\w)/, (_x, c: string) => `-${c.toUpperCase()}`))} (${l})` }))),
};

const now = Date.now();
const SPEED = {
  startedAt: now - 60_000, endedAt: now - 7_090, final: true, ttftMs: 2_563, generationMs: 573, outputTokens: 137,
  turnOutputTokens: 137, tokenScope: 'last-call', messages: 3, model: 'openai.gpt-6.1-sol[xhigh]', durationMs: 52_910,
  inFlight: false, inFlightChars: 0, inFlightMs: 0, inFlightVisibleMs: 0,
};

// Keyed as the ACP meter keys a turn: the model id without its effort.
const SPEED_TOTALS = { 'openai.gpt-6.2-sol': { outputTokens: 12_800, generationMs: 100_000, turns: 42, lastAt: now - 7_090 } };

const COST = {
  sessionId: SID, engine: 'codex', source: 'codex-rollout', status: 'priced', totalUsd: 102.31, responses: 1_412, unpricedResponses: 0,
  firstAt: new Date(now - 41 * 3_600_000 - 120_000).toISOString(), lastAt: new Date(now - 60_000).toISOString(), apiDurationMs: 9_480_000,
  prices: { source: 'litellm', asOf: new Date(now).toISOString() },
  models: [{
    model: 'gpt-6.2-sol', speed: 'standard', responses: 1_412, costUsd: 102.31, unpricedResponses: 0, longResponses: 0, webSearches: 0, usRegionResponses: 0,
    tokens: { input: 310_000, output: 902_000, cacheRead: 401_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 9_100_000 },
    rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, singleCacheWrite: true },
    priceSource: { kind: 'litellm', key: 'gpt-6.2-sol', asOf: new Date(now).toISOString() },
    firstAt: new Date(now - 41 * 3_600_000).toISOString(), lastAt: new Date(now - 60_000).toISOString(),
  }],
};

const history = Array.from({ length: 4 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  text: index % 2 ? `Checked step ${index}. The recorded state matches.` : `Run check ${index + 1} and tell me what changed.`,
  msgId: `history-${index}`, timestamp: new Date(1_000 + index).toISOString(),
}));

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 1280, height: 860 } });

async function open(page: Page, budgetState: 'active' | 'paused' = 'active', cost: (route: Route) => unknown = (route) => route.fulfill({ json: COST })) {
  await fs.mkdir(SHOTS, { recursive: true });
  await page.route(`**/api/sessions/${SID}`, (route) => route.fulfill({ json: { session: {
    claudeSessionId: SID, taskId: '', project: '', process_status: 'running', mode: 'bypass', engine: 'codex', provider: 'cli',
    acpModel: 'openai.gpt-6.2-sol[max]', acpModelName: 'GPT-6.2-Sol (max)', contextTokens: 767_600, modelMaxWindow: 828_400,
    statusRevision: 1, statusUpdatedAt: new Date().toISOString(), startedAt: new Date(now - 41 * 3_600_000).toISOString(),
    lastActiveAt: new Date().toISOString(), messageCount: history.length, title: 'Picker folds fixture', lastTurnSpeed: SPEED,
    speedTotals: SPEED_TOTALS,
  } } }));
  await page.route(`**/api/sessions/${SID}/history**`, (route) => route.fulfill({ json: { messages: history, cursor: history.length, delta: false, fromStart: true } }));
  await page.route(`**/api/sessions/${SID}/model-catalog**`, (route) => route.fulfill({ json: CATALOG }));
  await page.route(`**/api/sessions/${SID}/cost`, cost);
  // By path: the read carries a query (?absent=null), which a plain glob does not match.
  await page.route((url) => url.pathname === `/api/usage/sessions/${SID}`, (route) => route.fulfill({ json: {
    sessionId: SID, title: 'Picker folds fixture', engine: 'codex', checkEverySec: 30, checkedAt: new Date().toISOString(),
    budget: { limitUsd: budgetState === 'paused' ? 100 : null, spentUsd: 102.31, state: budgetState, reason: null, revision: 1, updatedAt: new Date().toISOString(), responses: 1_412,
      unpricedResponses: 0, unpricedModel: null, pausedAt: null, pauseId: null, stopError: null, engine: 'codex' },
  } }));
  await page.setContent(`<a href="http://localhost:${PORT}/sessions?id=${SID}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`);
  // The first spec to reach a cold fixture waits on Vite compiling the app (dev mode).
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel).toContainText('Checked step 3.', { timeout: 30_000 });
  return panel;
}

async function openPicker(page: Page, panel: ReturnType<Page['locator']>) {
  await panel.locator('.composer-model-pill').first().click();
  const picker = page.locator('body > .model-picker.model-picker-popout');
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker.getByRole('option', { name: 'GPT-6.2-Sol' })).toBeVisible({ timeout: 20_000 });
  return picker;
}

test('model left, effort right, and only Cost, Speed (tok/s) and Details under them, each opening its own part', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = await open(page);
  const picker = await openPicker(page, panel);

  // The main view: the two columns and the three toggles, nothing stacked above them.
  const cols = picker.locator('.model-picker-columns');
  await expect(cols.locator('[aria-label="Model"] .picker-row-current')).toHaveText('GPT-6.2-Sol');
  await expect(cols.locator('[aria-label="Reasoning effort"] .picker-row-current')).toHaveText('Max');
  await expect(picker.getByTestId('picker-fold-cost')).toContainText('Cost$102');
  // The session's average on its model, not the one turn's 239 tok/s.
  await expect(picker.getByTestId('speed-headline')).toHaveText('128 tok/s avg');
  await expect(picker.getByTestId('picker-fold-details')).toHaveText(/Details/);
  // Context 93% puts a dot on Details, its reason as the title.
  await expect(picker.getByTestId('picker-fold-details')).toHaveAttribute('title', 'Context 93% full');
  for (const gone of ['Switch Model', 'Current:', 'Where these come from', 'This turn', 'Last turn', 'Budget', 'Context ']) {
    await expect(picker, `"${gone}" stays folded`).not.toContainText(gone);
  }
  // Each fact once: the model and the effort are named only by their ticked rows.
  expect(await picker.evaluate((el) => (el.textContent ?? '').split('GPT-6.2-Sol').length - 1)).toBe(1);
  await expect(picker.locator('[data-testid^="picker-fold-body-"]')).toHaveCount(0);
  const closedHeight = (await picker.boundingBox())!.height;
  await page.waitForTimeout(400);
  await picker.screenshot({ path: `${SHOTS}/1-main.png` });

  // Cost: the budget and the cost detail, nothing of Speed or Details.
  await picker.getByTestId('picker-fold-cost').click();
  const cost = picker.getByTestId('picker-fold-body-cost');
  await expect(cost.getByTestId('session-cost-times')).toContainText('span 1d 17h');
  await expect(cost.getByTestId('session-cost-model')).toHaveCount(1);
  await expect(cost.getByTestId('session-cost-budget')).toContainText('No budget');
  await expect(picker.getByTestId('picker-fold-body-speed')).toHaveCount(0);
  const costHeight = (await picker.boundingBox())!.height;
  await page.waitForTimeout(400);
  await picker.screenshot({ path: `${SHOTS}/2-cost.png` });

  // Speed: the session's average first, then the turn's rows; the rate is tok/s, the times only here.
  await picker.getByTestId('picker-fold-speed').click();
  await expect(cost).toHaveCount(0);
  const speed = picker.getByTestId('picker-fold-body-speed');
  await expect(speed.getByTestId('speed-average-tps')).toHaveText('128 tok/s');
  await expect(speed.getByTestId('speed-average-scope')).toHaveText('42 turns on GPT-6.2-Sol');
  await expect(speed.getByTestId('speed-average-note')).toHaveText(
    'Output tokens per second of model generation, averaged over this session\'s turns on this model (thinking counted; tool waits and time to first token not).');
  await expect(speed.getByTestId('speed-tps')).toHaveText('239 tok/s');
  await expect(speed.getByTestId('speed-ttft')).toContainText('2.6s');
  await expect(speed.getByTestId('speed-duration')).toHaveText('53s');
  const speedHeight = (await picker.boundingBox())!.height;
  await page.waitForTimeout(400);
  await picker.screenshot({ path: `${SHOTS}/3-speed.png` });

  // Details: the live strip (mode only), the context, where the values come from.
  await picker.getByTestId('picker-fold-details').click();
  const details = picker.getByTestId('picker-fold-body-details');
  await expect(details.getByTestId('picker-acp-context')).toContainText('767.6K / 828.4K (93%)');
  await expect(details.getByTestId('picker-live-strip')).toContainText('Live');
  const detailsHeight = (await picker.boundingBox())!.height;
  await page.waitForTimeout(400);
  await picker.screenshot({ path: `${SHOTS}/4-details.png` });

  // A second click closes it; Escape closes the picker; the next open starts folded again.
  await picker.getByTestId('picker-fold-details').click();
  await expect(details).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  const again = await openPicker(page, panel);
  await expect(again.locator('[data-testid^="picker-fold-body-"]')).toHaveCount(0);

  // An open fold grows the picker by at most about half (the UI rule: never fill the screen).
  for (const [name, h] of [['cost', costHeight], ['speed', speedHeight], ['details', detailsHeight]] as const) {
    expect(h / closedHeight, `${name} fold: ${Math.round(h)} px vs ${Math.round(closedHeight)} px`).toBeLessThan(1.6);
  }
  await fs.writeFile(`${SHOTS}/heights.json`, JSON.stringify({ closedHeight, costHeight, speedHeight, detailsHeight }));
  expect(errors).toEqual([]);
});

test('a budget that paused the session marks the Cost toggle without opening it', async ({ page }) => {
  const panel = await open(page, 'paused');
  const picker = await openPicker(page, panel);
  const cost = picker.getByTestId('picker-fold-cost');
  await expect(cost.getByTestId('cost-budget-paused')).toBeVisible();
  await expect(cost).toContainText('$102');
  await cost.click();
  await expect(picker.getByTestId('picker-fold-body-cost').getByTestId('session-cost-budget')).toHaveAttribute('data-state', 'paused');
});

/** Record the Cost toggle's text in the very frame it first appears (before any read of the open). */
async function watchFirstCostFrame(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __firstCost?: string | null };
    w.__firstCost = null;
    const seen = () => {
      const el = document.querySelector('[data-testid="picker-fold-cost"]');
      if (el && w.__firstCost === null) { w.__firstCost = el.textContent ?? ''; observer.disconnect(); }
    };
    const observer = new MutationObserver(seen);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
const firstCostFrame = (page: Page) => page.evaluate(() => (window as unknown as { __firstCost?: string | null }).__firstCost ?? null);

test('the Cost toggle shows the number in its first frame: the session pill read it before the click', async ({ page }) => {
  // Every read answers after 3 s until one got its answer (the pill's warm-up); every later one
  // never answers, so a number in the picker can only be the one read before it opened.
  let answered = false;
  let later = 0;
  const panel = await open(page, 'active', async (route) => {
    if (answered) { later++; return; }
    await new Promise((r) => setTimeout(r, 3_000));
    if (answered) { later++; return; }
    await route.fulfill({ json: COST }).then(() => { answered = true; }, () => {});
  });
  await expect.poll(() => answered, { timeout: 60_000 }).toBe(true);
  await watchFirstCostFrame(page);
  const picker = await openPicker(page, panel);
  expect(await firstCostFrame(page)).toContain('Cost$102');
  await expect(picker.getByTestId('picker-fold-cost')).toContainText('Cost$102');
  // The picker asked again (and is still waiting): the number it shows is the warm-up's.
  await expect.poll(() => later).toBeGreaterThanOrEqual(1);
});

test('a read that answers pending never takes the known number away, on a reopen or after a reload', async ({ page }) => {
  let answer: 'priced' | 'pending' | 'hang' = 'priced';
  const PENDING = { ...COST, status: 'pending', totalUsd: null, models: [], pending: { readBytes: 1_000, totalBytes: 9_000 } };
  const panel = await open(page, 'active', (route) => {
    if (answer === 'hang') return;
    return route.fulfill({ json: answer === 'priced' ? COST : PENDING });
  });
  let picker = await openPicker(page, panel);
  await expect(picker.getByTestId('picker-fold-cost')).toContainText('Cost$102');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // The host is reading a long transcript again: its answer is pending.
  answer = 'pending';
  const pending = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${SID}/cost`));
  await watchFirstCostFrame(page);
  picker = await openPicker(page, panel);
  await pending;
  expect(await firstCostFrame(page)).toContain('Cost$102');
  await page.waitForTimeout(500);
  await expect(picker.getByTestId('picker-fold-cost')).toContainText('Cost$102');
  await expect(picker).not.toContainText('reading');
  await page.keyboard.press('Escape');

  // A reload with the host not answering at all: the number this browser kept.
  answer = 'hang';
  await page.reload();
  const again = page.locator(`.session-panel[data-session-id="${SID}"]`);
  await expect(again).toContainText('Checked step 3.', { timeout: 60_000 });
  await watchFirstCostFrame(page);
  picker = await openPicker(page, again);
  expect(await firstCostFrame(page)).toContain('Cost$102');
});
