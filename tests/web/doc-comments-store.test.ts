/**
 * The comments file store (web/src/stores/doc-comments-store.ts) against a fake
 * file API: the first comment makes the file, a lost race replays the edits on
 * the fresh read, a read older than a write is dropped, a file of the same name
 * that is not a comments file is never written over, and a failed read keeps
 * what was shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disk = new Map<string, string>();
let nextReadDelay: Promise<void> | null = null;
let readError: string | null = null;
const hashOf = (s: string) => `h${s.length}-${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

vi.mock('@/api/files', () => {
  class FileOpError extends Error { constructor(m: string, public code: string) { super(m); } }
  class FileSaveConflictError extends Error { constructor(public currentHash: string) { super('conflict'); } }
  return {
    FileOpError,
    FileSaveConflictError,
    createFile: vi.fn(async (path: string) => {
      if (disk.has(path)) throw new FileOpError('exists', 'exists');
      disk.set(path, '');
      return path;
    }),
    fetchFileContentConditional: vi.fn(async (path: string, _host: string | undefined, opts: { ifNoneMatch?: string }) => {
      const snapshot = disk.get(path);
      const gate = nextReadDelay;
      nextReadDelay = null;
      if (gate) await gate;
      if (readError) return { notModified: false, payload: { content: null, error: readError, size: 0, truncated: false, binary: false } };
      if (snapshot === undefined) return { notModified: false, payload: { content: null, error: 'File not found', size: 0, truncated: false, binary: false } };
      if (opts.ifNoneMatch === hashOf(snapshot)) return { notModified: true };
      return { notModified: false, payload: { content: snapshot, contentHash: hashOf(snapshot), size: snapshot.length, truncated: false, binary: false } };
    }),
    saveFileContent: vi.fn(async (path: string, content: string, opts: { expectedHash?: string }) => {
      const cur = disk.get(path) ?? '';
      if (opts.expectedHash !== hashOf(cur)) throw new FileSaveConflictError(hashOf(cur));
      disk.set(path, content);
      return { size: content.length, contentHash: hashOf(content) };
    }),
  };
});

const { docCommentsEntry, docCommentsSnapshot, editDocComments, refreshDocComments, resetDocCommentsStore } = await import('@/stores/doc-comments-store');
const { addDocComment, addDocPost, parseDocComments, serializeDocComments } = await import('@/utils/doc-comments');
const files = await import('@/api/files');

const SIDECAR = '/notes/d.md.comments.md';
const T0 = '2026-11-01T10:00:00.000Z';
const comment = (id: string, text = 'first') => ({
  id, status: 'open' as const, quote: { exact: 'The words.' }, text: 'The words.', thread: [{ author: 'You', at: T0, text }],
});
const settle = () => new Promise((r) => setTimeout(r, 0));
async function idle(): Promise<void> { for (let i = 0; i < 20; i++) await settle(); }

beforeEach(() => {
  resetDocCommentsStore();
  disk.clear();
  nextReadDelay = null;
  readError = null;
  vi.clearAllMocks();
});

describe('doc comments store', () => {
  it('the first comment makes the file and writes it under its empty hash', async () => {
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    expect(docCommentsSnapshot(e)).toMatchObject({ loaded: true, comments: [] });
    editDocComments(e, addDocComment(comment('c-00000001')), 'add');
    expect(docCommentsSnapshot(e).comments).toHaveLength(1); // shown at once
    await idle();
    expect(files.createFile).toHaveBeenCalledTimes(1);
    expect(parseDocComments(disk.get(SIDECAR)!).map((c) => c.id)).toEqual(['c-00000001']);
  });

  it('a lost race replays the edit on what the AI wrote meanwhile', async () => {
    disk.set(SIDECAR, serializeDocComments('d.md', [comment('c-00000001')]));
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    // The AI replies on disk; the store has not read it.
    disk.set(SIDECAR, serializeDocComments('d.md', [{ ...comment('c-00000001'), thread: [...comment('c-00000001').thread, { author: 'AI', at: T0, text: 'Done.' }] }]));
    editDocComments(e, addDocPost('c-00000001', { author: 'You', at: '2026-11-01T10:05:00.000Z', text: 'Thanks.' }), 'reply');
    await idle();
    expect(files.saveFileContent).toHaveBeenCalledTimes(2);
    const [c] = parseDocComments(disk.get(SIDECAR)!);
    expect(c!.thread.map((p) => p.text)).toEqual(['first', 'Done.', 'Thanks.']);
    expect(docCommentsSnapshot(e).comments[0]!.thread).toHaveLength(3);
  });

  it('a read that started before a write landed does not bring the older list back', async () => {
    disk.set(SIDECAR, serializeDocComments('d.md', [comment('c-00000001')]));
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    let release!: () => void;
    nextReadDelay = new Promise<void>((r) => { release = r; });
    disk.set(SIDECAR, `${disk.get(SIDECAR)}\n`); // changed, so the slow read is not a 304
    refreshDocComments(e); // slow read of the old bytes
    await settle();
    editDocComments(e, addDocComment(comment('c-00000002', 'second')), 'add');
    await idle();
    release();
    await idle();
    expect(docCommentsSnapshot(e).comments.map((c) => c.id)).toEqual(['c-00000001', 'c-00000002']);
  });

  it('never writes over a file of the same name that is not a comments file', async () => {
    disk.set(SIDECAR, '# My own notes\n\nNot comments at all.\n');
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    editDocComments(e, addDocComment(comment('c-00000001')), 'add');
    await idle();
    expect(files.saveFileContent).not.toHaveBeenCalled();
    expect(disk.get(SIDECAR)).toBe('# My own notes\n\nNot comments at all.\n');
    expect(docCommentsSnapshot(e).saveError).toMatch(/is not a comments file/);
  });

  it('keeps a preface the AI wrote at the top', async () => {
    disk.set(SIDECAR, `Summary at the top.\n\n${serializeDocComments('d.md', [comment('c-00000001')]).split('\n').slice(2).join('\n')}`);
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    editDocComments(e, addDocComment(comment('c-00000002')), 'add');
    await idle();
    expect(disk.get(SIDECAR)).toContain('Summary at the top.');
    expect(parseDocComments(disk.get(SIDECAR)!)).toHaveLength(2);
  });

  it('a failed read (host reconnecting) keeps the comments shown', async () => {
    disk.set(SIDECAR, serializeDocComments('d.md', [comment('c-00000001')]));
    const e = docCommentsEntry(SIDECAR, undefined, 'd.md');
    refreshDocComments(e);
    await idle();
    readError = 'Host is reconnecting';
    disk.set(SIDECAR, `${disk.get(SIDECAR)}\n`);
    refreshDocComments(e);
    await idle();
    expect(docCommentsSnapshot(e)).toMatchObject({ readError: 'Host is reconnecting' });
    expect(docCommentsSnapshot(e).comments).toHaveLength(1);
  });
});
