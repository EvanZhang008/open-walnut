/**
 * The draft pill and the launch must name a folder's new project the same way:
 * the draft column's newProjectNameForFolder (what the user sees before Start)
 * against the server's folderProjectName (what quick-start files under). A
 * generated matrix of folders, hosts and taken names; any drift is a pill that
 * says one project while the task lands in another.
 *
 * The home folder is part of the matrix in both forms: `~` and the ABSOLUTE home the folder
 * picker stores after its `~` rewrite (2026-11-10 review: a Quick access pick of "~/" read
 * "New project: <the home's last segment>", a generation id in the Demo, the user name elsewhere).
 * The draft learns this Walnut's home from the working-dirs answer (`localHome`), the launch
 * passes os.homedir() for a local launch only; a remote host's absolute home is named by its last
 * segment on both sides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { folderProjectFor, folderProjectName } from '../../src/core/sessions/folder-project.js';
import { assertValidProjectName } from '../../src/core/task-manager.js';

const state = vi.hoisted(() => ({ localHome: undefined as string | undefined }));
vi.mock('@/api/sessions', () => ({
  peekWorkingDirs: () => (state.localHome ? { dirs: [], hosts: [], localHome: state.localHome } : null),
}));
const { newProjectNameForFolder, projectForFolderPick } = await import('@/components/sessions/draft-column');
const { rememberHostHome, shownFolderName, tildePath } = await import('@/utils/home-folder');

const isValid = (name: string) => { try { assertValidProjectName(name); return true; } catch { return false; } };

// A home named by an id (the Demo's) and an ordinary account home.
const ID_HOME = '/tmp/demo/homes/3381787b-4980-437b-8280-f6df099dc1f3';
const ACCOUNT_HOME = '/Users/sam';
const REMOTE_HOME = '/home/alice';

const FOLDERS = [
  '/repos/acme/tidepool', '/repos/acme/tidepool/', '/tidepool', '/', '', '/home/.config/tidepool',
  '/home/.claude', '/tags/v1..v2', '/w/Café/Marina', '/w/team-a/marina 2', `/a/${'y'.repeat(195)}`,
  '/x/constructor', '/__proto__/tidepool', '/x/Prototype', '/x/ spaced ', '/x/  ', '/x/back\\slash',
  // The home folder as a draft names it, and look-alikes that are not it.
  '~', '~/', '/~', '/x/~', '/x/Home', '~x',
  // The absolute homes the picker stores, with and without a trailing slash, and their children.
  ID_HOME, `${ID_HOME}/`, `${ID_HOME}/Projects`, ACCOUNT_HOME, `${ACCOUNT_HOME}/`, `${ACCOUNT_HOME}/code`,
  REMOTE_HOME, `${REMOTE_HOME}/`, '/Users/Home',
];
const TAKEN_HOME = [['Home'], ['home', 'Home 2'], ['Home', 'Home (devbox)']];
const HOSTS = [null, '__local__', 'devbox'];
const TAKEN_SETS = [
  [], ['tidepool'], ['TIDEPOOL', 'acme-tidepool'], ['tidepool', 'acme-tidepool', 'acme-tidepool (devbox)'],
  ['tidepool', 'tidepool 2'], ['marina', 'Café-Marina'], ['marina 2', 'team-a-marina 2'],
];
// The home each local Walnut may have (none known yet = an older server or a cold cache).
const LOCAL_HOMES = [undefined, ID_HOME, ACCOUNT_HOME, '/Users/Home'];

/** The home the LAUNCH passes for this host (task-manager.ts ensureFolderProject; pinned below). */
const launchHome = (host: string | null, localHome: string | undefined) => (!host || host === '__local__' ? localHome : undefined);

beforeEach(() => { state.localHome = undefined; });

describe('folder project names: draft pill = launch', () => {
  it('agree on every folder × host × local home × taken-name combination', () => {
    // A remote home a listing taught the window must not change what the launch names it.
    rememberHostHome('devbox', REMOTE_HOME);
    const drift: string[] = [];
    for (const localHome of LOCAL_HOMES) {
      state.localHome = localHome;
      for (const cwd of FOLDERS) {
        for (const host of HOSTS) {
          for (const taken of [...TAKEN_SETS, ...TAKEN_HOME]) {
            const isTaken = (name: string) => taken.some((t) => t.toLowerCase() === name.toLowerCase());
            // The draft's own default: the home it learned, judged for this host.
            const client = newProjectNameForFolder(cwd, host, isTaken);
            const server = folderProjectName(cwd, host, isTaken, isValid, launchHome(host, localHome));
            if (client !== server) drift.push(`${JSON.stringify({ cwd, host, localHome, taken })}: draft=${client} launch=${server}`);
          }
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('a pick of the local home reads "Home", in both forms, whatever the home is called', () => {
    for (const home of [ID_HOME, ACCOUNT_HOME]) {
      state.localHome = home;
      for (const cwd of ['~', '~/', home, `${home}/`]) {
        expect(newProjectNameForFolder(cwd, null, () => false), cwd).toBe('Home');
        expect(folderProjectName(cwd, null, () => false, isValid, home), cwd).toBe('Home');
      }
      // Taken: the parent (`homes`, `Users`) says nothing about it, so a number.
      expect(newProjectNameForFolder(home, null, (n) => n === 'Home')).toBe('Home 2');
    }
    // A remote host's absolute home is its own name on both sides; its `~` is "Home" there too.
    state.localHome = ACCOUNT_HOME;
    expect(newProjectNameForFolder(REMOTE_HOME, 'devbox', () => false)).toBe('alice');
    expect(folderProjectName(REMOTE_HOME, 'devbox', () => false, isValid, launchHome('devbox', ACCOUNT_HOME))).toBe('alice');
    expect(newProjectNameForFolder('~', 'devbox', (n) => n === 'Home')).toBe('Home (devbox)');
    // The local home path seen on a remote host is just a folder there.
    expect(newProjectNameForFolder(ACCOUNT_HOME, 'devbox', () => false)).toBe('sam');
  });

  it('a "Home" project stamped with either form of the home owns a pick of the other (never "Home 2")', () => {
    for (const home of [ID_HOME, ACCOUNT_HOME]) {
      state.localHome = home;
      for (const [stamped, picked] of [[home, '~'], ['~', home], [`${home}`, `${home}/`], ['~', '~']] as const) {
        const projects = { Walnut: { metadata: { default_cwd: '/w/walnut' } }, Home: { metadata: { default_cwd: stamped } } };
        const byCwd = new Map(Object.entries(projects).map(([n, p]) => [p.metadata.default_cwd.replace(/\/+$/, ''), n]));
        const projectForDir = (cwd: string) => byCwd.get(cwd.replace(/\/+$/, '')) ?? '';
        const isTaken = (n: string) => n in projects;
        const draft = { project: '', projectSource: undefined, taskId: undefined, forkOf: undefined };
        expect(projectForFolderPick(draft, picked, null, projectForDir, isTaken), `${stamped} <- ${picked}`).toBe('Home');
        expect(folderProjectFor(projects, picked, null, isValid, home), `${stamped} <- ${picked}`).toBe('Home');
      }
    }
    // On a remote host the launch knows no home, so the forms are two folders there, on both sides.
    state.localHome = ACCOUNT_HOME;
    const projects = { Home: { metadata: { default_cwd: '~' } } };
    const draft = { project: '', projectSource: undefined, taskId: undefined, forkOf: undefined };
    const projectForDir = (cwd: string) => (cwd === '~' ? 'Home' : '');
    expect(projectForFolderPick(draft, REMOTE_HOME, 'devbox', projectForDir, (n) => n === 'Home')).toBe('alice');
    expect(folderProjectFor(projects, REMOTE_HOME, 'devbox', isValid, undefined)).toBe('alice');
  });
});

describe('the home folder is shown as ~ on every host', () => {
  it('the pill, the tree and the crumbs read ~ for the home, never its id or user name', () => {
    state.localHome = ID_HOME;
    expect(shownFolderName(ID_HOME, null)).toBe('~');
    expect(shownFolderName(`${ID_HOME}/`, '__local__')).toBe('~');
    expect(shownFolderName(`${ID_HOME}/Projects`, null)).toBe('Projects');
    expect(shownFolderName('~', null)).toBe('~');
    expect(tildePath(`${ID_HOME}/Projects/x.ts`, ID_HOME)).toBe('~/Projects/x.ts');
    // The account-shaped guess never wins over a known home (the Demo's HOME is not the account's).
    expect(shownFolderName('/Users/sam', null)).toBe('sam');
    // A remote home: learned from a listing, else the account-shaped guess.
    rememberHostHome('devbox', '/data/alice');
    expect(shownFolderName('/data/alice', 'devbox')).toBe('~');
    expect(shownFolderName('/home/bob', 'otherbox')).toBe('~');
    expect(shownFolderName('/opt/data', 'otherbox')).toBe('data');
    expect(shownFolderName('/', null)).toBe('/');
  });
});

describe('guard: every draft and Files surface names a folder through the home rule', () => {
  const root = path.join(__dirname, '../../web/src');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  // Every draft naming file (Draft*.tsx, draft-*.ts, the pending column a Start turns into) and the
  // Files surfaces that show a folder by name. A new one joins the class by its file name.
  const sessionsDir = path.join(root, 'components/sessions');
  const draftFiles = fs.readdirSync(sessionsDir)
    .filter((f) => /^(Draft.*\.tsx|draft-.*\.ts|PendingSessionPanel\.tsx)$/.test(f))
    .map((f) => `components/sessions/${f}`);
  const files = [
    ...draftFiles,
    'components/sessions/SessionFileExplorer.tsx',
    'components/common/FileContentView.tsx',
    'components/sessions/path-selector/PathList.tsx',
  ];
  // A folder's name taken by hand: its last segment, without asking whether it is the home.
  const HAND_NAMED = [
    { re: /function basename\(/, why: 'a local basename() helper' },
    { re: /cwd\??\.replace\([^)]*\)\.split\('\/'\)\.pop\(\)/, why: "a cwd's last segment" },
    { re: /cwd\??\.split\('\/'\)\.pop\(\)/, why: "a cwd's last segment" },
    { re: /lastSegment\(root\)|lastSegment\(repoRoot\)|lastSegment\(parentPath\(/, why: "a tree root's or parent's last segment" },
    { re: /parentPath\([^)]*\)\.split\('\/'\)/, why: "a parent path's segments" },
    { re: /crumbSegments\(shownPath\)/, why: 'crumbs of the raw path' },
    { re: /\/\^\\\/\(\?:Users\|home\)/, why: 'its own copy of the account-shaped home guess' },
  ];

  it('finds the draft files it guards (the class is enumerated from the source)', () => {
    expect(draftFiles).toEqual(expect.arrayContaining([
      'components/sessions/DraftLaunchBar.tsx', 'components/sessions/DraftLaunchPills.tsx',
      'components/sessions/draft-column.ts', 'components/sessions/draft-project-chip.ts',
      'components/sessions/PendingSessionPanel.tsx',
    ]));
  });

  it('no guarded file names a folder by hand', () => {
    const found: string[] = [];
    for (const rel of files) {
      read(rel).split('\n').forEach((line, i) => {
        for (const { re, why } of HAND_NAMED) if (re.test(line)) found.push(`${rel}:${i + 1}: ${why}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('the draft names new projects against the home the launch uses, and owns either form of it', () => {
    const draft = read('components/sessions/draft-column.ts');
    expect(draft).toMatch(/home: string \| undefined = namingHomeOf\(host\)/);
    expect(draft).toMatch(/isHomeFolder\(cwd, home\) \? HOME_PROJECT_NAME/);
    expect(draft).toMatch(/isHomeFolder\(clean, home\)/);
    // newProjectNameForFolder is called only from draft-column itself, with its own default home.
    const callers = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f) && read(f).includes('newProjectNameForFolder('));
    expect(callers.map((f) => f.replace(/\\/g, '/'))).toEqual(['components/sessions/draft-column.ts']);
    // The two sides tell local from remote the same way.
    expect(read('utils/home-folder.ts')).toMatch(/return !host \|\| host === LOCAL \? knownHomeOf\(host\) : undefined/);
    const server = fs.readFileSync(path.join(__dirname, '../../src/core/task-manager.ts'), 'utf8');
    expect(server).toMatch(/const home = !host \|\| host === '__local__' \? os\.homedir\(\) : undefined;/);
    expect(fs.readFileSync(path.join(__dirname, '../../src/web/routes/sessions.ts'), 'utf8')).toMatch(/localHome: os\.homedir\(\)/);
  });
});
