/**
 * The picker's `~` is the host's own home, the one its `~/` listing resolved, never
 * a guess from the account-shaped path (2026-11-08: the Demo's HOME is a folder under
 * the account's, and a typed `~/Documents/Project-001` was labelled
 * `~/.local/state/.../home/Documents/Project-001`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fullRowLabel, shortenHomePath } from '../../../web/src/components/sessions/path-selector/PathList';

const DEMO_HOME = '/Users/alice/Library/Application Support/Walnut Demo/home';

describe('shortenHomePath', () => {
  it('folds the learned home to ~, even when it is not the account home', () => {
    expect(shortenHomePath(`${DEMO_HOME}/Documents/`, DEMO_HOME)).toBe('~/Documents/');
    expect(shortenHomePath(`${DEMO_HOME}/`, DEMO_HOME)).toBe('~/');
  });

  it('keeps a path outside the learned home whole', () => {
    expect(shortenHomePath('/Users/alice/code/', DEMO_HOME)).toBe('/Users/alice/code/');
    expect(shortenHomePath(`${DEMO_HOME}-other/x/`, DEMO_HOME)).toBe(`${DEMO_HOME}-other/x/`);
  });

  it('falls back to the account-shaped home before any listing taught one', () => {
    expect(shortenHomePath('/Users/alice/code/')).toBe('~/code/');
    expect(shortenHomePath('/home/bob/src/')).toBe('~/src/');
    expect(shortenHomePath('/opt/data/')).toBe('/opt/data/');
  });

  it('a row for the home folder itself reads ~, with or without a trailing slash (2026-11-08)', () => {
    expect(fullRowLabel(DEMO_HOME, DEMO_HOME)).toEqual({ ghost: '', leaf: '~' });
    expect(fullRowLabel(`${DEMO_HOME}/`, DEMO_HOME)).toEqual({ ghost: '', leaf: '~' });
    expect(fullRowLabel('/Users/alice')).toEqual({ ghost: '', leaf: '~' });
    expect(fullRowLabel(`${DEMO_HOME}/Documents`, DEMO_HOME)).toEqual({ ghost: '~/', leaf: 'Documents' });
    expect(fullRowLabel('/opt/data', DEMO_HOME)).toEqual({ ghost: '/opt/', leaf: 'data' });
    expect(fullRowLabel('/', DEMO_HOME)).toEqual({ ghost: '/', leaf: '' });
  });

  it('every account-shaped home guess in the web app is this one fallback', () => {
    const root = path.resolve(__dirname, '../../../web/src');
    const guess = /\(\?:Users\|home\)|\\\/Users\\\/\[\^\/\]/;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(ts|tsx)$/.test(entry.name) && guess.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(root, file));
      }
    };
    walk(root);
    // The one home rule (shortenHomePath is its tildePath, shared with the draft and the Files tree).
    expect(found).toEqual(['utils/home-folder.ts']);
  });
});
