/**
 * The first-paint view store keeps what the user opens (src/core/history-view-snapshot.ts).
 *
 * 2026-11-16: the store held 600 views ranked by write time while the background refresher kept
 * 645 recent sessions current, so a burst of its writes pushed out a session opened a few hours
 * earlier, and that open waited 11 s for its host. Pinned here: an open touches its view, the
 * prune ranks by last use and bounds bytes as well as files, and the default room covers every
 * session the refresher keeps current with a margin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, HISTORY_CACHE_DIR } from '../../src/constants.js';
import {
  _resetHistoryViewsForTesting, flushHistoryViewsForTesting, readHistoryView, saveHistoryView, beginHistoryViewRead,
  pruneHistoryViews, VIEW_MAX_FILES, VIEW_MAX_TOTAL_BYTES,
} from '../../src/core/history-view-snapshot.js';
import type { SessionHistoryMessage } from '../../src/core/session-history.js';

const viewsDir = path.join(HISTORY_CACHE_DIR as string, 'views');
const row = (text: string): SessionHistoryMessage => ({ role: 'assistant', text, timestamp: '', msgId: text }) as SessionHistoryMessage;
const file = (sid: string) => path.join(viewsDir, `${sid}.json`);
const ageBy = (sid: string, hours: number) => { const t = new Date(Date.now() - hours * 3600_000); fs.utimesSync(file(sid), t, t); };

async function keep(sid: string, text = `row of ${sid}`): Promise<void> {
  saveHistoryView(sid, { messages: [row(text)], total: 1 }, beginHistoryViewRead(sid));
  await flushHistoryViewsForTesting();
}

beforeEach(async () => { await fsp.mkdir(WALNUT_HOME as string, { recursive: true }); _resetHistoryViewsForTesting(); });
afterEach(async () => { _resetHistoryViewsForTesting(); await fsp.rm(WALNUT_HOME as string, { recursive: true, force: true }); });

describe('the view store keeps what the user opens', () => {
  it('a view opened after newer background writes outlives them at a prune', async () => {
    await keep('opened');
    ageBy('opened', 6);
    for (const sid of ['bg-1', 'bg-2', 'bg-3']) { await keep(sid); ageBy(sid, 1); }
    _resetHistoryViewsForTesting(); // a restart: memory is empty, the open reads the disk copy
    expect((await readHistoryView('opened'))?.messages).toHaveLength(1);
    await vi.waitFor(() => expect(Date.now() - fs.statSync(file('opened')).mtimeMs).toBeLessThan(60_000));
    await pruneHistoryViews({ maxFiles: 2 });
    expect(fs.existsSync(file('opened'))).toBe(true);
    expect(fs.readdirSync(viewsDir).filter((n) => n.endsWith('.json')).length).toBe(2);
  });

  it('an open from memory touches the disk copy too, at most once per window', async () => {
    await keep('hot');
    ageBy('hot', 6);
    expect(await readHistoryView('hot')).not.toBeNull();
    await vi.waitFor(() => expect(Date.now() - fs.statSync(file('hot')).mtimeMs).toBeLessThan(60_000));
    ageBy('hot', 6);
    await readHistoryView('hot');
    await new Promise((r) => setTimeout(r, 50));
    expect(Date.now() - fs.statSync(file('hot')).mtimeMs).toBeGreaterThan(5 * 3600_000);
  });

  it('the byte budget drops the least recently used views first', async () => {
    for (const [i, sid] of ['old', 'mid', 'new'].entries()) { await keep(sid, 'x'.repeat(10_000)); ageBy(sid, 3 - i); }
    const one = fs.statSync(file('new')).size;
    await pruneHistoryViews({ maxTotalBytes: one * 2 + 10 });
    expect(['old', 'mid', 'new'].map((sid) => fs.existsSync(file(sid)))).toEqual([false, true, true]);
    expect(fs.existsSync(path.join(viewsDir, 'old.meta'))).toBe(false);
  });

  it('the default room covers every recent session the refresher keeps current, with margin', () => {
    // 645 recent sessions on the maintainer's Mac (2026-11-16), views averaging 426 KB.
    expect(VIEW_MAX_FILES).toBeGreaterThanOrEqual(4 * 645);
    expect(VIEW_MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(2 * 645 * 426 * 1024);
  });
});
