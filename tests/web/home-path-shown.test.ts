/**
 * Every place the web app shows a host path shows its home as `~` (utils/home-folder.ts;
 * 2026-11-11 review F10: the picker field, the "Create folder ..." row and the Files path field
 * showed the long absolute Demo home, and the Files crumbs started with "…" instead of "~").
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/api/sessions', () => ({ peekWorkingDirs: () => null }));
const { pathCrumbs, tildePath, untildePath } = await import('@/utils/home-folder');

const HOME = '/Users/sam/.local/share/open-walnut-demo/homes/4d986e27';

describe('the home reads ~, and reads back', () => {
  it('untildePath is tildePath backwards against a known home, and leaves the rest alone', () => {
    for (const p of [HOME, `${HOME}/projects/app`, `${HOME}/a b`]) expect(untildePath(tildePath(p, HOME), HOME)).toBe(p);
    expect(untildePath('~', HOME)).toBe(HOME);
    expect(untildePath('~/x', `${HOME}/`)).toBe(`${HOME}/x`);
    expect(untildePath('~/x', undefined)).toBe('~/x');
    expect(untildePath('/etc', HOME)).toBe('/etc');
    expect(untildePath('~alice/x', HOME)).toBe('~alice/x');
  });

  it('the crumbs keep ~ first under the home; the ellipsis stands only for folders between', () => {
    expect(pathCrumbs('~/projects/app/notes.md')).toEqual(['~', 'projects', 'app', 'notes.md']);
    expect(pathCrumbs('~/a/b/c/d.md')).toEqual(['~', '…', 'b', 'c', 'd.md']);
    expect(pathCrumbs('~')).toEqual(['~']);
    expect(pathCrumbs('/srv/a/b/c/d')).toEqual(['…', 'b', 'c', 'd']);
    expect(pathCrumbs('/srv/a')).toEqual(['srv', 'a']);
    expect(pathCrumbs('/')).toEqual(['/']);
  });
});

describe('guard: a path field or row shows its home through the one rule', () => {
  const root = path.join(__dirname, '../../web/src');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('the picker field, its create row and the Files path field and crumbs go through it', () => {
    const picker = read('components/sessions/SessionPathSelector.tsx');
    expect(picker).toMatch(/value=\{editMode \? shownFieldPath\(editingPath, fieldHome\) : query\}/);
    expect(picker).toMatch(/setEditingPath\(keptFieldPath\(restartTypedPath\(v\), fieldHome\)\)/);
    expect(picker).toMatch(/createOption=\{createOption && shownFieldPath\(createOption, homeOfKey\(createTarget\)\)\}/);
    const files = read('components/sessions/SessionFileExplorer.tsx');
    expect(files).toMatch(/defaultValue=\{hostHome \? tildePath\(focusedDir \?\? root, hostHome\) : focusedDir \?\? root\}/);
    expect(files).toMatch(/const next = untildePath\(raw\.trim\(\), hostHome\);/);
    expect(files).toMatch(/pathCrumbs\(tildePath\(shownPath, hostHome\)\)/);
  });

  it('no input anywhere shows a folder path as a raw value (a new path field joins the rule)', () => {
    // An <input> whose value is a cwd/path/root/dir variable straight, with no home rule around it.
    const RAW = /(?:defaultValue|value)=\{\s*(?:[a-zA-Z]+\.)?(?:cwd|editingPath|root|focusedDir|dirPath|folderPath|currentPath)\s*(?:\?\?[^}]*)?\}/;
    // Editable fields saved exactly as typed (a `~` there is kept and expanded where it runs).
    const AS_TYPED = new Set(['components/routines/RoutineForm.tsx']);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.tsx') && !AS_TYPED.has(path.relative(root, full).replace(/\\/g, '/'))) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (RAW.test(line)) found.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });
});
