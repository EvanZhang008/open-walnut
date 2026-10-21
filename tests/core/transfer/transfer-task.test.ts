/**
 * transferTask end to end over the real task and session stores. The edges
 * that would start a CLI or reach a daemon are stubbed and record what they
 * were asked, so these tests pin the decisions transferTask makes: which task
 * takes the work, what its first message carries, which history path runs,
 * and what happens to the source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const edges = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  forks: [] as Array<{ sid: string; input: Record<string, unknown> }>,
  writes: [] as Array<{ host: string; path: string; content: string }>,
  copies: [] as Array<{ host: string; from: string; to: string }>,
  cwds: [] as Array<{ cwd: string; host?: string }>,
  hosts: {} as Record<string, unknown>,
  failStart: false,
}));

vi.mock('../../../src/constants.js', () => createMockConstants('transfer-task'));
vi.mock('../../../src/utils/process.js', () => ({ isProcessAlive: () => true, isProcessAliveAsync: async () => true }));
vi.mock('../../../src/core/fork-title.js', () => ({
  summarizeForkPrompt: vi.fn(async () => 'x'), summarizeGroupLabel: vi.fn(async () => 'Parser Work'),
}));
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>();
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: edges.hosts }) };
});
vi.mock('../../../src/core/sessions/ensure-cwd.js', () => ({
  ensureCwd: async (cwd: string, host?: string) => { edges.cwds.push({ cwd, host }); },
}));
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    constructor(private host: string) {}
    async writeFile(path: string, content: string) { edges.writes.push({ host: this.host, path, content }); }
    async copyPath(from: string, to: string) { edges.copies.push({ host: this.host, from, to }); }
    async findSessionPath(sid: string) { return `/Users/me/.claude/projects/-work-repo/${sid}.jsonl`; }
  },
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  readProviderSessionHistory: async () => ({
    messages: [
      { role: 'user', text: 'Make the parser accept trailing commas', timestamp: '2026-10-20T10:00:00Z' },
      { role: 'assistant', text: 'Done in src/parser.ts; the magic word is PELICAN.', timestamp: '2026-10-20T10:01:00Z' },
    ],
  }),
}));
vi.mock('../../../src/core/transfer/workspace.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/transfer/workspace.js')>()),
  moveWorkspace: async () => ({
    meta: { kind: 'git', root: '/work/repo', relCwd: '', createdAt: '', remotes: [{ name: 'origin', url: 'https://github.com/acme/marina.git' }] },
    bundleDir: '~/.open-walnut/transfers/xf-test/workspace', files: ['meta.json', 'changes.patch'], route: 'relay', bytes: 2048,
  }),
}));
// The target resolves its own symlinks (macOS: /work is a link to /private/work here).
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', () => ({
  realpathOn: async (_host: string, p: string) => `/private${p}`,
  probeHostFacts: async () => { throw new Error('no probe in this test'); },
}));
vi.mock('../../../src/core/transfer/brief.js', () => ({
  writeHandoffBrief: async () => ({ text: 'Goal: trailing commas. Next: add a test.', method: 'model' }),
}));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async (params: Record<string, unknown>) => {
    edges.starts.push(params);
    if (edges.failStart) throw new Error('engine would not start');
    return { started: true, sessionId: 'new-codex-sid' };
  },
}));
vi.mock('../../../src/core/sessions/session-controls.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/sessions/session-controls.js')>()),
  forkSessionToTask: async (sid: string, input: Record<string, unknown>) => {
    edges.forks.push({ sid, input });
    return { sessionId: 'forked-sid', taskId: input.task_id };
  },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, listTasks, updateTaskRaw, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { transferTask } from '../../../src/core/transfer/transfer.js';
import { recordProbedFacts, recordRepoPath, repoKey } from '../../../src/core/hosts/host-profile.js';

beforeEach(async () => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  edges.starts.length = 0; edges.forks.length = 0; edges.writes.length = 0; edges.copies.length = 0; edges.cwds.length = 0;
  edges.hosts = {}; edges.failStart = false;
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 30));
  closeTaskDb(); closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

async function taskWithConversation(): Promise<string> {
  const { task } = await addTask({ title: 'Fix the parser', project: 'Marina', pinned: true, cwd: '/work/repo' } as never);
  await createSessionRecord('claude-sid', task.id, 'Marina', '/work/repo');
  // Between turns: a session mid-turn is refused (source_busy).
  await updateSessionRecord('claude-sid', { process_status: 'idle' } as never);
  return task.id;
}

describe('transferTask', () => {
  it('Claude to Codex on this machine: a new sibling task replays the conversation, the source completes', async () => {
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, engine: 'codex', message: 'Run the tests first.' });

    expect(res).toMatchObject({ history: 'replay', sourceCompleted: true, sessionId: 'new-codex-sid', target: { engine: 'codex', host: '__local__', cwd: '/work/repo' } });
    expect(res.taskId).not.toBe(src);
    expect(res.title).toBe('Fix the parser · Codex');

    const [start] = edges.starts;
    expect(start).toMatchObject({ taskIdPrefix: res.taskId, engine: 'codex', cwd: '/work/repo', expectReply: false });
    const message = String(start.message);
    expect(message).toContain('# Work transferred to you');
    expect(message).toContain('the magic word is PELICAN');
    expect(message).toContain(`-transfers/`);
    // The carry-over stays simple: no host summary, nothing asked about the host.
    expect(message).not.toContain('host_note_add');
    expect(message).not.toContain('## This host');
    expect(message.trimEnd().endsWith('Run the tests first.')).toBe(true);

    const [transcript] = edges.writes;
    expect(transcript.host).toBe('__local__');
    expect(transcript.path.startsWith(`${WALNUT_HOME}-transfers/xf-`)).toBe(true);
    expect(transcript.path).toMatch(/-transfers\/xf-[0-9a-f-]{12}\/transcript\.md$/);
    expect(transcript.content).toContain('Make the parser accept trailing commas');

    const source = await getTask(src);
    const target = await getTask(res.taskId);
    expect(source.phase).toBe('COMPLETE');
    expect(source.transferred_to).toBe(res.taskId);
    expect(target.transferred_from).toBe(src);
    expect(target.project).toBe('Marina');
    expect(target.group_id).toBe(source.group_id);
    expect(edges.forks).toHaveLength(0);
  });

  it('keep_source leaves the source open', async () => {
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, engine: 'codex', keepSource: true });
    expect(res.sourceCompleted).toBe(false);
    expect((await getTask(src)).phase).not.toBe('COMPLETE');
    expect((await getTask(src)).transferred_to).toBe(res.taskId);
  });

  it('Claude to Claude in another directory copies the CLI transcript and forks into the new task', async () => {
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, cwd: '/work/repo-copy' });

    expect(res.history).toBe('native-copy');
    expect(edges.copies).toEqual([{
      host: '__local__',
      from: '/Users/me/.claude/projects/-work-repo/claude-sid.jsonl',
      to: '~/.claude/projects/-private-work-repo-copy/claude-sid.jsonl',
    }]);
    const [fork] = edges.forks;
    expect(fork.sid).toBe('claude-sid');
    expect(fork.input).toMatchObject({ task_id: res.taskId, rawMessage: true, placeOverride: { cwd: '/work/repo-copy' } });
    expect(String(fork.input.message)).toContain('Paths and results in it refer to the old place');
    expect(edges.starts).toHaveLength(0);
    expect(res.title).toBe('Fix the parser · repo-copy');

    // Chained: the next transfer replaces the last place instead of stacking another.
    await createSessionRecord('forked-sid', res.taskId, 'Marina', '/work/repo-copy');
    await updateSessionRecord('forked-sid', { process_status: 'idle' } as never);
    const again = await transferTask({ taskId: res.taskId, engine: 'codex' });
    expect(again.title).toBe('Fix the parser · Codex');
    expect((await getTask(again.taskId)).transferred_from).toBe(res.taskId);
  });

  it('a task with no conversation is refused, and nothing is created', async () => {
    const { task } = await addTask({ title: 'Empty', project: 'Marina' });
    await expect(transferTask({ taskId: task.id, engine: 'codex' })).rejects.toMatchObject({ code: 'no_conversation', status: 409 });
    expect(edges.starts).toHaveLength(0);
  });

  it('Codex to a remote host is refused before anything moves', async () => {
    edges.hosts = { devbox: { hostname: 'devbox.example.org' } };
    const src = await taskWithConversation();
    await expect(transferTask({ taskId: src, engine: 'codex', host: 'devbox' })).rejects.toMatchObject({ code: 'engine_host_unsupported' });
    expect(edges.writes).toHaveLength(0);
    expect((await getTask(src)).phase).not.toBe('COMPLETE');
  });

  it('a remote host with a known home gets an absolute directory and the host summary', async () => {
    edges.hosts = { devbox: { hostname: 'devbox.example.org' } };
    await recordProbedFacts('devbox', {
      os: { platform: 'linux', release: '6.1' }, arch: 'x64', home: '/home/dev', proxyEnv: {},
      cloud: { imds: true, hasPublicIpv4: true, instanceType: 't4g.large' }, internet: { github: true },
      tools: { git: 'git version 2.43.0' }, probedAt: new Date().toISOString(),
    } as never);
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, host: 'devbox', cwd: '~/src/marina', mode: 'brief' });
    expect(res.history).toBe('brief');
    expect(res.workspace).toMatchObject({ route: 'relay', bytes: 2048 });
    expect(res.target).toMatchObject({ host: 'devbox', cwd: '/home/dev/src/marina' });
    expect(edges.cwds).toContainEqual({ cwd: '/home/dev/src/marina', host: 'devbox' });
    const message = String(edges.starts[0].message);
    expect(message).toContain('## Handoff brief\n\nGoal: trailing commas.');
    expect(message).toContain('## Workspace');
    expect(edges.writes[0]).toMatchObject({ host: 'devbox' });
    // The probe is Walnut's own (cwd expansion, the profile); the session is not handed it.
    expect(message).not.toContain('## This host');
    expect(message).not.toContain('t4g.large');
  });

  it('refuses while the source is mid-turn, and creates nothing', async () => {
    const id = await taskWithConversation();
    await updateSessionRecord('claude-sid', { process_status: 'running' } as never);
    await expect(transferTask({ taskId: id, engine: 'codex' })).rejects.toMatchObject({ code: 'source_busy', status: 409 });
    expect((await listTasks()).length).toBe(1);
  });

  it('a start that fails removes the new task and leaves the source open', async () => {
    const id = await taskWithConversation();
    edges.failStart = true;
    await expect(transferTask({ taskId: id, engine: 'codex' })).rejects.toThrow(/would not start/);
    const tasks = await listTasks();
    expect(tasks.map((t) => t.id)).toEqual([id]);
    expect(tasks[0].phase).not.toBe('COMPLETE');
    expect(tasks[0].transferred_to).toBeUndefined();
  });

  it('a worker stays its leader\'s worker after a transfer', async () => {
    const { task: leader } = await addTask({ title: 'Lead', project: 'Marina' } as never);
    const id = await taskWithConversation();
    await updateTaskRaw(id, { parent_task_id: leader.id }, { source: 'test' });
    const result = await transferTask({ taskId: id, engine: 'codex' });
    expect((await getTask(result.taskId)).parent_task_id).toBe(leader.id);
  });

  it('a model change in the same place forks without copying the transcript', async () => {
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, model: 'claude-opus-5-5' });
    expect(res.history).toBe('native-copy');
    expect(edges.copies).toEqual([]);
    expect(edges.forks[0].input).toMatchObject({ task_id: res.taskId, model: 'claude-opus-5-5' });
    expect(res.title).toBe('Fix the parser · claude-opus-5-5');
  });

  it('a directory the user names wins over where the host already keeps the repository', async () => {
    edges.hosts = { devbox: { hostname: 'devbox.example.org' } };
    await recordRepoPath('devbox', repoKey('https://github.com/acme/marina.git', 'repo'), '/srv/marina');
    const src = await taskWithConversation();
    const res = await transferTask({ taskId: src, host: 'devbox', cwd: '/srv/fresh-copy', mode: 'brief' });
    expect(res.target.cwd).toBe('/srv/fresh-copy');
    const message = String(edges.starts[0].message);
    expect(message).toContain('Set it up at /srv/fresh-copy');
    expect(message).not.toContain('already has it at /srv/marina');
  });
});
