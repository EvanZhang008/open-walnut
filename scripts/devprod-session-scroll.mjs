/**
 * Second render check: open one long session and scroll it both ways.
 *
 * 2026-09-26: a deploy shipped a new wrapper around the transcript without the
 * stylesheet that makes it transparent. The home page painted, the first-paint
 * check passed, and every long session was clipped with no scroll range.
 *
 * Runs against the smoke server AND live production, so the session is served
 * from inside this browser (route mocks) and nothing is written anywhere.
 * Verdicts match devprod-render-check.mjs: 0 ok, 1 definitive, 2 undetermined.
 */
const SESSION_ID = 'render-check-scroll-session';
const BOUNDARY_CONSOLE = /\[error-boundary\]|render error caught by boundary/;
const BOUNDARY_BANNER = 'Something went wrong rendering the page';

const messages = Array.from({ length: 60 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  msgId: `render-check-message-${index}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  text: index % 2
    ? `## Answer ${index}\n\nA long conversation must stay readable above the composer.\n\n| Item | State |\n| --- | --- |\n| Scrolling | Available |\n| Layout | Bounded |\n\n\`\`\`text\nLine ${index}\n\`\`\`\n\nFinal line ${index}.`
    : `Question ${index}: can I read the whole conversation?`,
}));

async function mockSession(page) {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    if (pathname === '/api/ui-prefs') return route.fulfill({ json: { prefs: {} } });
    if (pathname === `/api/sessions/${SESSION_ID}/history`) {
      return route.fulfill({ json: { messages, total: messages.length, cursor: messages.length, delta: false } });
    }
    if (pathname === `/api/sessions/${SESSION_ID}`) {
      return route.fulfill({ json: { session: {
        claudeSessionId: SESSION_ID, title: 'Session scroll check', process_status: 'idle',
        mode: 'default', messageCount: messages.length, startedAt: messages[0].timestamp,
        lastActiveAt: messages.at(-1).timestamp, threadAnchors: [], pinnedMessages: [],
      } } });
    }
    if (pathname.startsWith(`/api/sessions/${SESSION_ID}/`)) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.addInitScript((id) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]));
    localStorage.setItem('open-walnut-home-chat-visible', 'false');
    localStorage.setItem('open-walnut-home-todo-visible', 'false');
  }, SESSION_ID);
}

/** Wheel until the scroller reaches the top (-1) or the bottom (+1). */
async function wheelTo(page, scroller, direction, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = await scroller.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, direction * 800);
    await page.waitForTimeout(100);
    const done = await scroller.evaluate((el, step) => (step < 0
      ? el.scrollTop <= 1
      : el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1), direction);
    if (done) return true;
  }
  return false;
}

export async function checkSessionScroll(browser, url, timeoutMs, strict = false) {
  let page;
  let phase = 'load';
  const pageErrors = [];
  const boundaryHits = [];
  const crashed = async () => boundaryHits.length > 0
    || (await page?.evaluate((banner) => document.body?.innerText.includes(banner), BOUNDARY_BANNER).catch(() => false));
  const crashResult = () => ({ code: 1, message: `session scroll FAILED: the session panel crashed ${boundaryHits.slice(0, 2).join('; ')}` });
  try {
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' && BOUNDARY_CONSOLE.test(m.text())) boundaryHits.push(m.text().slice(0, 300)); });
    await mockSession(page);
    const target = new URL(url);
    target.search = '';
    target.hash = '';
    target.searchParams.set('s1', SESSION_ID);
    await page.goto(target.href, { waitUntil: 'load', timeout: timeoutMs });
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
    const scroller = panel.locator('.session-history');
    await page.waitForFunction((id) => document.querySelector(`.session-panel[data-session-id="${id}"] .session-history`)?.textContent.includes('Final line 59.'),
      SESSION_ID, { timeout: timeoutMs });
    if (await crashed()) return crashResult();
    const geometry = await panel.evaluate((root) => {
      const el = root.querySelector('.session-history');
      const body = root.querySelector('.session-panel-body');
      const composer = root.querySelector('.session-panel-input');
      if (!el || !body || !composer) return null;
      return {
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
        scrollerBottom: el.getBoundingClientRect().bottom,
        bodyBottom: body.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      };
    });
    if (!geometry || geometry.clientHeight < 100
      || geometry.scrollHeight <= geometry.clientHeight + 100
      || geometry.scrollerBottom > geometry.bodyBottom + 1
      || geometry.scrollerBottom > geometry.composerTop + 1) {
      return { code: 1, message: `session scroll FAILED: transcript is clipped or has no scroll range ${JSON.stringify(geometry)}` };
    }
    // Down, up, down: whichever end the panel opens at, the last two legs must move.
    for (const direction of [1, -1, 1]) {
      phase = direction < 0 ? 'scroll up' : 'scroll down';
      if (!await wheelTo(page, scroller, direction, timeoutMs)) {
        return { code: 1, message: `session scroll FAILED: could not ${phase} within ${timeoutMs}ms` };
      }
    }
    if (await crashed()) return crashResult();
    if (strict && pageErrors.length) return { code: 1, message: `session scroll FAILED (--strict): ${pageErrors.slice(0, 3).join('; ')}` };
    if (pageErrors.length) console.warn(`session scroll WARN: ${pageErrors.length} uncaught page exception(s): ${pageErrors.slice(0, 3).join('; ')}`);
    return { code: 0, message: `session scroll OK: long transcript scrolls both ways above the composer ${JSON.stringify(geometry)}` };
  } catch (error) {
    if (await crashed()) return crashResult();
    return { code: 2, message: `session scroll UNDETERMINED (${phase}): ${String(error?.message ?? error).split('\n')[0]}` };
  } finally {
    await page?.close().catch(() => {});
  }
}
