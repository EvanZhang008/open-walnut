/**
 * A Claude to Claude transfer (native-copy): the gates before anything moves,
 * the private stage, the fork bound to its own attempt, and what is kept when
 * it is not confirmed.
 *
 * MACHINE SAFETY: every edge with an effect is a recorder. The task store is an
 * in-memory map, the daemon client and file reader are fakes, the workspace move
 * and the local prune are stubs, logging is a no-op, and every absolute path the
 * constants module exports is moved under /nonexistent, so a write that slipped
 * past these mocks fails instead of landing. No server, daemon, CLI, socket or
 * process is started. The event bus is the real in-memory one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const st = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  conversations: new Map<string, { claudeSessionId: string }>(),
  ops: [] as Array<{ op: string; id: string; patch?: Record<string, unknown> }>,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  files: new Map<string, string>(),
  privateStage: true as boolean | 'upgrade',
  lookup: null as null | ((host: string, sid: string) => unknown),
  relay: null as null | ((...a: unknown[]) => Promise<unknown>),
  onFork: null as null | ((sid: string, input: Record<string, unknown>) => void | Promise<void>),
  newTaskSeq: 0,
}));

vi.mock('../../../src/constants.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real)) out[k] = typeof v === 'string' && v.startsWith('/') ? '/nonexistent/walnut-xfer-test' + v : v;
  return out;
});
vi.mock('../../../src/logging/index.js', () => {
  // Any depth (log.session.info, log.bus.debug) is the same callable no-op.
  const noop: Record<string, unknown> = new Proxy(function noopLog() {}, { get: (_t, k) => (k === 'then' ? undefined : noop), apply: () => undefined }) as never;
  return { log: noop, createSubsystemLogger: () => noop, initLogging: () => {}, shouldLog: () => false, LOG_LEVEL_ORDER: [], redactSensitiveText: (s: string) => s };
});
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => {
    const t = st.tasks.get(id);
    if (!t) throw new Error(`No task found with id ${id}`);
    return { ...t };
  },
  updateTaskRaw: async (id: string, patch: unknown) => {
    const cur = st.tasks.get(id)!;
    const p = (typeof patch === 'function' ? (patch as (c: unknown) => Record<string, unknown>)(cur) : patch) as Record<string, unknown>;
    st.ops.push({ op: 'raw', id, patch: p });
    Object.assign(cur, p);
    return cur;
  },
  updateTask: async (id: string, patch: Record<string, unknown>) => {
    st.ops.push({ op: 'update', id, patch });
    Object.assign(st.tasks.get(id)!, patch);
    return st.tasks.get(id);
  },
  deleteTask: async (id: string) => { st.ops.push({ op: 'delete', id }); st.tasks.delete(id); },
  listTasks: async () => [...st.tasks.values()],
}));
vi.mock('../../../src/core/sessions/task-session-claim.js', () => ({
  taskConversation: async (taskId: string) => st.conversations.get(taskId),
}));
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { box: { hostname: 'box.example' } } }),
}));
vi.mock('../../../src/core/hosts/host-profile.js', () => ({
  readHostProfile: async () => null, probeIsStale: () => true, recordProbedFacts: async () => null,
  recordRepoPath: async () => {}, recordReach: async () => {}, repoKey: () => 'marina',
}));
vi.mock('../../../src/core/transfer/workspace.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/transfer/workspace.js')>()),
  pruneLocalTransfers: async () => 0,
  moveWorkspace: async (a: unknown) => {
    st.calls.push({ fn: 'moveWorkspace', args: [a] });
    return {
      meta: { kind: 'git', root: '/work/repo', relCwd: '', createdAt: '', remotes: [{ name: 'origin', url: 'https://github.com/acme/marina.git' }] },
      bundleDir: '~/.open-walnut-transfers/xf/workspace', files: ['meta.json'], route: 'relay', bytes: 10,
    };
  },
}));
vi.mock('../../../src/core/sessions/ensure-cwd.js', () => ({ ensureCwd: async (...a: unknown[]) => { st.calls.push({ fn: 'ensureCwd', args: a }); } }));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async (...a: unknown[]) => { st.calls.push({ fn: 'startSessionForTask', args: a }); throw new Error('not a native-copy path'); },
}));
vi.mock('../../../src/core/sessions/session-controls.js', () => ({
  createForkSiblingTask: async (sourceId: string, opts: { childTitle: string }) => {
    const id = `new-task-${++st.newTaskSeq}`;
    const task = { id, title: opts.childTitle, phase: 'TODO', project: 'Marina', created_at: '2026-10-24T00:00:00Z' };
    st.tasks.set(id, task);
    st.calls.push({ fn: 'createForkSiblingTask', args: [sourceId] });
    return { task };
  },
  forkSessionToTask: async (sid: string, input: Record<string, unknown>) => {
    st.calls.push({ fn: 'forkSessionToTask', args: [sid, input] });
    await st.onFork?.(sid, input);
    return { status: 'pending', sessionId: 'preassigned-id', taskId: input.task_id };
  },
}));
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonNeedsUpgradeError: class DaemonNeedsUpgradeError extends Error {
    constructor(public host: string, public capability = 'fs-mutate-v1') { super(`upgrade ${host} for ${capability}`); this.name = 'DaemonNeedsUpgradeError'; }
  },
  DaemonFileReader: class {
    constructor(private host: string) {}
    async readFile(p: string) { st.calls.push({ fn: 'readFile', args: [this.host, p] }); return st.files.get(`${this.host}:${p}`) ?? null; }
    async readRangeBytes(p: string, start: number, length: number) {
      st.calls.push({ fn: 'readRangeBytes', args: [this.host, p, start, length] });
      const f = st.files.get(`${this.host}:${p}`);
      if (f === undefined) return null;
      const all = Buffer.from(f);
      const buf = all.subarray(start, start + length);
      return { buf, fileSize: all.length, eof: start + buf.length >= all.length };
    }
    async removePath(p: string, recursive: boolean) { st.calls.push({ fn: 'removePath', args: [this.host, p, recursive] }); }
  },
}));
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', async () => {
  const { DaemonNeedsUpgradeError } = await import('../../../src/core/daemon-file-reader.js');
  class TransferHostOfflineError extends Error { constructor(public host: string) { super(`offline ${host}`); } }
  return {
    TransferHostOfflineError,
    probeHostFacts: async () => { throw new Error('no probe in this test'); },
    assertPrivateStage: async (host: string) => {
      st.calls.push({ fn: 'assertPrivateStage', args: [host] });
      if (st.privateStage === 'upgrade') throw new DaemonNeedsUpgradeError(host, 'transfer-private-v1');
    },
    findTranscript: async (host: string, sid: string) => { st.calls.push({ fn: 'findTranscript', args: [host, sid] }); return st.lookup!(host, sid); },
    relayFile: async (...a: unknown[]) => { st.calls.push({ fn: 'relayFile', args: a }); return st.relay!(...a); },
  };
});

import { bus, EventNames } from '../../../src/core/event-bus.js';
import { transferTask, __setResumeFileGateForTesting } from '../../../src/core/transfer/transfer.js';
import { unconfirmedTransferJob } from '../../../src/core/transfer/transfer-jobs.js';

const SRC_SID = '11111111-2222-4333-8444-555555555555';
const FORK_SID = '99999999-8888-4777-8666-555555555555';
const XF = 'xf-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SRC_PATH = `/Users/me/.claude/projects/-work-repo/${SRC_SID}.jsonl`;
const FORK_PATH = `/home/dev/.claude/projects/-home-dev-repo/${FORK_SID}.jsonl`;
/** The stage: an attempt dir of its own (never the transfer's id, where the workspace pack goes). */
const STAGE_PATH = expect.stringMatching(new RegExp(`^~/\\.open-walnut-transfers/xf-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/transcript/${SRC_SID}\\.jsonl$`));
const STAGED_ABS = expect.stringMatching(new RegExp(`^/home/dev/\\.open-walnut-transfers/xf-[0-9a-f-]{36}/transcript/${SRC_SID}\\.jsonl$`));
const absOf = (p: string) => p.replace(/^~/, '/home/dev');

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const SOURCE_TEXT = [
  line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-20T10:00:00Z', message: { content: 'hi' } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-20T10:00:05Z', message: { content: 'hello' } }),
].join('\n') + '\n';
// The fork's own file: the copied conversation (uuids kept), then its first turn.
const FORK_TEXT = SOURCE_TEXT + line({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-10-24T10:00:00Z', message: { content: 'go on' } }) + '\n';
const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');

function seedSource(): string {
  st.tasks.set('src-task', { id: 'src-task', title: 'Fix the parser', phase: 'IN_PROGRESS', project: 'Marina', cwd: '/work/repo', created_at: '2026-10-20T00:00:00Z' });
  st.conversations.set('src-task', { claudeSessionId: SRC_SID, engine: 'claude', cwd: '/work/repo', process_status: 'idle', taskId: 'src-task' } as never);
  return 'src-task';
}

const allow = () => __setResumeFileGateForTesting({ versions: ['9.9.9'], versionOn: async () => '9.9.9' });
const called = (fn: string) => st.calls.filter((c) => c.fn === fn);
const newTask = () => [...st.tasks.values()].find((t) => t.id !== 'src-task');
/** The init a successful fork sends after its record chain (which linked the new task to the id it runs under). */
const latestTask = () => [...st.tasks.values()].filter((t) => t.id !== 'src-task').pop();
const initFor = (actualId: string, attemptId = XF) => () => {
  st.conversations.set(latestTask()!.id as string, { claudeSessionId: actualId });
  bus.emit(EventNames.TRANSFER_FORK_INIT, { attemptId, preassignedId: 'preassigned-id', actualId, renamed: actualId !== 'preassigned-id' }, ['transfer'], { source: 'test' });
};

beforeEach(() => {
  bus.clear();
  st.tasks.clear(); st.conversations.clear(); st.ops.length = 0; st.calls.length = 0; st.files.clear();
  st.privateStage = true; st.newTaskSeq = 0; st.onFork = null;
  st.lookup = (host, sid) => (sid === SRC_SID ? { kind: 'one', path: SRC_PATH } : sid === FORK_SID ? { kind: 'one', path: FORK_PATH } : { kind: 'none' });
  st.relay = async (_from, _fp, _to, tp, opts) => {
    (opts as { onBytes: (b: Buffer) => void }).onBytes(Buffer.from(SOURCE_TEXT));
    return { bytes: SOURCE_TEXT.length, sha256: sha(SOURCE_TEXT), chunks: 1, retries: 0, path: absOf(tp as string) };
  };
  st.files.set(`__local__:${SRC_PATH}`, SOURCE_TEXT);
  st.files.set(`box:${FORK_PATH}`, FORK_TEXT);
  __setResumeFileGateForTesting(null);
});

afterEach(() => { vi.useRealTimers(); __setResumeFileGateForTesting(null); bus.clear(); });

const toBox = (extra: Record<string, unknown> = {}) => ({ taskId: seedSource(), host: 'box', cwd: '/home/dev/repo', ...extra });

describe('native-copy: refusals before anything moves', () => {
  it('the target\'s CLI is not a version on the allowlist: cli_resume_file_unsupported, nothing read, moved, staged or created', async () => {
    __setResumeFileGateForTesting({ versions: ['9.9.9'], versionOn: async () => '1.0.0' });
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ status: 409, code: 'cli_resume_file_unsupported' });
    expect(st.calls.map((c) => c.fn)).toEqual([]);
    expect(newTask()).toBeUndefined();
  });

  it('a target daemon without transfer-private-v1: daemon_upgrade_required, the source is never read and no byte moves', async () => {
    allow();
    st.privateStage = 'upgrade';
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ status: 409, code: 'daemon_upgrade_required' });
    expect(st.calls.map((c) => c.fn)).toEqual(['assertPrivateStage']);
    expect(newTask()).toBeUndefined();
  });

  it.each([
    [{ kind: 'unreachable', error: 'socket closed' }, 502, 'source_unreachable'],
    [{ kind: 'none' }, 409, 'transcript_missing'],
    [{ kind: 'many', paths: ['/a', '/b'] }, 409, 'transcript_ambiguous'],
  ])('the source lookup answers %o: %s %s, no relay, no task', async (answer, status, code) => {
    allow();
    st.lookup = () => answer;
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ status, code });
    expect(called('relayFile')).toHaveLength(0);
    expect(called('moveWorkspace')).toHaveLength(0);
    expect(newTask()).toBeUndefined();
  });
});

describe('native-copy to another host: stage, fork, confirm', () => {
  it('done: the private relay of the source file, a fork from the staged file bound to the attempt, then the source completes', async () => {
    allow();
    st.onFork = initFor(FORK_SID);
    const res = await transferTask(toBox(), XF);
    expect(res).toMatchObject({ sessionId: FORK_SID, sourceCompleted: true, history: 'native-copy' });

    const [relay] = called('relayFile');
    expect(relay.args.slice(0, 4)).toEqual(['__local__', SRC_PATH, 'box', STAGE_PATH]);
    // The workspace pack went under the transfer's id; the stage is never inside it.
    expect(called('moveWorkspace')[0].args[0]).toMatchObject({ transferId: XF });
    expect(String(relay.args[3])).not.toContain(`/${XF}/`);
    expect((relay.args[4] as { privateAttempt: string }).privateAttempt).toMatch(/^[0-9a-f]{32}$/);
    const [fork] = called('forkSessionToTask');
    expect(fork.args[0]).toBe(SRC_SID);
    expect(fork.args[1]).toMatchObject({ resumeFile: STAGED_ABS, transferAttemptId: XF, placeOverride: { cwd: '/home/dev/repo', host: 'box' } });

    const made = newTask()!;
    expect(made).toMatchObject({ transferred_from: 'src-task', transfer_state: 'done', transfer: { id: XF, stage: { host: 'box', path: STAGE_PATH } } });
    expect(st.tasks.get('src-task')).toMatchObject({ phase: 'COMPLETE', transferred_to: made.id });
    // The task was pending while the stage and the fork ran; done came before the source completed.
    const order = st.ops.map((o) => `${o.id === 'src-task' ? 'src' : 'new'}:${JSON.stringify(o.patch)}`);
    expect(order.findIndex((o) => o.includes('"transfer_state":"pending"'))).toBeLessThan(order.findIndex((o) => o.includes('"transfer_state":"done"')));
    expect(order.findIndex((o) => o.includes('"transfer_state":"done"'))).toBeLessThan(order.findIndex((o) => o.startsWith('src:') && o.includes('COMPLETE')));
    expect(st.ops.some((o) => o.op === 'delete')).toBe(false);
    // Confirmed: the staged copy goes, the whole attempt dir and nothing above it.
    const staged = (fork.args[1] as { resumeFile: string }).resumeFile;
    await vi.waitFor(() => expect(called('removePath').map((c) => c.args)).toEqual([['box', staged.replace(/\/transcript\/[^/]+$/, ''), true]]));
    // The leaf is scanned for in chunks of the fork's file, never read whole or parsed.
    expect(called('readFile')).toHaveLength(0);
    expect(called('readRangeBytes').map((c) => [c.args[0], c.args[2]])).toEqual([['box', 0]]);
    // And the record stops naming a stage that is gone.
    await vi.waitFor(() => expect((st.tasks.get(made.id as string)!.transfer as Record<string, unknown>).stage).toBeUndefined());
  });

  it('keepSource: done, linked, the source stays open', async () => {
    allow();
    st.onFork = initFor(FORK_SID);
    const res = await transferTask(toBox({ keepSource: true }), XF);
    expect(res.sourceCompleted).toBe(false);
    expect(st.tasks.get('src-task')!.phase).toBe('IN_PROGRESS');
    expect(newTask()!.transfer_state).toBe('done');
  });

  it('the CLI ran under another id (branch B): done once the task resolves to that id and its file holds the leaf', async () => {
    allow();
    st.onFork = () => {
      // The init handler's rename chain moved the record and queue before it announced.
      st.conversations.set(newTask()!.id as string, { claudeSessionId: FORK_SID });
      initFor(FORK_SID)();
    };
    const res = await transferTask(toBox(), XF);
    expect(res.sessionId).toBe(FORK_SID);
    expect(called('findTranscript').map((c) => c.args)).toContainEqual(['box', FORK_SID]);
  });

  it('an init of ANOTHER attempt does not count', async () => {
    allow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    st.onFork = initFor(FORK_SID, 'xf-00000000-0000-4000-8000-000000000000');
    const run = transferTask(toBox(), XF).catch((e) => e);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await run).toMatchObject({ code: 'fork_unconfirmed' });
    expect(newTask()).toMatchObject({ phase: 'NEED_ACTION', transfer_state: 'pending' });
  });
});

describe('native-copy: every failure after the stage keeps the task and the stage', () => {
  async function expectKept(code: string) {
    const made = newTask()!;
    expect(made).toMatchObject({ phase: 'NEED_ACTION', transfer_state: 'pending', transfer: { id: XF, stage: { host: 'box', path: STAGE_PATH } } });
    expect(String((made.transfer as { error?: string }).error)).not.toBe('');
    expect(st.ops.some((o) => o.op === 'delete')).toBe(false);
    expect(called('removePath')).toHaveLength(0);
    expect(st.tasks.get('src-task')).toMatchObject({ phase: 'IN_PROGRESS' });
    expect(st.tasks.get('src-task')!.transferred_to).toBeUndefined();
    expect(code).toBeTruthy();
  }

  it('the relay is refused by the stage', async () => {
    allow();
    st.relay = async () => { throw Object.assign(new Error('that attempt dir belongs to another transfer'), { code: 'stage_foreign' }); };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'stage_foreign' });
    await expectKept('stage_foreign');
    expect(called('forkSessionToTask')).toHaveLength(0);
  });

  it('the staged bytes do not hash to what the relay reports', async () => {
    allow();
    st.relay = async (_a, _b, _c, _d, opts) => {
      (opts as { onBytes: (b: Buffer) => void }).onBytes(Buffer.from(SOURCE_TEXT));
      return { bytes: 1, sha256: 'f'.repeat(64), chunks: 1, retries: 0, path: '/home/dev/.open-walnut-transfers/xf-11111111-1111-4111-8111-111111111111/transcript/x.jsonl' };
    };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'stage_unverified' });
    await expectKept('stage_unverified');
  });

  it('the fork request throws after the stage', async () => {
    allow();
    st.onFork = () => { throw new Error('fork refused'); };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'transfer_unconfirmed' });
    await expectKept('transfer_unconfirmed');
  });

  it('the new session errors before its init', async () => {
    allow();
    st.onFork = () => { bus.emit(EventNames.SESSION_ERROR, { error: 'spawn failed', taskId: newTask()!.id }, ['main-ai'], { source: 'test' }); };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'fork_failed' });
    await expectKept('fork_failed');
  });

  it('the new session ends before its init', async () => {
    allow();
    st.onFork = () => { bus.emit(EventNames.SESSION_ENDED, { taskId: newTask()!.id }, ['main-ai'], { source: 'test' }); };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'fork_failed' });
    await expectKept('fork_failed');
  });

  it('an error of ANOTHER task\'s session is not this fork\'s', async () => {
    allow();
    st.onFork = () => {
      bus.emit(EventNames.SESSION_ERROR, { error: 'unrelated', taskId: 'other-task' }, ['main-ai'], { source: 'test' });
      initFor(FORK_SID)();
    };
    expect((await transferTask(toBox(), XF)).sessionId).toBe(FORK_SID);
  });

  it('the init id is not the new task\'s conversation', async () => {
    allow();
    // The init is announced, but the task's conversation is some other session.
    st.onFork = () => { initFor(FORK_SID)(); st.conversations.set(newTask()!.id as string, { claudeSessionId: 'someone-else' }); };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'fork_link_mismatch' });
    await expectKept('fork_link_mismatch');
  });

  it('the new transcript never shows the source leaf', async () => {
    allow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    st.files.set(`box:${FORK_PATH}`, line({ type: 'user', uuid: 'zz', parentUuid: null, timestamp: '2026-10-24T10:00:00Z' }) + '\n');
    st.onFork = () => { st.conversations.set(newTask()!.id as string, { claudeSessionId: FORK_SID }); initFor(FORK_SID)(); };
    const run = transferTask(toBox(), XF).catch((e) => e);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await run).toMatchObject({ code: 'fork_unconfirmed' });
    await expectKept('fork_unconfirmed');
  });

  it('the runner refuses the start (it says so at once): kept for the user, no wait for the bound', async () => {
    allow();
    st.onFork = (_sid, input) => {
      bus.emit(EventNames.TRANSFER_FORK_INIT, { attemptId: input.transferAttemptId as string, preassignedId: 'preassigned-id', actualId: '', renamed: false, refused: 'no fork on this path' }, ['transfer'], { source: 'test' });
    };
    await expect(transferTask(toBox(), XF)).rejects.toMatchObject({ code: 'fork_refused' });
    await expectKept('fork_refused');
  });

  it('no init at all within the bound', async () => {
    allow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = transferTask(toBox(), XF).catch((e) => e);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await run).toMatchObject({ code: 'fork_unconfirmed' });
    await expectKept('fork_unconfirmed');
  });
});

describe('looking for the source leaf in the fork\'s transcript', () => {
  const MB = 1024 * 1024;
  const leafRecord = '"uuid":"a1"';

  it('a long file: found in a later chunk, and across a chunk edge', async () => {
    allow();
    // Pad so the leaf's record starts 5 bytes before the first 1 MB edge.
    const at = Buffer.from(SOURCE_TEXT).indexOf(leafRecord);
    const head = '{"pad":"' + 'x'.repeat(MB - 5 - at - 11) + '"}\n';
    const text = head + SOURCE_TEXT + 'z'.repeat(3 * MB) + '\n';
    expect(Buffer.from(text).indexOf(leafRecord)).toBeLessThan(MB);
    expect(Buffer.from(text).indexOf(leafRecord) + leafRecord.length).toBeGreaterThan(MB);
    st.files.set(`box:${FORK_PATH}`, text);
    st.onFork = initFor(FORK_SID);
    expect((await transferTask(toBox(), XF)).sessionId).toBe(FORK_SID);
    expect(called('readRangeBytes').map((c) => c.args[2])).toEqual([0, MB]);
  });

  it('the copy arrives later: the next look reads on from where the last stopped, not from the start', async () => {
    allow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const before = line({ type: 'system', uuid: 'init-only', timestamp: '2026-10-24T10:00:00Z' }) + '\n';
    st.files.set(`box:${FORK_PATH}`, before);
    st.onFork = initFor(FORK_SID);
    const run = transferTask(toBox(), XF).catch((e) => e);
    await vi.waitFor(() => expect(called('readRangeBytes')).toHaveLength(1));
    st.files.set(`box:${FORK_PATH}`, before + FORK_TEXT);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await run).sessionId).toBe(FORK_SID);
    const starts = called('readRangeBytes').map((c) => c.args[2] as number);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBe(Buffer.byteLength(before) - (Buffer.byteLength(leafRecord) - 1));
  });
});

describe('native-copy in place (same host, same directory): the CLI forks by id, no stage', () => {
  const inPlace = () => ({ taskId: seedSource(), model: 'claude-model-b' });

  it('no allowlist, no private stage, no relay, no transcript bytes read; the init confirms it; done', async () => {
    st.lookup = (host, sid) => ({ kind: 'one', path: sid === SRC_SID ? SRC_PATH : `/Users/me/.claude/projects/-work-repo/${sid}.jsonl` });
    st.files.set(`__local__:/Users/me/.claude/projects/-work-repo/${FORK_SID}.jsonl`, FORK_TEXT);
    st.onFork = () => { st.conversations.set(newTask()!.id as string, { claudeSessionId: FORK_SID }); initFor(FORK_SID)(); };
    const res = await transferTask(inPlace(), XF);
    expect(res).toMatchObject({ sessionId: FORK_SID, sourceCompleted: true });
    expect(called('assertPrivateStage')).toHaveLength(0);
    expect(called('relayFile')).toHaveLength(0);
    const input = called('forkSessionToTask')[0].args[1] as Record<string, unknown>;
    expect(input.resumeFile).toBeUndefined();
    expect(input.transferAttemptId).toBe(XF);
    expect(newTask()).toMatchObject({ transfer_state: 'done', transfer: { id: XF } });
    expect((newTask()!.transfer as Record<string, unknown>).stage).toBeUndefined();
    // A long conversation is never pulled onto the server: the CLI finds its own transcript by id.
    expect(called('readFile')).toHaveLength(0);
    expect(called('readRangeBytes')).toHaveLength(0);
    expect(called('removePath')).toHaveLength(0);
  });

  it('the fork keeps the source\'s effort and permissions, takes picks over them, and the title names the model', async () => {
    st.lookup = (_host, sid) => ({ kind: 'one', path: `/Users/me/.claude/projects/-work-repo/${sid}.jsonl` });
    st.files.set(`__local__:/Users/me/.claude/projects/-work-repo/${FORK_SID}.jsonl`, FORK_TEXT);
    st.onFork = (_sid, input) => initFor(FORK_SID, input.transferAttemptId as string)();
    const src = seedSource();
    Object.assign(st.conversations.get(src)!, { cliModel: 'opus[1m]', effort: 'xhigh', mode: 'plan' });
    const kept = await transferTask({ taskId: src, model: 'claude-model-b', keepSource: true }, XF);
    expect(kept.title).toBe('Fix the parser · claude-model-b');
    expect(called('forkSessionToTask')[0].args[1]).toMatchObject({ model: 'claude-model-b', effort: 'xhigh', permissionMode: 'plan', rawMessage: true });
    // 'default' means the CLI's own default, so the fork names no model.
    await transferTask({ taskId: src, model: 'default', effort: 'low', permissionMode: 'accept', keepSource: true }, 'xf-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(called('forkSessionToTask')[1].args[1]).toMatchObject({ model: '', effort: 'low', permissionMode: 'accept' });
  });

  it('the fork request throws: nothing was staged or started, so the new task is removed', async () => {
    st.onFork = () => { throw new Error('fork refused'); };
    await expect(transferTask(inPlace(), XF)).rejects.toThrow('fork refused');
    expect(st.ops.filter((o) => o.op === 'delete')).toHaveLength(1);
    expect(newTask()).toBeUndefined();
    expect(st.tasks.get('src-task')!.phase).toBe('IN_PROGRESS');
  });

  it('the runner refuses the start: nothing ran or was staged, so the new task is removed at once', async () => {
    st.onFork = (_sid, input) => {
      bus.emit(EventNames.TRANSFER_FORK_INIT, { attemptId: input.transferAttemptId as string, preassignedId: 'preassigned-id', actualId: '', renamed: false, refused: 'no fork on this path' }, ['transfer'], { source: 'test' });
    };
    await expect(transferTask(inPlace(), XF)).rejects.toMatchObject({ code: 'fork_refused', status: 409 });
    expect(newTask()).toBeUndefined();
    expect(st.tasks.get('src-task')!.phase).toBe('IN_PROGRESS');
  });

  it('the init names another session than the new task\'s: kept for the user, the source stays open', async () => {
    st.onFork = () => { initFor(FORK_SID)(); st.conversations.set(newTask()!.id as string, { claudeSessionId: 'someone-else' }); };
    await expect(transferTask(inPlace(), XF)).rejects.toMatchObject({ code: 'fork_link_mismatch' });
    expect(newTask()).toMatchObject({ phase: 'NEED_ACTION', transfer_state: 'pending' });
    expect(st.tasks.get('src-task')!.phase).toBe('IN_PROGRESS');
  });
});

describe('a transfer no job holds any more', () => {
  it('a pending task for that id reads as unconfirmed; nothing is changed by reading it', async () => {
    st.tasks.set('made', { id: 'made', transferred_from: 'src-task', transfer_state: 'pending', transfer: { id: XF }, created_at: '2026-10-24T00:00:00Z' });
    expect(await unconfirmedTransferJob(XF)).toMatchObject({ id: XF, state: 'unconfirmed', taskId: 'src-task', newTaskId: 'made' });
    expect(st.ops).toEqual([]);
  });

  it('a done task, an unknown id, or a malformed id: none', async () => {
    st.tasks.set('made', { id: 'made', transfer_state: 'done', transfer: { id: XF } });
    expect(await unconfirmedTransferJob(XF)).toBeUndefined();
    expect(await unconfirmedTransferJob('xf-ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeUndefined();
    expect(await unconfirmedTransferJob('../etc')).toBeUndefined();
  });
});
