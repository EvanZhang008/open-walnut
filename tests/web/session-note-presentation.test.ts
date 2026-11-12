import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
});
