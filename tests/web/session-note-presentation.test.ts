import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { tidyNote } from '../../web/src/components/sessions/SessionNotes';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const sessions = path.join(root, 'web/src/components/sessions');
const note = readFileSync(path.join(sessions, 'SessionNotes.tsx'), 'utf8');
const css = readFileSync(path.join(root, 'web/src/styles/globals.css'), 'utf8');

describe('session note presentation', () => {
  it('labels reference notes, without presenting an unexplained delivery dot', () => {
    expect(note).toContain('aria-label="Session note"');
    expect(note).toContain("{expanded ? 'Done' : 'Edit'}");
    expect(note).not.toContain('session-notes-dot');
    expect(css).not.toContain('.session-notes-dot');
  });

  it('keeps every human_note rendering behind the shared note component', () => {
    const renderers = readdirSync(sessions)
      .filter(name => name.endsWith('.tsx') && name !== 'SessionNotes.tsx')
      .filter(name => /session-notes-(?:preview|editor|textarea|dot)/.test(readFileSync(path.join(sessions, name), 'utf8')));
    expect(renderers).toEqual([]);
  });

  it('removes the focused editor frame rather than adding another colored frame', () => {
    const focus = css.match(/\.session-notes \.session-notes-textarea:focus\s*\{([^}]+)\}/)?.[1];
    expect(focus).toContain('border: none');
    expect(focus).toContain('outline: none');
    expect(focus).toContain('box-shadow: none');
  });

  it('puts every SessionNotesBar in a composer card, as its noteSlot', () => {
    // Every web file that mounts the bar, found from the source: a new surface that
    // draws the note beside the composer instead of inside it fails here.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (e.name.endsWith('.tsx')) files.push(p);
      }
    };
    walk(path.join(root, 'web/src'));
    const mounts = files.flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      // The text from the nearest <ChatInput before the mount up to the mount.
      return [...src.matchAll(/<SessionNotesBar\b/g)].map((m) => {
        const head = src.slice(0, m.index);
        const open = head.lastIndexOf('<ChatInput');
        return { f: path.relative(root, f), before: open < 0 ? '' : head.slice(open) };
      });
    });
    expect(mounts.map((m) => m.f).sort()).toEqual([
      'web/src/components/sessions/SessionPanel.tsx',
      'web/src/components/sessions/SideQuestionDrawer.tsx',
    ]);
    // Each mount is the noteSlot of the ChatInput it sits in: that ChatInput's
    // opening tag has not closed before the mount, and noteSlot is the last prop
    // started before it.
    for (const m of mounts) {
      expect(m.before, m.f).not.toBe('');
      expect(m.before.length, m.f).toBeLessThan(6000);
      expect(m.before.slice(m.before.lastIndexOf('={')), m.f).not.toMatch(/\n\s*\/>/);
      expect(m.before.match(/\b(\w+)=\{[^=]*$/)?.[1], m.f).toBe('noteSlot');
    }
  });

  it('tidies a closed note: no blank lines before it, no whitespace after it', () => {
    expect(tidyNote('\n  \n\nnext\n\n\n2. plan  \n\n')).toBe('next\n\n\n2. plan');
    expect(tidyNote('  indented first line\nsecond \n')).toBe('  indented first line\nsecond');
    expect(tidyNote('\r\nwindows\r\n')).toBe('windows');
    expect(tidyNote('')).toBe('');
    expect(tidyNote(' \n \n')).toBe('');
  });

  it('never lets the note editor scroll sideways', () => {
    const rule = css.match(/\.session-notes-textarea \{([^}]+)\}/)?.[1] ?? '';
    expect(rule).toContain('overflow-x: hidden');
    expect(rule).toContain('max-height');
  });
});
