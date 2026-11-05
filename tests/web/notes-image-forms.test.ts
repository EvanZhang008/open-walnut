/**
 * Every way a note can name a picture draws it, on every notes surface.
 *
 * The reported bug (2026-11-05): images in notes did not show. The vault's
 * editor used the plain TipTap Image node, so a standard markdown image with a
 * relative path, `![](photo.jpeg)` (how Notion exports and most editors write
 * one), was handed to the browser as is and resolved against the app's origin:
 * nothing drew. A real vault held 171 of them, 39 percent-encoded
 * (`Untitled%201.jpeg`), which the server also answered 404. Only `![[embeds]]`
 * worked.
 *
 * The class is "an image reference a notes surface paints without resolving it".
 * This file pins each member:
 *   1. FORMS: one row per way of writing an image src, with where it must point
 *      for a vault note. A new branch in resolveImageSrc that returns a src
 *      unchanged must be added here as a deliberate pass-through.
 *   2. SURFACES: no web file builds an editor with the plain Image node, and every
 *      file that builds a TipTap editor paints images through ResolvedImage, so a
 *      new notes surface cannot bring the bug back.
 * The server half (relative to the note, percent-decoded, every served image type
 * drawn) is in tests/web/routes/notes-v2.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveImageSrc,
  rebaseImageSrc,
  resolveImageCandidates,
  unproxyImageSrc,
  vaultFileOf,
  type ResolveImageSrcContext,
} from '@/components/notes/extensions/resolved-image';

const NOTE = 'Trips/Spring/Plan.md';
const VAULT: ResolveImageSrcContext = { notePath: NOTE };

const vault = (p: string, exact = 'note') => `/api/notes-v2/attachment?${new URLSearchParams({ path: p, note: NOTE, exact })}`;
const local = (p: string) => `/api/local-image?path=${encodeURIComponent(p)}`;

/** [form, src as written in the note, where a vault note must paint it] */
const FORMS: Array<[string, string, string]> = [
  ['relative bare', 'photo.jpeg', vault('photo.jpeg')],
  ['relative percent-encoded (Notion export)', 'Untitled%201.jpeg', vault('Untitled%201.jpeg')],
  ['relative with a space (from <angle brackets>)', 'Untitled 1.jpeg', vault('Untitled 1.jpeg')],
  ['relative ./', './_attachment/a.png', vault('./_attachment/a.png')],
  ['relative ../', '../shared/map.png', vault('../shared/map.png')],
  ['relative subfolder', 'Plan/_attachment/b.webp', vault('Plan/_attachment/b.webp')],
  ['heic photo', 'IMG_0001.heic', vault('IMG_0001.heic')],
  ['absolute file path', '/home/dev/Pictures/a.png', local('/home/dev/Pictures/a.png')],
  ['file:// URL', 'file:///home/dev/Pictures/a%20b.png', local('/home/dev/Pictures/a b.png')],
  ['https URL', 'https://example.com/a.png', 'https://example.com/a.png'],
  ['data URL (pasted with no upload)', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='],
  ['blob URL', 'blob:http://localhost:3456/9f1c', 'blob:http://localhost:3456/9f1c'],
  ['chat image store', '/api/images/abc.png', '/api/images/abc.png'],
  ['vault attachment URL already', '/api/notes-v2/attachment?path=a.png', '/api/notes-v2/attachment?path=a.png'],
  ['protocol-relative URL', '//cdn.example.com/a.png', '//cdn.example.com/a.png'],
];

describe('every image form a vault note can hold paints a fetchable src', () => {
  for (const [form, src, want] of FORMS) {
    it(form, () => {
      expect(resolveImageSrc(src, VAULT)).toBe(want);
    });
  }

  it('the Files panel keeps resolving against its directory, not the vault', () => {
    expect(resolveImageSrc('photo.jpeg', { baseDir: '/home/dev/repo', notePath: NOTE }))
      .toBe(local('/home/dev/repo/photo.jpeg'));
  });

  it('a surface with no note and no directory leaves a relative src as written', () => {
    expect(resolveImageSrc('photo.jpeg', {})).toBe('photo.jpeg');
  });

  it('a relative path is tried beside the note, then from the vault root; a leading slash from the root, then as a file', () => {
    expect(resolveImageCandidates('/Travel/shared/map.png', VAULT)).toEqual([
      vault('/Travel/shared/map.png', 'vault'),
      local('/Travel/shared/map.png'),
    ]);
    expect(resolveImageCandidates('photo.jpeg', VAULT)).toEqual([vault('photo.jpeg'), vault('photo.jpeg', 'vault')]);
    expect(resolveImageCandidates('https://e.com/a.png', VAULT)).toEqual(['https://e.com/a.png']);
    expect(resolveImageCandidates('/a.png', { baseDir: '/home/dev' })).toEqual([local('/a.png')]);
  });

  it('a src in another scheme is not a file to fetch', () => {
    expect(resolveImageSrc('obsidian://open?file=x', VAULT)).toBe('obsidian://open?file=x');
  });
});

describe('a copied vault image pastes back as the path it was written with', () => {
  it('inside the same note', () => {
    for (const [, src] of FORMS.slice(0, 7)) {
      expect(unproxyImageSrc(resolveImageSrc(src, VAULT), VAULT)).toBe(src);
    }
  });

  it('into another note it becomes the path from that note, never an /api/ URL', () => {
    // 2026-11-05 review: a cross-note paste saved `/api/notes-v2/attachment?...`.
    const from = (src: string) => resolveImageSrc(src, VAULT);
    expect(unproxyImageSrc(from('photo.jpeg'), { notePath: 'Trips/Summer/Log.md' })).toBe('../Spring/photo.jpeg');
    expect(unproxyImageSrc(from('Untitled%201.jpeg'), { notePath: 'Home.md' })).toBe('Trips/Spring/Untitled%201.jpeg');
    expect(unproxyImageSrc(from('../shared/map.png'), { notePath: 'Trips/Spring/Other.md' })).toBe('../shared/map.png');
    expect(unproxyImageSrc(from('a (1).png'), { notePath: 'Notes/x.md' })).toBe('../Trips/Spring/a%20%281%29.png');
    // A folder name with a space would end a markdown link: encoded.
    const spaced = resolveImageSrc('p.png', { notePath: 'Spring trip/Plan.md' });
    expect(unproxyImageSrc(spaced, { notePath: 'Home.md' })).toBe('Spring%20trip/p.png');
    // The clipboard may carry it HTML-escaped or as a full URL on this origin.
    expect(unproxyImageSrc(from('photo.jpeg').replace(/&/g, '&amp;'), { notePath: 'Home.md' })).toBe('Trips/Spring/photo.jpeg');
  });

  it('a plain-text paste from another note rebases the written path (ImageClipboard)', () => {
    expect(rebaseImageSrc('../shared/route%20map.png', 'Travel/Spring trip/A.md', 'Travel/B.md')).toBe('shared/route%20map.png');
    expect(rebaseImageSrc('photo.png', 'Travel/Spring trip/A.md', 'Travel/Spring trip/C.md')).toBe('photo.png');
    for (const kept of ['https://e.com/a.png', '/home/dev/a.png', '/api/images/a.png', 'data:image/png;base64,AA']) {
      expect(rebaseImageSrc(kept, 'A/x.md', 'B/y.md')).toBe(kept);
    }
  });

  it('the drawn URL names its file, and a paste elsewhere names that file', () => {
    // 2026-11-05 review: `shared/map.png` in A/Note.md drew the vault-root file
    // (nothing beside the note); rebased as written it became ../A/shared/map.png.
    const fromRoot = vault('shared/map.png', 'vault');
    expect(vaultFileOf(fromRoot)).toBe('shared/map.png');
    expect(vaultFileOf(vault('../shared/map.png'))).toBe('Trips/shared/map.png');
    expect(vaultFileOf(vault('Untitled%201.jpeg'))).toBe('Trips/Spring/Untitled 1.jpeg');
    expect(vaultFileOf('/api/notes-v2/attachment?path=a.png&note=n.md&exact=1')).toBeNull();
    expect(unproxyImageSrc(fromRoot, { notePath: 'B/Note.md' })).toBe('../shared/map.png');
    expect(unproxyImageSrc(vault('photo.jpeg', 'vault'), { notePath: 'Home.md' })).toBe('photo.jpeg');
  });

  it('a surface with no note keeps the URL, which works from anywhere', () => {
    const url = resolveImageSrc('photo.jpeg', VAULT);
    expect(unproxyImageSrc(url, {})).toBe(url);
  });
});

describe('every notes surface paints images through ResolvedImage', () => {
  const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
    }
  };
  walk(WEB_SRC);
  const rel = (f: string) => path.relative(WEB_SRC, f);

  it('only resolved-image.ts imports the plain Image node', () => {
    const importers = files
      .filter((f) => /from ['"]@tiptap\/extension-image['"]/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(importers).toEqual(['components/notes/extensions/resolved-image.ts']);
  });

  it('every file that builds a TipTap editor configures ResolvedImage', () => {
    const builders = files.filter((f) => /\buseEditor\(|\bnew Editor\(/.test(fs.readFileSync(f, 'utf8')));
    expect(builders.length).toBeGreaterThan(0);
    for (const f of builders) {
      expect(fs.readFileSync(f, 'utf8'), rel(f)).toMatch(/\bResolvedImage\.configure\(/);
    }
  });

  it('every editor that paints images also rebases pasted ones and selects before deleting', () => {
    for (const f of files.filter((x) => /\bResolvedImage\.configure\(/.test(fs.readFileSync(x, 'utf8')))) {
      if (f.endsWith('resolved-image.ts')) continue;
      const src = fs.readFileSync(f, 'utf8');
      expect(src, rel(f)).toMatch(/\bImageClipboard\b/);
      expect(src, rel(f)).toMatch(/\bImageKeys\b/);
    }
  });

  it('the vault editor hands ResolvedImage the note it edits', () => {
    const src = fs.readFileSync(path.join(WEB_SRC, 'components/notes/NotesEditor.tsx'), 'utf8');
    expect(src).toMatch(/notePath:\s*imageBaseDir \? undefined : attachmentNotePath/);
    expect(src).toMatch(/storage\.notePath = imageBaseDir \? undefined : attachmentNotePath/);
  });
});
