/**
 * tiptap throws on `editor.view` until EditorContent has mounted the view, so reading it while a
 * component renders (a useMemo or a lazy useState initializer) breaks the render of any editor
 * opened at once: 2026-11-14, New note opened its note in the same render and NotesBubbleMenu's
 * `useMemo(() => ({ current: editor.view.dom }))` threw ("The editor view is not available"),
 * which React reported as a concurrent rendering error. Read it in an effect, a handler, or
 * through editorDomOf (web/src/components/notes/editor-dom.ts).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editorDomOf } from '../../web/src/components/notes/editor-dom';

const ROOT = join(__dirname, '../..');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? files(p) : /\.(tsx?)$/.test(e.name) ? [p] : [];
});
/** A memo or lazy state initializer whose body reads `<something>.view` on an editor. */
const IN_RENDER = /use(Memo|State)\(\s*\(\)\s*=>[^;]*?\beditor\??\.view\b/;

describe('no render reads a tiptap editor view', () => {
  it('no useMemo or useState initializer in web/src reads editor.view', () => {
    const offenders = files(join(ROOT, 'web/src')).filter((f) => IN_RENDER.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('editorDomOf answers null for an editor whose view is not mounted, and for a destroyed one', () => {
    const unmounted = { isDestroyed: false, get view(): never { throw new Error('[tiptap error]: The editor view is not available.'); } };
    expect(editorDomOf(unmounted as never)).toBeNull();
    expect(editorDomOf({ isDestroyed: true } as never)).toBeNull();
    const dom = { tagName: 'DIV' };
    expect(editorDomOf({ isDestroyed: false, view: { dom } } as never)).toBe(dom);
  });
});
