/**
 * Playwright tests for RICH-BLOCK STREAMING — assistant text that carries raw
 * HTML is rendered natively, split into frozen chunks plus one growing tail
 * (web/src/utils/rich-blocks.ts + web/src/components/chat/RichBlocks.tsx).
 *
 * The regression this exists for: streaming used to re-set the WHOLE message's
 * innerHTML on every delta, so a CSS-only widget the user had just clicked reset
 * ~6 times a second and was unusable while the model kept talking. A completed
 * chunk must therefore keep its DOM NODES (not just its text) for the rest of the
 * stream — that is what test 1 measures, with a marker written onto the live node.
 *
 * Also pinned here, because each is a way model markup could damage the app:
 *   2. a reply's `<style>` may not restyle the console (every rule is rewritten
 *      under the message's own `[data-rblk]`).
 *   3. a ```html-app fence renders a placeholder while incomplete and a
 *      sandbox="allow-scripts" iframe island once closed — never innerHTML, and
 *      never allow-same-origin (which would undo the sandbox).
 *   4. the composer's output-mode pill PATCHes `output_mode` on the session.
 *   5. a `<style>` written FIRST (the order a model writes most naturally) both
 *      survives the sanitizer AND styles markup that lands in a LATER chunk of the
 *      same message. Two fixes meet here: `FORCE_BODY: true` in markdown.ts, which
 *      stops the HTML parser from putting a leading `<style>` into `<head>` where
 *      DOMPurify then dropped it, and a MESSAGE-level scope id, since the style and
 *      the markup it styles are separated by a blank line, i.e. a chunk boundary.
 *   6. angle brackets that are prose (a `<https://…>` autolink) do not count as an
 *      open element — the old depth counter never closed one, which silently
 *      disabled freezing for everything after it in the reply.
 *
 * Harness is the one from single-timeline-fault-injection.spec.ts: the app's own
 * /ws socket is captured in an init script and events are dispatched into it, so
 * the whole client pipeline (useSessionStream → 150ms coalesced flush →
 * StreamingTextBlock → RichMarkdown) runs for real against injected deltas.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SESSION_ID = 'pw-rich-html';
const TASK_ID = 'pw-task-rich-html';
const MSG_ID = 'msg-rich-1';
const SHOT_DIR = '/tmp/rich-html-e2e';

// ── Helpers (same harness as single-timeline-fault-injection.spec.ts) ──

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

/**
 * Session record mock. Stateful on purpose: the output-mode test PATCHes the
 * record, and a later GET that answered with the pre-PATCH value would look like
 * the optimistic update being reverted.
 */
function mockSessionDetail(page: Page, opts?: { onPatch?: (body: Record<string, unknown>) => void }) {
  const record: Record<string, unknown> = {
    claudeSessionId: SESSION_ID,
    taskId: TASK_ID,
    project: 'Walnut',
    process_status: 'running',
    mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: new Date().toISOString(),
    messageCount: 2,
    title: 'Rich HTML streaming session',
  };
  return page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    if (request.method() === 'PATCH') {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      opts?.onPatch?.(body);
      Object.assign(record, body);
      return route.fulfill({ json: { session: { ...record } } });
    }
    await route.fulfill({ json: { session: { ...record } } });
  });
}

const base = [
  { role: 'user', text: 'Show me the rollout wizard', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Sure.', timestamp: '2026-01-01T00:00:01.000Z' },
];

/**
 * History NEVER grows in these tests. A persisted twin would absorb the
 * streaming block and legitimately rebuild its DOM (a fresh render of the
 * archived row) — which is not what "state survives STREAMING" means.
 */
function mockFrozenHistory(page: Page) {
  return page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
    return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
  });
}

async function openSession(page: Page) {
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await waitForWs(page);
  await page.waitForSelector('.session-msg', { timeout: 15000 });
}

/** Stream `text` as ~`size`-char text-deltas, exactly like the provider does. */
async function streamDeltas(page: Page, text: string, size = 40) {
  for (let i = 0; i < text.length; i += size) {
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, taskId: TASK_ID, msgId: MSG_ID, delta: text.slice(i, i + size),
    });
  }
}

/** `data-rblk` of the MESSAGE wrapper that owns `selector`, or null. */
function scopeIdOf(page: Page, selector: string) {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.closest('[data-rblk]')?.getAttribute('data-rblk') ?? null,
    selector,
  );
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

// ── The widget under test ────────────────────────────────────────────────────

/**
 * A compact CSS-only radio stepper: three radios (hidden), labels as "next"
 * buttons, `:checked ~ sibling` rules revealing one step at a time. No blank
 * lines (one HTML block, so ONE chunk) and every line flush-left (4+ leading
 * spaces after a blank line would read as an indented code block).
 *
 * The `<style>` sits INSIDE `.wz` here only because that keeps the whole widget in
 * ONE chunk, which is what tests 1 and 6 are about. The style-first shape is
 * covered separately by test 5.
 */
const STEPPER = [
  '<div class="wz">',
  '<style>',
  '.wz-step { display: none; }',
  '.wz input[type="radio"] { display: none; }',
  '#wz-s1:checked ~ .wz-steps .wz-step-1 { display: block; }',
  '#wz-s2:checked ~ .wz-steps .wz-step-2 { display: block; }',
  '#wz-s3:checked ~ .wz-steps .wz-step-3 { display: block; }',
  '.wz-btn { display: inline-block; padding: 4px 10px; border: 1px solid #888; border-radius: 6px; cursor: pointer; }',
  '</style>',
  '<input type="radio" name="wz" id="wz-s1" checked>',
  '<input type="radio" name="wz" id="wz-s2">',
  '<input type="radio" name="wz" id="wz-s3">',
  '<div class="wz-steps">',
  '<div class="wz-step wz-step-1">STEP ONE pick a region <label class="wz-btn" for="wz-s2">Next capacity</label></div>',
  '<div class="wz-step wz-step-2">STEP TWO choose capacity <label class="wz-btn" for="wz-s3">Next review</label></div>',
  '<div class="wz-step wz-step-3">STEP THREE review and apply</div>',
  '</div>',
  '</div>',
].join('\n');

test.describe('Rich HTML streaming', () => {
  test('1. a frozen chunk keeps its DOM and its widget state while the tail keeps streaming', async ({ page }) => {
    await mockFrozenHistory(page);
    await mockSessionDetail(page);
    await openSession(page);
    const history = page.locator('.session-history');

    // Stepper closes, then the blank line + the first prose line — which is what
    // turns the stepper into a STABLE (frozen) chunk — then a bit more prose.
    await streamDeltas(page, `${STEPPER}\n\nMore analysis is streaming right now`);
    await streamDeltas(page, ', and the wizard above must keep whatever the user clicked.');

    // Rendered as many blocks, not one: the stepper is its own chunk.
    await expect(page.locator('.session-history .rich-blocks').first()).toBeVisible();
    await expect(page.locator('.session-history .wz-step-1')).toBeVisible();
    await expect(page.locator('.session-history .wz-step-2')).toBeHidden();
    expect(await page.locator('.session-history .rich-blocks .rich-chunk').count())
      .toBeGreaterThanOrEqual(2);
    const scopeId = await scopeIdOf(page, '.wz');
    expect(scopeId).toBeTruthy();

    // Mark the LIVE node. An innerHTML rewrite rebuilds it and drops the marker,
    // so this distinguishes "React skipped the write" from "it happened to
    // re-render the same checked state".
    await page.evaluate(() => {
      (document.querySelector('.wz') as HTMLElement).dataset.pwMarker = 'kept';
    });

    // The user drives the widget mid-stream: label click checks the hidden radio.
    await page.locator('.session-history label[for="wz-s2"]').click();
    await expect(page.locator('.session-history .wz-step-2')).toBeVisible();
    await expect(page.locator('.session-history .wz-step-1')).toBeHidden();

    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SHOT_DIR}/step2-during-stream.png` });

    // …and the model keeps talking: five more prose deltas.
    const later = [
      ' The capacity check compared three regions',
      ' and picked the cheapest one that still had',
      ' headroom for the next two quarters.',
      ' Nothing else needs to change before apply.',
      ' TAIL-SENTINEL-OK',
    ];
    for (const delta of later) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, taskId: TASK_ID, msgId: MSG_ID, delta });
    }
    // Proof the stream really kept rendering (so the assertions below are not a
    // frozen-display false pass).
    await expect(history).toContainText('TAIL-SENTINEL-OK');

    // THE REGRESSION: state and node identity both survived.
    await expect(page.locator('.session-history .wz-step-2')).toBeVisible();
    await expect(page.locator('.session-history .wz-step-1')).toBeHidden();
    expect(await scopeIdOf(page, '.wz')).toBe(scopeId);
    expect(await page.evaluate(() => (document.querySelector('.wz') as HTMLElement | null)?.dataset.pwMarker))
      .toBe('kept');

    // Turn end must not disturb it either.
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await expect(page.locator('.session-history .wz-step-2')).toBeVisible();
    await expect(page.locator('.session-history .wz-step-1')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('Something went wrong rendering the page.');
  });

  test('2. a reply\'s <style> cannot restyle the app — every rule is scoped to its message', async ({ page }) => {
    await mockFrozenHistory(page);
    await mockSessionDetail(page);
    await openSession(page);

    // The hostile case: two page-author rules that would blank the console — one
    // global (`body`), one aimed at a REAL app class. (Placement is not the point
    // here; test 5 covers the style-first shape.)
    await streamDeltas(
      page,
      '<div>styled block</div>\n<style>body{display:none!important}\n.chat-input-textarea{display:none!important}</style>\n\nand some prose after it.',
    );
    // `toBeAttached`, not `toBeVisible`: a `body{display:none}` rule is remapped to
    // the scope element itself (that is what "the page" means for a confined block),
    // and the scope element is now the MESSAGE wrapper — so the reply hides ITSELF.
    // Which is exactly the intended blast radius: this one message, nothing else.
    await expect(page.locator('.session-history .rich-blocks').first()).toBeAttached();
    await expect(page.locator('.session-history style')).toHaveCount(1);

    // The app is alive: composer visible, body not hidden.
    await expect(page.locator('.chat-input-textarea').first()).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
    expect(await page.evaluate(() => document.body.getBoundingClientRect().height)).toBeGreaterThan(0);
    // The rest of the page still paints: a sibling message is untouched.
    await expect(page.locator('.session-history').getByText('Show me the rollout wizard')).toBeVisible();

    // …because every selector was rewritten under the message's own attribute.
    const styleTexts = await page.locator('.session-history style').evaluateAll(
      (nodes) => nodes.map((n) => n.textContent ?? ''),
    );
    expect(styleTexts.length).toBeGreaterThan(0);
    for (const css of styleTexts) {
      expect(css, 'a model <style> reached the DOM unscoped').toContain('[data-rblk=');
      // EVERY rule, not just the first: one unprefixed selector is app-wide.
      const selectors = css.split('}').map((rule) => rule.split('{')[0].trim()).filter(Boolean);
      expect(selectors.length).toBeGreaterThanOrEqual(2);
      for (const sel of selectors) {
        expect(sel, `selector escaped its message: ${sel}`).toMatch(/^\[data-rblk="[A-Za-z0-9_-]+"\]/);
      }
    }
  });

  test('3. an html-app fence is a placeholder while incomplete, then a sandboxed island', async ({ page }) => {
    await mockFrozenHistory(page);
    await mockSessionDetail(page);
    await openSession(page);

    const fenceBody = [
      '<div id="app">counting…</div>',
      '<script>document.getElementById("app").textContent = "island ready";</script>',
    ].join('\n');

    // Prose, blank line, then the fence — so the fence is a chunk of its own.
    await streamDeltas(page, `Here is a widget:\n\n\`\`\`html-app\n${fenceBody}`);

    // Unclosed: inert placeholder, and NOTHING mounted.
    await expect(page.locator('.session-history .rich-app-building')).toBeVisible();
    expect(await page.locator('.session-history iframe.rich-island').count()).toBe(0);

    // Closing fence + a following prose line.
    await streamDeltas(page, '\n```\n\nDone building the widget.');

    const island = page.locator('.session-history iframe.rich-island');
    await expect(island).toHaveCount(1);
    await expect(page.locator('.session-history .rich-app-building')).toHaveCount(0);

    // allow-scripts and NOTHING else: with allow-same-origin the frame could
    // reach the app's DOM/storage and remove its own sandbox.
    expect(await island.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = (await island.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).toContain('<div id="app">counting…</div>');
    expect(srcdoc).toContain('island ready');

    // The frame carries its own CSP: the sandbox denies same-origin access, this
    // denies the NETWORK, so a model script cannot beacon out of the user's machine.
    expect(srcdoc).toMatch(/http-equiv="Content-Security-Policy"/i);
    expect(srcdoc).toContain("default-src 'none'");
    // …and the script still RUNS under it (a CSP that killed every island would
    // otherwise fail silently — the frame would just render its initial markup).
    await expect(page.frameLocator('iframe.rich-island').locator('#app')).toHaveText('island ready');
  });

  test('4. the output-mode pill PATCHes output_mode and shows the new mode', async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    await mockFrozenHistory(page);
    await mockSessionDetail(page, { onPatch: (body) => patches.push(body) });
    await openSession(page);

    const pill = page.locator('.session-mode-bar button[title^="Output mode"]').first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('MD');

    await pill.click();

    await expect(pill).toHaveText('Rich');
    await expect.poll(() => patches.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(patches.at(-1)).toMatchObject({ output_mode: 'rich' });
  });

  /**
   * The shape a model writes most naturally — "here is the CSS, here is the
   * markup" — and the one that used to be broken twice over:
   *
   *  · the sanitizer DROPPED a leading `<style>`. DOMPurify parses via
   *    `DOMParser.parseFromString(html, 'text/html')`, whose "before head"
   *    insertion mode puts a leading `<style>` into `<head>`; DOMPurify then
   *    returns `body` only, so the element was gone, content included (`style` is
   *    in its DEFAULT_FORBID_CONTENTS). `FORCE_BODY: true` fixes it. Measured with
   *    dompurify 3.3.1 in a real DOM: `<style>…</style><div>x</div>` loses the
   *    style without the flag and keeps it with, while `<script>`, `<form>`,
   *    `action` and `formaction` are stripped either way.
   *  · the scope was per CHUNK. A blank line between the style and the markup IS a
   *    chunk boundary, so the rule was confined to a `data-rblk` the styled element
   *    was not under and could never match. The scope is now per MESSAGE.
   *
   * Hence the blank line below: it is the exact separation that broke this.
   */
  test('5. a leading <style> survives, is scoped, and styles a LATER chunk of the same message', async ({ page }) => {
    await mockFrozenHistory(page);
    await mockSessionDetail(page);
    await openSession(page);

    await streamDeltas(
      page,
      '<style>\n.led { color: rgb(1, 2, 3); }\n</style>\n\n<div class="led">tinted</div>\n\ntrailing prose.',
    );

    // The style and the markup really are separate chunks (otherwise this would
    // pass for the wrong reason).
    await expect(page.locator('.session-history .led')).toBeVisible();
    expect(await page.locator('.session-history .rich-blocks .rich-chunk').count())
      .toBeGreaterThanOrEqual(2);
    const sameChunk = await page.evaluate(() => {
      const style = document.querySelector('.session-history .rich-blocks style');
      const led = document.querySelector('.session-history .led');
      return style?.closest('.rich-chunk') === led?.closest('.rich-chunk');
    });
    expect(sameChunk, 'style and markup landed in the SAME chunk — the cross-chunk case is not covered')
      .toBe(false);

    // It reached the DOM, it is scoped, and the rule APPLIES across the boundary.
    const css = await page.locator('.session-history style').first().textContent();
    expect(css ?? '').toContain('[data-rblk=');
    await expect(page.locator('.session-history .led')).toHaveCSS('color', 'rgb(1, 2, 3)');
  });

  test('6. an autolink in prose does not stop a later widget from freezing', async ({ page }) => {
    await mockFrozenHistory(page);
    await mockSessionDetail(page);
    await openSession(page);

    // `<https://…>` used to read as an element that opened a depth level and never
    // closed, so EVERY later blank line saw depth > 0 and nothing after it froze —
    // the widget below reset on every delta for the rest of the reply.
    await streamDeltas(page, `See <https://example.com/x> for the plan.\n\n${STEPPER}\n\nAnalysis continues`);

    // Wait for the coalesced flush before counting anything.
    await expect(page.locator('.session-history .wz-step-1')).toBeVisible();
    const chunks = page.locator('.session-history .rich-blocks .rich-chunk');
    await expect.poll(() => chunks.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(3); // prose · stepper · tail

    await page.evaluate(() => {
      (document.querySelector('.wz') as HTMLElement).dataset.pwMarker = 'kept';
    });
    await page.locator('.session-history label[for="wz-s2"]').click();
    await expect(page.locator('.session-history .wz-step-2')).toBeVisible();

    for (const delta of [' one', ' two', ' three', ' four', ' AUTOLINK-TAIL-OK']) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, taskId: TASK_ID, msgId: MSG_ID, delta });
    }
    await expect(page.locator('.session-history')).toContainText('AUTOLINK-TAIL-OK');

    await expect(page.locator('.session-history .wz-step-2')).toBeVisible();
    await expect(page.locator('.session-history .wz-step-1')).toBeHidden();
    expect(await page.evaluate(() => (document.querySelector('.wz') as HTMLElement | null)?.dataset.pwMarker))
      .toBe('kept');
  });
});
