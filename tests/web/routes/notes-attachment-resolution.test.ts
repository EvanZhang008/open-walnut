/**
 * Attachment path resolution — the duplicate-filename bug (2026-08).
 *
 * A real vault has the SAME image filename in many `_attachment/` folders (51
 * such basenames here; `Untitled 5.png` in seven folders, all different
 * pictures). The old resolver threw every path segment away and matched the
 * basename alone, so an embed that spelled out its folder still got whichever
 * copy the directory walk reached first — 67 embeds rendered a picture belonging
 * to an unrelated note.
 *
 * The fix matches the LONGEST PATH SUFFIX, and breaks any remaining tie by
 * proximity to the embedding note. Each test below pins one rung of that ladder,
 * plus the containment guards that must survive it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-attachment-resolution'));

import {
  resolveAttachmentPath,
  invalidateAttachmentIndex,
} from '../../../src/web/routes/notes-attachment.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

async function writeFile(relPath: string, content = 'BYTES'): Promise<void> {
  const full = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

/** Resolved absolute path back to a vault-relative POSIX path (or null). */
async function resolve(raw: string, notePath?: string): Promise<string | null> {
  const full = await resolveAttachmentPath(raw, notePath);
  if (!full) return null;
  return path.relative(NOTES_DIR, full).split(path.sep).join('/');
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  invalidateAttachmentIndex();
});

afterEach(async () => {
  invalidateAttachmentIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('resolveAttachmentPath — exact vault-relative path', () => {
  it('resolves an exact path without searching', async () => {
    await writeFile('Areas/proj/_attachment/pic.png');
    expect(await resolve('Areas/proj/_attachment/pic.png')).toBe('Areas/proj/_attachment/pic.png');
  });

  it('resolves a bare name that exists only once', async () => {
    await writeFile('health/_attachment/unique.png');
    expect(await resolve('unique.png')).toBe('health/_attachment/unique.png');
  });

  it('strips a legacy Notion/ vault root that no longer exists on disk', async () => {
    await writeFile('journal/_attachment/old.png');
    expect(await resolve('Notion/journal/_attachment/old.png')).toBe('journal/_attachment/old.png');
  });

  it('strips an Obsidian display-size suffix from the target', async () => {
    await writeFile('_attachment/sized.png');
    expect(await resolve('_attachment/sized.png|300')).toBe('_attachment/sized.png');
  });
});

describe('resolveAttachmentPath — duplicate filenames (the 2026-08 bug)', () => {
  /**
   * THE regression test. Two different pictures share a filename; the embed
   * names its folder. Basename-only matching returned the wrong one.
   */
  it('honors the folder in the embed when the basename is duplicated', async () => {
    await writeFile('journal/Dimension 4/_attachment/Untitled 5.png', 'JOURNAL');
    await writeFile('records/Passwords/_attachment/Untitled 5.png', 'RECORDS');

    expect(await resolve('Notion/Areas/Records/Passwords/_attachment/Untitled 5.png'))
      .toBe('records/Passwords/_attachment/Untitled 5.png');
    expect(await resolve('Notion/Areas/Journal/Dimension 4/_attachment/Untitled 5.png'))
      .toBe('journal/Dimension 4/_attachment/Untitled 5.png');
  });

  it('matches the longest suffix available, not the first basename hit', async () => {
    await writeFile('a/_attachment/image.jpg', 'A');
    await writeFile('b/deep/_attachment/image.jpg', 'B');

    // `deep/_attachment/image.jpg` is a 3-segment suffix of exactly one file.
    expect(await resolve('Vault/Root/b/deep/_attachment/image.jpg'))
      .toBe('b/deep/_attachment/image.jpg');
  });

  it('breaks a remaining tie by proximity to the embedding note', async () => {
    await writeFile('finance/_attachment/image.jpg', 'FINANCE');
    await writeFile('health/_attachment/image.jpg', 'HEALTH');
    await writeFile('records/_attachment/image.jpg', 'RECORDS');

    expect(await resolve('image.jpg', 'health/Checkup.md')).toBe('health/_attachment/image.jpg');
    expect(await resolve('image.jpg', 'finance/Taxes.md')).toBe('finance/_attachment/image.jpg');
  });

  it('proximity beats the _attachment preference when the note lives deeper', async () => {
    await writeFile('_attachment/photo.png', 'ROOT-ATTACHMENT');
    await writeFile('housing/mckay/photo.png', 'NOTE-SIBLING');

    // The note's own folder wins even though the other hit is in `_attachment/`:
    // being beside the note is the stronger signal about which picture is meant.
    expect(await resolve('photo.png', 'housing/mckay/House.md')).toBe('housing/mckay/photo.png');
  });

  it('prefers an _attachment/ hit when no note path narrows it down', async () => {
    await writeFile('misc/photo.png', 'LOOSE');
    await writeFile('misc/_attachment/photo.png', 'CONVENTIONAL');
    expect(await resolve('photo.png')).toBe('misc/_attachment/photo.png');
  });

  /**
   * Determinism matters more than which copy wins: a resolution that flips
   * between runs makes a note's images change on every reload.
   */
  it('is deterministic for a genuinely ambiguous embed', async () => {
    await writeFile('x/_attachment/dup.png');
    await writeFile('y/_attachment/dup.png');
    await writeFile('z/_attachment/dup.png');

    const first = await resolve('dup.png');
    for (let i = 0; i < 5; i++) {
      invalidateAttachmentIndex();
      expect(await resolve('dup.png')).toBe(first);
    }
  });
});

describe('resolveAttachmentPath — safety', () => {
  it('refuses a traversal segment', async () => {
    expect(await resolve('../../../etc/passwd.png')).toBeNull();
    expect(await resolve('Areas/../../outside.png')).toBeNull();
  });

  it('never escapes the vault via a note path either', async () => {
    await writeFile('_attachment/pic.png');
    // A hostile note path must not widen resolution — it only ranks candidates.
    expect(await resolve('pic.png', '../../../etc/Note.md')).toBe('_attachment/pic.png');
  });

  it('returns null for a directory that matches the name', async () => {
    await fs.mkdir(path.join(NOTES_DIR, 'weird.png'), { recursive: true });
    expect(await resolve('weird.png')).toBeNull();
  });

  it('returns null for a missing attachment', async () => {
    await writeFile('_attachment/other.png');
    expect(await resolve('absent.png')).toBeNull();
  });
});

describe('resolveAttachmentPath — index freshness', () => {
  /**
   * The resolver caches the vault listing (one image-heavy note fires 20-40
   * requests at once, and re-walking the vault per request measured 167-217ms
   * each). A freshly written file must still resolve immediately, or a
   * just-pasted image renders as a broken embed.
   */
  it('resolves a file created after the cache was warmed', async () => {
    await writeFile('_attachment/first.png');
    expect(await resolve('first.png')).toBe('_attachment/first.png');

    await writeFile('Areas/_attachment/second.png');
    expect(await resolve('second.png')).toBe('Areas/_attachment/second.png');
  });

  it('serves many concurrent requests consistently', async () => {
    await writeFile('a/_attachment/one.png');
    await writeFile('b/_attachment/two.png');

    const results = await Promise.all([
      ...Array.from({ length: 15 }, () => resolve('one.png')),
      ...Array.from({ length: 15 }, () => resolve('two.png')),
    ]);
    expect(results.slice(0, 15).every((r) => r === 'a/_attachment/one.png')).toBe(true);
    expect(results.slice(15).every((r) => r === 'b/_attachment/two.png')).toBe(true);
  });
});

describe('resolveAttachmentPath — case insensitivity', () => {
  it('matches a differently-cased embed (macOS vaults are case-preserving)', async () => {
    await writeFile('_attachment/Photo.PNG');
    expect(await resolve('photo.png')).toBe('_attachment/Photo.PNG');
  });
});
