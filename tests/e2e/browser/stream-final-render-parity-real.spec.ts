/**
 * The streamed-vs-finished parity check (stream-final-render-parity.spec.ts)
 * through the REAL pipeline: session:start, the daemon spawning the mock CLI,
 * its stream_event lines, the server's stream buffer, the WS broadcast, and the
 * persisted row from the real transcript parser, so the reply's msgId and text
 * after the handover are the ones the server really produces.
 *
 * The mock CLI's `stream-partial-markdown-reply` turn: a line of narration and a
 * Bash call, then a long rich Markdown answer in 40-character deltas. The
 * history read that brings the persisted rows is held until the streamed reply
 * has been measured, then released while every frame and DOM commit is sampled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import {
  countIslandLoads, diffSnaps, disableTransitions, dumpRows, islandLoads, replyNodesReplaced, snapReply,
  startFrameSampler, stopFrameSampler, tagReplyNodes,
} from './render-parity-helpers';

const MARKER = 'PARITYREAL';
let rpcSeq = 0;

async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const info = test.info();
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${info.project.name} #${info.repeatEachIndex})`, source: 'local', project: 'Walnut' },
  });
  expect(res.ok(), `create task: ${res.status()}`).toBe(true);
  const body = await res.json() as { task?: { id: string }; id?: string };
  return body.task?.id ?? body.id!;
}

async function startRealSession(page: Page, message: string, taskId: string): Promise<void> {
  const reqId = `pw-parity-start-${++rpcSeq}`;
  const answer = await page.evaluate(async ({ message, taskId, reqId }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')); });
    ws.send(JSON.stringify({ type: 'req', id: reqId, method: 'session:start', payload: { taskId, message, project: 'Walnut' } }));
    const result = await new Promise<string>((resolve) => {
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data as string);
          if (parsed.type === 'res' && parsed.id === reqId) resolve(parsed.ok ? 'ok' : `error: ${JSON.stringify(parsed.error)}`);
        } catch { /* ignore */ }
      };
      setTimeout(() => resolve('no answer within 10s'), 10_000);
    });
    ws.close();
    return result;
  }, { message, taskId, reqId });
  expect(answer, 'session:start answer').toBe('ok');
}

async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/sessions/task/${taskId}`);
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> };
      const sid = body.sessions?.[0]?.claudeSessionId;
      if (sid) return sid;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no session appeared for task ${taskId}`);
}

async function openFromTaskRow(page: Page, taskId: string, sid: string): Promise<Locator> {
  await page.locator('.todo-search-input').fill(taskId);
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('.task-start-btn')).toHaveCount(0, { timeout: 20_000 });
  await row.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel.locator('.session-history');
}

test('a real streamed reply looks exactly like its persisted row, in every frame', async ({ page, request }) => {
  test.setTimeout(120_000);
  await disableTransitions(page);
  await countIslandLoads(page);
  const taskId = await newTask(request, 'Stream parity real');
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Every history read after the reply finished streaming waits for `release`.
  let holding = false;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/sessions/*/history**', async (route) => {
    if (holding) await held;
    await route.continue();
  });

  // The column must open while the reply still streams: one that opens after the turn ended reads
  // the persisted row from its first history read, before the hold below. A time window alone did
  // not hold on a loaded CI runner (40ms deltas, then 120ms: the column still opened after the
  // turn, both tries, 2026-11-10), so the mock stops the answer after its first delta until the
  // gate file exists, and the gate opens once the streaming reply is on screen. A column that
  // opens after that first delta must keep the text streamed before it (useSessionStream
  // seedOnAdopt: the next delta used to write over it).
  const gate = path.join(os.tmpdir(), `pw-parity-real-gate-${process.pid}-${Date.now()}`);
  await startRealSession(page, `chunk-delay:120 stream-partial-markdown-reply gate:${gate}`, taskId);
  const sid = await waitForSessionId(request, taskId);
  const history = await openFromTaskRow(page, taskId, sid);
  await expect(history.locator('[data-stream-reply]', { hasText: 'Findings PARITYREAL' }), 'the column opened while the reply streamed')
    .toBeVisible({ timeout: 20_000 });
  holding = true;
  fs.writeFileSync(gate, '');
  await expect(history).toContainText('Closing sentence PARITYREAL.', { timeout: 30_000 });
  fs.rmSync(gate, { force: true });
  // The turn is over (no working indicator) and still on screen as stream blocks.
  await expect(page.locator(`.session-panel[data-session-id="${sid}"] .session-working-indicator`)).toHaveCount(0, { timeout: 15_000 });
  // The turn's last text and its end often land in one commit: the column must
  // still follow it to the bottom here, not at the handover.
  await page.waitForTimeout(500);
  // The streaming reply is a row too (`data-stream-reply`); the persisted one is not.
  const persistedRow = history.locator('[data-msg-ts]:not([data-stream-reply])', { hasText: 'Findings PARITYREAL' });
  expect(await persistedRow.count(), 'the history read is held: no persisted row yet').toBe(0);

  await expect.poll(() => islandLoads(page, MARKER), { timeout: 8000 }).toBe(1);
  const streamed = await snapReply(page, MARKER);
  if (process.env.PARITY_DUMP) await dumpRows(page, 'streamed');
  expect(await tagReplyNodes(page, MARKER)).toBeGreaterThanOrEqual(2);
  await startFrameSampler(page, MARKER);
  holding = false;
  release();
  // The persisted row takes over, one copy.
  await expect(persistedRow).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => ((await history.textContent()) ?? '').split('Closing sentence PARITYREAL.').length - 1).toBe(1);
  await page.waitForTimeout(800);
  const { samples } = await stopFrameSampler(page);
  const finished = await snapReply(page, MARKER);
  if (process.env.PARITY_DUMP) await dumpRows(page, 'finished');

  expect(streamed.elems.some((e) => e.tag === 'PRE')).toBe(true);
  expect(streamed.elems.some((e) => e.tag === 'IFRAME')).toBe(true);
  // The persisted row took over the stream's own elements: the script block
  // never reloaded.
  expect(await islandLoads(page, MARKER), 'loads of the script block').toBe(1);
  expect(await replyNodesReplaced(page, MARKER), 'reply nodes the handover replaced').toEqual([]);
  const diffs = diffSnaps(streamed, finished);
  expect(diffs, `streamed vs finished render differ:\n${diffs.slice(0, 40).join('\n')}`).toEqual([]);
  expect(finished.html).toBe(streamed.html);
  expect(samples.length).toBeGreaterThan(1);
  const first = samples[0][0];
  const bad = samples
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => s.length !== 1 || Math.abs(s[0].top - first.top) >= 1
      || JSON.stringify({ ...s[0], top: 0 }) !== JSON.stringify({ ...first, top: 0 }));
  expect(bad.slice(0, 5), `frames where the code block was missing, doubled or changed (first: ${JSON.stringify(first)})`).toEqual([]);
});
