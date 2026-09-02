/**
 * Relative markdown images in the Files panel's WYSIWYG editor.
 *
 * The reported bug: opening `…/designs/final-design-v2.md` from a REMOTE
 * session's Files tab drew a tiny broken-image box for
 * `![Diagram one](option1-acme-gateway.png)`, even though the .png sits right
 * next to the .md and the file tree lists it. The editor emitted the src as
 * authored, so the browser resolved it against the SPA origin
 * (`http://localhost:3456/option1-acme-gateway.png`) and 404'd. The read-only
 * render never had the bug — `proxyImageSrcs()` rewrites those srcs — so this
 * pins the same policy for the editor path.
 *
 * The DANGEROUS half is the other direction. tiptap-markdown serializes an image
 * from `node.attrs.src`, so a resolver that mutated the attribute would make the
 * next ⌘S write `![alt](/api/local-image?path=%2F…)` into the user's file: a
 * corrupted document, strictly worse than a broken thumbnail. The last block
 * below pins the structural guards that keep the rewrite DOM-only. The full
 * proof — a real parse→serialize round trip through the production serializer —
 * lives in tests/web/notes-roundtrip/resolved-image-roundtrip.test.ts, which is
 * the only place tiptap-markdown resolves (web/node_modules).
 */
import { describe, it, expect } from 'vitest';
import Image from '@tiptap/extension-image';
import {
  resolveImageSrc,
  unproxyImageSrc,
  ResolvedImage,
  type ResolveImageSrcContext,
} from '@/components/notes/extensions/resolved-image';

const BASE = '/home/dev/repo/designs';

type AttrSpec = { default?: unknown; parseHTML?: (el: unknown) => unknown };

/**
 * The node's OWN declared attributes, with the parent Image node supplying the
 * inherited half — i.e. exactly what TipTap merges into the schema, without
 * standing up an editor.
 */
function imageAttributes(ctx: ResolveImageSrcContext = { baseDir: BASE }): Record<string, AttrSpec> {
  const parent = () => Image.config.addAttributes?.call(
    { name: 'image', options: {}, storage: {}, parent: undefined } as never,
  ) as Record<string, AttrSpec>;
  return ResolvedImage.config.addAttributes?.call(
    { name: 'image', options: { ...ctx }, storage: { ...ctx }, parent } as never,
  ) as Record<string, AttrSpec>;
}

/** Run the src attribute's parse rule over an `<img src="…">`. */
function parseSrc(src: string, ctx?: ResolveImageSrcContext): unknown {
  const spec = imageAttributes(ctx).src;
  return spec.parseHTML?.({ getAttribute: (n: string) => (n === 'src' ? src : null) });
}

describe('resolveImageSrc — pass-through', () => {
  it('leaves a data: URL alone (a pasted base64 image)', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    expect(resolveImageSrc(src, { baseDir: BASE })).toBe(src);
  });

  it('leaves http/https URLs alone', () => {
    expect(resolveImageSrc('http://example.com/a.png', { baseDir: BASE }))
      .toBe('http://example.com/a.png');
    expect(resolveImageSrc('https://example.com/a.png', { baseDir: BASE }))
      .toBe('https://example.com/a.png');
  });

  it('leaves a blob: URL alone', () => {
    const src = 'blob:http://localhost:3456/9f1c-42';
    expect(resolveImageSrc(src, { baseDir: BASE })).toBe(src);
  });

  it('leaves an existing /api/ URL alone — double-proxying would 404', () => {
    // The chat image store (a pasted image) and the proxy route itself.
    expect(resolveImageSrc('/api/images/abc.png', { baseDir: BASE })).toBe('/api/images/abc.png');
    const already = '/api/local-image?path=%2Fhome%2Fdev%2Fa.png';
    expect(resolveImageSrc(already, { baseDir: BASE })).toBe(already);
  });

  it('leaves a protocol-relative URL alone', () => {
    expect(resolveImageSrc('//cdn.example.com/a.png', { baseDir: BASE }))
      .toBe('//cdn.example.com/a.png');
  });

  it('leaves an empty src alone', () => {
    expect(resolveImageSrc('', { baseDir: BASE })).toBe('');
  });
});

describe('resolveImageSrc — absolute filesystem path', () => {
  it('proxies without a host', () => {
    expect(resolveImageSrc('/home/dev/repo/designs/a.png'))
      .toBe('/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fa.png');
  });

  it('proxies with a host', () => {
    expect(resolveImageSrc('/home/dev/repo/designs/a.png', { host: 'devbox' }))
      .toBe('/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fa.png&host=devbox');
  });

  it('needs no baseDir — an absolute path is already the answer', () => {
    expect(resolveImageSrc('/tmp/a.png', {}))
      .toBe('/api/local-image?path=%2Ftmp%2Fa.png');
  });
});

describe('resolveImageSrc — relative path against baseDir', () => {
  const decode = (url: string) =>
    decodeURIComponent(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('path') ?? '');

  it('resolves a bare filename beside the file', () => {
    expect(decode(resolveImageSrc('option1-acme-gateway.png', { baseDir: BASE })))
      .toBe('/home/dev/repo/designs/option1-acme-gateway.png');
  });

  it('resolves a ./-prefixed filename identically', () => {
    expect(decode(resolveImageSrc('./option1-acme-gateway.png', { baseDir: BASE })))
      .toBe('/home/dev/repo/designs/option1-acme-gateway.png');
  });

  it('resolves a subdirectory path', () => {
    expect(decode(resolveImageSrc('sub/a.png', { baseDir: BASE })))
      .toBe('/home/dev/repo/designs/sub/a.png');
  });

  it('climbs out with ../ instead of concatenating the segment', () => {
    const url = resolveImageSrc('../assets/a.png', { baseDir: BASE });
    expect(decode(url)).toBe('/home/dev/repo/assets/a.png');
    // The literal `..` must not survive into the path the server receives.
    expect(url).not.toContain('..');
  });

  it('climbs more than one level', () => {
    // designs → repo → dev, then down into img.
    expect(decode(resolveImageSrc('../../img/a.png', { baseDir: BASE })))
      .toBe('/home/dev/img/a.png');
  });

  it('clamps ../ at the filesystem root rather than escaping it', () => {
    expect(decode(resolveImageSrc('../../../../../../a.png', { baseDir: BASE })))
      .toBe('/a.png');
  });

  it('tolerates a trailing slash on baseDir', () => {
    expect(decode(resolveImageSrc('a.png', { baseDir: `${BASE}/` })))
      .toBe('/home/dev/repo/designs/a.png');
  });

  it('carries the host through', () => {
    expect(resolveImageSrc('a.png', { baseDir: BASE, host: 'devbox' }))
      .toBe('/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fa.png&host=devbox');
  });

  it('URL-encodes spaces and # in the path', () => {
    // `#` unencoded would truncate the query at the fragment; a space would
    // break the attribute. Both must survive the round trip to the server.
    const url = resolveImageSrc('my diagram #2.png', { baseDir: BASE });
    expect(url).toContain('%20');
    expect(url).toContain('%23');
    expect(url).not.toContain('#');
    expect(decode(url)).toBe('/home/dev/repo/designs/my diagram #2.png');
  });

  it('encodes a host that needs it', () => {
    expect(resolveImageSrc('a.png', { baseDir: BASE, host: 'my box' }))
      .toContain('&host=my%20box');
  });
});

describe('resolveImageSrc — no baseDir', () => {
  it('leaves a relative src exactly as authored (the Notes vault surface)', () => {
    expect(resolveImageSrc('a.png')).toBe('a.png');
    expect(resolveImageSrc('./a.png', {})).toBe('./a.png');
    expect(resolveImageSrc('sub/a.png', { host: 'devbox' })).toBe('sub/a.png');
  });

  it('treats a blank baseDir as absent', () => {
    expect(resolveImageSrc('a.png', { baseDir: '   ' })).toBe('a.png');
  });
});

/**
 * Serialization safety. Every assertion here is a structural guard whose failure
 * mode is "the next Save rewrites the user's markdown with a proxy URL".
 */
describe('ResolvedImage — the saved markdown keeps the authored src', () => {
  it('keeps the node name `image`', () => {
    // tiptap-markdown looks the image serializer up BY NAME (getMarkdownSpec →
    // markdownExtensions.find(e => e.name === …)). A renamed node falls through
    // to its generic markdownHTMLNode handler, which serializes a node by
    // calling renderHTML — i.e. it would write our proxy <img> into the file.
    expect(ResolvedImage.name).toBe('image');
  });

  it('keeps `src`\'s inherited null default — no invented src', () => {
    const attrs = imageAttributes();
    // A rewritten default or a getter here is how the proxy URL would reach the
    // document model; the only thing this node adds is the parse rule below.
    expect(attrs.src.default).toBe(null);
    expect(Object.keys(attrs.src).sort()).toEqual(['default', 'parseHTML']);
  });

  it('declares no markdown storage spec — the built-in `![alt](src)` writer stays', () => {
    const storage = ResolvedImage.config.addStorage?.call(
      { name: 'image', options: { baseDir: BASE, host: 'devbox' } } as never,
    ) as Record<string, unknown>;
    expect(storage).toEqual({ baseDir: BASE, host: 'devbox' });
    expect(storage).not.toHaveProperty('markdown');
  });

  it('resolves the DOM src while the attribute it was given is untouched', () => {
    const attrs = { src: 'option1-acme-gateway.png', alt: 'Diagram one' };
    const frozen = { ...attrs };
    const out = ResolvedImage.config.renderHTML?.call(
      {
        name: 'image',
        options: { HTMLAttributes: {}, baseDir: BASE, host: 'devbox' },
        storage: { baseDir: BASE, host: 'devbox' },
      } as never,
      { HTMLAttributes: attrs } as never,
    ) as [string, Record<string, string>];

    expect(out[0]).toBe('img');
    expect(out[1].src).toBe(
      '/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Foption1-acme-gateway.png&host=devbox',
    );
    // Same URL on data-lightbox-src + lazy loading, matching proxyImageSrcs().
    expect(out[1]['data-lightbox-src']).toBe(out[1].src);
    expect(out[1].loading).toBe('lazy');
    expect(out[1].alt).toBe('Diagram one');
    // renderHTML must not write back through the object it was handed.
    expect(attrs).toEqual(frozen);
  });

  it('emits no proxy attributes when there was nothing to resolve', () => {
    const out = ResolvedImage.config.renderHTML?.call(
      {
        name: 'image',
        options: { HTMLAttributes: {}, baseDir: BASE },
        storage: { baseDir: BASE },
      } as never,
      { HTMLAttributes: { src: 'https://example.com/a.png' } } as never,
    ) as [string, Record<string, string>];

    expect(out[1].src).toBe('https://example.com/a.png');
    expect(out[1]['data-lightbox-src']).toBeUndefined();
  });

  it('un-proxies on parse, so an internal copy/paste cannot write a proxy URL', () => {
    // ProseMirror's clipboard carries a text/html flavour built from renderHTML.
    // Pasting a copied image re-parses that HTML, so the parse rule is the only
    // thing standing between "user pressed ⌘C ⌘V" and a corrupted file.
    expect(parseSrc('/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fa.png'))
      .toBe('a.png');
    expect(parseSrc('/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fsub%2Fa.png'))
      .toBe('sub/a.png');
    // Outside baseDir there is no relative form — keep the absolute path.
    expect(parseSrc('/api/local-image?path=%2Ftmp%2Fa.png')).toBe('/tmp/a.png');
    // An authored src is passed through untouched.
    expect(parseSrc('a.png')).toBe('a.png');
    expect(parseSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(parseSrc('/api/images/a.png')).toBe('/api/images/a.png');
  });

  it('un-proxies with the host param, and refuses to when hosts differ', () => {
    const proxied = '/api/local-image?path=%2Fhome%2Fdev%2Frepo%2Fdesigns%2Fa.png&host=devbox';
    expect(unproxyImageSrc(proxied, { baseDir: BASE, host: 'devbox' })).toBe('a.png');
    // A picture on a DIFFERENT machine has no authored local form — leave the URL
    // alone rather than repoint it at this host's filesystem.
    expect(unproxyImageSrc(proxied, { baseDir: BASE })).toBe(proxied);
    expect(unproxyImageSrc(proxied, { baseDir: BASE, host: 'otherbox' })).toBe(proxied);
  });

  it('round-trips resolve → unproxy for every relative form', () => {
    for (const authored of ['a.png', 'sub/a.png', '/abs/a.png']) {
      const ctx = { baseDir: BASE, host: 'devbox' };
      expect(unproxyImageSrc(resolveImageSrc(authored, ctx), ctx))
        .toBe(authored === '/abs/a.png' ? '/abs/a.png' : authored);
    }
  });

  it('prefers editor.storage over the schema snapshot over the option', () => {
    // The editor is built once per mount, so a later baseDir can only arrive
    // through `editor.storage.image` — and that is the ONLY live object:
    // `extension.storage` is a getter the schema builder snapshots once.
    const render = (ctx: Record<string, unknown>) => (ResolvedImage.config.renderHTML?.call(
      { name: 'image', ...ctx } as never,
      { HTMLAttributes: { src: 'a.png' } } as never,
    ) as [string, Record<string, string>])[1].src;

    const options = { HTMLAttributes: {}, baseDir: '/opt' };
    expect(render({
      options,
      storage: { baseDir: '/snapshot' },
      editor: { storage: { image: { baseDir: '/live' } } },
    })).toBe('/api/local-image?path=%2Flive%2Fa.png');
    expect(render({ options, storage: { baseDir: '/snapshot' } }))
      .toBe('/api/local-image?path=%2Fsnapshot%2Fa.png');
    expect(render({ options })).toBe('/api/local-image?path=%2Fopt%2Fa.png');
  });
});
