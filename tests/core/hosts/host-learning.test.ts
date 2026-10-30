/**
 * host-learning: Walnut describes each execution host from the sessions that
 * ran there, the way project-summary describes each project. Pinned:
 *   - only sessions on that host with a self-reported overview count
 *   - regenerated on threshold crossings, never between them
 *   - the prompt carries the probe, the user's note, the previous summary and
 *     the newest sessions; the result lands on the profile as `learned`
 *   - a session's recap event schedules its host (debounced) and nothing else
 *   - a failed or empty generation stores nothing
 *
 * Real: host profiles and the session store on a temp WALNUT_HOME, the event
 * bus. Fake: sendMessage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('host-learning'));

const sendMessageMock = vi.fn();
vi.mock('../../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
vi.mock('../../../src/core/cheap-model.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => false,
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { maybeLearnHost, runHostLearningCatchUp, startHostLearning, stopHostLearning } from '../../../src/core/hosts/host-learning.js';
import { readHostProfile, updateHostProfile } from '../../../src/core/hosts/host-profile.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import {
  createSessionRecord, updateSessionRecordConditionally, hostSessionsWithOverview, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import { closeDb } from '../../../src/core/session-db.js';

/** One session row; `overview: ''` is a session that never reported. */
async function session(i: number, host: string | undefined, overview = `Worked on part ${i} of the marina build.`): Promise<void> {
  const sid = `s-${host ?? 'local'}-${i}`;
  await createSessionRecord(sid, '', 'marina', '/home/dev/src/marina', { title: `Marina task ${i}`, ...(host ? { host } : {}) });
  // An explicit activity time: a plain update stamps "now", and rows written in
  // the same millisecond would tie.
  await updateSessionRecordConditionally(sid, overview ? { overview } : {}, () => true,
    { setLastActiveAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
}
async function sessions(...rows: Array<[number, string | undefined, string?]>): Promise<void> {
  for (const [i, host, overview] of rows) await session(i, host, overview);
}
const reply = (text: string) => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(reply('{"summary":"Builds and tests the marina service."}'));
  process.env.WALNUT_HOST_LEARNING_DEBOUNCE_MS = '0';
});
afterEach(() => {
  stopHostLearning();
  closeDb();
  _resetSessionTrackerForTesting();
  delete process.env.WALNUT_HOST_LEARNING_DEBOUNCE_MS;
});

describe('which sessions teach Walnut about a host', () => {
  it('only that host, only sessions that said what they did, newest first', async () => {
    await sessions([1, 'devbox'], [2, 'devbox', ''], [3, 'other'], [4, undefined], [5, 'devbox']);
    const devbox = await hostSessionsWithOverview('devbox', 30);
    expect(devbox.count).toBe(2);
    expect(devbox.sessions.map((s) => s.claudeSessionId)).toEqual(['s-devbox-5', 's-devbox-1']);
    expect(devbox.sessions[0]).toMatchObject({ cwd: '/home/dev/src/marina', title: 'Marina task 5', overview: 'Worked on part 5 of the marina build.' });
    // A session with no host ran on this Mac.
    expect((await hostSessionsWithOverview('__local__', 30)).sessions.map((s) => s.claudeSessionId)).toEqual(['s-local-4']);
    // The limit bounds the lines, never the count.
    expect(await hostSessionsWithOverview('devbox', 1)).toMatchObject({ count: 2, sessions: [{ claudeSessionId: 's-devbox-5' }] });
  });
});

describe('maybeLearnHost', () => {
  it('writes the description from the probe, the note, the previous summary and the sessions', async () => {
    await updateHostProfile('devbox', (p) => {
      p.userNote = 'Use the build cache in /data';
      p.probed = { os: { platform: 'linux', release: '6', prettyName: 'Ubuntu 24.04' }, arch: 'arm64', home: '/home/dev', tools: { git: '2.43', docker: null } } as never;
      p.learned = { summary: 'Runs marina builds.', sessionCount: 1, at: '2026-10-01T00:00:00.000Z' };
    });
    await sessions([1, 'devbox'], [2, 'devbox']);
    expect(await maybeLearnHost('devbox')).toBe(true);

    const prompt = String(sendMessageMock.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain('Ubuntu 24.04 arm64');
    expect(prompt).toContain('Tools found: git.');
    expect(prompt).toContain("The user's note: Use the build cache in /data");
    expect(prompt).toContain('Previous summary:\nRuns marina builds.');
    expect(prompt.indexOf('Marina task 2')).toBeLessThan(prompt.indexOf('Marina task 1'));
    expect(sendMessageMock.mock.calls[0][0].purpose).toBe('background');

    const p = await readHostProfile('devbox');
    expect(p.learned).toMatchObject({ summary: 'Builds and tests the marina service.', sessionCount: 2 });
    expect(p.userNote).toBe('Use the build cache in /data');
  });

  it('between thresholds the model is not called', async () => {
    await updateHostProfile('devbox', (p) => { p.learned = { summary: 'x', sessionCount: 4, at: 'x' }; });
    for (const i of [1, 2, 3, 4, 5, 6, 7]) await session(i, 'devbox');
    expect(await maybeLearnHost('devbox')).toBe(false);
    await session(8, 'devbox');
    expect(await maybeLearnHost('devbox')).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('a host with no sessions, a bad reply, or a failed call stores nothing', async () => {
    expect(await maybeLearnHost('devbox')).toBe(false);
    await session(1, 'devbox');
    sendMessageMock.mockResolvedValueOnce(reply('not json'));
    expect(await maybeLearnHost('devbox')).toBe(false);
    sendMessageMock.mockRejectedValue(new Error('offline'));
    expect(await maybeLearnHost('devbox')).toBe(false);
    expect((await readHostProfile('devbox')).learned).toBeUndefined();
  });

  it('a call cut off by its deadline (a busy local model) is a quiet skip, not a parse failure', async () => {
    // 2026-10-30: "JSON Parse error: Unexpected EOF" on every run while Ollama was busy.
    const { log } = await import('../../../src/logging/index.js');
    const warn = vi.spyOn(log.session, 'warn');
    const info = vi.spyOn(log.session, 'info');
    await session(1, 'devbox');
    sendMessageMock.mockResolvedValueOnce({ content: [], stopReason: null, aborted: true });
    expect(await maybeLearnHost('devbox')).toBe(false);
    expect(warn.mock.calls.map((c) => c[0])).not.toContain('host-learning: generation failed');
    expect(info.mock.calls.map((c) => c[0])).toContain('host-learning: skipped, the model was busy');
    expect((await readHostProfile('devbox')).learned).toBeUndefined();
    // The next pass gets its answer and stores it.
    expect(await maybeLearnHost('devbox')).toBe(true);
    warn.mockRestore(); info.mockRestore();
  });

  it('the catch-up pass learns every host that has sessions', async () => {
    await sessions([1, 'devbox'], [2, undefined], [3, 'other', '']);
    expect(await runHostLearningCatchUp()).toBe(2);
    expect((await readHostProfile('devbox')).learned?.sessionCount).toBe(1);
    expect((await readHostProfile('__local__')).learned?.sessionCount).toBe(1);
    expect((await readHostProfile('other')).learned).toBeUndefined();
  });
});

describe('the background maintainer', () => {
  it('a session recap schedules its own host', async () => {
    await sessions([1, 'devbox'], [2, 'other']);
    startHostLearning();
    bus.emit(EventNames.SESSION_RECAP_UPDATED, { sessionId: 's-devbox-1', taskId: 't1' }, ['web-ui'], { source: 'test' });
    await vi.waitFor(async () => expect((await readHostProfile('devbox')).learned).toBeDefined(), { timeout: 3000 });
    expect((await readHostProfile('other')).learned).toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
