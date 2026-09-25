/**
 * The cached notes tree (core/notes-tree.ts): shape of the walk, when the
 * snapshot is reused, when it is rebuilt, and the two timers (re-warm after an
 * invalidation, warmup after boot).
 *
 * The staleness contract under test: the tree changes exactly when some
 * directory's LISTING changes, and a directory's mtime moves exactly then. So a
 * content-only write must be served from the snapshot with no re-walk, while a
 * create / delete / rename anywhere in the vault must be visible on the very
 * next read, with or without an explicit invalidation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('notes-tree-test'));

import fsp from 'node:fs/promises';
import { NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import {
  getNotesTree,
  invalidateNotesTree,
  resetNotesTreeCache,
  scheduleNotesTreeWarmup,
  peekNotesTree,
  refreshNotesTreeIfChanged,
  scanTree,
  isAttachmentFile,
  REWARM_DEBOUNCE_MS,
  type TreeNode,
} from '../../src/core/notes-tree.js';

async function write(rel: string, content = '# x'): Promise<void> {
  const full = path.join(NOTES_DIR, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

/** Directory mtimes carry sub-ms precision on APFS/ext4, but give the clock a nudge anyway. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.type === 'folder' ? `${n.name}/` : n.name));
}

/**
 * Fire due timers under the fake clock, then let the real disk I/O the callback
 * started finish (fake timers cannot flush libuv). Resolves once the snapshot
 * exists, or after `maxMs` of real time.
 */
async function fireTimersAndSettle(advanceMs: number, maxMs = 3000): Promise<void> {
  vi.advanceTimersByTime(advanceMs);
  vi.useRealTimers();
  const until = Date.now() + maxMs;
  while (peekNotesTree() == null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  resetNotesTreeCache();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
});

afterEach(async () => {
  resetNotesTreeCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('walk shape', () => {
  it('folders first, then files, alphabetical; notes and attachments typed; noise skipped', async () => {
    await write('zeta.md');
    await write('alpha.md');
    await write('sub/inner.md');
    await write('sub/photo.PNG', 'bin');
    await write('sub/deck.pptx', 'bin');
    await write('sub/readme.txt', 'not listed');
    await write('.hidden.md');
    await write('~$lock.docx', 'office lock');
    await fs.mkdir(path.join(NOTES_DIR, 'empty-folder'));

    const { tree } = await getNotesTree();
    expect(names(tree)).toEqual(['empty-folder/', 'sub/', 'alpha.md', 'zeta.md']);
    const sub = tree.find((n) => n.name === 'sub')!;
    expect(sub.children!.map((c) => [c.name, c.kind])).toEqual([
      ['deck.pptx', 'attachment'],
      ['inner.md', 'note'],
      ['photo.PNG', 'attachment'],
    ]);
    expect(sub.children!.map((c) => c.path)).toEqual(['sub/deck.pptx', 'sub/inner.md', 'sub/photo.PNG']);
    expect(tree.find((n) => n.name === 'empty-folder')!.children).toEqual([]);
  });

  it('a missing vault root yields an empty tree, and is never treated as current', async () => {
    await fs.rm(NOTES_DIR, { recursive: true, force: true });
    const first = await getNotesTree();
    expect(first.tree).toEqual([]);
    await write('now.md');
    const second = await getNotesTree();
    expect(names(second.tree)).toEqual(['now.md']);
  });

  it('json is the serialized tree, computed once per build', async () => {
    await write('a.md');
    const snap = await getNotesTree();
    expect(JSON.parse(snap.json)).toEqual({ tree: snap.tree });
    expect((await getNotesTree()).json).toBe(snap.json);
  });

  it('scanTree walks an arbitrary directory without touching the snapshot', async () => {
    await write('a.md');
    const other = path.join(WALNUT_HOME, 'elsewhere');
    await fs.mkdir(path.join(other, 'd'), { recursive: true });
    await fs.writeFile(path.join(other, 'd', 'n.md'), '');
    expect(names(await scanTree(other, ''))).toEqual(['d/']);
    expect(peekNotesTree()).toBeNull();
  });

  it('isAttachmentFile is case-insensitive and needs an extension', () => {
    expect(isAttachmentFile('x.PDF')).toBe(true);
    expect(isAttachmentFile('x.heic')).toBe(true);
    expect(isAttachmentFile('x.txt')).toBe(false);
    expect(isAttachmentFile('pdf')).toBe(false);
  });
});

describe('snapshot reuse', () => {
  it('a second read is served from the snapshot: no readdir at all', async () => {
    await write('a/b/c.md');
    await write('a/d.md');
    const first = await getNotesTree();
    const readdir = vi.spyOn(fsp, 'readdir');
    const second = await getNotesTree();
    expect(second).toBe(first);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('rewriting a note\'s bytes does not rebuild the tree', async () => {
    await write('a/b/c.md', 'v1');
    const first = await getNotesTree();
    await tick();
    await write('a/b/c.md', 'v2 — typing into the editor autosaves every 500ms');
    const readdir = vi.spyOn(fsp, 'readdir');
    expect(await getNotesTree()).toBe(first);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('concurrent readers share one build', async () => {
    await write('a/b/c.md');
    await write('a/d/e.md');
    const readdir = vi.spyOn(fsp, 'readdir');
    const all = await Promise.all(Array.from({ length: 12 }, () => getNotesTree()));
    expect(new Set(all).size).toBe(1);
    // root + a + a/b + a/d = 4 directories, each read exactly once
    expect(readdir).toHaveBeenCalledTimes(4);
  });
});

describe('staleness without any explicit invalidation', () => {
  it('a new note deep in the tree is on the next read', async () => {
    await write('a/b/c.md');
    await getNotesTree();
    await tick();
    await write('a/b/new.md');
    const { tree } = await getNotesTree();
    expect(names(tree[0].children![0].children!)).toEqual(['c.md', 'new.md']);
  });

  it('a new folder, a deleted note, and a renamed note each show on the next read', async () => {
    await write('a/one.md');
    await write('a/two.md');
    await getNotesTree();

    await tick();
    await fs.mkdir(path.join(NOTES_DIR, 'a', 'fresh'));
    expect(names((await getNotesTree()).tree[0].children!)).toEqual(['fresh/', 'one.md', 'two.md']);

    await tick();
    await fs.unlink(path.join(NOTES_DIR, 'a', 'two.md'));
    expect(names((await getNotesTree()).tree[0].children!)).toEqual(['fresh/', 'one.md']);

    await tick();
    await fs.rename(path.join(NOTES_DIR, 'a', 'one.md'), path.join(NOTES_DIR, 'a', 'uno.md'));
    expect(names((await getNotesTree()).tree[0].children!)).toEqual(['fresh/', 'uno.md']);
  });

  it('a whole folder removed is gone on the next read (a vanished directory counts as changed)', async () => {
    await write('a/b/c.md');
    await write('a/x.md');
    await getNotesTree();
    await tick();
    await fs.rm(path.join(NOTES_DIR, 'a', 'b'), { recursive: true });
    expect(names((await getNotesTree()).tree[0].children!)).toEqual(['x.md']);
  });

  it('a vault swapped out wholesale (test fixture pattern) is re-read', async () => {
    await write('old.md');
    await getNotesTree();
    await fs.rm(NOTES_DIR, { recursive: true, force: true });
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await write('new.md');
    expect(names((await getNotesTree()).tree)).toEqual(['new.md']);
  });
});

describe('invalidation and timers', () => {
  it('invalidateNotesTree drops the snapshot and re-warms it after the debounce', async () => {
    vi.useFakeTimers();
    await write('a.md');
    await getNotesTree();
    invalidateNotesTree();
    expect(peekNotesTree()).toBeNull();
    invalidateNotesTree(); // a burst coalesces
    await write('b.md');
    await fireTimersAndSettle(REWARM_DEBOUNCE_MS + 20);
    const warmed = peekNotesTree();
    expect(warmed).not.toBeNull();
    expect(names(warmed!.tree)).toEqual(['a.md', 'b.md']);
  });

  it('a read during the debounce window builds immediately and the re-warm then stays out of the way', async () => {
    vi.useFakeTimers();
    await write('a.md');
    await getNotesTree();
    invalidateNotesTree();
    const snap = await getNotesTree();
    const readdir = vi.spyOn(fsp, 'readdir');
    vi.advanceTimersByTime(REWARM_DEBOUNCE_MS + 20);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
    expect(peekNotesTree()).toBe(snap);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('scheduleNotesTreeWarmup builds after the delay, and cancel prevents it', async () => {
    vi.useFakeTimers();
    await write('a.md');
    scheduleNotesTreeWarmup(1000);
    vi.advanceTimersByTime(999);
    expect(peekNotesTree()).toBeNull();
    await fireTimersAndSettle(20);
    expect(peekNotesTree()).not.toBeNull();

    resetNotesTreeCache();
    vi.useFakeTimers();
    const cancel = scheduleNotesTreeWarmup(1000);
    cancel();
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
    expect(peekNotesTree()).toBeNull();
  });

  it('resetNotesTreeCache clears pending timers too', async () => {
    vi.useFakeTimers();
    await write('a.md');
    invalidateNotesTree();
    resetNotesTreeCache();
    vi.advanceTimersByTime(REWARM_DEBOUNCE_MS * 4);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
    expect(peekNotesTree()).toBeNull();
  });
});

/**
 * The watcher's question after a burst of fs events: did the SHAPE change since
 * open pages were last told? macOS reports an in-place write as 'rename', so
 * the event type is not evidence; the tree itself is.
 */
describe('refreshNotesTreeIfChanged', () => {
  it('the first check after boot announces nothing: nobody holds a tree yet', async () => {
    await write('a.md');
    expect(await refreshNotesTreeIfChanged()).toBe(false);
  });

  it('rewriting a note in place (an autosave) is not a shape change', async () => {
    await write('a/b.md', 'v1');
    await getNotesTree();
    await tick();
    await write('a/b.md', 'v2: a save from the editor, Obsidian or git-sync');
    expect(await refreshNotesTreeIfChanged()).toBe(false);
  });

  it('a note created, then deleted, each announce exactly once', async () => {
    await write('a/b.md');
    await getNotesTree();
    await tick();
    await write('a/c.md');
    expect(await refreshNotesTreeIfChanged()).toBe(true);
    expect(await refreshNotesTreeIfChanged()).toBe(false);
    await tick();
    await fs.rm(path.join(NOTES_DIR, 'a/c.md'));
    expect(await refreshNotesTreeIfChanged()).toBe(true);
    expect(names((await getNotesTree()).tree[0].children!)).toEqual(['b.md']);
  });

  it('a burst is judged against what clients hold, not against a mid-burst rebuild', async () => {
    await write('a/b.md');
    await getNotesTree();
    await tick();
    await write('a/c.md');
    await getNotesTree(); // a page read the tree mid-burst; the snapshot is rebuilt
    await tick();
    await write('a/b.md', 'and then a plain save');
    expect(await refreshNotesTreeIfChanged()).toBe(true); // c.md is new to everyone told before the burst
  });

  it('a temp file that appeared and vanished within the burst moves an mtime but not the tree', async () => {
    await write('a/b.md');
    await getNotesTree();
    await tick();
    await write('a/.b.md.tmp');
    await fs.rm(path.join(NOTES_DIR, 'a/.b.md.tmp'));
    expect(await refreshNotesTreeIfChanged()).toBe(false);
  });
});
