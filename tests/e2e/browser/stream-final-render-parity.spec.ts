/**
 * A reply looks the same while it streams and after it lands.
 *
 * The user (2026-11-01, Mac app): a code block was grey while the reply
 * streamed and turned dark the moment it finished, with a visible refresh; "no
 * flash, no change of format, font, whatever". The cause was a style keyed on
 * an ancestor class: `.session-msg-assistant .markdown-body pre` is the dark
 * code block, and a streaming text block that followed a tool run rendered in a
 * wrapper with no class, so it fell back to the plain grey `.markdown-body pre`
 * (and lost the row's font size, line height and list indents) until its
 * persisted twin replaced it.
 *
 * This spec is the guard for the whole class: it streams rich Markdown (heading,
 * inline code, bold, a link, both list kinds, a fenced code block, a table, a
 * blockquote, a rule, a raw HTML card) as the FIRST block of a turn and as a
 * block AFTER a tool run, snapshots every element of the reply (tag, class,
 * computed style, size, offset), lands the turn, and requires the persisted row
 * to match exactly. A sampler running on every animation frame across the
 * handover requires that the reply is on screen exactly once in every frame and
 * that its code block never changes color, place or size.
 *
 * The reply also holds a script block (an ```html-app island, a sandboxed
 * iframe): it must load once and never again, and the reply's body, iframe and
 * images must be the very same DOM nodes after the handover. WebKit (the Mac
 * app) reloads an iframe that is moved or re-created, so the persisted row has
 * to take over the stream's own elements.
 *
 * Harness: the captured /ws socket of single-timeline-fault-injection.spec.ts,
 * so the real client pipeline (useSessionStream, render filter, StreamingBlockView,
 * SessionMessage) runs against injected deltas and a route-mocked history.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  countIslandLoads, diffSnaps, disableTransitions, dumpRows, islandFence, islandLoads, replyNodesReplaced, snapReply,
  startFrameSampler, stopFrameSampler, tagReplyNodes,
} from './render-parity-helpers';

const SESSION_ID = 'pw-stream-parity';
/** A 40x24 solid PNG, served for the screenshot path the reply names. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAKElEQVR4nGNwaDgwIIhh1OJRi0ctHrV41OJRi0ctHrV41OJRi4ePxQCJ4aBM/dotLQAAAABJRU5ErkJggg==',
  'base64',
);

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket: did addInitScript run?');
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

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-stream-parity',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Stream parity session',
        },
      },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await disableTransitions(page);
  await countIslandLoads(page);
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

/** Rich Markdown carrying one unique marker, so each copy can be found. */
function richReply(marker: string, long: boolean): string {
  const filler = long
    ? Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} of the long reply, long enough to wrap onto a second line in a narrow column of the session panel.\n`)
    : [];
  return [
    ...filler,
    `## Findings ${marker}`,
    '',
    `The **check** ran \`bun run build\` and wrote [the report](https://example.com/r) for ${marker}.`,
    '',
    '- first point with `inline code`',
    '- second point',
    '  - nested point',
    '',
    '1. step one',
    '2. step two',
    '',
    '```ts',
    `const marker = '${marker}';`,
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '```',
    '',
    '| Name | Count |',
    '| --- | ---: |',
    '| alpha | 1 |',
    '| beta | 22 |',
    '',
    '> A quoted line.',
    '',
    `The screenshot is at /tmp/parity-shots/${marker}.png for review.`,
    '',
    '---',
    '',
    '<div style="border:1px solid #888;padding:8px;border-radius:6px"><b>Card</b> body text</div>',
    '',
    ...islandFence(marker),
    'Closing sentence.',
  ].join('\n');
}

type Placement = 'first' | 'after-tool';
type Length = 'short' | 'long' | 'fits';

/** `midRead`: the reply has reasoning, and a history read while its words
 *  still stream brings the reasoning alone (the transcript wrote that line
 *  first), so the reply's row is in history before its words are. */
async function runParity(page: Page, placement: Placement, length: Length, midRead = false) {
  const marker = `M${placement === 'first' ? 'FIRST' : 'AFTER'}${length.toUpperCase()}${midRead ? 'MID' : ''}${test.info().repeatEachIndex}`;
  // `fits`: a window tall enough that the conversation does not scroll, so
  // nothing anchors the reply to the bottom and any change above it shows.
  if (length === 'fits') await page.setViewportSize({ width: 1280, height: 2400 });
  const reply = richReply(marker, length === 'long');
  const base = [
    { role: 'user', text: 'Run the check', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'Starting.', msgId: 'msg-base', timestamp: '2026-01-01T00:00:01.000Z' },
    { role: 'user', text: 'Now report', timestamp: '2026-01-01T00:00:02.000Z' },
  ];
  const tool = { name: 'Bash', toolUseId: 'toolu_parity_1', input: { command: 'echo hi' }, result: 'hi' };
  const reasoning = midRead ? { thinking: 'Weighing the findings.' } : {};
  const thinkingOnly = [{ role: 'assistant', text: '', ...reasoning, msgId: 'msg-reply', timestamp: new Date().toISOString() }];
  const persisted = placement === 'first'
    // Stamped now, as the CLI stamps a reply it just wrote: the strip under it
    // reads the same age before and after.
    ? [{ role: 'assistant', text: reply, ...reasoning, msgId: 'msg-reply', timestamp: new Date().toISOString() }]
    : [
      { role: 'assistant', text: 'Let me check.', msgId: 'msg-lead', timestamp: new Date().toISOString(), tools: [tool] },
      { role: 'assistant', text: reply, msgId: 'msg-reply', timestamp: new Date().toISOString() },
    ];
  let flushed = false;
  let reasoned = false;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const rows = flushed ? [...base, ...persisted] : reasoned ? [...base, ...thinkingOnly] : base;
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) {
      return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    }
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await mockSessionDetail(page);
  await page.route('**/api/local-image**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }));

  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await waitForWs(page);
  await page.waitForSelector('.session-msg', { timeout: 8000 });

  if (placement === 'after-tool') {
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Let me check.', msgId: 'msg-lead' });
    await page.waitForTimeout(200);
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: tool.toolUseId, input: tool.input });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: tool.toolUseId, result: 'hi' });
  }
  if (midRead) {
    await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'Weighing the findings.', msgId: 'msg-reply' });
  }
  // Stream the reply in pieces, the way tokens arrive.
  const pieces = reply.match(/[\s\S]{1,40}/g)!;
  for (const piece of pieces) {
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: piece, msgId: 'msg-reply' });
  }
  const history = page.locator('.main-page-session-column .session-history').first();
  await expect(history).toContainText('Closing sentence.');
  await page.waitForTimeout(400);
  if (midRead) {
    await expect.poll(() => islandLoads(page, marker), { timeout: 8000 }).toBe(1);
    expect(await tagReplyNodes(page, marker)).toBeGreaterThanOrEqual(3);
    reasoned = true;
    const read = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
    await read;
    await page.waitForTimeout(600);
    expect(await replyNodesReplaced(page, marker), 'reply nodes the reasoning-only read replaced').toEqual([]);
    expect(((await history.textContent()) ?? '').split('Closing sentence.').length - 1, 'copies of the reply').toBe(1);
  }
  // The turn ends: the working indicator goes, the stream stays on screen.
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
  await page.waitForTimeout(400);

  // The script block ran once, as the stream drew it.
  await expect.poll(() => islandLoads(page, marker), { timeout: 8000 }).toBe(1);
  const streamed = await snapReply(page, marker);
  if (process.env.PARITY_DUMP) await dumpRows(page, 'streamed');
  expect(await tagReplyNodes(page, marker)).toBeGreaterThanOrEqual(3);
  await startFrameSampler(page, marker);

  // The archive lands and the persisted row takes over.
  flushed = true;
  const landed = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await landed;
  // The persisted row is what renders now: the streamed "Let me check." and
  // its persisted twin are one copy, never two.
  await expect.poll(async () => page.evaluate((marker) => {
    const h = document.querySelector('.main-page-session-column .session-history') ?? document.querySelector('.session-history');
    const copies = ((h?.textContent ?? '').match(/Closing sentence\./g) ?? []).length;
    // A reply still streaming is drawn as a row too, marked `data-stream-reply`;
    // a row without it is the persisted one, so this proves the handover happened.
    const persisted = Array.from(h?.querySelectorAll('[data-msg-ts]:not([data-stream-reply])') ?? [])
      .some((row) => (row.textContent ?? '').includes(`Findings ${marker}`));
    return copies === 1 && persisted;
  }, marker), { timeout: 8000 }).toBe(true);
  await page.waitForTimeout(800);
  const { samples, imgs, srcs } = await stopFrameSampler(page);
  if (process.env.PARITY_DUMP) console.log(JSON.stringify(samples.map((x, i) => [srcs[i], x[0]?.top])));
  const finished = await snapReply(page, marker);
  if (process.env.PARITY_DUMP) await dumpRows(page, 'finished');
  const replaced = await replyNodesReplaced(page, marker);
  const loads = await islandLoads(page, marker);

  return { streamed, finished, samples, imgs, replaced, loads };
}

test('a reply whose reasoning reached a history read before its words keeps every element through both reads', async ({ page }) => {
  const { finished, replaced, loads } = await runParity(page, 'first', 'short', true);
  expect(loads, 'loads of the script block').toBe(1);
  expect(replaced, 'reply nodes the handover replaced').toEqual([]);
  expect(finished.elems.some((e) => e.tag === 'IFRAME')).toBe(true);
});

for (const placement of ['first', 'after-tool'] as const) for (const length of ['short', 'long', 'fits'] as const) {
  test(`a ${length} reply streamed as the ${placement} block of its turn looks exactly like its persisted row, in every frame`, async ({ page }) => {
    const { streamed, finished, samples, imgs, replaced, loads } = await runParity(page, placement, length);

    // The reply really is rich: a dark code block, a table, lists, a card.
    expect(streamed.elems.some((e) => e.tag === 'PRE')).toBe(true);
    expect(streamed.elems.some((e) => e.tag === 'TABLE')).toBe(true);

    // Nothing was built again: the same body, iframe and images, and the
    // script block never reloaded.
    expect(loads, 'loads of the script block').toBe(1);
    expect(replaced, 'reply nodes the handover replaced').toEqual([]);
    expect(streamed.elems.some((e) => e.tag === 'IFRAME')).toBe(true);

    const diffs = diffSnaps(streamed, finished);
    expect(diffs, `streamed vs finished render differ:\n${diffs.slice(0, 40).join('\n')}`).toEqual([]);
    expect(finished.html).toBe(streamed.html);

    // Across the handover, every frame shows the reply exactly once, in the
    // same place, the same size and the same colors.
    expect(samples.length).toBeGreaterThan(1);
    const first = samples[0][0];
    const bad = samples
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.length !== 1 || Math.abs(s[0].top - first.top) >= 1
        || JSON.stringify({ ...s[0], top: 0 }) !== JSON.stringify({ ...first, top: 0 }));
    // The screenshot preview is on screen and drawn in every frame: it is the
    // same <img> the stream drew.
    const blankImg = imgs.map((s, i) => ({ i, s })).filter(({ s }) => s.length < 2 || s.some((ok) => !ok));
    expect(blankImg.slice(0, 5), 'frames where the image preview was missing or not drawn').toEqual([]);
    expect(bad.slice(0, 5), `frames where the code block was missing, doubled or changed (first: ${JSON.stringify(first)})`).toEqual([]);
  });
}
