/**
 * A task the user wrote in is found by his own words (user-asks personWordsText in the task's search
 * document), however far its session transcript's indexed tail has moved past them.
 *
 * 2026-11-18: he could not find the task he had worked a stack rollback and an account permission in
 * the day before. Its title named only the pipelines it watched, and its 484 MB transcript was
 * indexed from its last 4 MB: five hours of trigger traffic, none of his words.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventBus, EventNames } from '../../src/core/event-bus.js';
import { addTask } from '../../src/core/task-manager.js';
import { prepareUserAskCapture } from '../../src/core/sessions/user-asks.js';
import { getSearchV2Index, resetSearchV2IndexForTests, startSearchV2Wiring, type SearchV2Wiring } from '../../src/core/search/wiring.js';
import { search } from '../../src/core/search.js';
import { queryTerms, serverRowShowsQuery } from '../../web/src/components/tasks/search-relevance.js';

beforeAll(() => { process.env.WALNUT_SEARCH_V2_SEMANTIC = '0'; });
afterAll(() => { delete process.env.WALNUT_SEARCH_V2_SEMANTIC; resetSearchV2IndexForTests(); });

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: timeoutMs, interval: 100 });
}

/** The web task list's reading of the server's answer: the task shows up, as a hit that shows the query. */
async function findsTask(query: string, taskId: string): Promise<boolean> {
  const terms = queryTerms(query);
  const rows = await search(query, { types: ['task', 'session'], limit: 80 });
  return rows.some((r) => r.taskId === taskId && serverRowShowsQuery(r, terms));
}

describe('a task is found by what the user wrote in it', () => {
  let wiring: SearchV2Wiring | undefined;
  afterEach(async () => { await wiring?.stop(); wiring = undefined; });

  it('his message, typos and all, finds the task whose title never says it', async () => {
    wiring = startSearchV2Wiring(new EventBus());
    const index = getSearchV2Index();
    // A summary of its own that never says the words: his words count from the note.
    const { task } = await addTask({ title: 'Pipeline watch leader: Ledger, Courier', project: 'marina', description: 'Watches the Ledger and Courier pipelines and reports each failed stage.' });
    const send = async (message: string) => (await prepareUserAskCapture({ task, message, inChat: true }))?.commit();

    await send('sorry forget that, can u acutally do the rest the vaultkep add permisison and then contineu rollabck for cfn');
    await waitFor(() => (index.getDoc('task', task.id)?.note ?? '').includes('rollabck'));
    expect(await findsTask('vaultkep permisison', task.id)).toBe(true);
    expect(await findsTask('rollabck cfn', task.id)).toBe(true);

    // A later message adds its words; the earlier ones stay.
    await send('for zrk what si thenext is the continue rollback done?');
    await waitFor(() => (index.getDoc('task', task.id)?.note ?? '').includes('zrk'));
    expect(await findsTask('zrk cfn rollback', task.id)).toBe(true);
    expect(await findsTask('vaultkep permisison', task.id)).toBe(true);
  });

  it('his passing words never outrank the task that is about them', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const index = getSearchV2Index();
    const { task: about } = await addTask({ title: 'Stack rollback runbook for the cfn widget stacks', project: 'marina' });
    const { task: chat } = await addTask({ title: 'Weekly chores list', project: 'marina', description: 'Groceries and errands.' });
    bus.emit(EventNames.TASK_CREATED, { task: about }, ['*'], { source: 'test' });
    await (await prepareUserAskCapture({ task: chat, message: 'remind me after the cfn rollback runbook is done', inChat: true }))?.commit();
    await waitFor(() => (index.getDoc('task', chat.id)?.note ?? '').includes('rollback') && index.getDoc('task', about.id) !== null);
    const rows = (await search('cfn rollback runbook', { types: ['task'], limit: 20 })).map((r) => r.taskId);
    expect(rows.indexOf(about.id)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(chat.id)).toBeGreaterThan(rows.indexOf(about.id));
  });

  it('a task he never wrote in is not found by words that are only in other tasks', async () => {
    wiring = startSearchV2Wiring(new EventBus());
    const { task } = await addTask({ title: 'Quiet unrelated pipeline task', project: 'marina' });
    expect(await findsTask('vaultkep permisison', task.id)).toBe(false);
  });
});
