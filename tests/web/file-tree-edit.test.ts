/**
 * The rules behind the file explorer's inline create / rename / duplicate rows.
 *
 * Contract under test:
 *   - A name the filesystem (or the tree) can't take is rejected BEFORE the
 *     request, with a sentence a person can act on — the server's 400 arrives too
 *     late to keep the row usable.
 *   - Duplicating follows VS Code's series (`foo copy`, `foo copy 2`, …) and
 *     CONTINUES it when the thing being duplicated is itself a copy, so repeated
 *     duplication never produces "foo copy copy copy".
 *   - A rename is followed through into every path the tree remembered
 *     (remapPathPrefix), so the open file and the expanded folders survive it.
 *   - "Copy relative path" is relative to the containing root section, and a path
 *     outside that root stays absolute rather than becoming a ../.. climb.
 */
import { describe, it, expect } from 'vitest';
import {
  validateEntryName, nextCopyName, remapPathPrefix, relativeTo,
} from '@/components/sessions/file-tree-edit';

describe('validateEntryName', () => {
  it('accepts an ordinary new name', () => {
    expect(validateEntryName('notes.md', ['a.ts', 'b.ts'])).toBeNull();
    expect(validateEntryName('.gitignore', [])).toBeNull();
    expect(validateEntryName('a file with spaces.txt', [])).toBeNull();
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateEntryName('', [])).toBe("Name can't be empty");
    expect(validateEntryName('   ', [])).toBe("Name can't be empty");
  });

  it('rejects path separators — a name is one segment, never a path', () => {
    expect(validateEntryName('a/b', [])).toBe("Name can't contain slashes");
    expect(validateEntryName('a\\b', [])).toBe("Name can't contain slashes");
    expect(validateEntryName('/abs.txt', [])).toBe("Name can't contain slashes");
    expect(validateEntryName('../escape.txt', [])).toBe("Name can't contain slashes");
  });

  it('rejects the two reserved directory names', () => {
    expect(validateEntryName('.', [])).toBe('That name is reserved');
    expect(validateEntryName('..', [])).toBe('That name is reserved');
    // A leading dot is otherwise perfectly normal.
    expect(validateEntryName('...', [])).toBeNull();
  });

  it('rejects an embedded NUL byte', () => {
    expect(validateEntryName('bad\0name.txt', [])).toBe("Name can't contain that character");
  });

  it('measures length in BYTES, not characters', () => {
    expect(validateEntryName('a'.repeat(255), [])).toBeNull();
    expect(validateEntryName('a'.repeat(256), [])).toBe('Name is too long');
    // 3-byte characters: 85 of them fit, 86 do not.
    expect(validateEntryName('好'.repeat(85), [])).toBeNull();
    expect(validateEntryName('好'.repeat(86), [])).toBe('Name is too long');
  });

  it('rejects a sibling collision', () => {
    expect(validateEntryName('a.ts', ['a.ts', 'b.ts'])).toBe('Something with that name already exists');
    // Exact match only — a differently-cased or partial name is not a collision here.
    expect(validateEntryName('A.ts', ['a.ts'])).toBeNull();
    expect(validateEntryName('a.tsx', ['a.ts'])).toBeNull();
  });

  it('lets a rename keep its own name (that is a no-op, not a collision)', () => {
    expect(validateEntryName('a.ts', ['a.ts', 'b.ts'], { current: 'a.ts' })).toBeNull();
    // …but not a DIFFERENT sibling's name.
    expect(validateEntryName('b.ts', ['a.ts', 'b.ts'], { current: 'a.ts' }))
      .toBe('Something with that name already exists');
  });
});

describe('nextCopyName', () => {
  it('appends " copy" before the extension', () => {
    expect(nextCopyName('foo.ts', ['foo.ts'])).toBe('foo copy.ts');
    expect(nextCopyName('a.test.ts', ['a.test.ts'])).toBe('a.test copy.ts');
  });

  it('numbers from 2 once " copy" is taken', () => {
    expect(nextCopyName('foo.ts', ['foo.ts', 'foo copy.ts'])).toBe('foo copy 2.ts');
    expect(nextCopyName('foo.ts', ['foo.ts', 'foo copy.ts', 'foo copy 2.ts'])).toBe('foo copy 3.ts');
  });

  it('continues the series when the source is already a copy', () => {
    expect(nextCopyName('foo copy.ts', ['foo.ts', 'foo copy.ts'])).toBe('foo copy 2.ts');
    expect(nextCopyName('foo copy 2.ts', ['foo.ts', 'foo copy.ts', 'foo copy 2.ts']))
      .toBe('foo copy 3.ts');
    // A gap in the series is skipped past, never reused.
    expect(nextCopyName('foo copy.ts', ['foo copy.ts', 'foo copy 2.ts', 'foo copy 3.ts']))
      .toBe('foo copy 4.ts');
  });

  it('treats a dotfile as all-stem, no extension', () => {
    expect(nextCopyName('.env', ['.env'])).toBe('.env copy');
    expect(nextCopyName('.env copy', ['.env', '.env copy'])).toBe('.env copy 2');
    // A dotfile WITH a further extension still splits at the last dot.
    expect(nextCopyName('.env.local', ['.env.local'])).toBe('.env copy.local');
  });

  it('handles extension-less names (directories)', () => {
    expect(nextCopyName('src', ['src'])).toBe('src copy');
    expect(nextCopyName('src copy', ['src', 'src copy'])).toBe('src copy 2');
  });

  it('always returns a name that is free', () => {
    const siblings = ['x.ts', 'x copy.ts', 'x copy 2.ts', 'x copy 3.ts', 'x copy 4.ts'];
    const next = nextCopyName('x.ts', siblings);
    expect(siblings).not.toContain(next);
    expect(next).toBe('x copy 5.ts');
  });
});

describe('remapPathPrefix', () => {
  it('rewrites the renamed path itself', () => {
    expect(remapPathPrefix('/w/acme/old.ts', '/w/acme/old.ts', '/w/acme/new.ts'))
      .toBe('/w/acme/new.ts');
  });

  it('rewrites everything under a renamed directory', () => {
    expect(remapPathPrefix('/w/acme/old/deep/f.ts', '/w/acme/old', '/w/acme/new'))
      .toBe('/w/acme/new/deep/f.ts');
  });

  it('leaves unrelated paths alone, including sibling name prefixes', () => {
    expect(remapPathPrefix('/w/acme/other.ts', '/w/acme/old.ts', '/w/acme/new.ts'))
      .toBe('/w/acme/other.ts');
    // "oldest" starts with "old" as a STRING but is not under it as a path.
    expect(remapPathPrefix('/w/acme/oldest/f.ts', '/w/acme/old', '/w/acme/new'))
      .toBe('/w/acme/oldest/f.ts');
  });
});

describe('relativeTo', () => {
  it('strips the root prefix', () => {
    expect(relativeTo('/w/acme', '/w/acme/src/x.ts')).toBe('src/x.ts');
    expect(relativeTo('/w/acme/', '/w/acme/src/x.ts')).toBe('src/x.ts');
    expect(relativeTo('/', '/w/acme/x.ts')).toBe('w/acme/x.ts');
  });

  it('answers "." for the root itself', () => {
    expect(relativeTo('/w/acme', '/w/acme')).toBe('.');
    expect(relativeTo('/w/acme', '/w/acme/')).toBe('.');
    expect(relativeTo('/', '/')).toBe('.');
  });

  it('returns a path outside the root unchanged', () => {
    expect(relativeTo('/w/acme', '/w/other/x.ts')).toBe('/w/other/x.ts');
    // Sibling-prefix trap: /w/acme-2 is not inside /w/acme.
    expect(relativeTo('/w/acme', '/w/acme-2/x.ts')).toBe('/w/acme-2/x.ts');
  });
});
