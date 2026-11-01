/**
 * Ratchet: a sync plugin never reads or changes a task kept local (src/core/private-tasks/
 * visibility.ts). Every method of the plugin API's `tasks` group (src/core/plugins/server-api.ts),
 * read from the source, either screens task ids against the filter or is listed here with why it
 * needs none. A new method fails here until it is placed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SCREENS = /providerVisible|assertProviderMayWrite|withoutKept/;
/** Methods that take no existing task, with why. */
const NO_TASK: Record<string, string> = {
  create: 'makes a new task; the birth check (private-tasks/birth.ts) decides its source',
  keepInPlugin: 'marks tasks as the plugin\'s own (plugin_only); a sync plugin keeps none',
  folders: 'lists folders, no task text',
  createFolder: 'makes a folder',
  deleteFolder: 'deletes an empty folder only',
  pinGroups: 'lists pin groups, no task text',
  ensurePinGroup: 'makes a pin group',
};

describe('plugin API access to tasks kept local', () => {
  it('every tasks.* method screens the task ids it takes, or takes none', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/core/plugins/server-api.ts'), 'utf8');
    const start = src.indexOf('\n    tasks: {');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('\n    },\n', start);
    const block = src.slice(start, end);
    const heads = [...block.matchAll(/^ {6}(?:async )?(\w+)\(/gm)];
    expect(heads.length).toBeGreaterThan(10);
    const unscreened: string[] = [];
    heads.forEach((m, i) => {
      const body = block.slice(m.index!, heads[i + 1]?.index ?? block.length);
      if (!SCREENS.test(body) && !(m[1] in NO_TASK)) unscreened.push(m[1]);
    });
    expect(unscreened, 'screen these against the private-task filter or list them in NO_TASK with why').toEqual([]);
    for (const name of Object.keys(NO_TASK)) expect(heads.some((m) => m[1] === name), name).toBe(true);
  });
});
