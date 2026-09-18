/**
 * Playwright browser test: when a turn ends, the END of the reply is on screen.
 *
 * Reported (2026-09-17, screenshot): a long reply finished, the recap tip
 * appeared above the composer, and the last lines of the answer sat under the
 * composer glass, fading out — with no ↓ arrow and no follow-bottom catching
 * up. "Why does it keep not showing the end?"
 *
 * This file replays that exact sequence with the captured-WS injection harness:
 * a stream of text deltas, then `session:result`, then the persisted message and
 * the recap arrive through the refetches the panel makes on turn end. After each
 * step it measures the one quantity the symptom is about — how far the newest
 * content's bottom edge sits below the composer overlay's top — and requires
 * the tail to be clear of the glass whenever the reader was following.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-turn-end-tail';
const TASK_ID = 'pw-turn-end-tail-task';
const BASE_TURNS = 24;

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() });
      ws.dispatchEvent(new MessageEvent('message', { data: frame }));
    },
    { name, data },
  );
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

function buildBase() {
  const out: Array<{ role: string; text: string; timestamp: string; msgId: string }> = [];
  for (let i = 0; i < BASE_TURNS; i++) {
    out.push({
      role: 'user', msgId: `base-u${i}`,
      text: `historical question ${i}: where does the folder name come from?`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString(),
    });
    out.push({
      role: 'assistant', msgId: `base-a${i}`,
      text: `historical answer ${i}\n\n${'The registry is fetched separately from the task list, so a failed fetch leaves every folder nameless. '.repeat(3)}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString(),
    });
  }
  return out;
}

/** The reply, shaped like the reported one: bold lead, bullets, inline code, an
 *  insight block, and a closing paragraph — the part that went missing. */
const REPLY_PARAGRAPHS = [
  '**Bottom line: no session corrupted the data; the folder names and projects are intact.** What you saw is one window whose in-memory state broke: the folder-name registry was not fetched during the automatic reload and was never fetched again. Press Cmd+R once and the names come back.',
  'Two separate things are going on here.',
  '**The number after the project (Walnut PROJECT 3) is normal.** It is the task count under that project, present since the first version of `TodoPanel` (`todo-group-count`), not something new.',
  '**Folder rows showing only an icon and a number is the anomaly.** The number is the member count (also always there); what is missing is the folder name. The name comes from a separate endpoint, `GET /api/tasks/groups`, read in `web/src/components/tasks/TodoPanel.tsx:5500` as `taskGroups?.[gid] ?? \'\'`, so an empty registry silently paints an empty name.',
  'I verified layer by layer that the data is fine:',
  '- the `task_groups` table in `~/.open-walnut/tasks/tasks.sqlite` has 72 rows with every label present; `/api/tasks/groups` returns all of them, 115 requests over two days, all 200.',
  '- a fresh headless browser against :3456 renders the three nameless folders from your screenshot with their real names, so the deployed code is fine and only your window is broken.',
  '**Timeline (local time):**',
  '1. 17:01 a deploy restarted :3456.',
  '2. 17:50:16 your window reloaded onto the new build (log: `[assets] reloading hidden tab onto the current build`).',
  '3. 17:50:21 the page remounted while the server event loop was stalled for about 15s (`/api/skills` took 11.4s, the health monitor reported "tick budget exceeded").',
  '4. the client admission queue (`web/src/api/client.ts:25`, 6 slots, 20s max wait) rejected a whole batch of boot requests at +20s: `[workflow]`, `[engine-catalog]`, `[focus] custom tier registry fetch failed`. `/api/tasks/groups` was in that batch; the server has no record of the request.',
  '5. the task list has backoff retry and refetches on WS reconnect (`useTasks.ts:575`), so it recovered at 17:50:46; `refetchGroups` (`useTasks.ts:411`) swallows the error with `.catch(() => {})`, never retries, and the reconnect effect does not refetch it — so it stayed empty until now.',
  '★ Insight ─────────────────────────────────────',
  '- Two silent failures stacked: the queue rejection happens before `attemptRequest`, so no `[api] ... FAILED` line is written, and `refetchGroups` swallows the rejection. Either layer speaking up would have made this visible on the spot.',
  '- The two fetches in the same hook have asymmetric recovery: one has retry plus reconnect resync, the other is one-shot. Any registry that is fetched once and used for a long time needs the same recovery path as the primary data.',
  '- This is another instance of the rule already in your memory: an empty object left behind by a failed read is indistinguishable from a genuine "nothing here", and the UI paints the failure as "no name".',
  '─────────────────────────────────────────────────',
  '**Proposed fix** (no code touched yet, since you asked why): in `web/src/hooks/useTasks.ts` give `refetchGroups` the same backoff retry as `refetch`, and refetch groups in the WS-reconnect effect too; while there, make the admission queue in `client.ts` log one line with the request path when it rejects, so the next deploy that lands on a stall heals itself. Say the word and I will implement it through the full development flow and commit.',
];
const REPLY_TEXT = REPLY_PARAGRAPHS.join('\n\n');
const TAIL_SENTENCE = 'Say the word and I will implement it';

const RECAP = 'Diagnosed the blank folder names as a silent client-side fetch failure in one window (data intact, reload fixes it) and proposed a retry/resync code fix, not yet implemented.';

/** Split the reply into stream-sized deltas (word boundaries, ~40 chars). */
function deltasOf(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const word of text.split(/(?<=\s)/)) {
    buf += word;
    if (buf.length >= 40) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out;
}

type Geometry = {
  gap: number;
  arrow: boolean;
  lastRowBelowComposerBy: number | null;
  composerTop: number;
  composerH: number;
  varH: string;
  paddingBottom: string;
  tailBottom: number | null;
  /** > 0 means the newest content is under the composer overlay. */
  tailBelowComposerBy: number | null;
  recap: boolean;
};

async function geometry(page: Page, tailNeedle: string): Promise<Geometry> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
  return panel.evaluate((p, needle) => {
    const h = p.querySelector<HTMLElement>('.session-history')!;
    const composer = p.querySelector<HTMLElement>('.session-panel-input')!;
    const cr = composer.getBoundingClientRect();
    // The newest content = the text node holding the reply's last sentence,
    // measured through a Range so inline children (code, strong) do not matter.
    let tail: DOMRect | null = null;
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const idx = (node.textContent || '').indexOf(needle);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, Math.min(node.textContent!.length, idx + needle.length));
      const r = range.getBoundingClientRect();
      if (r.height > 0 && (!tail || r.bottom > tail.bottom)) tail = r;
    }
    // The lowest row box (the message's action row included), arrow excluded.
    let rowBottom = -Infinity;
    for (const child of Array.from(h.children) as HTMLElement[]) {
      if (child.classList.contains('scroll-to-bottom-btn')) continue;
      const r = child.getBoundingClientRect();
      if (r.height > 0) rowBottom = Math.max(rowBottom, r.bottom);
    }
    return {
      gap: Math.round(h.scrollHeight - h.scrollTop - h.clientHeight),
      arrow: !!p.querySelector('.scroll-to-bottom-btn.visible'),
      lastRowBelowComposerBy: Number.isFinite(rowBottom) ? Math.round(rowBottom - cr.top) : null,
      composerTop: Math.round(cr.top),
      composerH: composer.offsetHeight,
      varH: p.style.getPropertyValue('--sp-composer-h'),
      paddingBottom: getComputedStyle(h).paddingBottom,
      tailBottom: tail ? Math.round(tail.bottom) : null,
      tailBelowComposerBy: tail ? Math.round(tail.bottom - cr.top) : null,
      recap: !!p.querySelector('.session-recap-tip'),
    };
  }, tailNeedle);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
              }
            } catch { /* non-JSON */ }
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  });
});

test.describe('turn end keeps the tail of the reply on screen', () => {
  test('stream → result → persisted message + recap: the last sentence stays clear of the composer', async ({ page }) => {
    const base = buildBase();
    let turnDone = false;
    let recapReady = false;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) {
        const delta = turnDone
          ? [
              { role: 'user', text: 'why are my folders numbered?', msgId: 'turn-u', timestamp: '2026-01-01T03:00:00.000Z' },
              { role: 'assistant', text: REPLY_TEXT, msgId: 'turn-a', timestamp: '2026-01-01T03:00:05.000Z' },
            ]
          : [];
        await route.fulfill({ json: { messages: delta, cursor: base.length + delta.length, delta: true } });
      } else {
        await route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
    });
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
            process_status: turnDone ? 'idle' : 'running', mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
            messageCount: base.length, title: 'Turn end tail repro',
            ...(recapReady ? { recap: RECAP } : {}),
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
    await expect(history).toContainText(`historical answer ${BASE_TURNS - 1}`, { timeout: 15000 });
    // Let the load-window pin retire so only the turn moves the view from here.
    await page.waitForTimeout(1500);
    const g0 = await geometry(page, `historical answer ${BASE_TURNS - 1}`);
    console.log('[tail] loaded', JSON.stringify(g0));
    expect(g0.gap).toBeLessThanOrEqual(2);

    // The user's question, then the reply streams in.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, taskId: TASK_ID, delta: '', msgId: 'turn-a' });
    for (const d of deltasOf(REPLY_TEXT)) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, taskId: TASK_ID, delta: d, msgId: 'turn-a' });
      await page.waitForTimeout(12);
    }
    await expect(history).toContainText(TAIL_SENTENCE);
    await page.waitForTimeout(600);
    const g1 = await geometry(page, TAIL_SENTENCE);
    console.log('[tail] streamed', JSON.stringify(g1));
    await page.screenshot({ path: '/tmp/turn-end-tail/1-streamed.png' });

    // Turn ends: the panel refetches the session (recap not ready yet) and the
    // history delta replaces the live block with the persisted message.
    turnDone = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, result: 'done', isError: false });
    await expect(page.locator('.session-working-indicator')).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(1200);
    const g2 = await geometry(page, TAIL_SENTENCE);
    console.log('[tail] after result', JSON.stringify(g2));
    await page.screenshot({ path: '/tmp/turn-end-tail/2-after-result.png' });

    // The recap lands a little later (the summarizer runs after the turn); the
    // panel picks it up on its next session refetch — drive one via status-changed
    // the way the server does.
    recapReady = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, result: 'done', isError: false });
    await expect(page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-recap-tip`)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(800);
    const g3 = await geometry(page, TAIL_SENTENCE);
    console.log('[tail] after recap', JSON.stringify(g3));
    await page.screenshot({ path: '/tmp/turn-end-tail/3-after-recap.png' });

    // The invariant the report is about: while following, the newest content is
    // never under the composer overlay. (A clear ↓ arrow would also be an
    // acceptable answer, but the reader never left the bottom here.)
    for (const [label, g] of [['streamed', g1], ['after result', g2], ['after recap', g3]] as const) {
      expect(g.tailBottom, `${label}: tail sentence rendered`).not.toBeNull();
      expect(g.tailBelowComposerBy!, `${label}: tail clear of the composer glass (gap=${g.gap}, arrow=${g.arrow})`).toBeLessThanOrEqual(0);
    }
  });

  test('a 40px late-layout growth is followed, and the reader\'s own 40px nudge is not', async ({ page }) => {
    // The small-gap shape from the screenshot: the last line ended up ~40px under
    // the composer glass with NO ↓ arrow. 40px is inside the 80px near-bottom
    // tolerance, so `isAtBottom` still said "following", every event-keyed follow
    // path had already fired, and the arrow's own threshold hid the affordance —
    // a permanent blind spot right where the newest words are.
    //
    // The growth driver here is synthetic (a spacer appended to the last row)
    // because it stands in for a FAMILY of late layout that arrives after every
    // other path is done: WebKit reserving a scrollbar track in a code block, a
    // font swapping, an async rich block committing. What matters is the shape —
    // scrollHeight grows, scrollTop does not move, nobody is notified.
    //
    // The second half is the safety property, and it is why the follower keys on
    // growth rather than on `isAtBottom`: when the READER moves up by the same
    // 40px to read a clipped line, nothing may drag them back.
    const base = buildBase();
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
      await route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
            process_status: 'running', mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
            messageCount: base.length, title: 'Late layout tail',
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
    const history = panel.locator('.session-history');
    await expect(history).toContainText(`historical answer ${BASE_TURNS - 1}`, { timeout: 15000 });
    await page.waitForTimeout(2000); // load-window pin retired; the view rests at the bottom
    expect((await geometry(page, 'nothing')).gap).toBeLessThanOrEqual(2);

    // ── Late layout: the last row grows 40px, nothing is notified ──
    const grow = async (px: number) => history.evaluate((el, px) => {
      const rows = Array.from(el.children).filter((c) => !c.classList.contains('scroll-to-bottom-btn'));
      const last = rows[rows.length - 1] as HTMLElement;
      const spacer = document.createElement('div');
      spacer.style.height = `${px}px`;
      spacer.setAttribute('data-late-layout', '1');
      last.appendChild(spacer);
    }, px);
    await grow(40);
    // One 2Hz tick is the budget: this shape has no event to ride.
    await page.waitForTimeout(900);
    const g = await geometry(page, 'nothing');
    console.log('[tail] late layout', JSON.stringify(g));
    await page.screenshot({ path: '/tmp/turn-end-tail/5-late-layout.png' });
    expect(g.gap, 'a shortfall under the 80px tolerance is still closed').toBeLessThanOrEqual(2);
    expect(g.lastRowBelowComposerBy!, 'last row clear of the composer glass').toBeLessThanOrEqual(0);

    // ── The reader's own nudge is theirs to keep ──
    // A REAL wheel, not a dispatched one: only a real gesture goes through the
    // same path a person's fingers do (a synthesized wheel scrolled by a
    // different amount in WebKit, which is the harness talking, not the app).
    const box = (await history.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(300);
    const before = await history.evaluate((el) => Math.round(el.scrollTop));
    await page.waitForTimeout(1600); // three follower ticks
    const after = await history.evaluate((el) => Math.round(el.scrollTop));
    console.log(`[tail] reader nudge before=${before} after=${after}`);
    // One-directional on purpose: the property is "never pulled back toward the
    // bottom". Drifting further up would be a different bug, and the specs that
    // own it (scroll-jump-on-absorption) assert it where it belongs.
    expect(after, 'the follower never drags a reader who moved').toBeLessThanOrEqual(before + 2);
  });

  test('fresh load of an idle session that already has a recap lands on the end of the reply', async ({ page }) => {
    // The reported window: the turn had ended minutes earlier, the recap was
    // already on the record, and the page was reloaded (the RPC counter in its
    // log restarts at r1). Everything the panel needs is there from the first
    // fetch; the question is only where the initial load leaves the view.
    const base = buildBase();
    const full = [
      ...base,
      { role: 'user', text: 'why are my folders numbered?', msgId: 'turn-u', timestamp: '2026-01-01T03:00:00.000Z' },
      { role: 'assistant', text: REPLY_TEXT, msgId: 'turn-a', timestamp: '2026-01-01T03:00:05.000Z' },
    ];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) return route.fulfill({ json: { messages: [], cursor: full.length, delta: true } });
      await route.fulfill({ json: { messages: full, cursor: full.length, delta: false } });
    });
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
            process_status: 'idle', mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
            messageCount: full.length, title: 'Turn end tail repro (reload)',
            recap: RECAP,
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
    await expect(panel.locator('.session-history')).toContainText(TAIL_SENTENCE, { timeout: 15000 });
    await expect(panel.locator('.session-recap-tip')).toBeVisible({ timeout: 5000 });
    // Well past the load-window pin's quiet period, so this is where the view rests.
    await page.waitForTimeout(2500);
    const g = await geometry(page, TAIL_SENTENCE);
    console.log('[tail] reload', JSON.stringify(g));
    await page.screenshot({ path: '/tmp/turn-end-tail/4-reload.png' });
    expect(g.tailBottom, 'tail sentence rendered').not.toBeNull();
    expect(g.tailBelowComposerBy!, `tail clear of the composer glass (gap=${g.gap}, arrow=${g.arrow})`).toBeLessThanOrEqual(0);
  });
});
