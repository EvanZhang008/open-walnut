/**
 * folder-project — "a folder is a project", as the server decides it at launch:
 * the folder's own project, else a new one named after the folder that grows
 * (parent folder, host, number) until no other project has the name.
 */
import { describe, it, expect } from 'vitest';
import { folderProjectFor, folderProjectName, trimDir } from '../../../src/core/sessions/folder-project.js';
import { assertValidProjectName } from '../../../src/core/task-manager.js';

const isValid = (name: string) => { try { assertValidProjectName(name); return true; } catch { return false; } };
const takenOf = (...names: string[]) => (name: string) => names.some((n) => n.toLowerCase() === name.toLowerCase());

describe('folderProjectName', () => {
  it('is the folder name when nobody has it', () => {
    expect(folderProjectName('/repos/acme/tidepool/', null, takenOf(), isValid)).toBe('tidepool');
  });

  it('grows by the parent, then the remote host, then a number', () => {
    expect(folderProjectName('/repos/acme/tidepool', null, takenOf('TIDEPOOL'), isValid)).toBe('acme-tidepool');
    expect(folderProjectName('/repos/acme/tidepool', 'devbox', takenOf('tidepool', 'acme-tidepool'), isValid))
      .toBe('acme-tidepool (devbox)');
    expect(folderProjectName('/repos/acme/tidepool', 'devbox', takenOf('tidepool', 'acme-tidepool', 'acme-tidepool (devbox)'), isValid))
      .toBe('acme-tidepool (devbox) 2');
    expect(folderProjectName('/repos/acme/tidepool', '__local__', takenOf('tidepool', 'acme-tidepool'), isValid))
      .toBe('acme-tidepool 2');
    expect(folderProjectName('/tidepool', null, takenOf('tidepool', 'tidepool 2'), isValid)).toBe('tidepool 3');
  });

  it('never names a project the registry gate would refuse', () => {
    expect(folderProjectName('/home/.claude', null, takenOf(), isValid)).toBeNull();
    expect(folderProjectName('/tags/v1..v2', null, takenOf(), isValid)).toBeNull();
    expect(folderProjectName('/', null, takenOf(), isValid)).toBeNull();
    // A hidden parent is skipped, not glued on.
    expect(folderProjectName('/home/.config/tidepool', null, takenOf('tidepool'), isValid)).toBe('tidepool 2');
    // Over the length cap even with the parent: no project rather than a 400.
    const long = 'x'.repeat(200);
    expect(folderProjectName(`/a/${long}`, null, takenOf(long), isValid)).toBeNull();
  });
});

describe('folderProjectFor', () => {
  const projects = {
    Walnut: { metadata: { default_cwd: '/home/me/walnut/' } },
    'Hub Agent': { metadata: { default_cwd: '/work/hub' } },
    'Hub Review': { metadata: { default_cwd: '/work/hub/' } },
    Tidepool: { metadata: { default_cwd: '/elsewhere/tidepool' } },
    Loose: {},
  };

  it("files under the project that declares exactly this folder", () => {
    expect(folderProjectFor(projects, '/home/me/walnut', null, isValid)).toBe('Walnut');
    // Two declarers: the first in registry order, the same pick the draft makes.
    expect(folderProjectFor(projects, '/work/hub//', 'devbox', isValid)).toBe('Hub Agent');
  });

  it("never inherits a parent folder's project", () => {
    expect(folderProjectFor(projects, '/work/hub/teams/marina', 'devbox', isValid)).toBe('marina');
    expect(folderProjectFor(projects, '/home/me/walnut/web', null, isValid)).toBe('web');
  });

  it('a name another folder (or no folder) already owns grows', () => {
    expect(folderProjectFor(projects, '/repos/acme/tidepool', null, isValid)).toBe('acme-tidepool');
    expect(folderProjectFor(projects, '/repos/acme/loose', 'devbox', isValid)).toBe('acme-loose');
  });

  it('paths are case-sensitive; an empty cwd has no project', () => {
    // Not Walnut's folder (other case), and "walnut" is taken by Walnut.
    expect(folderProjectFor(projects, '/HOME/me/walnut', null, isValid)).toBe('me-walnut');
    expect(folderProjectFor(projects, '', null, isValid)).toBeNull();
    expect(trimDir(undefined)).toBe('');
  });
});
