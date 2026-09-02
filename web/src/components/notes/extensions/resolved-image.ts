/**
 * ResolvedImage — the Image node that can render a RELATIVE markdown image.
 *
 * Why this exists: a markdown file opened from the Files panel lives at some
 * host path (`…/designs/final-design-v2.md`) and references its picture the way
 * a markdown author naturally does — `![alt](diagram.png)`, a path relative to
 * the file. The read-only render already handles that (`proxyImageSrcs()` in
 * `web/src/utils/markdown.ts` rewrites the src to `/api/local-image?path=…`),
 * but the WYSIWYG surface — the DEFAULT body for an editable .md — used a bare
 * `Image.configure(...)`, so the browser resolved `diagram.png` against the SPA
 * origin (`http://localhost:3456/diagram.png`) and drew a broken-image box.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────────
 * The rewrite is DOM-ONLY. `attrs.src` keeps the path the author typed, because
 * that attribute IS the saved file: tiptap-markdown serializes an image with
 * prosemirror-markdown's `image` node spec, which writes `![alt](node.attrs.src)`
 * verbatim. Mutating `attrs.src` to the proxy URL would make the next ⌘S write
 * `![alt](/api/local-image?path=%2F…)` into the user's markdown — a corrupted
 * file, strictly worse than a broken thumbnail. So the resolution happens in
 * `renderHTML` (the DOM the editor paints) and nowhere else.
 *
 * Three details keep that guarantee, and all three are load-bearing:
 *  1. **The node name stays `image`.** tiptap-markdown looks its serializer up
 *     BY NAME (`getMarkdownSpec` → `markdownExtensions.find(e => e.name === …)`).
 *     Renaming the node to `resolvedImage` would silently fall through to its
 *     generic `markdownHTMLNode` handler, which serializes a node by calling
 *     `renderHTML` — i.e. it would write our proxy URL into the file, the exact
 *     bug we are avoiding. `Image.extend()` inherits the name; never override it.
 *  2. **`src` keeps the parent's `{ default: null }`** — no rewritten default, no
 *     getter. Nothing in the node's own definition invents a src.
 *  3. **The `src` parse rule un-proxies** (`unproxyImageSrc`). There is exactly
 *     one way a proxy URL can get back INTO the model: an internal copy/paste.
 *     ProseMirror's clipboard carries a `text/html` flavour serialized from
 *     `renderHTML` — so pasting a copied image would otherwise parse the proxy
 *     URL straight into `attrs.src`, and the next save would write it to disk.
 *     (tiptap-markdown's `transformCopiedText` only owns the `text/plain`
 *     flavour, so it cannot cover this.)
 *
 * `baseDir` unset ⇒ every src is left exactly as authored, which is the Notes
 * vault's existing behaviour (its images are `/api/images/…` or `![[embeds]]`).
 */
import { mergeAttributes, type Editor } from '@tiptap/core';
import Image, { type ImageOptions } from '@tiptap/extension-image';

/** Where a proxied src points. Mirrors `proxyImageSrcs()` in utils/markdown.ts. */
const PROXY_ROUTE = '/api/local-image';

/** Schemes that are already a complete reference — never a filesystem path. */
const PASSTHROUGH_SCHEME = /^(?:data|blob|https?):/i;

export interface ResolveImageSrcContext {
  /**
   * Directory the markdown file lives in, used to resolve a relative src.
   * Absent ⇒ relative srcs are left untouched.
   */
  baseDir?: string;
  /** Remote exec host the file came from; rides along as `&host=`. */
  host?: string;
}

/**
 * Join `rel` onto `baseDir`, resolving `.` and `..` SEGMENT-wise.
 *
 * Segment-wise, not string-concatenation: `../sibling/a.png` has to actually
 * climb out of the file's directory, and a concatenated `dir/../sibling/a.png`
 * would be handed to the server as a traversal-looking path. `..` past the root
 * clamps at the root (same as `path.resolve`).
 */
function joinPath(baseDir: string, rel: string): string {
  const rooted = baseDir.startsWith('/');
  const segments: string[] = [];
  for (const part of `${baseDir}/${rel}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  return (rooted ? '/' : '') + segments.join('/');
}

/**
 * The whole policy, as a pure function (so it is testable without TipTap).
 *
 * Returns the src UNCHANGED whenever there is nothing to resolve — callers use
 * that identity to decide whether to stamp the proxy-only attributes.
 */
export function resolveImageSrc(src: string, ctx: ResolveImageSrcContext = {}): string {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw) return src;
  // Already a complete reference: data:/blob: payloads, remote URLs, a
  // protocol-relative URL, or a Walnut API URL (which includes the proxy route
  // itself — double-proxying an already-resolved src would 404).
  if (PASSTHROUGH_SCHEME.test(raw)) return src;
  if (raw.startsWith('//')) return src;
  if (raw.startsWith('/api/')) return src;

  let absPath: string;
  if (raw.startsWith('/')) {
    absPath = joinPath('/', raw);
  } else {
    const baseDir = ctx.baseDir?.trim();
    // No containing directory known (the Notes vault surface) — leave it alone.
    if (!baseDir) return src;
    absPath = joinPath(baseDir, raw);
  }

  const hostParam = ctx.host ? `&host=${encodeURIComponent(ctx.host)}` : '';
  return `${PROXY_ROUTE}?path=${encodeURIComponent(absPath)}${hostParam}`;
}

/**
 * Reverse of `resolveImageSrc`, for the copy/paste channel described in the file
 * header. Maps a proxy URL back to the RELATIVE form when it points inside
 * `baseDir`, else to the plain absolute path; both are forms a human could have
 * authored, and both render identically through this node.
 *
 * Leaves the URL alone when it addresses a DIFFERENT host than the file being
 * edited — there is no authored form for "a file on another machine", and
 * un-proxying it would silently repoint the image at a local path.
 */
export function unproxyImageSrc(src: string | null | undefined, ctx: ResolveImageSrcContext = {}): string {
  const raw = typeof src === 'string' ? src : '';
  const prefix = `${PROXY_ROUTE}?`;
  if (!raw.startsWith(prefix)) return raw;

  const params = new URLSearchParams(raw.slice(prefix.length));
  const absPath = params.get('path') ?? '';
  if (!absPath.startsWith('/')) return raw;
  if ((params.get('host') ?? '') !== (ctx.host ?? '')) return raw;

  const baseDir = ctx.baseDir?.trim();
  if (baseDir?.startsWith('/')) {
    const dir = `${joinPath('/', baseDir)}/`;
    if (absPath.startsWith(dir)) return absPath.slice(dir.length);
  }
  return absPath;
}

export interface ResolvedImageOptions extends ImageOptions {
  baseDir?: string;
  host?: string;
}

/**
 * Live values, mutable from outside. The editor instance is created ONCE per
 * mount (`useEditor` with no deps, and `setOptions` never rebuilds the extension
 * manager), so an option captured at configure time can never change afterwards
 * — but `editor.storage.image` can, and a later `baseDir`/`host` still has to
 * reach `renderHTML`. Same pattern the `![[embed]]` NodeView uses for `notePath`
 * (see NotesEditor's storage effect).
 */
export interface ResolvedImageStorage {
  baseDir?: string;
  host?: string;
}

declare module '@tiptap/core' {
  interface Storage {
    /**
     * The `image` node's storage. OPTIONAL and possibly empty: the plain
     * `@tiptap/extension-image` declares no storage at all (Notes surfaces get
     * `{}`), only `ResolvedImage` fills these in.
     */
    image?: ResolvedImageStorage;
  }
}

/**
 * Which dir/host to resolve against, newest source first.
 *
 * The subtlety worth knowing: `this.storage` inside a node's
 * renderHTML/addAttributes is NOT the live storage object. `@tiptap/core`'s
 * `extension.storage` is a GETTER that rebuilds a fresh object on every access,
 * and the schema builder (`getSchemaByResolvedExtensions`) snapshots it ONCE — so
 * a later mutation is invisible there. `editor.storage` (a.k.a.
 * `editor.extensionStorage`) IS the single object the editor hands around, and
 * the one NotesEditor mutates, so read that first. Fall back to the schema-time
 * snapshot (headless use with no editor), then to the configure-time options.
 */
function liveSrcContext(ctx: {
  editor?: Editor;
  storage?: ResolvedImageStorage;
  options: ResolvedImageOptions;
}): ResolveImageSrcContext {
  const store = ctx.editor?.storage.image ?? ctx.storage;
  return {
    baseDir: store && 'baseDir' in store ? store.baseDir : ctx.options.baseDir,
    host: store && 'host' in store ? store.host : ctx.options.host,
  };
}

export const ResolvedImage = Image.extend<ResolvedImageOptions, ResolvedImageStorage>({
  // NOTE: no `name` override on purpose — see rule (1) in the header comment.
  addOptions() {
    return {
      ...this.parent?.(),
      baseDir: undefined,
      host: undefined,
    } as ResolvedImageOptions;
  },

  addStorage() {
    return { baseDir: this.options.baseDir, host: this.options.host };
  },

  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Record<string, Record<string, unknown>>;
    // Captured lazily (a closure, not a value) so the parse rule reads whatever
    // dir the editor holds at PASTE time, not at schema-build time.
    const self = this;
    return {
      ...parent,
      src: {
        // Parent's `{ default: null }` kept verbatim — see rule (2) in the header.
        ...(parent.src ?? {}),
        parseHTML: (element: HTMLElement) => unproxyImageSrc(
          element.getAttribute('src'),
          liveSrcContext({ editor: self.editor, storage: self.storage, options: self.options }),
        ),
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    const src = typeof attrs.src === 'string' ? attrs.src : '';
    if (!src) return ['img', attrs];

    const resolved = resolveImageSrc(src, liveSrcContext(this));
    // Untouched src ⇒ nothing was proxied, so don't stamp the proxy-only
    // attributes (keeps parity with proxyImageSrcs, which also only marks the
    // images it actually rewrote).
    if (resolved === src) return ['img', attrs];
    return ['img', { ...attrs, src: resolved, loading: 'lazy', 'data-lightbox-src': resolved }];
  },
});
