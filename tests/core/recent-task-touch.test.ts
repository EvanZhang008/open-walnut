/** Only a person's action joins the shared list; all agent sources leave it byte-identical. */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-recent-touch'));
import { WALNUT_HOME, UI_PREFS_FILE } from '../../src/constants.js';
import { recordRecentTaskTouch } from '../../src/core/recent-task-touch.js';
import { RECENT_OPENED_KEY, parseRecentOpened } from '../../src/core/recent-opened-list.js';
import { withTestRun } from '../../src/core/test-run.js';
import { _resetTestRunPrefsForTest } from '../../src/core/test-run-prefs.js';
import { PERSON_SEND_SOURCES, PERSON_START_SOURCES } from '../../src/core/sessions/send-sent-by.js';
const read = async () => parseRecentOpened(JSON.parse(await fs.readFile(UI_PREFS_FILE, 'utf8'))[RECENT_OPENED_KEY].v);
beforeEach(async () => { _resetTestRunPrefsForTest(); await fs.mkdir(WALNUT_HOME, { recursive: true }); });
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
describe('recent human touches', () => {
  it('every person send and start source counts, but background writes cannot add or reorder', async () => {
    const sources = [...PERSON_SEND_SOURCES, ...PERSON_START_SOURCES, 'human-inbox', 'side-thread', 'cloud-fallback'];
    for (const [i, source] of sources.entries()) await recordRecentTaskTouch(source, source, new Date(1000 + i).toISOString());
    const before = await fs.readFile(UI_PREFS_FILE, 'utf8');
    for (const source of ['api-agent', 'api-agent-cli', 'routine', 'cron', 'trigger', 'peer-message', 'session', 'heartbeat', 'hook', undefined]) {
      await recordRecentTaskTouch('agent-only', source);
      await recordRecentTaskTouch(sources[0], source);
      expect(await fs.readFile(UI_PREFS_FILE, 'utf8'), source).toBe(before);
    }
    expect((await read()).map((e) => e.id)).toEqual(sources.reverse());
  });
  it('agent rows rejected even if marked as human do not change an existing list', async () => {
    await recordRecentTaskTouch('mine', 'ui');
    const before = await fs.readFile(UI_PREFS_FILE, 'utf8');
    await recordRecentTaskTouch('mine', 'api-agent', new Date(Date.now() + 1000).toISOString());
    expect(await fs.readFile(UI_PREFS_FILE, 'utf8')).toBe(before);
  });
  it('a test run human touch never changes the real preference file', async () => {
    await recordRecentTaskTouch('mine', 'ui');
    const before = await fs.readFile(UI_PREFS_FILE, 'utf8');
    await withTestRun('recent-fixture', () => recordRecentTaskTouch('test-human', 'ui'));
    expect(await fs.readFile(UI_PREFS_FILE, 'utf8')).toBe(before);
  });
  it('parallel devices keep both; a stale retry cannot move an existing row backward', async () => {
    await Promise.all([
      recordRecentTaskTouch('phone', 'mobile', '2026-11-09T20:00:01Z'),
      recordRecentTaskTouch('mac', 'ui', '2026-11-09T20:00:02Z'),
    ]);
    await recordRecentTaskTouch('mac', 'ui', '2026-11-09T19:00:00Z');
    expect(await read()).toEqual([{ id: 'mac', at: '2026-11-09T20:00:02Z', human: true }, { id: 'phone', at: '2026-11-09T20:00:01Z', human: true }]);
  });
});
