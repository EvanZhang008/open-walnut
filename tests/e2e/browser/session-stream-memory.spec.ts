/**
 * Memory of a page while one session column streams (opt-in measurement).
 *
 * The owner's Mac app page grew about 14 MB a minute while a session streamed
 * with the DOM flat. This spec reproduces that load on a mocked session column
 * (mock-session-harness.ts): a long turn of thinking deltas of 10 to 40
 * characters at about 20 a second across many messages, text deltas, tool calls
 * with results, turn-speed frames every 400 ms and a usage update per message,
 * all dispatched inside the page on the captured WebSocket. Every sample forces
 * a GC (page.requestGC) and reads the retained JS heap (Chromium, CDP) or the
 * WebContent process footprint (WebKit, `footprint`).
 *
 * Off by default (it runs for minutes). Run:
 *   STREAM_MEM_MINUTES=4 bun x playwright test session-stream-memory --project chromium --retries=0
 *   STREAM_MEM_MINUTES=4 PW_WEBKIT=1 bun x playwright test session-stream-memory --project webkit --retries=0
 * Results land in /tmp/stream-mem/<project>.json. Options: STREAM_MEM_ABSORB=1 puts
 * each finished message into history and refetches it, as a real turn does (the
 * streamed blocks are absorbed and the DOM stays steady); STREAM_MEM_SNAPSHOT=1
 * writes a heap snapshot (V8, or JSC through the page's inspector session) at
 * the first and last sample; STREAM_MEM_ALLOC=1 (Chromium) records every
 * allocation by call site over the window (sampling heap profiler).
 * PW_BUILT_SPA=1 WALNUT_WEB_STATIC_DIR=<dist/web/static> measures a production build.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { MOCK_SESSION_ID as SESSION_ID, mockSession, open, waitForWs } from './mock-session-harness';

const MINUTES = Number(process.env.STREAM_MEM_MINUTES ?? 0);
const OUT = '/tmp/stream-mem';
const SAMPLE_MS = 30_000;

test.skip(!MINUTES, 'measurement only: set STREAM_MEM_MINUTES');

/** Start the in-page stream generator: returns at once, keeps running on timers. */
async function startStream(page: Page, absorb: boolean) {
  await page.evaluate(({ sid, absorb }) => {
    const ws = (window as any).__capturedWs as WebSocket;
    const emit = (name: string, data: unknown) =>
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
    const WORDS = 'the a check whether server path stream block reason so then because file test value next we should look at this one more time and compare it'.split(' ');
    const chunk = (min: number, max: number) => {
      const want = min + Math.floor(Math.random() * (max - min + 1));
      let s = '';
      while (s.length < want) s += WORDS[Math.floor(Math.random() * WORDS.length)] + ' ';
      return s.slice(0, want);
    };
    const startedAt = Date.now();
    let msg = 0;
    let step = 0; // deltas into the current message
    let thinkingSteps = 200 + Math.floor(Math.random() * 200);
    let textSteps = 20 + Math.floor(Math.random() * 40);
    let chars = 0;
    let thinkingText = '';
    let replyText = '';
    const stats = { thinking: 0, text: 0, tools: 0, speed: 0, usage: 0 };
    (window as any).__streamStats = stats;
    const msgId = () => `mem_msg_${msg}`;
    (window as any).__streamTimer = window.setInterval(() => {
      if (step < thinkingSteps) {
        const delta = chunk(10, 40);
        chars += delta.length;
        thinkingText += delta;
        emit('session:thinking-delta', { sessionId: sid, delta, msgId: msgId() });
        stats.thinking++;
      } else if (step < thinkingSteps + textSteps) {
        const delta = chunk(10, 40);
        chars += delta.length;
        replyText += delta;
        emit('session:text-delta', { sessionId: sid, delta, msgId: msgId() });
        stats.text++;
      } else {
        const toolUseId = `mem_tool_${msg}`;
        const input = { command: `grep -n ${chunk(8, 20)} src` };
        const result = chunk(500, 3000);
        emit('session:tool-use', { sessionId: sid, toolName: 'Bash', toolUseId, input });
        emit('session:tool-result', { sessionId: sid, toolUseId, result });
        // As in a real turn, the finished message reaches history and the
        // column refetches it, so its streamed blocks are absorbed.
        if (absorb) {
          const row = { role: 'assistant', text: replyText, thinking: thinkingText, msgId: msgId(), timestamp: new Date().toISOString(),
            tools: [{ name: 'Bash', input, toolUseId, result }] };
          void (window as any).__pushHistory(row).then(() => emit('session:batch-completed', { sessionId: sid, count: 1 }));
        }
        thinkingText = '';
        replyText = '';
        emit('session:usage-update', { sessionId: sid, model: 'claude-opus', contextPercent: 10 + (msg % 80), inputTokens: 20000 + msg * 500, contextWindow: 1_000_000 });
        stats.tools++;
        stats.usage++;
        msg++;
        step = -1;
        chars = 0;
        thinkingSteps = 200 + Math.floor(Math.random() * 200);
        textSteps = 20 + Math.floor(Math.random() * 40);
      }
      step++;
    }, 50);
    (window as any).__speedTimer = window.setInterval(() => {
      emit('session:turn-speed', { sessionId: sid, speed: {
        startedAt, ttftMs: 900, generationMs: Date.now() - startedAt, outputTokens: msg * 300, messages: msg,
        model: 'claude-opus', inFlight: true, inFlightChars: chars, inFlightMs: 1000, inFlightVisibleMs: 800, final: false,
      } });
      stats.speed++;
    }, 400);
  }, { sid: SESSION_ID, absorb });
}

/** The WebContent processes of the Playwright WebKit build started after `since`. */
function webContentPids(sinceMs: number): number[] {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('ms-playwright/webkit') || !line.includes('WebContent')) continue;
    const m = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+/);
    if (!m) continue;
    if (new Date(m[2]).getTime() >= sinceMs - 2000) pids.push(Number(m[1]));
  }
  return pids;
}

function footprintOf(pid: number): { total: number; categories: Record<string, number> } {
  const out = execFileSync('footprint', ['-f', 'bytes', String(pid)], { encoding: 'utf8' });
  const total = Number(out.match(/Footprint:\s+(\d+)\s+B/)?.[1] ?? 0);
  const categories: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+) B\s+(\d+) B\s+(\d+) B\s+(\d+)\s+(.+)$/);
    if (m && m[5] !== 'TOTAL') categories[m[5].trim()] = Number(m[1]);
  }
  return { total, categories };
}

test('memory while a column streams', async ({ page, browserName }) => {
  test.setTimeout(MINUTES * 60_000 + 180_000);
  fs.mkdirSync(OUT, { recursive: true });
  const since = Date.now();
  let consoleMessages = 0;
  page.on('console', () => { consoleMessages++; });
  const history: unknown[] = [{ role: 'user', text: 'MEM_ASK go', timestamp: '2026-01-01T00:00:00.000Z' }];
  // STREAM_MEM_ABSORB=1: each finished message joins history (blocks absorbed, DOM steady as in the app).
  const absorb = process.env.STREAM_MEM_ABSORB === '1';
  await page.exposeFunction('__pushHistory', (row: unknown) => { history.push(row); });
  await mockSession(page, history, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('MEM_ASK', { timeout: 20000 });

  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  let pids: number[] = [];
  if (browserName === 'webkit') {
    pids = webContentPids(since);
    expect(pids.length, 'the run\'s WebContent process').toBeGreaterThan(0);
  }

  // WebKit: the page's inspector session (in-process Playwright server), for Heap.snapshot.
  const wkSession = browserName === 'webkit'
    ? (page as any)._connection?.toImpl?.(page)?.delegate?._session as { send(m: string, p?: unknown): Promise<any> } | undefined
    : undefined;
  const snapshot = async (name: string) => {
    if (process.env.STREAM_MEM_SNAPSHOT !== '1') return;
    if (wkSession) {
      const r = await wkSession.send('Heap.snapshot');
      fs.writeFileSync(`${OUT}/${name}.jsc-heapsnapshot.json`, r.snapshotData);
      return;
    }
    if (!cdp) return;
    const file = fs.openSync(`${OUT}/${name}.heapsnapshot`, 'w');
    const onChunk = (p: { chunk: string }) => fs.writeSync(file, p.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    fs.closeSync(file);
  };

  const samples: Array<Record<string, unknown>> = [];
  const sample = async (t: number) => {
    await page.requestGC();
    if (cdp) await cdp.send('HeapProfiler.collectGarbage');
    const page_ = await page.evaluate(() => ({
      dom: document.getElementsByTagName('*').length,
      perfEntries: performance.getEntries().length,
      stats: (window as any).__streamStats ?? null,
    }));
    const row: Record<string, unknown> = { t, consoleMessages, ...page_ };
    if (cdp) {
      const h = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; totalSize: number };
      row.jsUsedMB = +(h.usedSize / 1e6).toFixed(1);
    }
    for (const pid of pids) {
      const f = footprintOf(pid);
      row[`footprintMB_${pid}`] = +(f.total / 1e6).toFixed(1);
      row[`webkitMallocMB_${pid}`] = +((f.categories['WebKit malloc'] ?? 0) / 1e6).toFixed(1);
      row[`jsHeapMB_${pid}`] = +(Object.entries(f.categories).filter(([k]) => /JS|Gigacage/i.test(k)).reduce((a, [, v]) => a + v, 0) / 1e6).toFixed(1);
    }
    samples.push(row);
    console.log(`[stream-mem] ${JSON.stringify(row)}`);
    fs.writeFileSync(`${OUT}/${test.info().project.name}.json`, JSON.stringify(samples, null, 2));
  };

  await startStream(page, absorb);
  // Warm up one minute (first renders, lazy chunks), then measure.
  await page.waitForTimeout(60_000);
  await sample(0);
  await snapshot('first');
  // Chromium: every allocation (kept or collected) by call site over the window.
  const alloc = !!cdp && process.env.STREAM_MEM_ALLOC === '1';
  if (alloc) {
    await cdp!.send('HeapProfiler.enable');
    await cdp!.send('HeapProfiler.startSampling', {
      samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
    } as any);
  }
  const end = Date.now() + MINUTES * 60_000;
  while (Date.now() < end) {
    await page.waitForTimeout(Math.min(SAMPLE_MS, Math.max(0, end - Date.now())));
    await sample(Math.round((Date.now() - (end - MINUTES * 60_000)) / 1000));
  }
  await snapshot('last');
  if (alloc) {
    const { profile } = await cdp!.send('HeapProfiler.stopSampling') as { profile: unknown };
    fs.writeFileSync(`${OUT}/alloc-${process.env.STREAM_MEM_LABEL ?? 'run'}.heapprofile`, JSON.stringify(profile));
  }
  await page.evaluate(() => {
    window.clearInterval((window as any).__streamTimer);
    window.clearInterval((window as any).__speedTimer);
  });
});
