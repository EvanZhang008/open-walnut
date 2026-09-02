/**
 * ResolvedImage — the DOM shows the proxied picture, the FILE keeps the relative path.
 *
 * The Files panel's WYSIWYG surface needs a relative `![alt](diagram.png)` to
 * render (resolve it against the .md's directory and go through
 * `/api/local-image`), and it must do that WITHOUT touching the document model:
 * tiptap-markdown serializes an image from `node.attrs.src`, so a resolver that
 * mutated the attribute would make the next ⌘S write
 * `![alt](/api/local-image?path=%2F…)` into the user's markdown file.
 *
 * This is the real proof rather than a structural one: it drives the production
 * parser and serializer (the same objects `NotesEditor` uses, via the headless
 * harness) over an extension set whose image node is `ResolvedImage`, and asserts
 * BOTH halves in one place — `getHTMLFromFragment` (what the editor paints) shows
 * the proxy URL, while `serializer.serialize` (what ⌘S writes) reproduces the
 * source bytes exactly.
 *
 * The harness is rebuilt locally instead of reusing `buildNotesExtensions()`
 * because the point is to swap ONE extension; the shared builder deliberately
 * mirrors the vault surface, which passes no baseDir.
 */
import { describe, it, expect } from 'vitest';
import {
  getSchema,
  resolveExtensions,
  generateJSON,
  type Extensions,
} from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { ResolvedImage } from '@/components/notes/extensions/resolved-image';

const BASE_DIR = '/home/dev/repo/designs';
const HOST = 'devbox';

/**
 * Same wiring as tests/web/notes-roundtrip/editor-harness.ts (see its header for
 * why the Markdown extension's onBeforeCreate is what builds the real
 * serializer/parser), trimmed to the extensions this case needs.
 */
function createHarness(imageExtension: Extensions[number]) {
  const extensions: Extensions = [
    StarterKit.configure({ link: false }),
    imageExtension,
    Markdown.configure({ html: true, transformPastedText: true, transformCopiedText: true }),
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' }),
  ];
  const schema = getSchema(extensions);
  const resolved = resolveExtensions(extensions);
  const fakeEditor = {
    schema,
    extensionManager: { extensions: resolved },
    options: { content: '' },
    storage: {} as Record<string, unknown>,
  } as any;

  const markdownExt = resolved.find((e: any) => e.name === 'markdown');
  if (!markdownExt) throw new Error('Markdown extension missing');
  (markdownExt.config.onBeforeCreate as (this: unknown) => void)
    .call({ editor: fakeEditor, options: markdownExt.options });
  const md = fakeEditor.storage.markdown as {
    parser: { parse(content: string): string };
    serializer: { serialize(doc: PMNode): string };
  };

  const mdToDoc = (input: string): PMNode =>
    schema.nodeFromJSON(generateJSON(md.parser.parse(input), extensions));

  return {
    schema,
    extensions,
    mdToDoc,
    /** Parse raw HTML the way a paste does (through the node's parse rules). */
    htmlToDoc: (html: string): PMNode => schema.nodeFromJSON(generateJSON(html, extensions)),
    docToMd: (doc: PMNode) => md.serializer.serialize(doc),
    roundTrip: (input: string) => md.serializer.serialize(mdToDoc(input)),
    /**
     * The `<img>` the editor actually paints, as an attribute map. Built with
     * ProseMirror's own DOMSerializer over the real schema (so it runs the node's
     * renderHTML), NOT via `getHTMLFromFragment` — that helper needs
     * `document.implementation.createHTMLDocument`, which the linkedom shim does
     * not provide. Reading attributes off the element also sidesteps HTML-entity
     * escaping in the serialized string.
     */
    paintedImage: (doc: PMNode): Record<string, string> => {
      const container = document.createElement('div');
      container.appendChild(
        DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document }),
      );
      const img = container.querySelector('img');
      if (!img) throw new Error('no <img> painted');
      const out: Record<string, string> = {};
      for (const attr of Array.from(img.attributes)) out[attr.name] = attr.value;
      return out;
    },
  };
}

const resolving = createHarness(
  ResolvedImage.configure({ inline: true, allowBase64: true, baseDir: BASE_DIR, host: HOST }),
);
const plain = createHarness(ResolvedImage.configure({ inline: true, allowBase64: true }));

/** The reported document, with neutral names. */
const RELATIVE_IMAGE_MD =
  '![Option one: gateway plus sync. Yellow = queue, blue = worker.](option1-acme-gateway.png)';

const paint = (md: string) => resolving.paintedImage(resolving.mdToDoc(md));

describe('ResolvedImage: rendered DOM', () => {
  it('proxies a relative src through /api/local-image with the host', () => {
    const img = paint(RELATIVE_IMAGE_MD);
    expect(img.src).toBe(
      '/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Foption1-acme-gateway.png&host=devbox',
    );
    expect(img.loading).toBe('lazy');
    expect(img['data-lightbox-src']).toBe(img.src);
    // The alt text (which the user wrote) survives into the DOM.
    expect(img.alt).toContain('Option one: gateway plus sync');
  });

  it('resolves ../ up a level and a subdirectory down', () => {
    expect(paint('![](../assets/logo.png)').src)
      .toContain('path=%2Fhome%2Fdev%2Frepo%2Fassets%2Flogo.png');
    expect(paint('![](img/logo.png)').src)
      .toContain('path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fimg%2Flogo.png');
  });

  it('leaves a remote URL and an /api/ URL as authored', () => {
    expect(paint('![](https://example.com/a.png)').src).toBe('https://example.com/a.png');
    expect(paint('![](/api/images/a.png)').src).toBe('/api/images/a.png');
  });

  it('with no baseDir (the Notes vault surface) paints the src untouched', () => {
    const img = plain.paintedImage(plain.mdToDoc(RELATIVE_IMAGE_MD));
    expect(img.src).toBe('option1-acme-gateway.png');
    expect(img['data-lightbox-src']).toBeUndefined();
  });
});

describe('ResolvedImage: the saved file', () => {
  it('round-trips the reported line byte-for-byte', () => {
    expect(resolving.roundTrip(RELATIVE_IMAGE_MD)).toBe(RELATIVE_IMAGE_MD);
  });

  it('is idempotent — repeated saves cannot drift', () => {
    const once = resolving.roundTrip(RELATIVE_IMAGE_MD);
    expect(resolving.roundTrip(once)).toBe(once);
  });

  it('keeps every relative form exactly as authored', () => {
    for (const md of [
      '![](a.png)',
      '![alt](./a.png)',
      '![alt](sub/a.png)',
      '![alt](../assets/a.png)',
      '![alt](/abs/path/a.png)',
      '![alt](https://example.com/a.png)',
      '![alt](/api/images/a.png)',
    ]) {
      expect(resolving.roundTrip(md), md).toBe(md);
      // Belt and braces: the proxy URL must never appear in written bytes.
      expect(resolving.roundTrip(md)).not.toContain('/api/local-image');
    }
  });

  it('keeps attrs.src as authored in the document model itself', () => {
    const doc = resolving.mdToDoc(RELATIVE_IMAGE_MD);
    const srcs: unknown[] = [];
    doc.descendants((node) => { if (node.type.name === 'image') srcs.push(node.attrs.src); });
    expect(srcs).toEqual(['option1-acme-gateway.png']);
  });

  it('survives a copy/paste of the painted DOM (the only way back in)', () => {
    // ProseMirror's clipboard carries a text/html flavour serialized from
    // renderHTML — i.e. the PROXIED src. Re-parsing that HTML is exactly what a
    // paste does, so the src parse rule has to map it back to the authored form
    // or the next save writes `![](/api/local-image?…)` to disk.
    const doc = resolving.mdToDoc(RELATIVE_IMAGE_MD);
    const painted = resolving.paintedImage(doc);
    expect(painted.src).toContain('/api/local-image');

    const reparsed = resolving.htmlToDoc(`<p><img src="${painted.src}" alt="Option one"></p>`);
    const srcs: unknown[] = [];
    reparsed.descendants((node) => { if (node.type.name === 'image') srcs.push(node.attrs.src); });
    expect(srcs).toEqual(['option1-acme-gateway.png']);
    expect(resolving.docToMd(reparsed)).toBe('![Option one](option1-acme-gateway.png)');
  });
});
