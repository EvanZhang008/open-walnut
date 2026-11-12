/**
 * A new note is named by its title (web/src/components/notes/note-auto-name.ts).
 *
 * 2026-11-11, the user: "When we new a file please immediately new the file ... name will
 * be provided as the title, by default if no name provided". New note makes `Untitled.md`
 * at once (the next free number when taken); once the note's first line is written, the
 * file takes that line's words as its name, never over another note's file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  pickUntitledPath, noteTitleFromBody, fileBaseFromTitle, autoNameTarget, MAX_NAME_CHARS,
  markAutoNamed, isAutoNamed, followAutoName, forgetAutoName, noteAutoNameFailed, autoNameFailedBefore,
  resetAutoNamesForTests,
} from '@/components/notes/note-auto-name';

afterEach(() => { resetAutoNamesForTests(); });

describe('the default name of a new note', () => {
  it('is Untitled.md, then the first free number', () => {
    expect(pickUntitledPath('', [])).toBe('Untitled.md');
    expect(pickUntitledPath('', ['Untitled.md'])).toBe('Untitled 1.md');
    expect(pickUntitledPath('', ['Untitled.md', 'Untitled 1.md'])).toBe('Untitled 2.md');
    // A gap is reused: the first free name, not the highest number plus one.
    expect(pickUntitledPath('', ['Untitled.md', 'Untitled 2.md'])).toBe('Untitled 1.md');
  });

  it('lives in the folder it was made in; another folder\'s Untitled does not count', () => {
    expect(pickUntitledPath('Work', ['Untitled.md'])).toBe('Work/Untitled.md');
    expect(pickUntitledPath('Work/Q4', ['Work/Q4/Untitled.md', 'Untitled 1.md'])).toBe('Work/Q4/Untitled 1.md');
  });

  it('counts a name taken in another case as taken (the Mac\'s file system ignores case)', () => {
    expect(pickUntitledPath('', ['untitled.md'])).toBe('Untitled 1.md');
    expect(pickUntitledPath('', ['UNTITLED.md', 'Untitled 1.MD'])).toBe('Untitled 2.md');
  });

  it('counts attachments too (a picture named like the note blocks the name)', () => {
    expect(pickUntitledPath('', ['Untitled.md', 'Untitled 1.md', 'Untitled 2.png'])).toBe('Untitled 2.md');
  });
});

describe('the title of a note', () => {
  it('is its first heading, or its first line with words', () => {
    expect(noteTitleFromBody('# Meeting notes\n\nbody')).toBe('Meeting notes');
    expect(noteTitleFromBody('\n\n  Plain first line\nsecond')).toBe('Plain first line');
    expect(noteTitleFromBody('### Closing hashes ###')).toBe('Closing hashes');
  });

  it('is the words a reader sees: links, emphasis and code marks gone', () => {
    expect(noteTitleFromBody('# **Bold** and `code` ~~gone~~ ==marked==')).toBe('Bold and code gone marked');
    expect(noteTitleFromBody('[Report](https://example.com/r) for [[Projects/Q4 plan|Q4]] and [[Ideas]]')).toBe('Report for Q4 and Ideas');
    expect(noteTitleFromBody('[[Projects/Roadmap#Goals]] review')).toBe('Roadmap review');
    expect(noteTitleFromBody('Plan \\#1 \\*draft\\*')).toBe('Plan #1 *draft*');
    expect(noteTitleFromBody('<b>Bold</b> words')).toBe('Bold words');
  });

  it('skips list, quote and task markers', () => {
    expect(noteTitleFromBody('- [ ] Buy milk')).toBe('Buy milk');
    expect(noteTitleFromBody('* Point')).toBe('Point');
    expect(noteTitleFromBody('1. First step')).toBe('First step');
    expect(noteTitleFromBody('> Quoted idea')).toBe('Quoted idea');
  });

  it('skips lines with nothing to read: a picture, an embed, a rule, a fence marker, an empty heading', () => {
    expect(noteTitleFromBody('![](a.png)\n# Real title')).toBe('Real title');
    expect(noteTitleFromBody('![[diagram.png]]\nAfter the picture')).toBe('After the picture');
    expect(noteTitleFromBody('---\nAfter the rule')).toBe('After the rule');
    expect(noteTitleFromBody('```js\nconst a = 1\n```')).toBe('const a = 1');
    expect(noteTitleFromBody('#\nSecond line')).toBe('Second line');
  });

  it('drops invisible characters the editor writes and reads entities as text', () => {
    expect(noteTitleFromBody('\u200B# Title&nbsp;here')).toBe('Title here');
    expect(noteTitleFromBody('Q&amp;A\u00A0notes')).toBe('Q&A notes');
  });

  it('keeps angle brackets that are no tag, and a written tag (as entities) as words', () => {
    expect(noteTitleFromBody('a <- b -> c')).toBe('a <- b -> c');
    expect(noteTitleFromBody('x < y and y > z')).toBe('x < y and y > z');
    expect(noteTitleFromBody('Use &lt;b&gt; for bold')).toBe('Use <b> for bold');
  });

  it('is empty for an empty note', () => {
    expect(noteTitleFromBody('')).toBe('');
    expect(noteTitleFromBody('\n   \n\t\n')).toBe('');
    expect(noteTitleFromBody('![](only-a-picture.png)')).toBe('');
  });

  it('keeps any script', () => {
    expect(noteTitleFromBody('# \u4F1A\u8BAE\u8BB0\u5F55')).toBe('\u4F1A\u8BAE\u8BB0\u5F55');
    expect(noteTitleFromBody('Caf\u00E9 plan \u{1F680}')).toBe('Caf\u00E9 plan \u{1F680}');
  });
});

describe('a title as a file name', () => {
  it('turns path separators into a dash, so the note stays in its folder', () => {
    expect(fileBaseFromTitle('A/B testing')).toBe('A-B testing');
    expect(fileBaseFromTitle('C:\\temp notes')).toBe('C-temp notes');
  });

  it('drops what file systems refuse and what breaks a wiki link to the note', () => {
    expect(fileBaseFromTitle('Q4: plan? <draft> "x" | y *z*')).toBe('Q4 plan draft x y z');
    expect(fileBaseFromTitle('[[link]] #tag ^block')).toBe('link tag block');
    // A tab is a space; any other control character goes.
    expect(fileBaseFromTitle('tab\there\u0007bell')).toBe('tab herebell');
  });

  it('never makes a hidden file, a trailing dot or a doubled .md', () => {
    expect(fileBaseFromTitle('...hidden')).toBe('hidden');
    expect(fileBaseFromTitle('Trailing dots...')).toBe('Trailing dots');
    expect(fileBaseFromTitle('notes.md')).toBe('notes');
    expect(fileBaseFromTitle('notes.MD.md')).toBe('notes');
    expect(fileBaseFromTitle('notes.md.')).toBe('notes');
    expect(fileBaseFromTitle('Report.md ...')).toBe('Report');
  });

  it('is empty when nothing usable is left', () => {
    expect(fileBaseFromTitle('   ')).toBe('');
    expect(fileBaseFromTitle('???')).toBe('');
    expect(fileBaseFromTitle('.md')).toBe('');
  });

  it('cuts a long title, at a word when one ends late enough', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const base = fileBaseFromTitle(long);
    expect(base.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    expect(long.startsWith(base)).toBe(true);
    expect(long.charAt(base.length)).toBe(' ');
    const oneWord = 'x'.repeat(200);
    expect(fileBaseFromTitle(oneWord)).toBe('x'.repeat(MAX_NAME_CHARS));
  });

  it('stays within the file system\'s byte limit for wide characters', () => {
    const cjk = '\u4F1A'.repeat(100); // 3 bytes each
    const base = fileBaseFromTitle(cjk);
    expect(new TextEncoder().encode(`${base} 99.md`).length).toBeLessThanOrEqual(255);
    expect(base.length).toBeGreaterThan(0);
    const emoji = '\u{1F680}'.repeat(90); // 4 bytes each, two UTF-16 units
    const e = fileBaseFromTitle(emoji);
    expect(new TextEncoder().encode(e).length).toBeLessThanOrEqual(200);
    expect(Array.from(e).every((c) => c === '\u{1F680}')).toBe(true); // never half a character
  });
});

describe('when an auto-named note is renamed, and to what', () => {
  it('a written title names the note, in its folder', () => {
    expect(autoNameTarget('Untitled.md', '# Meeting notes\nbody', ['Untitled.md'])).toBe('Meeting notes.md');
    expect(autoNameTarget('Work/Untitled 1.md', 'Plan for Q4', ['Work/Untitled 1.md'])).toBe('Work/Plan for Q4.md');
  });

  it('a title another note already has gets the first free number, whatever its case', () => {
    expect(autoNameTarget('Untitled.md', '# Plan', ['Untitled.md', 'Plan.md'])).toBe('Plan 1.md');
    expect(autoNameTarget('Untitled.md', '# Plan', ['Untitled.md', 'plan.md', 'Plan 1.md'])).toBe('Plan 2.md');
    // Another folder's Plan is no collision.
    expect(autoNameTarget('Work/Untitled.md', '# Plan', ['Plan.md', 'Work/Untitled.md'])).toBe('Work/Plan.md');
  });

  it('nothing to do with no title yet', () => {
    expect(autoNameTarget('Untitled.md', '', ['Untitled.md'])).toBeNull();
    expect(autoNameTarget('Untitled.md', '\n\n', ['Untitled.md'])).toBeNull();
    expect(autoNameTarget('Untitled.md', '![](x.png)', ['Untitled.md'])).toBeNull();
    expect(autoNameTarget('Untitled.md', '# ???', ['Untitled.md'])).toBeNull();
  });

  it('nothing to do when the name already is the title, in any case or with its number', () => {
    expect(autoNameTarget('Plan.md', '# Plan', ['Plan.md'])).toBeNull();
    // A case-only change: a case-blind file system cannot rename it, so it is left.
    expect(autoNameTarget('Plan.md', '# plan', ['Plan.md'])).toBeNull();
    // The number it got because Plan.md was taken.
    expect(autoNameTarget('Plan 1.md', '# Plan', ['Plan.md', 'Plan 1.md'])).toBeNull();
    expect(autoNameTarget('Plan 1.md', '# plan', ['PLAN.md', 'Plan 1.md'])).toBeNull();
    // The title "Untitled" keeps whichever Untitled it has.
    expect(autoNameTarget('Untitled 3.md', '# Untitled', ['Untitled.md', 'Untitled 3.md'])).toBeNull();
  });

  it('follows the title as it grows (the name a pause gave is not final)', () => {
    expect(autoNameTarget('Mee.md', '# Meeting notes', ['Mee.md'])).toBe('Meeting notes.md');
  });

  it('a title cut back to a name with no number on it ("Plan 3" to "Plan") drops the number when that name is free', () => {
    expect(autoNameTarget('Plan 3.md', '# Plan', ['Plan 3.md'])).toBe('Plan.md');
    expect(autoNameTarget('Work/Plan 3.md', '# Plan', ['Plan.md', 'Work/Plan 3.md'])).toBe('Work/Plan.md');
    // While Plan.md is another note's, the numbered name stays.
    expect(autoNameTarget('Plan 3.md', '# Plan', ['Plan.md', 'Plan 3.md'])).toBeNull();
  });

  it('never counts the note\'s own file as taken', () => {
    expect(autoNameTarget('Untitled.md', '# Untitled 1', ['Untitled.md'])).toBe('Untitled 1.md');
    expect(autoNameTarget('Plan 2.md', '# Plan 2', ['Plan 2.md'])).toBeNull();
  });
});

describe('which notes are auto-named', () => {
  it('only one New note made, under its current path', () => {
    expect(isAutoNamed('Untitled.md')).toBe(false);
    markAutoNamed('Untitled.md');
    expect(isAutoNamed('Untitled.md')).toBe(true);
    followAutoName('Untitled.md', 'Plan.md');
    expect(isAutoNamed('Untitled.md')).toBe(false);
    expect(isAutoNamed('Plan.md')).toBe(true);
  });

  it('a note that is not auto-named never becomes one by a rename', () => {
    followAutoName('Notes.md', 'Other.md');
    expect(isAutoNamed('Other.md')).toBe(false);
  });

  it('a name the user gives ends it, and a failed rename is not tried again for that name', () => {
    markAutoNamed('Untitled.md');
    noteAutoNameFailed('Untitled.md', 'Plan.md');
    expect(autoNameFailedBefore('Untitled.md', 'Plan.md')).toBe(true);
    expect(autoNameFailedBefore('Untitled.md', 'Plan 1.md')).toBe(false);
    forgetAutoName('Untitled.md');
    expect(isAutoNamed('Untitled.md')).toBe(false);
    expect(autoNameFailedBefore('Untitled.md', 'Plan.md')).toBe(false);
  });
});
