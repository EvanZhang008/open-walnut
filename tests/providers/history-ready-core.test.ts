/**
 * The daemon's ready view (src/providers/history-ready-core.ts, 'history-ready-v1').
 *
 * Runs the real module against a real Claude home in a temp dir (mkdtemp; only that dir is ever
 * removed). The rewind dead set is the real one (transcript-rewind-core.ts rewindDeadSetAtPath),
 * computed inside the build, which a daemon runs in its worker; cases that need a build held or
 * ordered wrap the in-thread executor. No process is spawned and nothing is signalled.
 *
 * Pinned here:
 *   - rows come from the ONE parser the server uses, keyed by the file's identity; the same key
 *     answers `unchanged`, an append changes it;
 *   - a tail of notices and agent-ack replies is never answered as a readable view: the build
 *     reaches further back, and answers `pending not-readable` when even the largest window has
 *     nothing to read;
 *   - a recorded rewind's abandoned branch never shows; the dead set is computed in the build
 *     (the worker), never on the caller's loop, and one that cannot be read (or was read at
 *     another version of the file) answers nothing;
 *   - an archived transcript is read through gunzip and never restored; an offloaded one answers
 *     `none`;
 *   - the budget answers `pending building` while the build goes on and fills the memo; a
 *     readable stage it answers early carries a partial key, never the whole view's, so asking
 *     again with it gets the whole view (never `unchanged`);
 *   - every answer and key carries the parser version (HISTORY_PARSER_VERSION);
 *   - a person's request goes before queued background builds, a queued background build a
 *     person asks for is moved up;
 *   - the server's legacy-hint cutoff rides into one parse and the key, never a global;
 *   - windows are cut on bytes (a multi-byte character at the edge reads whole), and a view is
 *     bounded by UTF-8 bytes; a newest row over the cap answers pending, never a cut row;
 *   - a search for the file answers within the request budget;
 *   - builds run in a worker (a fake one here, plus one real thread in this process): one
 *     worker reused, the next entry tried, death and overrun answered, idle workers ended.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { transcript, cutHere, type TranscriptFixture } from '../helpers/transcript-fixtures.js';
import {
  buildReadyView, createHistoryReady, createReadyWorkerExecutor, decodeReadyRows, fitRows, inThreadReadyExecutor, isReadableView,
  lastLines, locateTranscriptReadOnly, partialReadyKey, readyRequestFromWire, readyViewKey, readyWorkerEntries, serveReadyWorker, windowText,
  PARSE_MAX_LINES, READY_MAX_JSON_BYTES,
  type HistoryReady, type HistoryReadyDeps, type ReadyAnswer, type ReadyBuilt, type ReadyJob, type ReadyViewAnswer, type ReadyWorkerLike,
} from '../../src/providers/history-ready-core.js';
import { rewindDeadSetAtPath } from '../../src/providers/transcript-rewind-core.js';
import { HISTORY_PARSER_VERSION } from '../../src/core/history-parser-version.js';
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js';
import { HISTORY_CACHE_SCHEMA, rewindCutsKey, type SessionHistoryMessage } from '../../src/core/history-parse.js';
import { legacyHintCutoff } from '../../src/core/sessions/legacy-hint-lines.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const CWD = '/proj/ready-view';
const NOTE = '<walnut-message kind="notification" from="Walnut" outcome="stopped">\nA subtask stopped.\n</walnut-message>';
const ACK = '<walnut-turn status="agent-ack"/>';

let claudeHome: string;
let cutoffBefore: number;

beforeEach(async () => {
  claudeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'ready-core-'));
  cutoffBefore = legacyHintCutoff();
});
afterEach(async () => {
  // No build ever changes the process's own cutoff (a daemon serves several servers).
  expect(legacyHintCutoff()).toBe(cutoffBefore);
  await fsp.rm(claudeHome, { recursive: true, force: true });
});

function projectDir(cwd = CWD): string {
  return path.join(claudeHome, 'projects', encodeProjectPathCore(cwd));
}
async function writePlain(sid: string, t: TranscriptFixture | string, cwd = CWD): Promise<string> {
  await fsp.mkdir(projectDir(cwd), { recursive: true });
  const p = path.join(projectDir(cwd), `${sid}.jsonl`);
  await fsp.writeFile(p, typeof t === 'string' ? t : t.text());
  return p;
}
const rowsOf = (a: ReadyViewAnswer): SessionHistoryMessage[] => (a.status === 'ready' ? decodeReadyRows(a) : []);
const texts = (a: ReadyViewAnswer): string[] => rowsOf(a).map((m) => m.text);
/** createHistoryReady building in this thread (a daemon builds in its worker). */
const make = (over: Partial<HistoryReadyDeps> = {}): HistoryReady => createHistoryReady({ executor: inThreadReadyExecutor, ...over });
/** The in-thread executor, each build first waiting on `before` (which sees the job). */
const heldExecutor = (before: (job: ReadyJob) => Promise<void>): HistoryReadyDeps['executor'] =>
  async (job, onProgress) => { await before(job); return inThreadReadyExecutor(job, onProgress); };
const sidOfJob = (job: ReadyJob): string => path.basename(job.path, '.jsonl');
function notices(t: TranscriptFixture, n: number, prefix = 'n'): TranscriptFixture {
  for (let i = 0; i < n; i++) t.user(`${prefix}u${i}`, NOTE).assistant(`${prefix}a${i}`, ACK);
  return t;
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('a plain transcript', () => {
  it('answers the parsed rows, keyed by the file; the same key is unchanged, an append is not', async () => {
    const sid = 'ready-plain';
    const file = await writePlain(sid, transcript().user('u1', 'how do I open it').assistant('a1', 'Click the row.'));
    const ready = make();

    const first = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    expect(texts(first)).toEqual(['how do I open it', 'Click the row.']);
    expect(first).toMatchObject({ readable: true, reachedStart: true, complete: true, windowed: false, schema: HISTORY_CACHE_SCHEMA, parser: HISTORY_PARSER_VERSION, cutsKey: rewindCutsKey(undefined) });
    const st = await fsp.stat(file);
    expect(first.key).toBe(readyViewKey({ path: file, size: st.size, mtimeMs: st.mtimeMs }, undefined, { turns: 10, rows: 400 }));
    expect(first.key.split('|')).toContain(HISTORY_PARSER_VERSION);

    const again = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(again).toBe(first); // the memo, no second parse
    expect(await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, have: first.key })).toEqual({ status: 'unchanged', key: first.key });

    await fsp.appendFile(file, transcript().from('a1').user('u2', 'and then?').lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const grown = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, have: first.key });
    expect(grown.status).toBe('ready');
    if (grown.status !== 'ready') return;
    expect(grown.key).not.toBe(first.key);
    expect(texts(grown).at(-1)).toBe('and then?');
  });

  it('finds a transcript whose cwd it was not told, and answers not-found for none', async () => {
    const sid = 'ready-elsewhere';
    await writePlain(sid, transcript().user('u1', 'hi').assistant('a1', 'Hello.'), '/some/other/dir');
    const ready = make();
    expect((await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome })).status).toBe('ready');
    expect(await ready.readyView({ sessionId: 'ready-missing', cwd: CWD, claudeHome })).toEqual({ status: 'none', reason: 'not-found' });
  });

  it('refuses a session id that could leave the projects dir', async () => {
    const ready = make();
    for (const sid of ['', '../etc', 'a/b', '.hidden', 'x'.repeat(200)]) {
      expect(await ready.readyView({ sessionId: sid, claudeHome })).toEqual({ status: 'none', reason: 'invalid' });
    }
    expect(await ready.readyKeys([{ sessionId: '../etc' }], claudeHome)).toEqual({});
  });
});

describe('a view a person can read', () => {
  it('reads past a tail of notices to the last real exchange', async () => {
    const sid = 'ready-notice-tail';
    const t = transcript().user('u1', 'ship the fix').assistant('a1', 'Shipped: the fix is live.');
    notices(t, 40);
    await writePlain(sid, t);
    // A first window that holds only notices, then one that reaches the start.
    const ready = make({ stageBytes: [2048, 1024 * 1024] });
    const view = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.readable).toBe(true);
    expect(texts(view)).toContain('Shipped: the fix is live.');
  });

  it('answers pending, never notices, when even the largest window has nothing to read', async () => {
    const sid = 'ready-notice-only';
    const t = transcript().user('u1', 'the real question').assistant('a1', 'The real answer.');
    notices(t, 60);
    await writePlain(sid, t);
    const ready = make({ stageBytes: [1024, 2048] });
    const view = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view).toMatchObject({ status: 'pending', reason: 'not-readable' });
    // Remembered for this file: the next ask does not parse again, and still answers no rows.
    expect(ready._memoSize()).toBe(1);
    expect((await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome })).status).toBe('pending');
  });

  it('a whole file of notices answers pending too, never rows', async () => {
    const sid = 'ready-all-notices';
    await writePlain(sid, notices(transcript(), 3));
    const view = await make().readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view).toMatchObject({ status: 'pending', reason: 'not-readable' });
  });

  it('a session other tasks drive (no typed turn) is readable by its replies', async () => {
    const sid = 'ready-driven';
    const t = transcript();
    for (let i = 0; i < 3; i++) t.user(`u${i}`, NOTE).assistant(`a${i}`, `Checked build ${i}: it passed.`);
    await writePlain(sid, t);
    const view = await make().readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view).toMatchObject({ status: 'ready', readable: true });
  });

  it('isReadableView: envelopes, ack-only replies and CLI errors are not readable; words are', () => {
    const row = (role: 'user' | 'assistant', text: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage =>
      ({ role, text, timestamp: '', ...extra }) as SessionHistoryMessage;
    expect(isReadableView([])).toBe(false);
    expect(isReadableView([row('user', NOTE), row('assistant', ACK)])).toBe(false);
    expect(isReadableView([row('assistant', 'Prompt is too long', { cliError: true } as never)])).toBe(false);
    expect(isReadableView([row('user', NOTE), row('assistant', `Done.\n${ACK}`)])).toBe(true);
    expect(isReadableView([row('user', 'a real question')])).toBe(true);
  });
});

describe('a recorded in-place rewind', () => {
  function rewound(): { t: TranscriptFixture; cut: ReturnType<typeof cutHere> } {
    const t = transcript()
      .user('u1', 'set up the project').assistant('a1', 'done setup')
      .user('u2', 'add a feature')
      .assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third ask')
      .assistant('a3', 'ABANDONED reply three');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'add a DIFFERENT feature').assistant('a2b', 'NEW reply two');
    return { t, cut };
  }
  const wireCut = (c: ReturnType<typeof cutHere>) => ({ uuid: c.uuid, lastUuidAtCommit: c.lastUuidAtCommit, ...(c.trailingQueueKeys ? { trailingQueueKeys: c.trailingQueueKeys } : {}) });

  it('never shows the abandoned branch (the real dead set, computed in the build)', async () => {
    const sid = 'ready-rewound';
    const { t, cut } = rewound();
    await writePlain(sid, t);
    const view = await make().readyView({ sessionId: sid, cwd: CWD, claudeHome, cuts: [wireCut(cut)] });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(texts(view).some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(texts(view)).toEqual(['set up the project', 'done setup', 'add a feature', 'add a DIFFERENT feature', 'NEW reply two']);
    expect(view.cutsKey).toBe(rewindCutsKey([cut]));
  });

  it('the caller hands the cuts to the build (the worker), never a dead set of its own', async () => {
    const sid = 'ready-rewound-job';
    const { t, cut } = rewound();
    await writePlain(sid, t);
    const jobs: ReadyJob[] = [];
    const view = await make({ executor: heldExecutor(async (job) => { jobs.push(job); }) })
      .readyView({ sessionId: sid, cwd: CWD, claudeHome, cuts: [wireCut(cut)] });
    expect(view.status).toBe('ready');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cuts).toEqual([wireCut(cut)]);
    expect(Object.keys(jobs[0]!)).not.toContain('deadUuids');
  });

  it('answers nothing when the dead set cannot be read, or was read at another version of the file', async () => {
    const sid = 'ready-rewound-unresolved';
    const { t, cut } = rewound();
    const file = await writePlain(sid, t);
    const st = await fsp.stat(file);
    const cuts = [wireCut(cut)];
    const base: ReadyJob = { key: 'k', path: file, archived: false, size: st.size, mtimeMs: st.mtimeMs, cutsKey: rewindCutsKey(cuts), cuts, turns: 10, rows: 400, stageBytes: [512 * 1024] };
    expect((await buildReadyView(base)).status).toBe('ready');
    // The file grew (or changed) after the key's stat: a dead set of one file, a view of another.
    expect(await buildReadyView({ ...base, size: st.size - 1 })).toEqual({ status: 'none', reason: 'rewind-unresolved' });
    expect(await buildReadyView({ ...base, mtimeMs: st.mtimeMs - 5_000 })).toEqual({ status: 'none', reason: 'rewind-unresolved' });
    expect(await buildReadyView({ ...base, path: `${file}.missing` })).toEqual({ status: 'none', reason: 'rewind-unresolved' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('rewindDeadSetAtPath: the dead set with the identity it read, capped', async () => {
    const sid = 'ready-rewound-deadset';
    const { t, cut } = rewound();
    const file = await writePlain(sid, t);
    const st = await fsp.stat(file);
    const dead = await rewindDeadSetAtPath(file, [wireCut(cut)]);
    expect(dead).toMatchObject({ size: st.size, mtimeMs: st.mtimeMs });
    expect(dead!.deadUuids.length).toBeGreaterThan(0);
    expect(dead!.truncated).toBeUndefined();
    expect(await rewindDeadSetAtPath(file, [wireCut(cut)], 0)).toMatchObject({ truncated: true, deadUuids: [] });
    expect(await rewindDeadSetAtPath(path.join(claudeHome, 'none.jsonl'), [wireCut(cut)])).toBeNull();
  });

  it('an archived file with cuts answers nothing and never reaches the build', async () => {
    const sid = 'ready-rewound-archived';
    const { t, cut } = rewound();
    await fsp.mkdir(projectDir(), { recursive: true });
    await fsp.writeFile(path.join(projectDir(), `${sid}.jsonl.gz`), await gzip(Buffer.from(t.text())));
    await fsp.writeFile(path.join(projectDir(), `${sid}.walnut-archive.json`), '{}');
    const view = await make({ executor: async () => { throw new Error('the build must not run'); } })
      .readyView({ sessionId: sid, cwd: CWD, claudeHome, cuts: [wireCut(cut)] });
    expect(view).toEqual({ status: 'none', reason: 'rewound-archived' });
  });
});

describe('an archived transcript', () => {
  it('is read through gunzip and never restored', async () => {
    const sid = 'ready-archived';
    await fsp.mkdir(projectDir(), { recursive: true });
    const gz = path.join(projectDir(), `${sid}.jsonl.gz`);
    await fsp.writeFile(gz, await gzip(Buffer.from(transcript().user('u1', 'old question').assistant('a1', 'Old answer.').text())));
    await fsp.writeFile(path.join(projectDir(), `${sid}.walnut-archive.json`), '{}');
    const located = await locateTranscriptReadOnly(sid, CWD, claudeHome);
    expect(located).toMatchObject({ path: gz, archived: true });

    const view = await make().readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(texts(view)).toEqual(['old question', 'Old answer.']);
    expect(view.source.archived).toBe(true);
    expect(fs.existsSync(path.join(projectDir(), `${sid}.jsonl`))).toBe(false);
    expect((await fsp.readdir(projectDir())).sort()).toEqual([`${sid}.jsonl.gz`, `${sid}.walnut-archive.json`]);
  });

  it('a gz without its manifest is not taken for an archive', async () => {
    const sid = 'ready-stray-gz';
    await fsp.mkdir(projectDir(), { recursive: true });
    await fsp.writeFile(path.join(projectDir(), `${sid}.jsonl.gz`), await gzip(Buffer.from('{}\n')));
    expect(await locateTranscriptReadOnly(sid, CWD, claudeHome)).toBeNull();
  });

  it('an offloaded one (manifest, no file) answers none', async () => {
    const sid = 'ready-offloaded';
    await fsp.mkdir(projectDir(), { recursive: true });
    await fsp.writeFile(path.join(projectDir(), `${sid}.walnut-archive.json`), '{}');
    const ready = make();
    expect(await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome })).toEqual({ status: 'none', reason: 'offloaded' });
    expect(await ready.readyKeys([{ sessionId: sid, cwd: CWD }], claudeHome)).toEqual({ [sid]: null });
  });

  it('a corrupt gz answers read-failed', async () => {
    const sid = 'ready-corrupt-gz';
    await fsp.mkdir(projectDir(), { recursive: true });
    await fsp.writeFile(path.join(projectDir(), `${sid}.jsonl.gz`), Buffer.from('not gzip at all'));
    await fsp.writeFile(path.join(projectDir(), `${sid}.walnut-archive.json`), '{}');
    expect(await make().readyView({ sessionId: sid, cwd: CWD, claudeHome }))
      .toEqual({ status: 'none', reason: 'read-failed' });
  });
});

describe('budget and order', () => {
  it('answers pending building inside the budget; the build goes on and fills the memo', async () => {
    const sid = 'ready-slow';
    const { t, cut } = (() => {
      const f = transcript().user('u1', 'q').assistant('a1', 'A.').user('u2', 'q2');
      return { t: f, cut: cutHere(f, 'u2') };
    })();
    await writePlain(sid, t);
    const gate = deferred<void>();
    const ready = make({ executor: heldExecutor(() => gate.promise) });
    const cuts = [{ uuid: cut.uuid, lastUuidAtCommit: cut.lastUuidAtCommit }];
    try {
      const early = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, cuts, budgetMs: 20 });
      expect(early).toMatchObject({ status: 'pending', reason: 'building' });
    } finally {
      gate.resolve();
    }
    const later = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, cuts, budgetMs: 5_000 });
    expect(later.status).toBe('ready');
    expect(ready._memoSize()).toBe(1);
  });

  it("a person's request goes first; a queued background build a person asks for moves up", async () => {
    const order: string[] = [];
    const hold = deferred<void>();
    const ready = make({ executor: heldExecutor(async (job) => {
      order.push(sidOfJob(job));
      if (sidOfJob(job) === 'ready-q-a') await hold.promise;
    }) });
    const req = async (sid: string, interactive: boolean) => {
      const f = transcript().user('u1', `q ${sid}`).assistant('a1', 'A.').user('u2', 'q2');
      const cut = cutHere(f, 'u2');
      await writePlain(sid, f);
      return { sessionId: sid, cwd: CWD, claudeHome, cuts: [{ uuid: cut.uuid, lastUuidAtCommit: cut.lastUuidAtCommit }], budgetMs: 10_000, interactive };
    };
    const a = await req('ready-q-a', false);
    const b = await req('ready-q-b', false);
    const c = await req('ready-q-c', false);
    const d = await req('ready-q-d', true);
    const all: Array<Promise<ReadyViewAnswer>> = [];
    // Each request finds its transcript (a stat) before it queues: let it, so the queue order is fixed.
    const settle = () => new Promise((r) => setTimeout(r, 25));
    try {
      all.push(ready.readyView(a)); await settle(); // runs, held in its build
      all.push(ready.readyView(b)); await settle(); // queued, background
      all.push(ready.readyView(c)); await settle(); // queued, background
      all.push(ready.readyView({ ...c, interactive: true })); await settle(); // a person now waits on c
      all.push(ready.readyView(d)); await settle(); // queued, interactive
    } finally {
      hold.resolve();
    }
    await Promise.all(all);
    expect(order[0]).toBe('ready-q-a');
    // Both person-waited builds before the background one, in the order they were queued.
    expect(order.slice(1)).toEqual(['ready-q-c', 'ready-q-d', 'ready-q-b']);
  });
});

describe('every answer names the file as it was after the ask came in', () => {
  // The server stamps a kept view with the time its ask began (history-view-snapshot.ts
  // contentAt). That is honest only when the answer holds the file as stat'ed AFTER the ask
  // arrived: never a locate another request began earlier, a build queued on an older stat,
  // or a memo of an older version.
  const append = async (file: string, uuid: string, parent: string, text: string) =>
    fsp.appendFile(file, transcript().from(parent).user(uuid, text).lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  it('a locate shared with an earlier request is stat-ed again for this one', async () => {
    const sid = 'ready-fresh-locate';
    const file = await writePlain(sid, transcript().user('u1', 'first ask').assistant('a1', 'First answer.'));
    // The earlier request's stat of the transcript resolves, then is held before it returns.
    const real = fsp.stat.bind(fsp);
    const hold = deferred<void>();
    let held = false;
    const spy = vi.spyOn(fsp, 'stat').mockImplementation((async (p: Parameters<typeof fsp.stat>[0]) => {
      const st = await real(p);
      if (!held && String(p) === file) { held = true; await hold.promise; }
      return st;
    }) as typeof fsp.stat);
    try {
      const ready = make();
      const a = ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 10_000 });
      await new Promise((r) => setTimeout(r, 20)); // A's locate holds its old stat
      await append(file, 'u2', 'a1', 'asked after A began');
      const b = ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 10_000 }); // joins A's locate
      hold.resolve();
      const [va, vb] = await Promise.all([a, b]);
      const size = (await real(file)).size;
      for (const v of [va, vb]) {
        expect(v.status).toBe('ready');
        if (v.status !== 'ready') continue;
        expect(v.source.size).toBe(size);
        expect(texts(v).at(-1)).toBe('asked after A began');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a build queued on an older stat never answers a later ask: that ask builds the file as it is', async () => {
    const sid = 'ready-fresh-queued';
    const file = await writePlain(sid, transcript().user('u1', 'first ask').assistant('a1', 'First answer.'));
    const hold = deferred<void>();
    let builds = 0;
    const ready = make({ executor: heldExecutor(async () => { if (++builds === 1) await hold.promise; }) });
    const a = ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20)); // A's build is queued on A's stat, held
    await append(file, 'u2', 'a1', 'asked after A began');
    const b = ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 10_000 });
    hold.resolve();
    const [va, vb] = await Promise.all([a, b]);
    expect(va.status === 'ready' && vb.status === 'ready' && va.key !== vb.key).toBe(true);
    expect(texts(va)).not.toContain('asked after A began'); // A answers what A saw
    expect(texts(vb).at(-1)).toBe('asked after A began');
    expect(vb.status === 'ready' && vb.source.size).toBe((await fsp.stat(file)).size);
  });

  it('a memo of an older version is never the answer once the file moved; unchanged only for the same version', async () => {
    const sid = 'ready-fresh-memo';
    const file = await writePlain(sid, transcript().user('u1', 'first ask').assistant('a1', 'First answer.'));
    const ready = make();
    const first = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    await append(file, 'u2', 'a1', 'a later ask');
    const second = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, have: first.status === 'ready' ? first.key : undefined });
    expect(second.status).toBe('ready');
    expect(texts(second).at(-1)).toBe('a later ask');
    expect(second.status === 'ready' && first.status === 'ready' && second.key !== first.key).toBe(true);
  });
});

describe('the parse inputs', () => {
  it("takes the asking server's legacy-hint cutoff for that parse only, into the key too", async () => {
    // The fixture's rows are from 2026-08-30. A cutoff after that strips the old bracket line;
    // one before it keeps the row as written. Neither touches the process's own cutoff.
    const sid = 'ready-cutoff';
    await writePlain(sid, transcript().user('u1', 'hello there\n\n[Reply language: English]').assistant('a1', 'Hello.'));
    const ready = make();
    const before = legacyHintCutoff();
    const strips = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, legacyHintCutoffMs: Date.UTC(2027, 0, 1) });
    expect(legacyHintCutoff()).toBe(before);
    const keeps = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, legacyHintCutoffMs: Date.UTC(2020, 0, 1) });
    expect(legacyHintCutoff()).toBe(before);
    expect(texts(strips)[0]).toBe('hello there');
    expect(texts(keeps)[0]).toContain('[Reply language: English]');
    expect(strips.status === 'ready' && keeps.status === 'ready' && strips.key !== keeps.key).toBe(true);
    const keys = await ready.readyKeys([{ sessionId: sid, cwd: CWD, legacyHintCutoffMs: Date.UTC(2020, 0, 1) }], claudeHome);
    expect(keeps.status === 'ready' && keys[sid] === keeps.key).toBe(true);
  });

  it('a parse never reads more than PARSE_MAX_LINES lines', async () => {
    const sid = 'ready-many-lines';
    const t = transcript().user('u0', 'the very first message');
    for (let i = 0; i < PARSE_MAX_LINES + 200; i++) t.assistant(`a${i}`, `step ${i}`);
    await writePlain(sid, t);
    const view = await make({ stageBytes: [64 * 1024 * 1024] })
      .readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 20_000 });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.reachedStart).toBe(false);
    expect(view.windowed).toBe(true);
    expect(texts(view)).not.toContain('the very first message');
    expect(view.total).toBeLessThanOrEqual(PARSE_MAX_LINES);
  }, 30_000);
});

describe('bytes, not characters', () => {
  // Rows of three-byte characters: UTF-16 length is a third of the UTF-8 size.
  const wide = (n: number, seed: string) => `${seed} ${'\u4e2d'.repeat(n)}`;

  it('a window starting inside a multi-byte character reads the same rows as the whole file', async () => {
    const t = transcript();
    for (let i = 0; i < 12; i++) t.user(`u${i}`, wide(40, `q${i}`)).assistant(`a${i}`, wide(40, `a${i}`));
    const text = t.text();
    const bytes = Buffer.from(text, 'utf8');
    // A byte inside the 7th line's first wide character, plus one: mid-character.
    let line = 0;
    let at = 0;
    while (line < 7) { at = bytes.indexOf(10, at) + 1; line++; }
    const mid = bytes.indexOf(Buffer.from('\u4e2d', 'utf8'), at) + 1;
    const stage = bytes.length - mid;
    for (const archived of [false, true]) {
      const sid = archived ? 'ready-wide-gz' : 'ready-wide-plain';
      await fsp.mkdir(projectDir(), { recursive: true });
      if (archived) {
        await fsp.writeFile(path.join(projectDir(), `${sid}.jsonl.gz`), await gzip(bytes));
        await fsp.writeFile(path.join(projectDir(), `${sid}.walnut-archive.json`), '{}');
      } else {
        await fsp.writeFile(path.join(projectDir(), `${sid}.jsonl`), bytes);
      }
      const view = await make({ stageBytes: [stage] }).readyView({ sessionId: sid, cwd: CWD, claudeHome });
      expect(view.status, sid).toBe('ready');
      const got = texts(view);
      // The rows after the cut line, whole and in order: lines 8.. of the file.
      const expected = t.lines.slice(8).map((l) => (typeof l.message?.content === 'string' ? l.message.content : (l.message!.content as unknown as Array<{ text: string }>)[0]!.text));
      expect(got, sid).toEqual(expected);
      expect(got.join('').includes('\ufffd'), sid).toBe(false);
    }
  });

  it('windowText drops the partial first line on its byte, never a character index', () => {
    const buf = Buffer.from('x\u4e2d\u4e2d\nwhole \u4e2d line\n', 'utf8');
    expect(windowText(buf.subarray(2), false)).toBe('whole \u4e2d line\n');
    expect(windowText(buf, true)).toBe('x\u4e2d\u4e2d\nwhole \u4e2d line\n');
    expect(windowText(Buffer.from('no newline at all'), false)).toBe('');
  });

  it('caps a view at READY_MAX_JSON_BYTES of UTF-8, keeping the newest rows that fit', async () => {
    const sid = 'ready-wide-cap';
    const t = transcript();
    // Each reply is about 300 KB of UTF-8 (100 K characters): seven or so fit in 2 MiB.
    for (let i = 0; i < 12; i++) t.user(`u${i}`, `ask ${i}`).assistant(`a${i}`, wide(100_000, `reply ${i}`));
    await writePlain(sid, t);
    const view = await make({ stageBytes: [8 * 1024 * 1024] }).readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 20_000 });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    const rows = rowsOf(view);
    expect(view.jsonBytes).toBeLessThanOrEqual(READY_MAX_JSON_BYTES);
    expect(Buffer.byteLength(JSON.stringify(rows), 'utf8')).toBe(view.jsonBytes);
    expect(rows.length).toBe(view.rows);
    expect(rows.length).toBeLessThan(24);
    expect(rows.at(-1)!.text.startsWith('reply 11')).toBe(true);
    expect(view.windowed).toBe(true);
  }, 30_000);

  it('a newest row larger than the cap answers pending too-large, never a cut row', async () => {
    const sid = 'ready-wide-huge';
    // 800 K characters, 2.4 MB of UTF-8: under the cap by length, over it by bytes.
    await writePlain(sid, transcript().user('u1', 'write it all').assistant('a1', wide(800_000, 'huge')));
    const view = await make({ stageBytes: [8 * 1024 * 1024] }).readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 20_000 });
    expect(view).toMatchObject({ status: 'pending', reason: 'too-large' });
  }, 30_000);

  it('fitRows: the newest rows under both caps, by UTF-8 bytes; nothing when the newest is too big', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', text: `r${i} ${'\u4e2d'.repeat(30)}`, timestamp: '' })) as SessionHistoryMessage[];
    expect(fitRows(rows, 10, 1e9).rows).toEqual(rows.slice(40));
    const capped = fitRows(rows, 1000, 1200);
    expect(Buffer.byteLength(capped.json, 'utf8')).toBeLessThanOrEqual(1200);
    expect(capped.json).toBe(JSON.stringify(capped.rows));
    expect(capped.rows.at(-1)).toBe(rows.at(-1));
    // By characters these would fit three times over; by bytes they do not.
    expect(capped.rows.length).toBeLessThan(Math.floor(1200 / JSON.stringify(rows[0]).length));
    expect(fitRows(rows, 1000, 10)).toEqual({ rows: [], json: '[]' });
  });
});

describe('finding the file in bounded time', () => {
  it('a search past the budget answers pending locating; the next ask finds it', async () => {
    const sid = 'ready-far';
    await writePlain(sid, transcript().user('u1', 'hi').assistant('a1', 'Hello.'), '/some/other/place');
    let clock = Date.now();
    // Every reading of the clock is 10 s later: the request's budget has always run out.
    const late = make({ now: () => (clock += 10_000) });
    expect(await late.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 100 })).toEqual({ status: 'pending', reason: 'locating' });
    const ready = make();
    expect((await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome })).status).toBe('ready');
  });

  it('locateTranscriptReadOnly stops a directory search at its deadline', async () => {
    for (let i = 0; i < 5; i++) await fsp.mkdir(path.join(claudeHome, 'projects', `dir-${i}`), { recursive: true });
    expect(await locateTranscriptReadOnly('ready-nowhere', undefined, claudeHome, { deadline: Date.now() - 1 })).toEqual({ timedOut: true });
    expect(await locateTranscriptReadOnly('ready-nowhere', undefined, claudeHome, { deadline: Date.now() + 5_000 })).toBeNull();
  });
});

describe('the budget keeps what is readable', () => {
  it('a build still going answers its last readable stage, marked incomplete', async () => {
    const sid = 'ready-progress';
    await writePlain(sid, transcript().user('u1', 'hi').assistant('a1', 'Hello.'));
    const hold = deferred<void>();
    let progressSent = false;
    const executor = async (job: ReadyJob, onProgress: (a: ReadyAnswer) => void): Promise<ReadyBuilt> => {
      const full = await inThreadReadyExecutor(job, () => {});
      if (full.status === 'ready') { onProgress(full); progressSent = true; }
      await hold.promise;
      return full;
    };
    const ready = make({ executor });
    let early: ReadyViewAnswer;
    try {
      early = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 200 });
      expect(progressSent).toBe(true);
      expect(early).toMatchObject({ status: 'ready', complete: false });
    } finally {
      hold.resolve();
    }
    // Its key is not the whole view's: a server that kept it and asks again gets the whole view.
    const keys = await ready.readyKeys([{ sessionId: sid, cwd: CWD }], claudeHome);
    expect(early.status === 'ready' && early.key).toBe(partialReadyKey(keys[sid]!));
    const whole = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, budgetMs: 5_000, have: (early as ReadyAnswer).key });
    expect(whole).toMatchObject({ status: 'ready', complete: true, key: keys[sid] });
    expect(await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome, have: keys[sid]! })).toEqual({ status: 'unchanged', key: keys[sid] });
  });
});

describe('the worker executor', () => {
  /** A fake worker thread: it answers pings and runs builds in this thread, unless told not to. */
  class FakeWorker implements ReadyWorkerLike {
    handlers: Record<string, Array<(v: never) => void>> = {};
    terminated = false;
    jobs = 0;
    constructor(private mode: 'ok' | 'no-pong' | 'die-on-job' | 'hang' = 'ok') {}
    on(event: string, cb: (v: never) => void): this { (this.handlers[event] ??= []).push(cb); return this; }
    emit(event: string, v: unknown): void { for (const cb of this.handlers[event] ?? []) cb(v as never); }
    postMessage(m: unknown): void {
      const msg = m as { type: string; id: number; job: ReadyJob };
      setTimeout(() => {
        if (this.terminated) return;
        if (msg.type === 'ping') { if (this.mode !== 'no-pong') this.emit('message', { type: 'pong' }); return; }
        this.jobs++;
        if (this.mode === 'die-on-job') { this.emit('exit', 1); return; }
        if (this.mode === 'hang') return;
        void inThreadReadyExecutor(msg.job, (answer) => this.emit('message', { type: 'progress', id: msg.id, answer }))
          .then((result) => this.emit('message', { type: 'done', id: msg.id, result }));
      }, 1);
    }
    terminate(): void { this.terminated = true; }
  }
  async function job(sid: string): Promise<ReadyJob> {
    const file = await writePlain(sid, transcript().user('u1', `hi ${sid}`).assistant('a1', 'Hello.'));
    const st = await fsp.stat(file);
    return { key: `k-${sid}`, path: file, archived: false, size: st.size, mtimeMs: st.mtimeMs, cutsKey: '', turns: 10, rows: 400, stageBytes: [512 * 1024] };
  }

  it('connection warmup starts just one thread and reads no transcript', async () => {
    const made: FakeWorker[] = [];
    const ex = createReadyWorkerExecutor([() => { const w = new FakeWorker(); made.push(w); return w; }]);
    try {
      expect(await Promise.all([ex.warm(), ex.warm()])).toEqual([true, true]);
      expect(made).toHaveLength(1);
      expect(made[0]!.jobs).toBe(0);
      expect((await ex(await job('ready-prewarmed'), () => {})).status).toBe('ready');
      expect(made).toHaveLength(1);
    } finally { ex.close(); }
  });

  it('closing during warmup ends the newly started thread and never starts another', async () => {
    const w = new FakeWorker();
    const ex = createReadyWorkerExecutor([() => w]);
    const warming = ex.warm();
    ex.close();
    expect(await warming).toBe(false);
    expect(w.terminated).toBe(true);
    expect(await ex.warm()).toBe(false);
  });

  it('starts one worker, answers its builds, and reuses it', async () => {
    const made: FakeWorker[] = [];
    const ex = createReadyWorkerExecutor([() => { const w = new FakeWorker(); made.push(w); return w; }]);
    try {
      const a = await ex(await job('ready-w1'), () => {});
      const b = await ex(await job('ready-w2'), () => {});
      expect(a.status).toBe('ready');
      expect(b.status === 'ready' && decodeReadyRows(b)[0]!.text).toBe('hi ready-w2');
      expect(made).toHaveLength(1);
      expect(made[0]!.jobs).toBe(2);
    } finally { ex.close(); }
  });

  it('tries the next entry when one never answers, and keeps the one that works', async () => {
    const made: string[] = [];
    const ex = createReadyWorkerExecutor([
      () => { made.push('a'); return new FakeWorker('no-pong'); },
      () => { made.push('b'); return new FakeWorker(); },
    ], { pingMs: 30 });
    try {
      expect((await ex(await job('ready-w3'), () => {})).status).toBe('ready');
      expect(made).toEqual(['a', 'b']);
    } finally { ex.close(); }
  });

  it('with no worker at all it answers no-worker, and waits before trying again', async () => {
    let tries = 0;
    let clock = 0;
    const ex = createReadyWorkerExecutor([() => { tries++; throw new Error('no such entry'); }], { now: () => clock, retryAfterMs: 1_000 });
    expect(await ex(await job('ready-w4'), () => {})).toEqual({ status: 'none', reason: 'no-worker' });
    expect(await ex(await job('ready-w4'), () => {})).toEqual({ status: 'none', reason: 'no-worker' });
    expect(tries).toBe(1);
    clock = 2_000;
    await ex(await job('ready-w4'), () => {});
    expect(tries).toBe(2);
  });

  it('a worker that dies in a build answers read-failed, and the next build gets a new one', async () => {
    const made: FakeWorker[] = [];
    const modes: Array<'die-on-job' | 'ok'> = ['die-on-job', 'ok'];
    const ex = createReadyWorkerExecutor([() => { const w = new FakeWorker(modes[made.length] ?? 'ok'); made.push(w); return w; }]);
    try {
      expect(await ex(await job('ready-w5'), () => {})).toEqual({ status: 'none', reason: 'read-failed' });
      expect((await ex(await job('ready-w6'), () => {})).status).toBe('ready');
      expect(made).toHaveLength(2);
    } finally { ex.close(); }
  });

  it('a build that overruns is ended with its worker', async () => {
    const w = new FakeWorker('hang');
    const ex = createReadyWorkerExecutor([() => w], { jobMaxMs: 40 });
    expect(await ex(await job('ready-w7'), () => {})).toEqual({ status: 'none', reason: 'read-failed' });
    expect(w.terminated).toBe(true);
    expect(ex._alive()).toBe(false);
  });

  it('an idle worker is ended at its idle deadline', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const ex = createReadyWorkerExecutor([() => w], { idleMs: 20 });
    try {
      const warming = ex.warm();
      await vi.advanceTimersByTimeAsync(1);
      expect(await warming).toBe(true);
      await vi.advanceTimersByTimeAsync(19);
      expect(w.terminated).toBe(false);
      expect(ex._alive()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.terminated).toBe(true);
      expect(ex._alive()).toBe(false);
    } finally { ex.close(); vi.useRealTimers(); }
  });

  it("serveReadyWorker is the worker's side of the same messages", async () => {
    const posted: Array<Record<string, unknown>> = [];
    let onMessage: (v: unknown) => void = () => {};
    serveReadyWorker({ on: (_e, cb) => { onMessage = cb; }, postMessage: (v) => { posted.push(v as Record<string, unknown>); } });
    onMessage({ type: 'ping' });
    onMessage({ type: 'job', id: 7, job: await job('ready-w9') });
    for (let i = 0; i < 100 && !posted.some((p) => p.type === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted[0]).toEqual({ type: 'pong' });
    const done = posted.find((p) => p.type === 'done') as { id: number; result: ReadyBuilt };
    expect(done.id).toBe(7);
    expect(done.result.status).toBe('ready');
  });

  it('a real worker thread (in this process) builds the same view as this thread', async () => {
    // A thread, not a process: nothing is spawned or signalled outside this test run.
    const { Worker } = await import('node:worker_threads');
    const entry = new URL('../../src/providers/history-ready-worker.ts', import.meta.url);
    const ex = createReadyWorkerExecutor([() => new Worker(entry) as unknown as ReadyWorkerLike]);
    try {
      const j = await job('ready-w10');
      const viaWorker = await ex(j, () => {});
      const here = await inThreadReadyExecutor(j, () => {});
      expect(viaWorker.status).toBe('ready');
      expect(viaWorker.status === 'ready' && here.status === 'ready' && decodeReadyRows(viaWorker)).toEqual(here.status === 'ready' && decodeReadyRows(here));
      // A rewound session: the worker replays the cuts over the whole file itself.
      const t = transcript().user('u1', 'keep me').assistant('a1', 'kept').user('u2', 'second ask')
        .assistant('a2', 'ABANDONED reply').user('u3', 'ABANDONED ask');
      const cut = cutHere(t, 'u2');
      t.from('u2').user('u2b', 'the new ask').assistant('a2b', 'the new reply');
      const file = await writePlain('ready-w11', t);
      const st = await fsp.stat(file);
      const cuts = [{ uuid: cut.uuid, lastUuidAtCommit: cut.lastUuidAtCommit }];
      const rewoundJob: ReadyJob = { key: 'k-w11', path: file, archived: false, size: st.size, mtimeMs: st.mtimeMs, cutsKey: rewindCutsKey(cuts), cuts, turns: 10, rows: 400, stageBytes: [512 * 1024] };
      const rewoundView = await ex(rewoundJob, () => {});
      expect(rewoundView.status).toBe('ready');
      const got = rewoundView.status === 'ready' ? decodeReadyRows(rewoundView).map((m) => m.text) : [];
      expect(got.some((x) => x.includes('ABANDONED'))).toBe(false);
      expect(got).toContain('the new reply');
    } finally { ex.close(); }
  }, 20_000);

  it('readyWorkerEntries: the compiled layouts, then the source file', () => {
    expect(readyWorkerEntries('/$bunfs/root/daemon-linux-x64', 'file:///x/src/providers/daemon-standalone.ts'))
      .toEqual(['/$bunfs/root/history-ready-worker.ts', '/$bunfs/root/providers/history-ready-worker.ts']);
    expect(readyWorkerEntries('/repo/src/providers/daemon-standalone.ts', 'file:///repo/src/providers/daemon-standalone.ts'))
      .toEqual(['file:///repo/src/providers/history-ready-worker.ts']);
  });
});

describe('the wire', () => {
  it('a ready answer carries its rows gzipped, with their count and UTF-8 size', async () => {
    const sid = 'ready-wire';
    await writePlain(sid, transcript().user('u1', 'hi \u00e9\u4e2d').assistant('a1', 'Hello.'));
    const view = await make().readyView({ sessionId: sid, cwd: CWD, claudeHome });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect((view as unknown as { messages?: unknown }).messages).toBeUndefined();
    const rows = JSON.parse((await gunzip(Buffer.from(view.rowsGz, 'base64'))).toString('utf8')) as SessionHistoryMessage[];
    expect(rows.map((r) => r.text)).toEqual(['hi \u00e9\u4e2d', 'Hello.']);
    expect(view.rows).toBe(2);
    expect(view.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(rows), 'utf8'));
    expect(view).toMatchObject({ schema: HISTORY_CACHE_SCHEMA, parser: HISTORY_PARSER_VERSION, cutsKey: '', readable: true });
  });

  it('readyRequestFromWire keeps only well-formed fields', () => {
    const req = readyRequestFromWire({
      sid: 's1', cwd: '/w', turns: 10, rows: 'x', budgetMs: Number.NaN, have: 'k', interactive: 'yes', legacyHintCutoffMs: 5,
      cuts: [{ uuid: 'u', lastUuidAtCommit: 'l', trailingQueueKeys: ['q', 3] }, { uuid: 7 }, null],
    }, '/home/.claude');
    expect(req).toEqual({
      sessionId: 's1', cwd: '/w', claudeHome: '/home/.claude', turns: 10, have: 'k', legacyHintCutoffMs: 5,
      cuts: [{ uuid: 'u', lastUuidAtCommit: 'l', trailingQueueKeys: ['q'] }],
    });
    expect(readyRequestFromWire({}, '/h')).toEqual({ sessionId: '', claudeHome: '/h' });
  });

  it('readyKeys answers the key readyView would, from a stat', async () => {
    const sid = 'ready-keys';
    await writePlain(sid, transcript().user('u1', 'hi').assistant('a1', 'Hello.'));
    const ready = make();
    const view = await ready.readyView({ sessionId: sid, cwd: CWD, claudeHome });
    const keys = await ready.readyKeys([{ sessionId: sid, cwd: CWD }, { sessionId: 'ready-keys-missing' }], claudeHome);
    expect(view.status === 'ready' && keys[sid] === view.key).toBe(true);
    expect(keys['ready-keys-missing']).toBeNull();
    expect(ready._memoSize()).toBe(1); // a key costs no parse
  });
});

describe('helpers', () => {
  it('lastLines keeps whole trailing lines', () => {
    expect(lastLines('a\nb\nc\n', 2)).toEqual({ text: 'b\nc\n', cut: true });
    expect(lastLines('a\nb\nc', 2)).toEqual({ text: 'b\nc', cut: true });
    expect(lastLines('a\nb\nc\n', 5)).toEqual({ text: 'a\nb\nc\n', cut: false });
    expect(lastLines('', 3)).toEqual({ text: '', cut: false });
  });
});
