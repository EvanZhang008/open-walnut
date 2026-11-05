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
 *     (the markdown copy serializer in markdown-copy.ts only owns the
 *     `text/plain` flavour, so it cannot cover this.)
 *
 * Two places a relative src can be relative TO:
 *  - `baseDir` (the Files panel): a host directory, served by `/api/local-image`.
 *  - `notePath` (a Notes vault note): the note's folder in the vault, served by
 *    the notes attachment route, which resolves it beside the note first and
 *    percent-decodes it (`![](Untitled%201.jpeg)`, how Notion exports write it).
 *    Every Notes surface edits through this node (2026-11-05: the vault used the
 *    plain Image node, so every `![](photo.jpeg)` in a note drew nothing).
 * Neither set ⇒ a relative src is left exactly as authored.
 */
import { mergeAttributes, type Editor } from '@tiptap/core';
import Image, { type ImageOptions } from '@tiptap/extension-image';
import {
  claimLoad, drawnUrl, failureOf, knownUndrawable, noteDrawn, noteMissing, onPageReturn, recentlyMissing, retryDue,
  settleLoad,
} from '../image-load';

/** Where a proxied src points. Mirrors `proxyImageSrcs()` in utils/markdown.ts. */
const PROXY_ROUTE = '/api/local-image';
/** Where a vault note's relative image points (attachmentUrl in api/notes-v2.ts). */
const VAULT_ROUTE = '/api/notes-v2/attachment';

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
  /**
   * Vault path of the note being edited (`Areas/Trips/Plan.md`). Set (and no
   * `baseDir`) ⇒ a relative src resolves in the vault beside this note.
   */
  notePath?: string;
  /**
   * Pane reload generation, folded into the URL as `&r=`. An `<img src>` that
   * stays byte-identical is served from the browser's per-document memory cache
   * without a request — WebKit in particular never re-asks for a URL it has
   * already loaded in this document, whatever `Cache-Control` said — so a
   * diagram the agent regenerated kept its OLD pixels through every Refresh.
   * A token that moves with the reload makes each Refresh a new URL.
   */
  version?: string | number;
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
 * A vault note's image URL. `exact`: `note` asks only beside the note, `vault`
 * only that vault path, and `decode=0` only this spelling (the server's
 * ResolveOptions), so the URL that drew names exactly one file. `written` is
 * the src as the note wrote it, kept for a paste back into the same note.
 */
function vaultUrl(path: string, note: string, exact: 'note' | 'vault', written = path): string {
  const params: Record<string, string> = { path, note, exact, decode: '0' };
  if (written !== path) params.w = written;
  return `${VAULT_ROUTE}?${new URLSearchParams(params)}`;
}

/**
 * The spellings a relative src may stand for, likeliest first: percent-decoded
 * (a markdown image cannot hold a space, so `Untitled%201.jpeg` means the file
 * `Untitled 1.jpeg`), then as written (`%` is a legal file name character).
 */
function srcSpellings(raw: string): string[] {
  if (!raw.includes('%')) return [raw];
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? [raw] : [decoded, raw];
  } catch {
    return [raw];
  }
}

/** The file name a src names, decoded for reading (`Untitled%201.jpeg` → `Untitled 1.jpeg`). */
function decodeName(src: string): string {
  const base = src.split(/[?#]/)[0].split('/').pop() ?? '';
  try { return decodeURIComponent(base); } catch { return base; }
}

/** The path of a `file:///Users/x/a%20b.png` URL, decoded; null for anything else. */
function fileUrlPath(raw: string): string | null {
  const m = /^file:\/\/(?:localhost)?(\/[^?#]*)/i.exec(raw);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
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
  const fileUrl = fileUrlPath(raw);
  if (fileUrl) {
    absPath = joinPath('/', fileUrl);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // Some other scheme (obsidian:, mailto:): not a file this page can draw.
    return src;
  } else if (raw.startsWith('/')) {
    absPath = joinPath('/', raw);
  } else {
    const baseDir = ctx.baseDir?.trim();
    if (!baseDir) {
      const notePath = ctx.notePath?.trim();
      if (!notePath) return src;
      // The server joins it onto the note's folder and decodes it: one rule for
      // the web, the phone app and the companion's copy. A markdown image names
      // one file, never "that name anywhere": beside the note first, then the
      // same path from the vault's root (resolveImageCandidates).
      return vaultUrl(srcSpellings(raw)[0], notePath, 'note', raw);
    }
    absPath = joinPath(baseDir, raw);
  }

  const hostParam = ctx.host ? `&host=${encodeURIComponent(ctx.host)}` : '';
  const versionParam = ctx.version != null && ctx.version !== '' && ctx.version !== 0
    ? `&r=${encodeURIComponent(String(ctx.version))}`
    : '';
  return `${PROXY_ROUTE}?path=${encodeURIComponent(absPath)}${hostParam}${versionParam}`;
}

/** `path`, `note` and `exact` of a vault attachment URL (relative, or on this page's origin), else null. */
function vaultPathOf(raw: string): { path: string; note: string; exact: string; decode: string; written: string } | null {
  let url = raw.replace(/&amp;/g, '&');
  const origin = typeof location !== 'undefined' ? location.origin : '';
  if (origin && url.startsWith(origin + '/')) url = url.slice(origin.length);
  if (!url.startsWith(`${VAULT_ROUTE}?`)) return null;
  const params = new URLSearchParams(url.slice(VAULT_ROUTE.length + 1));
  const path = params.get('path') ?? '';
  const note = params.get('note') ?? '';
  return path && note
    ? { path, note, exact: params.get('exact') ?? '', decode: params.get('decode') ?? '', written: params.get('w') ?? path }
    : null;
}

/**
 * The vault file a markdown image URL names, when the URL asks one place only
 * (`exact=note` or `exact=vault`); null when the server may pick (an embed, or
 * `exact=1`, beside the note or the vault path).
 */
export function vaultFileOf(url: string): string | null {
  const v = vaultPathOf(url);
  // Only a URL that asked one place and one spelling names one file.
  if (!v || v.decode !== '0') return null;
  if (v.exact === 'note') return joinPath('', `${dirOf(v.note)}/${v.path}`) || null;
  if (v.exact === 'vault') return joinPath('', v.path) || null;
  return null;
}

/** How note `toNote` writes an image that names the vault file `file`. */
export function imageSrcForFile(file: string, toNote: string): string {
  return relativeVaultPath(file, dirOf(toNote));
}

function dirOf(notePath: string): string {
  const i = notePath.lastIndexOf('/');
  return i < 0 ? '' : notePath.slice(0, i);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * `target` (a vault path) as seen from the folder `fromDir`, written the way a
 * markdown image can hold it: a space or a parenthesis would end the link, so
 * those (and `%`) are percent-encoded; the server decodes them back.
 */
function relativeVaultPath(target: string, fromDir: string): string {
  const to = target.split('/').filter(Boolean);
  const from = fromDir.split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const parts = [...from.slice(shared).map(() => '..'), ...to.slice(shared)];
  return parts.map((p) => (p === '..' ? p : p.replace(/[% ()]/g, (c) => encodeURIComponent(c).replace('(', '%28').replace(')', '%29')))).join('/');
}

/**
 * A relative image src written in note `fromNote`, as the note `toNote` must
 * write it to name the same file. Anything not relative to its note (a URL, an
 * absolute path, an /api/ URL) is returned unchanged.
 */
export function rebaseImageSrc(src: string, fromNote: string, toNote: string): string {
  const raw = src.trim();
  if (!raw || fromNote === toNote) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('//')) return src;
  return relativeVaultPath(joinPath('', `${dirOf(fromNote)}/${safeDecode(raw)}`), dirOf(toNote));
}

/**
 * Every URL the picture may be at, best first; `resolveImageSrc` is the first.
 * In a vault note a relative src is beside the note, else the same path from the
 * vault's root (`Travel/shared/map.png`, how Obsidian's "absolute path" setting
 * writes one). A src starting with `/` is either a path from the vault's root
 * (`/Travel/shared/map.png`) or a file on this machine: both are asked, the
 * vault first.
 */
export function resolveImageCandidates(src: string, ctx: ResolveImageSrcContext = {}): string[] {
  const first = resolveImageSrc(src, ctx);
  const raw = typeof src === 'string' ? src.trim() : '';
  const notePath = ctx.notePath?.trim();
  if (!notePath || ctx.baseDir?.trim() || first === src) return [first];
  const spellings = srcSpellings(raw);
  const at = (exact: 'note' | 'vault') => spellings.map((p) => vaultUrl(p, notePath, exact, raw));
  if (vaultPathOf(first)?.exact === 'note') return [...at('note'), ...at('vault')];
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/api/')) {
    return [...at('vault'), first];
  }
  return [first];
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
  const vault = vaultPathOf(raw);
  if (vault) {
    // A vault image copied inside this note keeps the path it was written with;
    // pasted into another note it becomes the path from THAT note's folder, so
    // the saved markdown never holds an /api/ URL (2026-11-05 review). A surface
    // with no note of its own keeps the URL, which works from anywhere.
    // The URL names the file it drew (vaultFileOf), so the paste names that
    // file, wherever the path as written would point from the new note.
    const here = ctx.notePath?.trim();
    if (!here) return raw;
    if (vault.note === here) return vault.written;
    const file = vaultFileOf(raw);
    if (file) return imageSrcForFile(file, here);
    if (vault.path.startsWith('/')) return raw;
    return rebaseImageSrc(vault.path, vault.note, here);
  }
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
  notePath?: string;
  version?: string | number;
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
  notePath?: string;
  version?: string | number;
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
    notePath: store && 'notePath' in store ? store.notePath : ctx.options.notePath,
    version: store && 'version' in store ? store.version : ctx.options.version,
  };
}

export const ResolvedImage = Image.extend<ResolvedImageOptions, ResolvedImageStorage>({
  // NOTE: no `name` override on purpose — see rule (1) in the header comment.
  // Pictures move by cut and paste: a press on one selects it (image-zoom.ts),
  // so a drag affordance would only promise what it cannot do.
  draggable: false,
  addOptions() {
    return {
      ...this.parent?.(),
      baseDir: undefined,
      host: undefined,
      notePath: undefined,
      version: undefined,
    } as ResolvedImageOptions;
  },

  addStorage() {
    return {
      baseDir: this.options.baseDir,
      host: this.options.host,
      notePath: this.options.notePath,
      version: this.options.version,
    };
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

  /**
   * The painted image, with what a broken one becomes. A browser draws a missing
   * picture as nothing (WebKit, with no alt) or a tiny glyph, so a note whose
   * image moved looked like a note with no image at all. The node view shows a
   * card naming the file instead, and is a plain DOM view (no React) because a
   * note can hold hundreds of them. `renderHTML` below stays the clipboard and
   * getHTML form.
   */
  addNodeView() {
    const options = this.options;
    return ({ node: initial, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'notes-image';
      const img = document.createElement('img');
      img.draggable = false;
      dom.append(img);
      let current = initial;
      let src = '';

      // Where the picture may be, tried in order (resolveImageCandidates); the
      // view remembers how far it got for the src it shows, so a repaint (a
      // selection change, an edit nearby) never brings back a picture that
      // already failed as a broken-image glyph (2026-11-05 review). A failure
      // older than a few seconds is asked again on the next repaint, so a file
      // put back shows without reopening the note (image-load.ts).
      let tried = '';
      let at = 0;
      let candidates: string[] = [];
      let failed = false;
      let failedAt = 0;
      /** The URL this view's <img> is loading for every view waiting on it (claimLoad). */
      let loading = '';
      let destroyed = false;
      /** While a missing card shows: ask again when the user comes back to the page. */
      let stopReturn: (() => void) | null = null;

      const card = document.createElement('span');
      card.className = 'notes-image-missing';
      card.hidden = true;
      dom.append(card);
      /** The card a picture that cannot draw becomes: missing, or here but not drawable. */
      const showCard = (kind: 'missing' | 'undrawable', url = '') => {
        if (kind === 'missing' && !stopReturn) {
          stopReturn = onPageReturn(() => {
            if (!destroyed && failed && retryDue(failedAt)) tryFrom(0);
          });
        }
        failed = true;
        failedAt = Date.now();
        dom.classList.add('is-missing');
        img.hidden = true;
        img.removeAttribute('data-lightbox-src');
        card.hidden = false;
        const attrs = current.attrs as { alt?: string | null };
        const name = decodeName(src) || attrs.alt || 'image';
        // Rebuilt only when what it says changes: a retry that fails again while
        // the user clicks the card must not pull the clicked element out from
        // under the press (ProseMirror then lost the next click, 2026-11-05).
        const says = `${kind}\n${name}\n${url}\n${src}`;
        if (card.dataset.says === says) return;
        card.dataset.says = says;
        card.textContent = '';
        const icon = document.createElement('span');
        icon.className = 'notes-image-missing-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = kind === 'missing' ? '!' : '\u2193';
        const label = document.createElement('span');
        label.className = 'notes-image-missing-label';
        label.textContent = kind === 'missing' ? 'Image not found' : "Can't preview here";
        const file = document.createElement('span');
        file.className = 'notes-image-missing-name';
        file.textContent = name;
        card.append(icon, label, file);
        if (kind === 'undrawable' && url) {
          // The file is there; this browser cannot draw its type (HEIC, TIFF).
          const download = document.createElement('a');
          download.className = 'notes-image-download';
          download.href = url;
          download.download = name;
          download.textContent = 'Download';
          card.append(download);
        }
        card.title = src;
      };
      const showPicture = () => {
        stopReturn?.();
        stopReturn = null;
        failed = false;
        dom.classList.remove('is-missing');
        img.hidden = false;
        card.hidden = true;
      };
      /** Point the <img> at the next candidate not seen missing a moment ago. */
      const tryFrom = (index: number) => {
        at = index;
        while (at < candidates.length && recentlyMissing(candidates[at])) at++;
        if (at >= candidates.length) {
          img.removeAttribute('src');
          showCard('missing');
          return;
        }
        const url = candidates[at];
        if (knownUndrawable(url)) {
          img.removeAttribute('src');
          showCard('undrawable', url);
          const note = liveSrcContext({ editor, options }).notePath?.trim();
          if (note && src) noteDrawn(note, src, url);
          return;
        }
        // A retry keeps the card up until the picture really comes back.
        if (!failed) showPicture();
        // Eager, never lazy: a lazy picture loading in as the user scrolls moves
        // the text under the pointer, and a click meant for a line lands on the
        // image and selects it (2026-11-05 review: typing then replaced it).
        img.setAttribute('data-lightbox-src', url);
        if (img.getAttribute('src') === url && (loading === url || (img.complete && img.naturalWidth > 0))) return;
        const load = () => { loading = url; img.setAttribute('src', url); };
        // One request per picture: a second view of it waits for the first's answer.
        const mine = claimLoad(url, (outcome) => {
          if (destroyed || candidates[at] !== url) return;
          if (outcome === 'retry') load();
          else if (outcome === 'ok') img.setAttribute('src', url);
          else tryFrom(at);
        });
        if (mine) load();
        else img.removeAttribute('src');
      };
      const paint = () => {
        const attrs = current.attrs as { src?: string | null; alt?: string | null; title?: string | null; width?: unknown; height?: unknown };
        src = typeof attrs.src === 'string' ? attrs.src : '';
        candidates = src ? resolveImageCandidates(src, liveSrcContext({ editor, options })) : [];
        const key = candidates.join('\n');
        if (key !== tried || (failed && retryDue(failedAt))) {
          tried = key;
          if (candidates.length) tryFrom(0);
          else { img.removeAttribute('src'); img.removeAttribute('data-lightbox-src'); showPicture(); }
        }
        img.alt = attrs.alt ?? '';
        if (attrs.title) img.title = attrs.title; else img.removeAttribute('title');
        for (const dim of ['width', 'height'] as const) {
          const v = attrs[dim];
          if (v != null && v !== '') img.setAttribute(dim, String(v)); else img.removeAttribute(dim);
        }
      };
      img.addEventListener('error', () => {
        const url = img.getAttribute('src');
        if (!url) return;
        const owned = loading === url;
        if (owned) loading = '';
        // A failed picture keeps no src: macOS WebKit asks a failed <img> again
        // when ProseMirror moves its element (2026-11-05: one 404 asked twice).
        img.removeAttribute('src');
        void failureOf(url).then((kind) => {
          if (kind === 'missing') noteMissing(url);
          if (owned) settleLoad(url, 'failed');
          if (destroyed || url !== candidates[at] || img.hasAttribute('src')) return;
          if (kind === 'undrawable') {
            showCard('undrawable', url);
            // Its file is there (the HEAD answered): a copy or cut names it too.
            const note = liveSrcContext({ editor, options }).notePath?.trim();
            if (note && src) noteDrawn(note, src, url);
          } else tryFrom(at + 1);
        });
      });
      img.addEventListener('load', () => {
        const url = img.getAttribute('src');
        if (!url) return;
        if (loading === url) { loading = ''; settleLoad(url, 'ok'); }
        if (destroyed || url !== candidates[at]) return;
        showPicture();
        // Which file this image is (a copy pasted elsewhere names it: renderHTML).
        const note = liveSrcContext({ editor, options }).notePath?.trim();
        if (note && src) noteDrawn(note, src, url);
      });
      paint();

      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          paint();
          return true;
        },
        // The view owns its children (load/error swap them); none of that is
        // content. A selection change still reaches ProseMirror.
        ignoreMutation: (m) => m.type !== 'selection',
        // A request still running keeps answering the views waiting on it.
        destroy() { destroyed = true; stopReturn?.(); stopReturn = null; },
      };
    };
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    const src = typeof attrs.src === 'string' ? attrs.src : '';
    if (!src) return ['img', attrs];

    const ctx = liveSrcContext(this);
    // The URL this image drew from, when it drew: it names the file, so a copy
    // pasted into another note names the same one (unproxyImageSrc).
    const note = ctx.notePath?.trim();
    const resolved = (note && drawnUrl(note, src)) || resolveImageSrc(src, ctx);
    // Untouched src ⇒ nothing was proxied, so don't stamp the proxy-only
    // attributes (keeps parity with proxyImageSrcs, which also only marks the
    // images it actually rewrote).
    if (resolved === src) return ['img', attrs];
    // `loading` before `src`: this is the clipboard / HTML form, built with the
    // page's own document before it moves into an inert one, and WebKit starts
    // loading the moment `src` is set (2026-11-05: a missing picture was asked
    // again on every note switch). Lazy, it never loads off screen.
    return ['img', { loading: 'lazy', ...attrs, src: resolved, 'data-lightbox-src': resolved }];
  },
});
