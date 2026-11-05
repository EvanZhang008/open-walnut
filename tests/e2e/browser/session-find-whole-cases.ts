/**
 * Cmd+F across a WHOLE session, rows the chat has not loaded included, and
 * ArrowUp recall of the person's earlier messages in the composer. Shared by
 * session-find-whole.spec.ts (Chromium) and session-find-whole.webkit.spec.ts
 * (the Mac app's engine).
 *
 * Harness: history and the find route are mocked through page.route, so the
 * real client renders a long session and asks the real questions; only the data
 * is canned. The first answer serves the newest 60 rows of 240, so the oldest
 * rows are not even held: stepping onto one makes the chat load the rest.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { findChord } from './page-find-helpers';
import { SESSION_FIND_SKIP_SELECTOR } from '../../../web/src/utils/page-find';
import { toolHeaderText, type HeaderTool, type ToolCardKind } from '../../../src/lib/tool-header-text';

const SESSION_ID = 'pw-session-find-whole';
const TASK_ID = 'pw-task-session-find-whole';
const SHOT_DIR = process.env.SESSION_FIND_SHOTS ?? '/tmp/session-find-whole';
const ROWS = 240;
const TAIL = 60;
/** Only in the four oldest answers: never on the page until loaded. */
const OLD_WORD = 'quokka';
/** In every answer: on the page and above it. */
const WORD = 'zebra';
const MULTI_LINE_ROW = ROWS - 6;
const MULTI_LINE = 'First line of a long message\nsecond line\nthird line';
/** Sends the newest prompt again, earlier: recall lists it once, at its newest place. */
const REPEAT_ROW = ROWS - 10;
const question = (i: number) => `Question ${i}: please check row ${i}`;
/** Only in delivered cards (every 40th person row from 10): a sender title the
 *  folded card shows, and a body it shows only open. */
const CARD_WORD = 'heron';
const isCardRow = (i: number) => i % 40 === 10;
const card = (i: number) => [
  `<walnut-message kind="peer-note" from="Sample lead [abcd1234]" from-session="abcd1234-0000-4000-8000-00000000000${i % 10}" from-task="t1" host="local" title="${CARD_WORD} count ${i}">`,
  `Please recount the ${CARD_WORD} nests by row ${i}.`,
  '</walnut-message>',
].join('\n');
const HISTORY = `.session-panel[data-session-id="${SESSION_ID}"] .session-history`;

function rows() {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ROWS; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    if (i % 2 === 0) {
      // One message of three lines, for the caret rules of ArrowUp/ArrowDown recall.
      const text = isCardRow(i) ? card(i) : i === MULTI_LINE_ROW ? MULTI_LINE : i === REPEAT_ROW ? question(ROWS - 2) : question(i);
      out.push({ role: 'user', msgId: `u${i}`, text, timestamp: at });
    } else {
      const old = i < 8 ? ` The ${OLD_WORD} was here.` : '';
      out.push({
        role: 'assistant', msgId: `a${i}`, timestamp: at,
        text: [`Answer ${i}. The ${WORD} crossed the road.${old}`, '', `Padding paragraph ${i}. `.repeat(12)].join('\n'),
      });
    }
  }
  return out;
}

/** What the server's find answers for these rows (src/core/sessions/session-find.ts, simplified). */
function find(all: Array<Record<string, unknown>>, q: string) {
  const needle = q.toLowerCase();
  const matches: Array<{ id: string; role: string; timestamp: string; count: number }> = [];
  let total = 0;
  for (const r of all) {
    const text = String(r.text).toLowerCase();
    let count = 0;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
    if (!count) continue;
    total += count;
    matches.push({ id: String(r.msgId), role: String(r.role), timestamp: String(r.timestamp), count });
  }
  return { matches, total, capped: false };
}

interface Harness {
  findCalls: string[]; failFind: boolean; fullLoads: number;
  /** Hold the find answer for these queries until released. */
  holdFind: Map<string, Promise<void>>;
  /** Hold the full-history load until released. */
  holdFull: Promise<void> | null;
}

async function mockSession(page: Page): Promise<Harness> {
  const all = rows();
  const h: Harness = { findCalls: [], failFind: false, fullLoads: 0, holdFind: new Map(), holdFull: null };
  const record = {
    claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: all.length,
    title: 'Whole session find',
  };
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history') || request.url().includes('/find')) return route.fallback();
    await route.fulfill({ json: { session: { ...record } } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('since') !== null) return route.fulfill({ json: { messages: [], cursor: all.length, delta: true } });
    const streams = url.searchParams.get('source') === 'streams';
    const full = !streams && !url.searchParams.has('tail');
    if (full) { h.fullLoads++; if (h.holdFull) await h.holdFull; }
    const take = full ? all.length : TAIL;
    return route.fulfill({ json: { messages: all.slice(-take), total: all.length, delta: false, ...(streams ? {} : { cursor: all.length }) } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/find**`, async (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    h.findCalls.push(q);
    const hold = h.holdFind.get(q);
    if (hold) await hold;
    if (h.failFind) return route.fulfill({ status: 502, json: { error: 'host unreachable' } });
    return route.fulfill({ json: find(all, q) });
  });
  return h;
}

async function openSession(page: Page): Promise<Harness> {
  await page.setViewportSize({ width: 1280, height: 860 });
  const h = await mockSession(page);
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`)).toBeVisible({ timeout: 20_000 });
  // Let the chat settle (follow-bottom, the question map) before counting.
  let last = '';
  let still = 0;
  for (let i = 0; i < 60 && still < 4; i++) {
    const now = await page.locator(HISTORY).evaluate((el) => `${(el as HTMLElement).innerText.length}:${Math.round(el.scrollTop)}`);
    still = now === last ? still + 1 : 0;
    last = now;
    await page.waitForTimeout(250);
  }
  return h;
}

const bar = (page: Page) => page.locator('.page-find');
const label = (page: Page) => page.locator('.page-find .fv-search-count');
const note = (page: Page) => page.locator('.page-find .page-find-note');

/** The row holding the active find match, by its message id. */
function activeRowId(page: Page) {
  return page.evaluate(() => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights;
    const h = reg.get('walnut-find-active')?.size ? reg.get('walnut-find-active') : reg.get('walnut-find-solid-active');
    if (!h || !h.size) return null;
    const node = [...h][0]!.startContainer;
    const el = node instanceof Element ? node : node.parentElement;
    return el?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
  });
}

function activeInView(page: Page) {
  return page.locator(HISTORY).evaluate((el) => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights;
    const h = reg.get('walnut-find-active')?.size ? reg.get('walnut-find-active') : reg.get('walnut-find-solid-active');
    if (!h || !h.size) return false;
    const s = [...h][0]!;
    const live = document.createRange();
    live.setStart(s.startContainer, s.startOffset);
    live.setEnd(s.endContainer, s.endOffset);
    const r = live.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.top + el.clientHeight && r.height > 0;
  });
}

function shot(page: Page, engine: string, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: `${SHOT_DIR}/${engine}-${name}.png`, scale: 'css' });
}

const composer = (page: Page) => page.locator(`.session-panel[data-session-id="${SESSION_ID}"] textarea`).last();

// ── Tool cards: the words each kind shows are the words the server counts ──

const TOOLS_SESSION_ID = 'pw-session-find-tools';
const TOOLS_HISTORY = `.session-panel[data-session-id="${TOOLS_SESSION_ID}"] .session-history`;
const TOOL_TURNS = 36;
const TOOL_WORD = 'ibis';
/** One call of every way the chat draws one, each showing the word without being
 *  opened (or, for the ones that show no header, holding it where it must not
 *  count). A new kind fails to compile here until it has a sample. */
const TOOL_SAMPLES: Record<ToolCardKind, HeaderTool> = {
  bash: { name: 'Bash', input: { command: `grep -c ${TOOL_WORD} nests.txt\necho done` } },
  generic: { name: 'Read', input: { file_path: `/repo/docs/${TOOL_WORD}.md` } },
  edit: { name: 'Edit', input: { file_path: '/repo/src/birds.ts', old_string: 'const a = 1', new_string: `const ${TOOL_WORD} = 2` } },
  plan: { name: 'ExitPlanMode', input: { plan: `Plan: count the ${TOOL_WORD} nests` } },
  'plan-write': { name: 'Write', input: { file_path: `/home/u/.claude/plans/${TOOL_WORD}-plan.md`, content: 'x' } },
  chip: { name: 'Agent', input: { description: `${TOOL_WORD} survey`, prompt: `Count every ${TOOL_WORD}` }, result: 'done', agentId: 'agent-1' },
};
/** Drawn as their own cards with no header line: never counted. */
const UNCOUNTED_TOOLS: HeaderTool[] = [
  { name: 'Bash', input: { command: 'ls -la', description: `List the ${TOOL_WORD} folder` } },
  { name: 'mcp__walnut__task_send', input: { to: 'abcd1234', text: `The ${TOOL_WORD} report is ready` } },
];
const TOOL_KINDS = Object.keys(TOOL_SAMPLES) as ToolCardKind[];

function toolRows() {
  const out: Array<Record<string, unknown>> = [];
  for (let t = 0; t < TOOL_TURNS; t++) {
    const at = (k: number) => new Date(Date.UTC(2026, 0, 2, 0, t, k)).toISOString();
    out.push({ role: 'user', msgId: `tu${t}`, text: `Step ${t}, please`, timestamp: at(0) });
    const tool = t % 7 === 6 ? UNCOUNTED_TOOLS[t % 2]! : TOOL_SAMPLES[TOOL_KINDS[t % TOOL_KINDS.length]!];
    out.push({ role: 'assistant', msgId: `ta${t}`, text: `Working on step ${t}.`, timestamp: at(1), tools: [{ ...tool, toolUseId: `tool-${t}` }] });
    // A tool-only row too: it merges into a run with the call before it.
    if (t % 3 === 1) out.push({ role: 'assistant', msgId: `tb${t}`, text: '', timestamp: at(2), tools: [{ ...TOOL_SAMPLES.bash, toolUseId: `tool-${t}-b` }] });
  }
  return out;
}

/** The server's count for one row: its prose and its cards' words (session-find.ts findableText). */
function toolRowText(r: Record<string, unknown>): string {
  const tools = (r.tools as HeaderTool[] | undefined) ?? [];
  return [String(r.text ?? ''), ...tools.map(toolHeaderText)].join(' ').replace(/\s+/g, ' ');
}

async function openToolSession(page: Page): Promise<number> {
  await page.setViewportSize({ width: 1280, height: 860 });
  const all = toolRows();
  const record = {
    claudeSessionId: TOOLS_SESSION_ID, taskId: 'pw-task-session-find-tools', project: 'Walnut', process_status: 'idle', mode: 'bypass',
    startedAt: '2026-01-02T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: all.length, title: 'Tool cards find',
  };
  await page.route(`**/api/sessions/${TOOLS_SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history') || request.url().includes('/find')) return route.fallback();
    await route.fulfill({ json: { session: { ...record } } });
  });
  await page.route(`**/api/sessions/${TOOLS_SESSION_ID}/history**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('since') !== null) return route.fulfill({ json: { messages: [], cursor: all.length, delta: true } });
    const streams = url.searchParams.get('source') === 'streams';
    const full = !streams && !url.searchParams.has('tail');
    const take = full ? all.length : 24;
    return route.fulfill({ json: { messages: all.slice(-take), total: all.length, delta: false, ...(streams ? {} : { cursor: all.length }) } });
  });
  let total = 0;
  await page.route(`**/api/sessions/${TOOLS_SESSION_ID}/find**`, async (route: Route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const matches: Array<{ id: string; role: string; timestamp: string; count: number }> = [];
    let sum = 0;
    for (const r of all) {
      const text = toolRowText(r).toLowerCase();
      let count = 0;
      for (let at = text.indexOf(q); q && at !== -1; at = text.indexOf(q, at + q.length)) count++;
      if (!count) continue;
      sum += count;
      matches.push({ id: String(r.msgId), role: String(r.role), timestamp: String(r.timestamp), count });
    }
    return route.fulfill({ json: { matches, total: sum, capped: false } });
  });
  for (const r of all) total += toolRowText(r).toLowerCase().split(TOOL_WORD).length - 1;
  await page.goto(`/sessions?id=${TOOLS_SESSION_ID}`);
  await expect(page.locator(TOOLS_HISTORY).getByText(`Working on step ${TOOL_TURNS - 1}.`)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  return total;
}

function activeInViewOf(page: Page, history: string) {
  return page.locator(history).evaluate((el) => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights;
    const h = reg.get('walnut-find-active')?.size ? reg.get('walnut-find-active') : reg.get('walnut-find-solid-active');
    if (!h || !h.size) return false;
    const s = [...h][0]!;
    const live = document.createRange();
    live.setStart(s.startContainer, s.startOffset);
    live.setEnd(s.endContainer, s.endOffset);
    const r = live.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.top + el.clientHeight && r.height > 0;
  });
}

export function defineSessionFindWholeCases(engine: 'chromium' | 'webkit') {
  test(`${engine}: a word only in unloaded turns counts, and Enter loads and lands on each one`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const h = await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    // Four answers hold it, none of them loaded: counted from the server.
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    await expect(note(page)).toHaveText('4 in earlier turns');
    await expect(bar(page)).toHaveAttribute('data-earlier', '4');
    expect(h.findCalls).toContain(OLD_WORD);
    await shot(page, engine, '1-counted');

    // Enter: the oldest one. The chat loads the rest of the history and the
    // find lands on that row's match, in view.
    await page.keyboard.press('Enter');
    await expect.poll(() => activeRowId(page), { timeout: 20_000 }).toBe('a1');
    await expect(label(page)).toHaveText('1/4');
    expect(await activeInView(page)).toBe(true);
    expect(h.fullLoads).toBeGreaterThan(0);
    await expect(bar(page)).toHaveAttribute('data-revealing', 'false');
    // Only that turn rendered: the stretch up to the newest turns is left out
    // behind a divider, not rendered in full.
    const skip = page.locator(HISTORY).locator('.session-gap-divider', { hasText: 'not shown here' });
    await expect(skip).toHaveCount(1);
    expect(await page.locator(HISTORY).locator('[data-msg-index]').count()).toBeLessThan(TAIL + 20);
    // The other three are in that stretch: turns not on screen, below this one.
    await expect(note(page)).toHaveText('3 in later turns');
    await shot(page, engine, '2-landed-first');

    // The rest are on the page now: Enter steps through them, then wraps.
    for (const [id, n] of [['a3', 2], ['a5', 3], ['a7', 4], ['a1', 1]] as const) {
      await page.keyboard.press('Enter');
      await expect.poll(() => activeRowId(page), { timeout: 10_000 }).toBe(id);
      await expect(label(page)).toHaveText(`${n}/4`);
      expect(await activeInView(page)).toBe(true);
    }
    if (engine === 'webkit') {
      // Back on the first after the lap, far up the chat: its box is drawn once
      // the step's scroll gets there (a box far from the view is left out).
      await expect.poll(() => page.locator(`${HISTORY} .find-box-active`).count(), { timeout: 5_000 }).toBeGreaterThan(0);
    }
    // Shift+Enter goes back up.
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => activeRowId(page)).toBe('a7');
    await expect(label(page)).toHaveText('4/4');
    // The find keys of every browser step too: Ctrl/Cmd+G and F3, Shift for back.
    await page.keyboard.press('Control+g');
    await expect(label(page)).toHaveText('1/4');
    await page.keyboard.press('Shift+F3');
    await expect(label(page)).toHaveText('4/4');
    // "Show them" renders a stretch left out.
    const before = await page.locator(HISTORY).locator('[data-msg-index]').count();
    await page.locator(HISTORY).locator('.session-gap-divider', { hasText: 'not shown here' }).last()
      .getByRole('button', { name: 'Show them' }).click();
    await expect.poll(() => page.locator(HISTORY).locator('[data-msg-index]').count()).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });

  test(`${engine}: Enter pressed fast while a turn loads counts every press`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    // Three presses at once: the first loads the old turns, the others come in
    // while it does.
    for (let k = 0; k < 3; k++) await page.keyboard.press('Enter');
    await expect(bar(page)).toHaveAttribute('data-revealing', 'false', { timeout: 20_000 });
    await expect(label(page)).toHaveText('3/4', { timeout: 10_000 });
    await expect.poll(() => activeRowId(page), { timeout: 10_000 }).toBe('a5');
    expect(await activeInView(page)).toBe(true);
    // And back: two fast Shift+Enter presses go two back.
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await expect(label(page)).toHaveText('1/4', { timeout: 10_000 });
    await expect.poll(() => activeRowId(page), { timeout: 10_000 }).toBe('a1');
  });

  test(`${engine}: numbering runs in transcript order across the loaded edge, with no number skipped`, async ({ page }) => {
    test.setTimeout(180_000);
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type('row 2');
    // The questions of rows 2, 20..28 (not loaded) and 200..238 (on the page).
    await expect(label(page)).toHaveText(/^\d+ matches$/, { timeout: 10_000 });
    await expect(bar(page)).toHaveAttribute('data-remote', 'ready');
    const total = Number((await label(page).textContent())!.split(' ')[0]);
    // From the first match, Enter visits 1..N in order, each in view, then wraps.
    const ids: string[] = [];
    await page.keyboard.press('Enter');
    await expect(label(page)).toHaveText(new RegExp(`^\\d+/${total}$`));
    let n = Number((await label(page).textContent())!.split('/')[0]);
    const back = [n];
    // Back to number 1 first: each Shift+Enter is one less.
    for (let guard = 0; n !== 1 && guard < total + 2; guard++) {
      await page.keyboard.press('Shift+Enter');
      await expect(bar(page)).toHaveAttribute('data-revealing', 'false', { timeout: 20_000 });
      await expect(label(page)).toHaveText(`${n - 1}/${total}`, { timeout: 10_000 }).catch(() => {});
      n = Number((await label(page).textContent())!.split('/')[0]);
      back.push(n);
    }
    expect(n, `Shift+Enter went ${back.join(' ')}`).toBe(1);
    for (let k = 1; k <= total; k++) {
      await expect(bar(page)).toHaveAttribute('data-revealing', 'false', { timeout: 20_000 });
      await expect(label(page)).toHaveText(`${k}/${total}`);
      const id = await activeRowId(page);
      expect(await activeInView(page)).toBe(true);
      ids.push(id!);
      await page.keyboard.press('Enter');
    }
    await expect(label(page)).toHaveText(`1/${total}`, { timeout: 20_000 });
    // Transcript order: row ids ascend.
    const order = ids.map((id) => Number(id.slice(1)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test(`${engine}: earlier turns count before the page, and previous from the first page match goes up into them`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(WORD);
    // 120 answers hold the word; the page renders some of them.
    await expect(bar(page)).not.toHaveAttribute('data-earlier', '0', { timeout: 10_000 });
    const earlier = Number(await bar(page).getAttribute('data-earlier'));
    expect(earlier).toBeGreaterThan(0);
    await expect(label(page)).toHaveText('120 matches');
    await expect(note(page)).toHaveText(`${earlier} in earlier turns`);

    // Next from the view: a page match, numbered after every earlier one.
    await page.keyboard.press('Enter');
    await expect(label(page)).toHaveText(/^\d+\/120$/);
    const n = Number((await label(page).textContent())!.split('/')[0]);
    expect(n).toBeGreaterThan(earlier);

    // Up to the first page match, then one more: the newest earlier row renders and holds it.
    for (let i = n; i > earlier + 1; i--) await page.keyboard.press('Shift+Enter');
    await expect(label(page)).toHaveText(`${earlier + 1}/120`);
    const firstOnPage = await activeRowId(page);
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => activeRowId(page), { timeout: 20_000 }).not.toBe(firstOnPage);
    await expect(label(page)).toHaveText(`${earlier}/120`);
    expect(await activeInView(page)).toBe(true);
    const landed = await activeRowId(page);
    // The row it landed on is the one just above the old first page match.
    expect(Number(landed!.slice(1))).toBe(Number(firstOnPage!.slice(1)) - 2);
    await shot(page, engine, '3-up-into-earlier');
  });

  test(`${engine}: a failed whole-session search says so, keeps the page's count, and Retry recovers`, async ({ page }) => {
    test.setTimeout(90_000);
    const h = await openSession(page);
    h.failFind = true;
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    await expect(note(page)).toContainText("Couldn't search the rest of the session", { timeout: 10_000 });
    // Not "No results": the rest of the session was not searched.
    await expect(label(page)).toHaveText('None on screen');
    await shot(page, engine, '4-failed');
    h.failFind = false;
    await note(page).getByRole('button', { name: 'Retry' }).click();
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    await expect(note(page)).toHaveText('4 in earlier turns');
  });

  test(`${engine}: Esc closes the bar and a new query asks again`, async ({ page }) => {
    const h = await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    await findChord(page);
    await page.locator('.page-find input').fill('row 3');
    await expect(label(page)).not.toHaveText('No results', { timeout: 10_000 });
    // The page counts at once; the whole-history question follows its debounce.
    await expect.poll(() => h.findCalls.includes('row 3'), { timeout: 10_000 }).toBe(true);
    // A one-letter query searches the whole session too.
    await page.locator('.page-find input').fill('q');
    await expect.poll(() => h.findCalls.includes('q'), { timeout: 10_000 }).toBe(true);
  });

  test(`${engine}: a late answer for an earlier query never counts for the current one`, async ({ page }) => {
    test.setTimeout(90_000);
    const h = await openSession(page);
    let release!: () => void;
    h.holdFind.set(WORD, new Promise<void>((r) => { release = r; }));
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.locator('.page-find input').fill(WORD);
    await expect.poll(() => h.findCalls.includes(WORD), { timeout: 10_000 }).toBe(true);
    await page.locator('.page-find input').fill(OLD_WORD);
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    release();
    await page.waitForTimeout(800);
    await expect(label(page)).toHaveText('4 matches');
    await expect(note(page)).toHaveText('4 in earlier turns');
  });

  test(`${engine}: Esc while an earlier turn loads: nothing renders or moves when the load lands`, async ({ page }) => {
    test.setTimeout(90_000);
    const h = await openSession(page);
    let release!: () => void;
    h.holdFull = new Promise<void>((r) => { release = r; });
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(bar(page)).toHaveAttribute('data-revealing', 'true');
    await expect(note(page)).toHaveText('Showing that turn\u2026');
    await expect(label(page)).toHaveText('1/4');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    // Measured from the bottom: what the reader sees, whatever is held above.
    const fromBottom = () => page.locator(HISTORY).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop));
    const before = await fromBottom();
    release();
    await expect.poll(() => h.fullLoads).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await expect(page.locator(HISTORY).locator('[data-message-id="a1"]')).toHaveCount(0);
    expect(Math.abs((await fromBottom()) - before)).toBeLessThanOrEqual(2);
  });

  test(`${engine}: ArrowUp in the empty composer brings back the person's earlier messages`, async ({ page }) => {
    await openSession(page);
    const box = composer(page);
    await box.click();
    await expect(box).toHaveValue('');
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 2));
    // The caret at the end, ready to add to it; the hint says which one it is.
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(question(ROWS - 2).length);
    const hint = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .chat-recall-hint`);
    await expect(hint).toContainText('Last message (1 of');
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 4));
    await expect(hint).toContainText(/^2 of \d+ back/);
    await shot(page, engine, '5-recall');
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveValue(question(ROWS - 2));
    // Past the newest: empty again.
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveValue('');

    // An edited recall is a draft: the arrows move the caret, nothing is replaced.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type(' again');
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(`${question(ROWS - 2)} again`);
    // Typed back to what it was, it stays a draft: the arrows never replace it.
    await page.keyboard.press('End');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await expect(box).toHaveValue(question(ROWS - 2));
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 2));
    // A draft of one's own is never replaced.
    await box.fill('my own draft');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveValue('my own draft');
  });

  test(`${engine}: recall stops at a message sent again in its old place too, undo empties the box, and an untouched recall is no draft`, async ({ page }) => {
    // The session loads twice (here and after the reload).
    test.setTimeout(120_000);
    await openSession(page);
    const box = composer(page);
    await box.click();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowUp');
      seen.push(await box.inputValue());
    }
    // (The three-line message: one press to its start, then on.) The newest
    // question was also sent earlier (REPEAT_ROW): that send is a stop as well.
    expect(seen.filter((v, i) => v !== seen[i - 1]))
      .toEqual([question(ROWS - 2), question(ROWS - 4), MULTI_LINE, question(ROWS - 8), question(ROWS - 2)]);
    // Undo while untouched: back to the empty box.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(box).toHaveValue('');
    // A recall left in the box is not kept as a draft: a reload shows the empty box.
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 2));
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`)).toBeVisible({ timeout: 20_000 });
    await expect(composer(page)).toHaveValue('');
  });

  test(`${engine}: on a recalled message of several lines one press takes the caret to its start or end, the next goes on`, async ({ page }) => {
    await openSession(page);
    const box = composer(page);
    await box.click();
    const caret = () => box.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 4));
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(MULTI_LINE);
    // It lands with the caret at its end; one ArrowUp takes the caret to its
    // start (not one press per line), the text stays.
    expect(await caret()).toBe(MULTI_LINE.length);
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(MULTI_LINE);
    expect(await caret()).toBe(0);
    // On its first line: ArrowUp goes further back.
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveValue(question(ROWS - 8));
    // ArrowDown comes forward and lands at the end (its last line), so the next
    // ArrowDown goes on forward at once.
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveValue(MULTI_LINE);
    expect(await caret()).toBe(MULTI_LINE.length);
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveValue(question(ROWS - 4));
  });

  test(`${engine}: words in a folded card count once and Enter lands on every one, the total never moving`, async ({ page }) => {
    test.setTimeout(180_000);
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(CARD_WORD);
    // Six cards, each with its word in the title and the body: 12, whether a
    // card is loaded, folded or open.
    await expect(label(page)).toHaveText('12 matches', { timeout: 10_000 });
    const seen: string[] = [];
    for (let k = 1; k <= 13; k++) {
      await page.keyboard.press('Enter');
      await expect(bar(page)).toHaveAttribute('data-revealing', 'false', { timeout: 20_000 });
      const want = `${((k - 1) % 12) + 1}/12`;
      await expect(label(page), `steps so far: ${seen.join(' ')}`).toHaveText(want, { timeout: 10_000 });
      seen.push(want);
      expect(await activeInView(page), `step ${want} in view`).toBe(true);
    }
  });

  test(`${engine}: every word left to search on the page is a word of the transcript`, async ({ page }) => {
    // The whole-session count counts the transcript's words; a label of the
    // chat's own (a time, a copy button, a fold toggle, a divider) counted on
    // screen would make the total mean two things. A new label fails here until
    // SESSION_FIND_SKIP_SELECTOR skips it.
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    // A step far back puts a skip divider and a revealed turn on the page too.
    await findChord(page);
    await page.keyboard.type(OLD_WORD);
    await expect(label(page)).toHaveText('4 matches', { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect.poll(() => activeRowId(page), { timeout: 20_000 }).toBe('a1');
    const vocab = new Set<string>();
    for (const r of rows()) for (const w of String(r.text).toLowerCase().match(/[a-z]+/g) ?? []) vocab.add(w);
    const stray = await page.locator(HISTORY).evaluate((root, skip) => {
      const out = new Set<string>();
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!el || el.closest(skip) || el.closest('textarea, input, script, style')) continue;
        if (!el.checkVisibility?.()) continue;
        for (const word of n.textContent!.toLowerCase().match(/[a-z]+/g) ?? []) out.add(word);
      }
      return [...out];
    }, SESSION_FIND_SKIP_SELECTOR);
    expect(stray.filter((word) => !vocab.has(word))).toEqual([]);
  });

  test(`${engine}: a tool card's words count once, loaded or not, and Enter lands on each (every kind of card)`, async ({ page }) => {
    // The server counts each card's words with the function the cards are drawn
    // with (src/lib/tool-header-text.ts). A card whose shown words drift from it
    // makes the total move as turns render, or a step land on nothing.
    test.setTimeout(240_000);
    const total = await openToolSession(page);
    expect(total).toBeGreaterThan(20);
    await page.locator(TOOLS_HISTORY).getByText(`Working on step ${TOOL_TURNS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(TOOL_WORD);
    await expect(label(page)).toHaveText(`${total} matches`, { timeout: 10_000 });
    const seen: string[] = [];
    for (let k = 1; k <= total + 1; k++) {
      await page.keyboard.press('Enter');
      await expect(bar(page)).toHaveAttribute('data-revealing', 'false', { timeout: 20_000 });
      await expect(label(page), `steps so far: ${seen.join(' ')}`).toHaveText(new RegExp(`^\\d+/${total}$`), { timeout: 10_000 });
      const now = String(await label(page).textContent());
      seen.push(now);
      expect(await activeInViewOf(page, TOOLS_HISTORY), `step ${now} lands on a highlighted word in view`).toBe(true);
    }
    // One lap: every match once, then back to where it started.
    expect(new Set(seen.slice(0, total)).size).toBe(total);
    expect(seen[total]).toBe(seen[0]);
  });

  test(`${engine}: text cut short under an open find never takes the page down, and no painted match outlives its text`, async ({ page }) => {
    // A painted match outlives its text when a row is rewritten under it (a
    // queued message sent, a reply re-rendered). The bar takes such matches off
    // before the next frame (a StaticRange does not follow edits), the
    // highlight of a selection's echo too, and the page stays up. The total
    // still follows the server's count of the row.
    test.setTimeout(90_000);
    await openSession(page);
    await page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`).click();
    await findChord(page);
    await page.keyboard.type(WORD);
    await expect(label(page)).toHaveText(`${ROWS / 2} matches`, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(label(page)).toHaveText(new RegExp(`^\\d+/${ROWS / 2}$`), { timeout: 10_000 });
    // Cut every text node holding the word to two characters, in place.
    const cut = await page.locator(HISTORY).evaluate((root, word) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const hits: Text[] = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent!.includes(word)) hits.push(n as Text);
      for (const t of hits) t.data = t.data.slice(0, 2);
      return hits.length;
    }, WORD);
    expect(cut).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.readyState)).toBe('complete');
    // Every range still painted fits inside its text node.
    const stale = await page.evaluate(() => {
      const len = (n: Node) => (n.nodeType === Node.TEXT_NODE ? (n as Text).length : n.childNodes.length);
      let bad = 0;
      for (const [name, hl] of CSS.highlights) {
        if (!name.startsWith('walnut-')) continue;
        for (const r of hl as Highlight) {
          const range = r as AbstractRange;
          if (range.startOffset > len(range.startContainer) || range.endOffset > len(range.endContainer)) bad++;
        }
      }
      return bad;
    });
    expect(stale).toBe(0);
    await expect(label(page)).toHaveText(new RegExp(`^(\\d+/)?${ROWS / 2}( matches)?$`));
  });
}

