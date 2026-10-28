/**
 * A description of what a task delivers finds it (2026-10-28). The user asked for "the Walnut
 * tunnel and server replica redesign tasks"; the two tasks that did that work had titles that no
 * longer said so, and their summaries named tunnels and replica servers, while tasks whose long
 * notes held every word somewhere ranked above them. Through Walnut's own search(): the merge
 * ranks by coverage first, so this pins the whole path, not only the library component.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { getSearchV2Index, resetSearchV2IndexForTests } from '../../src/core/search/wiring.js';
import { taskToDoc } from '../../src/core/search/serializers.js';
import { search } from '../../src/core/search.js';

const FILLER = 'The crate rides the pallet and the dock crew stacks it before the round. ';
const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '0';
  const make = async (key: string, title: string, summary: string, note: string) => {
    const { task } = await addTask({ title, project: 'Walnut' });
    const { task: full } = await updateTaskRaw(task.id, { summary, note });
    const doc = taskToDoc(full!);
    if (doc) getSearchV2Index().upsert(doc);
    ids[key] = task.id;
  };
  for (let i = 0; i < 14; i++) await make(`pad${i}`, `Unrelated row ${i}`, `Filler ${i}.`, `${FILLER}${i}`);
  for (let i = 0; i < 6; i++) await make(`log${i}`, `Shift handover ${i}`, `Log ${i}.`, FILLER.repeat(60) + i);
  await make('about', 'API inventory for daemon takeover · Live Isolation',
    'This task keeps Walnut usable while its main computer sleeps. Already live: failover, host copies, tunnels, voice fallback, trigger resume, plugin links, phone layout, replica servers, offline letters and host routines.',
    `## Executive Summary\nThis task keeps the app usable while its main computer sleeps.\n${FILLER.repeat(40)}`);
  // A long working log that mentions every word of the query, several times, about other things.
  const log = Array.from({ length: 5 }, (_, i) => `${FILLER.repeat(25)}Round ${i}: the tunnel to the build server dropped, `
    + `so the replica copy of the chat list was stale, and the menu redesign tasks waited. `).join('');
  await make('mentions', 'Archive and auto title · Inject summary',
    'Archives finished chats in Walnut and names them from their first message.', log);
});

afterAll(() => {
  delete process.env.WALNUT_SEARCH_V2_SEMANTIC;
  resetSearchV2IndexForTests();
});

describe('a description of the deliverable finds the task', () => {
  it('the task whose summary names it ranks above one whose long note mentions the words', async () => {
    const results = await search('the Walnut tunnel and server replica redesign tasks', { types: ['task'], limit: 20 });
    const order = results.map((r) => r.taskId);
    expect(order).toContain(ids.about);
    expect(order.indexOf(ids.about)).toBeLessThan(order.indexOf(ids.mentions) < 0 ? Infinity : order.indexOf(ids.mentions));
  });
});
