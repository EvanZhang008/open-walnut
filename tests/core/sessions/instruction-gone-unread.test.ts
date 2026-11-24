/**
 * A part of the default instructions is told gone only when it is (2026-11-24: 39 sessions were told
 * in one night that the user's whole profile "is gone; none of its lines apply any more", and 42
 * that their Threads rules were, while neither had changed: the host replica on a dev box holds no
 * USER.md, and the Mac's first seconds after a restart had not read it or the Threads switch).
 *
 * - every kind of versioned block names the source its absence is read against (block-sources.ts),
 *   so a new kind cannot be told gone from a source nobody read;
 * - with USER.md unchanged, no session is told its profile or Threads rules are gone: not before
 *   the server read them, not on a replica that holds no copy;
 * - a real removal (USER.md deleted on the leader) is still told;
 * - a session that was told a part is gone, and the part is still there, is told it still applies,
 *   once.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instruction-gone-unread'));
import { USER_FILE, WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { BLOCK_KIND_IDS, hash, parseInstructions } from '../../../src/core/sessions/instruction-diff.js';
import { BLOCK_SOURCE_READ } from '../../../src/core/sessions/block-sources.js';
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js';
import { buildSessionContext } from '../../../src/core/sessions/session-context.js';
import { _resetUserProfileForTesting, refreshUserProfile } from '../../../src/core/sessions/user-profile-context.js';
import { _resetThreadsForEveryTaskForTesting, setThreadsForEveryTask } from '../../../src/core/org/keeps-threads.js';
import { FACT_INLINE_CAP } from '../../../src/core/session-channel/fact-log.js';
import { updateConfig } from '../../../src/core/config-manager.js';
import type { Config, SessionRecord, Task } from '../../../src/core/types.js';

const GONE = /A part of your instructions \(v[0-9a-f]{8}\) is gone/;

async function writeUser(): Promise<void> {
  await fs.mkdir(path.dirname(USER_FILE), { recursive: true });
  await fs.writeFile(USER_FILE, '---\nname: User Profile\n---\n\n## Standing rules\n- Never make sound on his machines.\n- Reply in Chinese.\n');
  await refreshUserProfile();
}

type Rec = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine' | 'lastCompactUuid' | 'lastCompactAt' | 'taskRoutingNoted' | 'judge'>;

/** A session spawned on the current instructions, with the profile and the Threads rules read. */
async function spawned(): Promise<{ task: Task; record: Rec }> {
  const { task } = await addTask({ title: 'Gone check' });
  const prompt = (await buildSessionContext(task.id)).systemPrompt;
  const blocks = parseInstructions(prompt).blocks;
  // The prompt holds both parts this test is about.
  expect(blocks.has('user-profile')).toBe(true);
  expect(blocks.has('task-threads')).toBe(true);
  return { task, record: { appliedAppendSystemPrompt: prompt } as Rec };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await writeUser();
  // Every task keeps Threads (the experiment task_threads), as on the night of the report.
  await updateConfig({ experimental: { task_threads: true } } as Partial<Config>);
  setThreadsForEveryTask(true);
});

afterEach(() => {
  delete process.env.WALNUT_HOST_SERVER;
});

describe('every kind of versioned block names the source it is told gone against', () => {
  it('BLOCK_SOURCE_READ covers BLOCK_KIND_IDS', () => {
    // A new kind of block: name what its absence is read against in block-sources.ts.
    expect(BLOCK_KIND_IDS.filter((id) => !(id in BLOCK_SOURCE_READ))).toEqual([]);
  });
});

describe('USER.md unchanged: no session is told its profile or Threads rules are gone', () => {
  it('nothing is due on the server that read every input', async () => {
    const { task, record } = await spawned();
    expect(instructionNoticeFor(record, task)).toBeNull();
  });

  it('before the server read USER.md (the first seconds after a restart)', async () => {
    const { task, record } = await spawned();
    _resetUserProfileForTesting();
    expect(instructionNoticeFor(record, task) ?? '').not.toMatch(GONE);
    expect(instructionNoticeFor(record, task, { ignoreTold: true }) ?? '').not.toMatch(GONE);
  });

  it('before the status sync read the Threads switch', async () => {
    const { task, record } = await spawned();
    _resetThreadsForEveryTaskForTesting();
    expect(instructionNoticeFor(record, task) ?? '').not.toMatch(GONE);
    expect(instructionNoticeFor(record, task, { ignoreTold: true }) ?? '').not.toMatch(GONE);
  });

  it('on a host replica, which holds no USER.md, no Reply language and no copy of the switch', async () => {
    const { task, record } = await spawned();
    process.env.WALNUT_HOST_SERVER = '1';
    await fs.rm(USER_FILE, { force: true });
    await refreshUserProfile();
    _resetThreadsForEveryTaskForTesting();
    expect(instructionNoticeFor(record, task) ?? '').not.toMatch(GONE);
    expect(instructionNoticeFor(record, task, { ignoreTold: true }) ?? '').not.toMatch(GONE);
  });

  it('a real removal on the leader is still told: USER.md deleted', async () => {
    const { task, record } = await spawned();
    await fs.rm(USER_FILE, { force: true });
    await refreshUserProfile();
    expect(instructionNoticeFor(record, task)).toMatch(GONE);
  });
});

describe('a session told a part is gone that is still there hears it still applies', () => {
  it('restates the part whole with the line saying so, once', async () => {
    const { task, record } = await spawned();
    const profile = parseInstructions(record.appliedAppendSystemPrompt!).blocks.get('user-profile')!;
    // What the night's false notice recorded: the part at its version, with no words.
    const told: Rec = { ...record, taskRoutingNoted: {
      version: 'x', promptHash: hash(record.appliedAppendSystemPrompt!), lines: [],
      blocks: { 'user-profile': { version: profile.version, words: [] } }, toldAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    } };
    const notice = instructionNoticeFor(told, task)!;
    expect(notice).toContain(`An earlier notice said this part of your instructions (${profile.version}) was gone. It was not: it still applies`);
    expect(notice).toContain('Never make sound on his machines.');
    // Told whole now: nothing more is due for it.
    const after: Rec = { ...told, taskRoutingNoted: { ...told.taskRoutingNoted!,
      blocks: { 'user-profile': { version: profile.version, words: profile.words, form: profile.form } } } };
    expect(instructionNoticeFor(after, task)).toBeNull();
  });

  it('the restatement after a compaction says so too', async () => {
    const { task, record } = await spawned();
    const profile = parseInstructions(record.appliedAppendSystemPrompt!).blocks.get('user-profile')!;
    const told: Rec = { ...record, taskRoutingNoted: {
      version: 'x', promptHash: hash(record.appliedAppendSystemPrompt!), lines: [],
      blocks: { 'user-profile': { version: profile.version, words: [], gone: true } }, toldAt: new Date().toISOString(),
    } };
    expect(instructionNoticeFor(told, task, { ignoreTold: true })).toContain('It was not: it still applies');
  });
});

describe('a host row whose stored prompt an older host log cut', () => {
  it('reads as an unknown prompt, never as rules dropped past the cut', async () => {
    const { task, record } = await spawned();
    const long = record.appliedAppendSystemPrompt!.padEnd(FACT_INLINE_CAP + 5_000, '\nA rule kept past the cut, which the session holds.');
    const cut: Rec = { ...record, judge: 'host', appliedAppendSystemPrompt: long.slice(0, FACT_INLINE_CAP) };
    expect(instructionNoticeFor(cut, task)).toBeNull();
  });
});
