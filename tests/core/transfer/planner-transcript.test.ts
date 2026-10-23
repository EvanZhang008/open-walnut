import { describe, it, expect } from 'vitest';
import { planTransfer, transferOptions, TransferError } from '../../../src/core/transfer/planner.js';
import { renderTranscriptMarkdown, renderTranscriptMarkdownChunked, renderTranscriptSeed } from '../../../src/core/transfer/transcript.js';
import type { SessionRecord, Task } from '../../../src/core/types.js';
import type { SessionHistoryMessage } from '../../../src/core/session-history.js';

const task = { id: 'task-1', title: 'Fix the parser', cwd: '/work/repo', phase: 'IN_PROGRESS' } as unknown as Task;
const claudeSession = {
  claudeSessionId: 's-1', taskId: 'task-1', project: '', process_status: 'idle', mode: 'default',
  startedAt: '', lastActiveAt: '', messageCount: 3, cwd: '/work/repo',
} as SessionRecord;
const hosts = new Set(['devbox', 'cloud']);

describe('planning a transfer', () => {
  it('Claude to Claude on another host copies the transcript and moves the workspace', () => {
    const plan = planTransfer(task, claudeSession, { taskId: 'task-1', host: 'devbox' }, hosts);
    expect(plan.history).toBe('native-copy');
    expect(plan.moveWorkspace).toBe(true);
    expect(plan.target.cwd).toBe('auto');
  });

  it('Claude to Codex on this machine replays the conversation and keeps the directory', () => {
    const plan = planTransfer(task, claudeSession, { taskId: 'task-1', engine: 'codex' }, hosts);
    expect(plan.history).toBe('replay');
    expect(plan.moveWorkspace).toBe(false);
    expect(plan.target).toMatchObject({ engine: 'codex', host: '__local__', cwd: '/work/repo' });
  });

  it('Codex back to Claude replays (the Codex journal is not a Claude transcript)', () => {
    const codex = { ...claudeSession, engine: 'codex' } as SessionRecord;
    expect(planTransfer(task, codex, { taskId: 'task-1', engine: 'claude' }, hosts).history).toBe('replay');
  });

  it('brief mode always writes a brief', () => {
    expect(planTransfer(task, claudeSession, { taskId: 'task-1', host: 'cloud', mode: 'brief' }, hosts).history).toBe('brief');
  });

  it('the same harness keeps the source\'s model, effort and permissions; another harness keeps only the permissions', () => {
    const src = { ...claudeSession, cliModel: 'opus[1m]', effort: 'high', mode: 'plan' } as SessionRecord;
    expect(planTransfer(task, src, { taskId: 'task-1', host: 'devbox' }, hosts).target)
      .toMatchObject({ model: 'opus[1m]', effort: 'high', permissionMode: 'plan' });
    const other = planTransfer(task, src, { taskId: 'task-1', engine: 'codex' }, hosts).target;
    expect(other).toMatchObject({ engine: 'codex', permissionMode: 'plan' });
    expect(other.model).toBeUndefined();
    expect(other.effort).toBeUndefined();
  });

  it('picks win over the source, and an ACP harness never takes a separate effort', () => {
    const src = { ...claudeSession, cliModel: 'opus[1m]', effort: 'high', mode: 'plan' } as SessionRecord;
    expect(planTransfer(task, src, { taskId: 'task-1', host: 'devbox', model: 'default', effort: 'low', permissionMode: 'accept' }, hosts).target)
      .toMatchObject({ model: 'default', effort: 'low', permissionMode: 'accept' });
    expect(planTransfer(task, src, { taskId: 'task-1', engine: 'codex', effort: 'low' }, hosts).target.effort).toBeUndefined();
  });

  it('a model change alone in the same place is a transfer', () => {
    expect(planTransfer(task, claudeSession, { taskId: 'task-1', model: 'sonnet' }, hosts).target.model).toBe('sonnet');
  });

  it('refuses an unknown effort or permission mode', () => {
    expect(() => planTransfer(task, claudeSession, { taskId: 'task-1', engine: 'codex', effort: 'huge' as never }, hosts)).toThrow(TransferError);
    expect(() => planTransfer(task, claudeSession, { taskId: 'task-1', engine: 'codex', permissionMode: 'yolo' as never }, hosts)).toThrow(TransferError);
  });

  it('refuses Codex on a remote host with a reason the UI can show', () => {
    expect(() => planTransfer(task, claudeSession, { taskId: 'task-1', engine: 'codex', host: 'devbox' }, hosts))
      .toThrow(/runs on this machine only/);
  });

  it('refuses a transfer that changes nothing, an unknown host, and a relative directory', () => {
    const codes = (req: Parameters<typeof planTransfer>[2]) => {
      try { planTransfer(task, claudeSession, req, hosts); return 'ok'; } catch (e) { return (e as TransferError).code; }
    };
    expect(codes({ taskId: 'task-1' })).toBe('nothing_to_transfer');
    expect(codes({ taskId: 'task-1', host: 'nope' })).toBe('unknown_host');
    expect(codes({ taskId: 'task-1', host: 'devbox', cwd: 'relative/path' })).toBe('bad_cwd');
    expect(codes({ taskId: 'task-1', cwd: '/work/other' })).toBe('ok');
    // A trailing slash names the same directory, so it changes nothing either.
    expect(codes({ taskId: 'task-1', cwd: '/work/repo/' })).toBe('nothing_to_transfer');
    expect(planTransfer(task, claudeSession, { taskId: 'task-1', cwd: '/work/other/' }, hosts).target.cwd).toBe('/work/other');
  });

  it('lists every engine and host pair, blocking ACP engines off this machine', () => {
    const options = transferOptions(['claude', 'codex'], ['devbox']);
    expect(options).toEqual([
      { engine: 'claude', host: '__local__' },
      { engine: 'claude', host: 'devbox' },
      { engine: 'codex', host: '__local__' },
      { engine: 'codex', host: 'devbox', blockedReason: expect.stringContaining('this machine only') },
    ]);
  });
});

function msg(role: SessionHistoryMessage['role'], text: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage {
  return { role, text, timestamp: '2026-10-20T10:00:00Z', ...extra };
}

describe('rendering a conversation for another engine', () => {
  const history: SessionHistoryMessage[] = [
    msg('user', 'Make the parser accept trailing commas'),
    msg('assistant', 'Looking at the parser.', {
      tools: [{ name: 'Bash', input: { command: 'npm test -- parser' }, result: 'FAIL 2 tests', isError: true }],
    }),
    msg('user', 'skill text dumped by the CLI', { injected: true }),
    msg('assistant', 'Fixed it in src/parser.ts.', { thinking: 'private scratch', tools: [{ name: 'Edit', input: { file_path: 'src/parser.ts' } }] }),
    msg('user', 'Now add a test'),
    msg('assistant', 'Added tests/parser.test.ts.'),
  ];

  it('the full transcript keeps tools and drops thinking', () => {
    const md = renderTranscriptMarkdown(history, { title: 'Parser', engine: 'Claude', host: 'this Mac', cwd: '/work/repo' });
    expect(md).toContain('**User:**\nMake the parser accept trailing commas');
    expect(md).toContain('- Bash: npm test -- parser (failed)\n  → FAIL 2 tests');
    expect(md).toContain('- Edit: src/parser.ts');
    expect(md).toContain('Context (not typed by the user)');
    expect(md).not.toContain('private scratch');
    expect(md).toContain('Turns: 2.');
  });

  it('the seed keeps the first ask and the newest turns, and says what it left out', () => {
    const long: SessionHistoryMessage[] = [msg('user', 'Goal: ship the parser')];
    for (let i = 0; i < 40; i++) {
      long.push(msg('user', `step ${i} ${'x'.repeat(200)}`));
      long.push(msg('assistant', `done ${i}`));
    }
    const seed = renderTranscriptSeed(long, 3_000);
    expect(seed.text.startsWith('**User:**\nGoal: ship the parser')).toBe(true);
    expect(seed.text).toContain('step 39');
    expect(seed.text).not.toContain('step 0 ');
    expect(seed.omittedTurns).toBeGreaterThan(0);
    expect(seed.text).toMatch(/\d+ earlier turns left out here/);
    expect(seed.text.length).toBeLessThanOrEqual(3_200);
  });

  it('the sliced render matches the one-pass render', async () => {
    const meta = { title: 'Parser', engine: 'Claude', host: 'this Mac' };
    const many: SessionHistoryMessage[] = [];
    for (let i = 0; i < 450; i++) many.push(msg(i % 2 ? 'assistant' : 'user', `line ${i}`));
    expect(await renderTranscriptMarkdownChunked(many, meta, 100)).toBe(renderTranscriptMarkdown(many, meta));
  });

  it('an empty conversation renders an empty seed', () => {
    expect(renderTranscriptSeed([], 1000)).toEqual({ text: '', omittedTurns: 0, keptTurns: 0 });
  });
});
