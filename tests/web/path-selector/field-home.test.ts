/**
 * The folder picker's path field shows the home as `~` and keeps the path absolute inside
 * (web/src/components/sessions/path-selector/field-home.ts; 2026-11-11 review: the field and the
 * "Create folder ..." row showed the long absolute Demo home, a remote pick read `/home/alice/`).
 */
import { describe, it, expect } from 'vitest';
import { homeFromListing, keptFieldPath, resolvedFieldPath, shownFieldPath } from '@/components/sessions/path-selector/field-home';

const DEMO = '/Users/sam/.local/share/open-walnut-demo/homes/4d986e27-9852-4fa4-aede-9bf7909c24b8';

describe('the picker field reads the home as ~', () => {
  it('shows a path under a known home with ~, on any host', () => {
    expect(shownFieldPath(`${DEMO}/`, DEMO)).toBe('~/');
    expect(shownFieldPath(`${DEMO}/projects/app/`, DEMO)).toBe('~/projects/app/');
    expect(shownFieldPath('/home/alice/', '/home/alice')).toBe('~/');
    expect(shownFieldPath('/home/alice/work', '/home/alice/')).toBe('~/work');
  });

  it('never guesses a home it was not told (the value must read back)', () => {
    expect(shownFieldPath('/Users/sam/code/', undefined)).toBe('/Users/sam/code/');
    expect(shownFieldPath('/srv/data/', '/home/alice')).toBe('/srv/data/');
    expect(shownFieldPath('/x/', '/')).toBe('/x/');
  });

  it('what the user types in the ~ form comes back absolute, and every shown value round-trips', () => {
    expect(keptFieldPath('~/', DEMO)).toBe(`${DEMO}/`);
    expect(keptFieldPath('~/p', DEMO)).toBe(`${DEMO}/p`);
    for (const p of [`${DEMO}/`, `${DEMO}/projects/app/`, `${DEMO}/a b/c`, '/etc/', '/']) {
      expect(keptFieldPath(shownFieldPath(p, DEMO), DEMO)).toBe(p);
    }
  });

  it('keeps a lone ~ as typed, so the next "/" is ~/ and not a restart at the root', () => {
    expect(keptFieldPath('~', DEMO)).toBe('~');
    // The confirm still hands on an absolute folder.
    expect(resolvedFieldPath('~', DEMO)).toBe(DEMO);
    expect(resolvedFieldPath('~/code', DEMO)).toBe(`${DEMO}/code`);
    expect(resolvedFieldPath('~/code', undefined)).toBe('~/code');
  });

  it('learns a host home from a ~ listing, at any depth, and refuses one that does not line up', () => {
    expect(homeFromListing('~/', '/home/alice/')).toBe('/home/alice');
    expect(homeFromListing('~/', `${DEMO}/`)).toBe(DEMO);
    expect(homeFromListing('~/a/b/', '/home/alice/a/b/')).toBe('/home/alice');
    expect(homeFromListing('~/a/b/', '/mnt/elsewhere/')).toBeUndefined();
    expect(homeFromListing('/srv/', '/srv/')).toBeUndefined();
  });
});
