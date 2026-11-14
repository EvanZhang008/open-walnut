import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-secret-writer'));
import { WALNUT_HOME } from '../../src/constants.js';
import { agentReply, listLetters, sendLetter } from '../../src/core/human-inbox/store.js';
import * as tracker from '../../src/core/session-tracker.js';
import * as delivery from '../../src/core/sessions/session-send-core.js';
import { holdStagedSecrets, setSecretHoldNotifierForTest, type SecretHoldNotice } from '../../src/integrations/git-sync-secrets.js';
import { notifySecretHoldWriter, readSecretHoldSummaries, secretFileWriter } from '../../src/integrations/git-sync-secret-notices.js';
import type { SessionRecord } from '../../src/core/types.js';

const git = async (args: string[], input?: string) => execFileSync('git', args, { cwd: WALNUT_HOME, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const fakeKey = () => ['GOC', 'SPX-', 'aB3_dE5-fG7_hI9-jK1_lM2-nO4Q'].join('');
const sender = { sessionId: 'writer-session', taskId: 'gone-task', host: 'devbox' };
let sent: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.net']);
  await git(['commit', '--allow-empty', '-qm', 'Initial']);
  setSecretHoldNotifierForTest(null);
  vi.spyOn(tracker, 'getSessionByClaudeId').mockImplementation(async (sid) => sid === 'writer-session' || sid === 'reply-session'
    ? { claudeSessionId: sid, taskId: sid === 'writer-session' ? 'gone-task' : 'reply-task' } as SessionRecord : null);
  // Only the CLI transport is stubbed. Git, letter provenance and disk storage are real.
  sent = vi.spyOn(delivery, 'deliverToSession').mockResolvedValue({ delivery: 'queued' });
});
afterEach(async () => {
  setSecretHoldNotifierForTest(null);
  vi.restoreAllMocks();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function stageLegacyBody(): Promise<{ file: string; key: string }> {
  const letter = await sendLetter({ subject: 'Connect storage', type: 'review', markdown: 'Step 1\nStep 2\nStep 3', sender });
  const file = `human-inbox/bodies/${letter.id}.md`;
  const key = fakeKey();
  await fs.writeFile(path.join(WALNUT_HOME, file), `Step 1\nClient secret: ${key}\nStep 3`);
  await git(['add', '-A']);
  return { file, key };
}

describe('private data holds go to the writer, never the person', () => {
  it('the legacy letter body is held, its writer gets file/line/kind, no user letter is sent, and later scans do not repeat', async () => {
    const { file, key } = await stageLegacyBody();
    expect(await holdStagedSecrets(git, WALNUT_HOME)).toEqual([file]);
    expect((await listLetters()).letters).toHaveLength(1);
    expect(sent).toHaveBeenCalledTimes(1);
    const [record, opts] = sent.mock.calls[0];
    expect(record.claudeSessionId).toBe(sender.sessionId);
    expect(opts).toMatchObject({ source: 'walnut-notify', taskId: 'gone-task' });
    expect(opts.enqueueText).toContain(path.join(WALNUT_HOME, file));
    expect(opts.enqueueText).toContain('google-oauth-secret (line 2)');
    expect(opts.enqueueText).toContain('private data folder, not the Walnut code repository');
    expect(opts.enqueueText).toContain('not sent anywhere');
    expect(opts.enqueueText).not.toContain(key);
    expect(await fs.readFile(path.join(WALNUT_HOME, file), 'utf8')).toContain(key);
    expect(await git(['diff', '--cached', '--name-only'])).not.toContain(file);
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).toHaveBeenCalledTimes(1);
    expect((await listLetters()).letters).toHaveLength(1);
    expect(await readSecretHoldSummaries()).toEqual([{ file: path.join(WALNUT_HOME, file), kinds: ['google-oauth-secret'], lines: [2], since: expect.any(String) }]);
  });

  it('a rich reply is attributed to its own writer and an old unattributed reply never borrows the original sender', async () => {
    const l = await sendLetter({ subject: 'Original', type: 'review', markdown: 'Clean', sender });
    const reply = await agentReply(l.id, { text: 'Details', markdown: 'Reply body' }, { sender: { sessionId: 'reply-session', taskId: 'reply-task' } });
    const body = reply.thread[0].bodyFile!;
    expect(await secretFileWriter(`human-inbox/bodies/${body}`)).toMatchObject({ sessionId: 'reply-session' });
    const unowned = await agentReply(l.id, { text: 'Old', markdown: 'Old body' });
    expect(await secretFileWriter(`human-inbox/bodies/${unowned.thread[1].bodyFile}`)).toBeUndefined();
    const notice: SecretHoldNotice = { event: 'set-aside', files: [{ file: `human-inbox/bodies/${body}`, hold: { kinds: ['private-key'], lines: [4], since: 'now', tracked: true } }], aside: 'local/preserved.md', op: 'aside-1', root: WALNUT_HOME };
    await notifySecretHoldWriter(notice);
    expect(sent.mock.calls[0][0].claudeSessionId).toBe('reply-session');
    expect(sent.mock.calls[0][1].enqueueText).toContain(path.join(WALNUT_HOME, 'local/preserved.md'));
  });

  it('unknown writers leave quiet Health details, keep the file and produce neither a message nor an inbox letter', async () => {
    const file = 'notes/unknown.md';
    await fs.mkdir(path.join(WALNUT_HOME, 'notes'));
    await fs.writeFile(path.join(WALNUT_HOME, file), fakeKey());
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).not.toHaveBeenCalled();
    expect((await listLetters()).letters).toEqual([]);
    expect((await readSecretHoldSummaries())[0]).toMatchObject({ file: path.join(WALNUT_HOME, file) });
    await fs.writeFile(path.join(WALNUT_HOME, file), 'The credential is in Settings.');
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(await readSecretHoldSummaries()).toEqual([]);
  });

  it('one failed file never repeats a successful writer notice from the same stage', async () => {
    const a = await stageLegacyBody();
    const b = await stageLegacyBody();
    sent.mockImplementation(async (_record, opts) => {
      if (opts.enqueueText.includes(b.file)) throw new Error('Host offline');
      return { delivery: 'queued' };
    });
    await holdStagedSecrets(git, WALNUT_HOME);
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent.mock.calls.filter(([, opts]) => opts.enqueueText.includes(a.file))).toHaveLength(1);
    expect(sent.mock.calls.filter(([, opts]) => opts.enqueueText.includes(b.file))).toHaveLength(2);
  });

  it('area sessions are not woken, and more than twenty unknown held files remain visible in Health', async () => {
    const { file } = await stageLegacyBody();
    vi.spyOn(tracker, 'getSessionByClaudeId').mockResolvedValue({ claudeSessionId: sender.sessionId, profile: { areaId: 'area-x' } } as SessionRecord);
    await fs.mkdir(path.join(WALNUT_HOME, 'notes'));
    for (let i = 0; i < 25; i++) await fs.writeFile(path.join(WALNUT_HOME, `notes/unknown-${i}.md`), fakeKey());
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).not.toHaveBeenCalled();
    expect((await readSecretHoldSummaries()).length).toBe(26);
    expect((await readSecretHoldSummaries()).some((s) => s.file === path.join(WALNUT_HOME, file))).toBe(true);
  });

  it('a preserved sidecar survives in Health and retries a failed writer notice on the next stage', async () => {
    const { file } = await stageLegacyBody();
    await holdStagedSecrets(git, WALNUT_HOME);
    // Emulate the already-preserved copy after a merge, as a persisted older hold.
    const aside = `${file}.conflicted-secret-test`;
    await fs.rename(path.join(WALNUT_HOME, file), path.join(WALNUT_HOME, aside));
    await fs.writeFile(path.join(WALNUT_HOME, file), 'Incoming clean body');
    await fs.writeFile(path.join(WALNUT_HOME, '.gitignore'), '*.conflicted-*\n');
    const store = { version: 2, holds: { [aside]: { kinds: ['google-oauth-secret'], lines: [2], tracked: false, since: 'now', asideOf: file, letterOp: 'aside-once', writerNotified: false } } };
    await fs.writeFile(path.join(WALNUT_HOME, '.git/walnut-secret-holds.json'), JSON.stringify(store));
    sent.mockClear().mockRejectedValueOnce(new Error('Host offline'));
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect((await readSecretHoldSummaries())[0].file).toBe(path.join(WALNUT_HOME, aside));
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][1].enqueueText).toContain('sidecar never syncs');
  });

  it('old hold records are delivered once after an upgrade, and delivery failure retries with a stable message id', async () => {
    const { file } = await stageLegacyBody();
    await fs.writeFile(path.join(WALNUT_HOME, '.git/walnut-secret-holds.json'), JSON.stringify({ version: 2, holds: { [file]: { kinds: ['google-oauth-secret'], lines: [2], tracked: false, since: '2026-11-12T00:00:00Z', letterOp: 'git-sync-secret-hold:old' } } }));
    sent.mockRejectedValueOnce(new Error('Transport unavailable'));
    await holdStagedSecrets(git, WALNUT_HOME);
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[0][1].messageId).toBe(sent.mock.calls[1][1].messageId);
    await git(['add', '-A']);
    await holdStagedSecrets(git, WALNUT_HOME);
    expect(sent).toHaveBeenCalledTimes(2);
    expect((await listLetters()).letters).toHaveLength(1);
  });
});
