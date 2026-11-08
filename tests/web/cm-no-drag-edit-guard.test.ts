/**
 * A pointer drag never edits a CodeMirror document (2026-11-08, a reviewer on Mac
 * WebKit: in the Files viewer's Source mode, a press inside a short selection and a
 * drag down to select more moved the selected text to the end of the next line, and
 * the file was saved to disk at once). CodeMirror starts a text drag-and-drop from a
 * press inside the selection; web/src/utils/cm-no-drag-edit.ts turns that press into a
 * new selection and refuses drops. This file pins the rule and lists every editor
 * construction in web/src from the source, so a new editor fails here until it
 * carries the extension.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// Resolved through web/: the repo root has no CodeMirror of its own.
import { EditorState } from '../../web/node_modules/@codemirror/state';
import { cmNoDragEdits } from '../../web/src/utils/cm-no-drag-edit';

const ROOT = path.resolve(__dirname, '../../web/src');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = sources(ROOT).map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

/** A file that builds a CodeMirror editor: a view, or a state a view will show. */
const BUILDS_EDITOR = /\bnew\s+EditorView\s*\(|\bEditorState\.create\s*\(/;

/** Files that build an editor and may let a drag edit it, with why. None today. */
const DRAG_EDIT_ALLOWED: Record<string, string> = {};

/** The editors known when this guard was written: a rename must update the list. */
const KNOWN_EDITORS = [
  'components/common/FileSourceEditor.tsx',
  'components/notes/RawMarkdownView.tsx',
];

describe('every CodeMirror editor in web/src refuses drag edits', () => {
  const editors = files.filter((f) => f.file !== 'utils/cm-no-drag-edit.ts' && BUILDS_EDITOR.test(f.text));

  it('finds the editors (the scan itself works)', () => {
    for (const known of KNOWN_EDITORS) expect(editors.map((e) => e.file)).toContain(known);
  });

  it.each(editors.map((e) => [e.file, e.text] as const))('%s carries cmNoDragEdits()', (file, text) => {
    if (DRAG_EDIT_ALLOWED[file]) return;
    expect(text, `${file} builds a CodeMirror editor without cmNoDragEdits(): a drag inside its selection moves text`)
      .toMatch(/import\s*\{[^}]*\bcmNoDragEdits\b[^}]*\}\s*from\s*'@\/utils\/cm-no-drag-edit'/);
    expect(text).toMatch(/\bcmNoDragEdits\(\)/);
  });
});

describe('cmNoDragEdits', () => {
  const doc = 'const value23 = 23;\nconst value24 = 24;';

  it.each(['move.drop', 'input.drop'])('refuses a %s transaction', (userEvent) => {
    const state = EditorState.create({ doc, extensions: [cmNoDragEdits()] });
    // The exact edit of the report: "co" deleted from line 1, put at the end of line 2.
    const tr = state.update({
      changes: [{ from: 0, to: 2 }, { from: doc.indexOf(';', 20), insert: 'co' }],
      userEvent,
    });
    expect(tr.state.doc.toString()).toBe(doc);
  });

  it('leaves typing and other edits alone', () => {
    const state = EditorState.create({ doc, extensions: [cmNoDragEdits()] });
    const tr = state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    expect(tr.state.doc.toString()).toBe(`x${doc}`);
  });
});

/**
 * The rich editor (TipTap, NotesEditor) is the other editor of the Files tab: markdown's
 * Preview. Every use of it outside the Notes pages, where a drag is the editor's own move,
 * passes `noDragEdits`, and a new use must say which it is.
 */
const NOTES_DRAG_IS_A_MOVE: Record<string, string> = {
  'components/notes/MarkdownEditorPanel.tsx': 'the Notes page: dragging text is a move the person makes on purpose',
  'components/notes/GlobalNotesSection.tsx': 'global notes: the same editor as the Notes page',
};

describe('every rich editor outside Notes refuses drag edits', () => {
  const uses = files.filter((f) => /<NotesEditor\b/.test(f.text));
  it('lists every use', () => {
    expect(uses.map((f) => f.file).sort()).toEqual(['components/common/FileMarkdownEditor.tsx', ...Object.keys(NOTES_DRAG_IS_A_MOVE)].sort());
  });
  for (const use of uses.filter((f) => !NOTES_DRAG_IS_A_MOVE[f.file])) {
    it(`${use.file} passes noDragEdits`, () => {
      for (const m of use.text.matchAll(/<NotesEditor\b[\s\S]*?\/>/g)) expect(m[0]).toMatch(/\bnoDragEdits\b/);
    });
  }
  it('NotesEditor refuses a drag start and a text drop when asked', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/notes/NotesEditor.tsx'), 'utf8');
    expect(src).toMatch(/handleDOMEvents: \{[\s\S]*?\.\.\.\(noDragEdits \? \{[\s\S]*?dragstart: \(_view(?:: unknown)?, event(?:: DragEvent)?\) => \{ event\.preventDefault\(\); return true; \}/);
    expect(src).toMatch(/if \(noDragEdits\) \{ event\.preventDefault\(\); return true; \}/);
  });
});
