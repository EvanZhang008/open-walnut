/**
 * A turn-end delta on a transcript past the full read's byte ceiling, through the
 * REAL route and the REAL window reader (no mocked parse).
 *
 * The reported failure (2026-10-05, a 352 MB session full of screenshot results):
 * after a turn the chat lost every AI reply and the user's own messages piled up at
 * the bottom until a reload. The file is only ever served as its 4 MB tail, and one
 * turn of screenshots appends more than that, so the client's anchor (its newest
 * row) had slid out of the tail. The delta was declined and the client was handed a
 * 3-row window that shared no row with what it held, so it replaced its history with
 * those 3 rows. Pinned here: a delta whose anchor sits behind the tail reaches back
 * for it and is served as a real delta, in order, nothing dropped; past the reader's
 * ceiling it still declines (a lossless rebuild, never a guess).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-history-anchor-reach'));
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import express from 'express';
import request from 'supertest';
import { CLAUDE_HOME } from '../../../src/constants.js';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { encodeProjectPath } from '../../../src/core/session-history.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { computeHistoryAnchor } from '../../../web/src/hooks/history-anchor.js';

const CWD = '/tmp/marina/whale-reach';
const WHALE_SESSION = 'anchor-reach-whale-session';
/** The full read's byte ceiling here, so the ~10 MB base file is only ever served as its 4 MB tail. */
const WHALE_CEILING_BYTES = 8 * 1024 * 1024;
/** Light turns, then heavy ones: the tail holds the newest heavy turns only. */
const LIGHT_TURNS = 300;
const HEAVY_TURNS = 120;
const WHALE_TURNS = LIGHT_TURNS + HEAVY_TURNS;
const tmpBase = path.dirname(CLAUDE_HOME);
const MB = 1024 * 1024;

/** The base transcript: every turn is `whale ask N`, `whale reply N`, one tool call and its result. */
function whaleJsonl(startMs: number): string {
  let n = 0;
  const at = () => new Date(startMs + (n++) * 250).toISOString();
  const id = (k: string, t: number) => `0199e0${k}-0000-4aaa-8bbb-${String(t).padStart(12, '0')}`;
  const lines: string[] = [];
  for (let t = 0; t < WHALE_TURNS; t++) {
    const chars = t < LIGHT_TURNS ? 12_000 : 60_000;
    lines.push(
      JSON.stringify({ type: 'user', uuid: id('01', t), sessionId: WHALE_SESSION, timestamp: at(), message: { role: 'user', content: `whale ask ${t}` } }),
      JSON.stringify({ type: 'assistant', uuid: id('02', t), sessionId: WHALE_SESSION, timestamp: at(), message: { id: `msg_whale_${t}_a`, role: 'assistant', content: [{ type: 'text', text: `whale reply ${t}` }] } }),
      JSON.stringify({ type: 'assistant', uuid: id('03', t), sessionId: WHALE_SESSION, timestamp: at(), message: { id: `msg_whale_${t}_b`, role: 'assistant', content: [{ type: 'tool_use', id: `tu-whale-${t}`, name: 'Bash', input: { command: `echo ${t}` } }] } }),
      JSON.stringify({ type: 'user', uuid: id('04', t), sessionId: WHALE_SESSION, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-whale-${t}`, content: 'x'.repeat(chars) }] } }),
    );
  }
  clock = startMs + n * 250;
  return lines.join('\n') + '\n';
}

interface Row { role: string; text: string; msgId?: string; timestamp: string }

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

function jsonlPath(): string {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${WHALE_SESSION}.jsonl`);
}

let clock = Date.now();
const stamp = () => new Date(clock += 250).toISOString();

/**
 * One turn the way the CLI writes it: the user's message, a reply, then `shots`
 * tool calls whose results weigh `shotBytes` each (screenshots), then a final reply.
 * `userBytes` pads the user line itself (a pasted image), so its uuid sits far
 * from the line start. `mention` puts the given string inside a later tool result
 * (the AI grepping its own transcript).
 */
function turnLines(t: number, opts: { shots: number; shotBytes: number; userBytes?: number; mention?: string }): string[] {
  const id = (k: string) => `0199f1${k}-0000-4aaa-8bbb-${String(t).padStart(12, '0')}`;
  const lines: string[] = [];
  // An unrendered top-level field stands in for the pasted image's bytes.
  lines.push(JSON.stringify({
    type: 'user', parentUuid: null, sessionId: WHALE_SESSION, timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'text', text: `reach ask ${t}` }] },
    ...(opts.userBytes ? { pastedBytes: 'p'.repeat(opts.userBytes) } : {}),
    uuid: id('01'),
  }));
  lines.push(JSON.stringify({
    type: 'assistant', parentUuid: id('01'), sessionId: WHALE_SESSION, timestamp: stamp(),
    message: { id: `msg_reach_${t}_a`, role: 'assistant', content: [{ type: 'text', text: `reach reply ${t}` }] },
    uuid: id('02'),
  }));
  for (let s = 0; s < opts.shots; s++) {
    const tu = `tu-reach-${t}-${s}`;
    lines.push(JSON.stringify({
      type: 'assistant', parentUuid: id('02'), sessionId: WHALE_SESSION, timestamp: stamp(),
      message: { id: `msg_reach_${t}_s${s}`, role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Screenshot', input: {} }] },
      uuid: `${id('03')}-${s}`,
    }));
    const body = s === 0 && opts.mention ? `found ${opts.mention} ` : '';
    lines.push(JSON.stringify({
      type: 'user', parentUuid: `${id('03')}-${s}`, sessionId: WHALE_SESSION, timestamp: stamp(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: body + 'i'.repeat(opts.shotBytes) }] },
      uuid: `${id('04')}-${s}`,
    }));
  }
  lines.push(JSON.stringify({
    type: 'assistant', parentUuid: id('02'), sessionId: WHALE_SESSION, timestamp: stamp(),
    message: { id: `msg_reach_${t}_z`, role: 'assistant', content: [{ type: 'text', text: `reach done ${t}` }] },
    uuid: id('05'),
  }));
  return lines;
}

async function appendTurn(t: number, opts: Parameters<typeof turnLines>[1]): Promise<void> {
  await fsp.appendFile(jsonlPath(), turnLines(t, opts).join('\n') + '\n');
}

/** Prose rows, as `ask:N` / `reply:N` / `done:N`. */
function proseOf(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const m = /^(?:whale|reach) (ask|reply|done) (\d+)$/.exec(r.text.trim());
    if (m) out.push(`${m[1]}:${m[2]}`);
  }
  return out;
}

async function loadTail(app: express.Express): Promise<Row[]> {
  const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ tail: 400 });
  expect(res.status).toBe(200);
  expect(res.body.windowed).toBe(true);
  return res.body.messages;
}

function deltaQuery(held: Row[]) {
  const anchor = computeHistoryAnchor(held);
  expect(anchor.anchorMsgId).toBeTruthy();
  return {
    since: held.length, anchorMsgId: anchor.anchorMsgId!, anchorTail: anchor.anchorTail, tail: Math.max(400, held.length),
  };
}

let savedCeiling: string | undefined;
beforeAll(() => {
  savedCeiling = process.env.WALNUT_MAX_FILE_READ_BYTES;
  process.env.WALNUT_MAX_FILE_READ_BYTES = String(WHALE_CEILING_BYTES);
});
afterAll(() => {
  if (savedCeiling === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = savedCeiling;
});

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  await fsp.mkdir(path.dirname(jsonlPath()), { recursive: true });
  await fsp.writeFile(jsonlPath(), whaleJsonl(Date.now() - 3_600_000));
  await createSessionRecord(WHALE_SESSION, CWD, 'p');
});

afterEach(async () => {
  _resetSessionTrackerForTesting();
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

describe('turn-end delta whose anchor slid out of the 4 MB tail', () => {
  it('a 6 MB turn is served as a delta holding the whole turn, in order', async () => {
    const app = createApp();
    const held = await loadTail(app);
    const before = proseOf(held);
    expect(before.at(-1)).toBe(`reply:${WHALE_TURNS - 1}`);
    expect(held.length, 'the tail is a bounded window of the newest turns').toBeLessThan(WHALE_TURNS);

    // Five 1.2 MB screenshots: more than the tail window, less than the ceiling.
    await appendTurn(WHALE_TURNS, { shots: 5, shotBytes: 1.2 * MB });

    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(true);
    const merged = [...held, ...(res.body.messages as Row[])];
    expect(proseOf(merged)).toEqual([...before, `ask:${WHALE_TURNS}`, `reply:${WHALE_TURNS}`, `done:${WHALE_TURNS}`]);
    // The delta carries exactly the new turn: the user row, the reply, five tool rows, the closing reply.
    expect(res.body.messages.length).toBe(1 + 1 + 5 + 1);
    expect(res.body.cursor).toBe(held.length + res.body.messages.length);
  });

  it('three heavy turns in a row each come back as a delta', async () => {
    const app = createApp();
    let held = await loadTail(app);
    for (let i = 0; i < 3; i++) {
      const t = WHALE_TURNS + i;
      await appendTurn(t, { shots: 4, shotBytes: 1.3 * MB });
      const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
      expect(res.body.delta, `turn ${i}`).toBe(true);
      held = [...held, ...(res.body.messages as Row[])];
      expect(proseOf(held).slice(-3)).toEqual([`ask:${t}`, `reply:${t}`, `done:${t}`]);
    }
  });

  it('finds the anchor when its uuid sits at the end of a 1.5 MB user line', async () => {
    const app = createApp();
    // The anchor is a user row (msgId = its uuid, written after the content).
    await appendTurn(WHALE_TURNS, { shots: 0, shotBytes: 0, userBytes: 1.5 * MB });
    let held = await loadTail(app);
    // Drop the closing reply and the assistant reply, so the user row is the newest one held.
    held = held.slice(0, held.findIndex((m) => m.text.trim() === `reach ask ${WHALE_TURNS}`) + 1);
    expect(computeHistoryAnchor(held).anchorMsgId).toMatch(/^0199f101-/);

    await appendTurn(WHALE_TURNS + 1, { shots: 4, shotBytes: 1.2 * MB });
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.body.delta).toBe(true);
    const merged = [...held, ...(res.body.messages as Row[])];
    expect(proseOf(merged).slice(-6)).toEqual([
      `ask:${WHALE_TURNS}`, `reply:${WHALE_TURNS}`, `done:${WHALE_TURNS}`,
      `ask:${WHALE_TURNS + 1}`, `reply:${WHALE_TURNS + 1}`, `done:${WHALE_TURNS + 1}`,
    ]);
  });

  it('a newer tool result quoting the anchor id does not cut the delta short', async () => {
    const app = createApp();
    const held = await loadTail(app);
    const { anchorMsgId } = computeHistoryAnchor(held);
    // The AI greps its own transcript: the anchor id shows up again, 5 MB later.
    await appendTurn(WHALE_TURNS, { shots: 5, shotBytes: 1.1 * MB, mention: JSON.stringify(anchorMsgId) });
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.body.delta).toBe(true);
    expect(proseOf(res.body.messages)).toEqual([`ask:${WHALE_TURNS}`, `reply:${WHALE_TURNS}`, `done:${WHALE_TURNS}`]);
  });

  it('a turn bigger than the reader ceiling still declines to a rebuild, never a guessed delta', async () => {
    const app = createApp();
    const held = await loadTail(app);
    await appendTurn(WHALE_TURNS, { shots: 8, shotBytes: 1.2 * MB });
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(false);
    expect(res.body.windowed).toBe(true);
    expect(proseOf(res.body.messages).at(-1)).toBe(`done:${WHALE_TURNS}`);
  });

  it('an anchor that is nowhere in the file declines to a rebuild', async () => {
    const app = createApp();
    const held = await loadTail(app);
    await appendTurn(WHALE_TURNS, { shots: 5, shotBytes: 1.2 * MB });
    const q = { ...deltaQuery(held), anchorMsgId: 'msg_never_written' };
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(q);
    expect(res.body.delta).toBe(false);
  });

  it('a fork reaches back in its own transcript; the parent prefix is untouched', async () => {
    const PARENT = 'anchor-reach-parent';
    const dir = path.dirname(jsonlPath());
    await fsp.writeFile(path.join(dir, `${PARENT}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: 'p-ask-0', sessionId: PARENT, timestamp: new Date(Date.now() - 7_200_000).toISOString(), message: { role: 'user', content: 'parent ask 0' } }),
      JSON.stringify({ type: 'assistant', uuid: 'p-reply-0', sessionId: PARENT, timestamp: new Date(Date.now() - 7_199_000).toISOString(), message: { id: 'msg_parent_0', role: 'assistant', content: [{ type: 'text', text: 'parent reply 0' }] } }),
    ].join('\n') + '\n');
    await createSessionRecord(PARENT, CWD, 'p');
    // The whale itself is the fork child (beforeEach made it a plain session).
    await updateSessionRecord(WHALE_SESSION, { forkedFromSessionId: PARENT });

    const app = createApp();
    const first = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ tail: 400 });
    expect(first.body.windowed).toBe(true);
    expect(first.body.forkBoundaryIndex, 'the parent prefix is in the payload').toBe(2);
    const held: Row[] = first.body.messages;
    expect(held[0].text).toBe('parent ask 0');
    await appendTurn(WHALE_TURNS, { shots: 5, shotBytes: 1.2 * MB });
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.body.delta).toBe(true);
    expect(proseOf(res.body.messages)).toEqual([`ask:${WHALE_TURNS}`, `reply:${WHALE_TURNS}`, `done:${WHALE_TURNS}`]);
    expect(res.body.cursor).toBe(held.length + res.body.messages.length);
  });

  it('an anchor still inside the tail is served without reaching back', async () => {
    const app = createApp();
    const held = await loadTail(app);
    await appendTurn(WHALE_TURNS, { shots: 1, shotBytes: 50_000 });
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query(deltaQuery(held));
    expect(res.body.delta).toBe(true);
    expect(proseOf(res.body.messages)).toEqual([`ask:${WHALE_TURNS}`, `reply:${WHALE_TURNS}`, `done:${WHALE_TURNS}`]);
  });
});
