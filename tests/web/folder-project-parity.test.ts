/**
 * The draft pill and the launch must name a folder's new project the same way:
 * the draft column's newProjectNameForFolder (what the user sees before Start)
 * against the server's folderProjectName (what quick-start files under). A
 * generated matrix of folders, hosts and taken names; any drift is a pill that
 * says one project while the task lands in another.
 */
import { describe, it, expect, vi } from 'vitest';
import { folderProjectName } from '../../src/core/sessions/folder-project.js';
import { assertValidProjectName } from '../../src/core/task-manager.js';

vi.mock('@/api/sessions', () => ({ peekWorkingDirs: () => null }));
const { newProjectNameForFolder } = await import('@/components/sessions/draft-column');

const isValid = (name: string) => { try { assertValidProjectName(name); return true; } catch { return false; } };

const FOLDERS = [
  '/repos/acme/tidepool', '/repos/acme/tidepool/', '/tidepool', '/', '', '/home/.config/tidepool',
  '/home/.claude', '/tags/v1..v2', '/w/Café/Marina', '/w/team-a/marina 2', `/a/${'y'.repeat(195)}`,
  '/x/constructor', '/__proto__/tidepool', '/x/Prototype', '/x/ spaced ', '/x/  ', '/x/back\\slash',
];
const HOSTS = [null, '__local__', 'devbox'];
const TAKEN_SETS = [
  [], ['tidepool'], ['TIDEPOOL', 'acme-tidepool'], ['tidepool', 'acme-tidepool', 'acme-tidepool (devbox)'],
  ['tidepool', 'tidepool 2'], ['marina', 'Café-Marina'], ['marina 2', 'team-a-marina 2'],
];

describe('folder project names: draft pill = launch', () => {
  it('agree on every folder × host × taken-name combination', () => {
    const drift: string[] = [];
    for (const cwd of FOLDERS) {
      for (const host of HOSTS) {
        for (const taken of TAKEN_SETS) {
          const isTaken = (name: string) => taken.some((t) => t.toLowerCase() === name.toLowerCase());
          const client = newProjectNameForFolder(cwd, host, isTaken);
          const server = folderProjectName(cwd, host, isTaken, isValid);
          if (client !== server) drift.push(`${JSON.stringify({ cwd, host, taken })}: draft=${client} launch=${server}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });
});
