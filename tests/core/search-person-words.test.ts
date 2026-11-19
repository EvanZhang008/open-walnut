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
import { refixPersonWords } from '../../src/core/search/build.js';
import { mergeUiPrefs } from '../../src/web/routes/ui-prefs.js';
import { RECENT_OPENED_KEY } from '../../src/core/recent-opened-list.js';
import { queryTerms, serverRowShowsQuery } from '../../web/src/components/tasks/search-relevance.js';

beforeAll(() => { process.env.WALNUT_SEARCH_V2_SEMANTIC = '0'; });
afterAll(() => { delete process.env.WALNUT_SEARCH_V2_SEMANTIC; resetSearchV2IndexForTests(); });

/** A word no earlier run made: the test home is shared across runs. */
function runWord(head: string): string {
  return `${head}${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
}

/** Wait on the state the sync leaves, never a fixed sleep (tests/core/fixed-sleep-wait-guard.test.ts). */
async function waitFor(check: () => boolean, timeout = 8_000): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout, interval: 100 });
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
    // Names of this run's own: the shared test home keeps every earlier run's tasks, and a word in
    // dozens of them crowds this one out.
    const [vault, zone] = [runWord('vault'), runWord('zr')];
    // A summary of its own that never says the words: his words count from the note.
    const { task } = await addTask({ title: 'Pipeline watch leader: Ledger, Courier', project: 'marina', description: 'Watches the Ledger and Courier pipelines and reports each failed stage.' });
    const send = async (message: string) => (await prepareUserAskCapture({ task, message, inChat: true }))?.commit();

    await send(`sorry forget that, can u acutally do the rest the ${vault} add permisison and then contineu rollabck for cfn`);
    await waitFor(() => (getSearchV2Index().getDoc('task', task.id)?.note ?? '').includes('rollabck'));
    expect(await findsTask(`${vault} permisison`, task.id)).toBe(true);
    expect(await findsTask('rollabck cfn', task.id)).toBe(true);

    // A later message adds its words; the earlier ones stay.
    await send(`for ${zone} what si thenext is the continue rollback done?`);
    await waitFor(() => (getSearchV2Index().getDoc('task', task.id)?.note ?? '').includes(zone));
    expect(await findsTask(`${zone} cfn rollback`, task.id)).toBe(true);
    expect(await findsTask(`${vault} permisison`, task.id)).toBe(true);
  });

  it('his passing words never outrank the task that is about them', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    // Words of this run's own: the test home is shared, and the last run's tasks would change
    // how rare they are.
    const [w1, w2] = [runWord('vex'), runWord('lum')];
    const { task: about } = await addTask({ title: `Stack ${w1} runbook for the ${w2} widget stacks`, project: 'marina' });
    const { task: chat } = await addTask({ title: 'Weekly chores list', project: 'marina', description: 'Groceries and errands.' });
    bus.emit(EventNames.TASK_CREATED, { task: about }, ['*'], { source: 'test' });
    await (await prepareUserAskCapture({ task: chat, message: `remind me after the ${w2} ${w1} runbook is done`, inChat: true }))?.commit();
    await waitFor(() => (getSearchV2Index().getDoc('task', chat.id)?.note ?? '').includes(w1) && getSearchV2Index().getDoc('task', about.id) !== null);
    const rows = (await search(`${w2} ${w1} runbook`, { types: ['task'], limit: 20 })).map((r) => r.taskId);
    expect(rows.indexOf(about.id)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(chat.id)).toBeGreaterThan(rows.indexOf(about.id));
  });

  // He types fast and searches spelled right: "permission" must find the task he wrote "permisison" in.
  it('a search spelled right finds the words he mistyped', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const index = getSearchV2Index();
    // Words of this run's own, each typed with two letters swapped: the shared test home keeps
    // every earlier run's typo, and a typo in many docs is no longer rare enough to fix.
    const [name, perm] = [runWord('quorv'), runWord('permi')];
    const swap = (w: string) => `${w.slice(0, -2)}${w.slice(-1)}${w.slice(-2, -1)}`;
    // The index knows the right spellings from other docs (as the real one does from months of work).
    for (let i = 0; i < 40; i++) {
      index.upsert({ kind: 'task', ref: `t-vocab-${i}`, title: `${name} audit ${i}`, summary: 'Reviewed the log.', note: '', meta: '', updatedAt: Date.now() });
      index.upsert({ kind: 'task', ref: `t-vocab-p${i}`, title: `Access review ${i}`, summary: `Granted the ${perm}.`, note: '', meta: '', updatedAt: Date.now() });
    }
    try {
      const { task } = await addTask({ title: 'Pipeline watch leader: Ledger, Courier', project: 'marina', description: 'Watches the Ledger and Courier pipelines.' });
      await (await prepareUserAskCapture({ task, message: `do the rest, the ${swap(name)} add ${swap(perm)} step by step`, inChat: true }))?.commit();
      await waitFor(() => (getSearchV2Index().getDoc('task', task.id)?.meta ?? '').includes(perm), 20_000);
      // His words in the note as he typed them, their right spellings in meta.
      expect(index.getDoc('task', task.id)?.note ?? '').toContain(`${swap(name)} add ${swap(perm)}`);
      expect(index.getDoc('task', task.id)?.meta ?? '').toContain(name);
      const rows = (await search(`${name} ${perm}`, { types: ['task'], limit: 20 })).map((r) => r.taskId);
      expect(rows.indexOf(task.id)).toBeGreaterThanOrEqual(0);
      expect(rows.indexOf(task.id)).toBeLessThan(3);
      // A full rebuild writes tasks before the vocabulary: the pass after it puts the fixes back.
      index.upsert({ ...index.getDoc('task', task.id)!, meta: 'Project: marina' });
      expect(await refixPersonWords(index)).toBeGreaterThanOrEqual(1);
      expect(index.getDoc('task', task.id)?.meta ?? '').toContain(name);
    } finally {
      for (let i = 0; i < 40; i++) { index.remove('task', `t-vocab-${i}`); index.remove('task', `t-vocab-p${i}`); }
    }
  }, 45_000);

  // 2026-11-19: a two-word search spelled right matched dozens of older tasks as fully as the one
  // he had worked in the day before; his touch puts it first among them, never above a better match.
  it('among equally good matches the task he touched lately comes first', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    // A name of this run's own: the test home is shared, and a retry finds the last run's tasks.
    const name = runWord('brim');
    const { task: older } = await addTask({ title: `${name} gateway lease audit`, project: 'marina', description: `${name} gateway lease audit notes.` });
    // No summary of its own, so his words in its note count in full (noteOnlyCoverage), as the other's title does.
    const { task: mine } = await addTask({ title: 'Weekly ops leader', project: 'marina' });
    for (const t of [older, mine]) bus.emit(EventNames.TASK_CREATED, { task: t }, ['*'], { source: 'test' });
    await (await prepareUserAskCapture({ task: mine, message: `check the ${name} gateway lease`, inChat: true }))?.commit();
    await waitFor(() => (getSearchV2Index().getDoc('task', mine.id)?.note ?? '').includes(name) && getSearchV2Index().getDoc('task', older.id) !== null);
    const order = async () => (await search(`${name} gateway lease`, { types: ['task'], limit: 20 })).map((r) => r.taskId);
    expect((await order()).indexOf(older.id)).toBeLessThan((await order()).indexOf(mine.id));
    await mergeUiPrefs({ [RECENT_OPENED_KEY]: { v: JSON.stringify([{ id: mine.id, at: new Date().toISOString(), human: true }]), ts: Date.now() } });
    try {
      await vi.waitFor(async () => {
        const rows = await order();
        expect(rows.indexOf(mine.id)).toBeGreaterThanOrEqual(0);
        expect(rows.indexOf(mine.id)).toBeLessThan(rows.indexOf(older.id));
      }, { timeout: 8_000, interval: 200 });
      // A better-covering match still wins: the touch only breaks ties.
      const better = (await search(`${name} gateway lease audit`, { types: ['task'], limit: 20 })).map((r) => r.taskId);
      expect(better[0]).toBe(older.id);
      // One word has no coverage tiers to tie in: the score decides, not the touch.
      const oneWord = (await search(name, { types: ['task'], limit: 20 })).map((r) => r.taskId);
      expect(oneWord.indexOf(older.id)).toBeLessThan(oneWord.indexOf(mine.id));
    } finally {
      await mergeUiPrefs({ [RECENT_OPENED_KEY]: { v: null, ts: Date.now() + 1 } });
    }
  });

  // 2026-11-19: both words of a two-word search were only in his words, which the index keeps
  // in the note, and a task with a summary gets half credit for a note-only term: it ranked 79th,
  // below the full tier, so the web and the phone hid the row.
  it('his words count in full for a task that has a summary of its own', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const [w1, w2] = [runWord('kel'), runWord('dor')];
    const { task } = await addTask({ title: 'Weekly ops leader', project: 'marina', description: 'Watches the ops queue and reports.' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['*'], { source: 'test' });
    await (await prepareUserAskCapture({ task, message: `then add the ${w1} ${w2} step`, inChat: true }))?.commit();
    await waitFor(() => (getSearchV2Index().getDoc('task', task.id)?.note ?? '').includes(w1));
    const row = (await search(`${w1} ${w2}`, { types: ['task'], limit: 20 })).find((r) => r.taskId === task.id);
    expect(row).toBeDefined();
    expect(row!.coveredTermHits).toBe(4);
  });

  // 2026-11-19: limit=3 cut the index lane before the merge, so the task he wrote in (first at the
  // web's limit 80) was missing from a three-row answer.
  it('a small limit returns the first rows of a large one', async () => {
    const bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const [w1, w2] = [runWord('mor'), runWord('tep')];
    const others = [];
    for (let i = 0; i < 6; i++) {
      others.push((await addTask({ title: `${w1} ${w2} report ${i}`, project: 'marina' })).task);
    }
    const { task: mine } = await addTask({ title: 'Weekly ops leader', project: 'marina', description: 'Watches the ops queue and reports.' });
    for (const t of [...others, mine]) bus.emit(EventNames.TASK_CREATED, { task: t }, ['*'], { source: 'test' });
    await (await prepareUserAskCapture({ task: mine, message: `then add the ${w1} ${w2} step`, inChat: true }))?.commit();
    await waitFor(() => (getSearchV2Index().getDoc('task', mine.id)?.note ?? '').includes(w1)
      && others.every((t) => getSearchV2Index().getDoc('task', t.id) !== null));
    await mergeUiPrefs({ [RECENT_OPENED_KEY]: { v: JSON.stringify([{ id: mine.id, at: new Date().toISOString(), human: true }]), ts: Date.now() } });
    try {
      const wide = (await search(`${w1} ${w2}`, { types: ['task'], limit: 80 })).map((r) => r.taskId);
      expect(wide[0]).toBe(mine.id);
      const narrow = (await search(`${w1} ${w2}`, { types: ['task'], limit: 3 })).map((r) => r.taskId);
      expect(narrow).toEqual(wide.slice(0, 3));
    } finally {
      await mergeUiPrefs({ [RECENT_OPENED_KEY]: { v: null, ts: Date.now() + 1 } });
    }
  }, 45_000);

  it('a task he never wrote in is not found by words that are only in other tasks', async () => {
    wiring = startSearchV2Wiring(new EventBus());
    const { task } = await addTask({ title: 'Quiet unrelated pipeline task', project: 'marina' });
    expect(await findsTask('vaultkep permisison', task.id)).toBe(false);
  });
});
