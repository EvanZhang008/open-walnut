/**
 * Renaming the OPEN note in place (useNoteContent.renameOpenNote), the way a new note's
 * name follows its title while the user types (web/src/components/notes/note-auto-name.ts).
 *
 * The editor must carry on under the new path: the same editor key (no remount, so the
 * caret and the unsaved text stay), nothing reloaded, and every later save written to the
 * NEW path with the hash the move kept. A save to the old path would bring the old file
 * back (the drag-to-move duplication bug of markMovedAway's comment). Edits made while the
 * move is on the server wait for its answer; so do edits of a note left during the move.
 *
 * The rename starts only after this editor's own save (`ownSave`), and a note another
 * writer wrote to keeps its name: that writer still holds the path, and its next write
 * would make the old file again. A move whose answer was lost is checked on the server
 * before anything is written back to the old path.
 *
 * Real React over linkedom; the notes API is a fake disk, the editor a stand-in with the
 * few members the hook reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  saves: [] as Array<{ path: string; content: string; expectedHash?: string }>,
  reads: [] as string[],
  /** While set, a save waits for it (a save still on its way). */
  saveGate: null as Promise<void> | null,
  /** While true, every read fails with no answer (the server cannot be reached). */
  offline: false,
}));
const ws = vi.hoisted(() => ({ handlers: new Map<string, (data: unknown) => void>() }));
const hashOf = (s: string) => `h${s.length}:${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

vi.mock('@/api/notes-v2', () => ({
  fetchNoteContent: async (p: string) => {
    disk.reads.push(p);
    if (disk.offline) throw new Error('Failed to fetch');
    const content = disk.files.get(p);
    if (content == null) throw Object.assign(new Error('Note not found'), { status: 404 });
    return { content, updatedAt: '2026-11-11T00:00:00.000Z', contentHash: hashOf(content) };
  },
  saveNoteContent: async (p: string, content: string, expectedHash?: string) => {
    if (disk.saveGate) await disk.saveGate;
    disk.saves.push({ path: p, content, expectedHash });
    const current = disk.files.get(p);
    if (expectedHash && current != null && hashOf(current) !== expectedHash) {
      throw Object.assign(new Error('Content was modified externally'), { status: 409, body: {} });
    }
    disk.files.set(p, content);
    return { updatedAt: '2026-11-11T00:00:01.000Z', contentHash: hashOf(content) };
  },
}));
vi.mock('@/hooks/useWebSocket', () => ({
  useEvent: (name: string, fn: (data: unknown) => void) => { ws.handlers.set(name, fn); },
}));
vi.mock('@/api/ws', () => ({ wsClient: { onEvent: () => {} } }));
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('@/api/leader-presence', () => ({ leaderErrorMessage: () => null }));
vi.mock('@/utils/markdown', () => ({ entityRefsToMarkdownLinks: (s: string) => s }));
vi.mock('@/components/notes/notes-content-preprocess', () => ({ normalizeForEditor: (s: string) => s }));
vi.mock('@/components/notes/editor-keep-source', () => ({
  markdownKeepingSource: (ed: { storage: { markdown: { getMarkdown: () => string } } }) => ed.storage.markdown.getMarkdown(),
  loadsAs: () => false,
}));

const { useNoteContent } = await import('../../web/src/hooks/useNoteContent');
const { useNoteAutoName } = await import('../../web/src/hooks/useNoteAutoName');
const { clearNoteContentCache } = await import('../../web/src/stores/note-content-cache');
const { noteDocKey, publishDocSaved, resetDocSaveSignals } = await import('../../web/src/stores/file-save-signal');
const { isAutoNamed, markAutoNamed, forgetAutoName, resetAutoNamesForTests, AUTO_NAME_SETTLE_MS } = await import('../../web/src/components/notes/note-auto-name');

type Hook = ReturnType<typeof useNoteContent>;
let hook: Hook;
function Probe({ path }: { path: string | null }) {
  hook = useNoteContent(path);
  return null;
}

let root: { render: (n: unknown) => void; unmount: () => void } | null = null;
async function show(path: string | null): Promise<void> {
  if (!root) root = createRoot((globalThis as unknown as { document: Document }).document.createElement('div'));
  await act(async () => { root!.render(createElement(Probe, { path })); });
  await settle(0);
}
async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** The editor members useNoteContent reads: its markdown, destroyed or not, its destroy event. */
function fakeEditor(md: string) {
  const onDestroy: Array<() => void> = [];
  const ed = {
    isDestroyed: false,
    md,
    storage: { markdown: { getMarkdown: () => ed.md } },
    state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
    commands: { setContent: () => {}, setTextSelection: () => {} },
    on: (event: string, fn: () => void) => { if (event === 'destroy') onDestroy.push(fn); },
    destroy: () => { onDestroy.forEach((fn) => fn()); ed.isDestroyed = true; },
  };
  return ed;
}
type FakeEditor = ReturnType<typeof fakeEditor>;
async function type(ed: FakeEditor, md: string): Promise<void> {
  ed.md = md;
  await act(async () => { hook.onEditorUpdate(ed as never); });
}

const FM = '---\nid: n1\n---\n';
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** The server move: the file's bytes go to the new path unchanged. */
function moveOnDisk(from: string, to: string) {
  const content = disk.files.get(from);
  if (content == null) throw Object.assign(new Error('Source note not found'), { status: 404 });
  if (disk.files.has(to)) throw Object.assign(new Error('Destination note already exists'), { status: 409 });
  disk.files.delete(from);
  disk.files.set(to, content);
}

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  disk.files.clear();
  disk.saves.length = 0;
  disk.reads.length = 0;
  disk.saveGate = null;
  disk.offline = false;
  ws.handlers.clear();
  clearNoteContentCache();
  resetDocSaveSignals();
  resetAutoNamesForTests();
});
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  vi.useRealTimers();
});

/** A new note, open and typed into until its title saved. */
async function newNoteTitled(title: string): Promise<FakeEditor> {
  disk.files.set('Untitled.md', FM);
  await show('Untitled.md');
  expect(hook.content).toBe('');
  const ed = fakeEditor('');
  await type(ed, `# ${title}`);
  await settle(600);
  expect(disk.files.get('Untitled.md')).toBe(`${FM}# ${title}`);
  expect(hook.content).toBe(`# ${title}`);
  return ed;
}

describe('renameOpenNote: the open note moves without reopening', () => {
  it('keeps the editor and the loaded note, and later saves go to the new path', async () => {
    const ed = await newNoteTitled('Meeting');
    const key = hook.remountKey;
    const readsBefore = disk.reads.length;
    let moved: string | null = null;
    let result: string | undefined;
    await act(async () => {
      result = await hook.renameOpenNote('Untitled.md', 'Meeting.md', async () => moveOnDisk('Untitled.md', 'Meeting.md'), (to) => { moved = to; });
    });
    expect(result).toBe('moved');
    expect(moved).toBe('Meeting.md');
    // The page points its tab there.
    await show('Meeting.md');
    expect(hook.remountKey, 'same editor: no remount').toBe(key);
    expect(hook.content).toBe('# Meeting');
    expect(hook.loading).toBe(false);
    expect(disk.reads.length, 'nothing reloaded').toBe(readsBefore);

    await type(ed, '# Meeting\n\nAgenda');
    await settle(600);
    const last = disk.saves.at(-1)!;
    expect(last.path).toBe('Meeting.md');
    expect(last.expectedHash, 'the hash the move kept: no false conflict').toBe(hashOf(`${FM}# Meeting`));
    expect(disk.files.get('Meeting.md')).toBe(`${FM}# Meeting\n\nAgenda`);
    expect(disk.files.has('Untitled.md'), 'the old file never comes back').toBe(false);
    expect(hook.saveStatus).not.toBe('error');
  });

  it('typing while the move is on the server is saved once, to the new path', async () => {
    const ed = await newNoteTitled('Plan');
    const savesBefore = disk.saves.length;
    const gate = deferred();
    let renaming!: Promise<string>;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Plan.md', async () => { await gate.promise; moveOnDisk('Untitled.md', 'Plan.md'); }, () => {});
    });
    await type(ed, '# Plan\n\nFirst point');
    await settle(2000);
    expect(disk.saves.length, 'nothing written while the path is unsure').toBe(savesBefore);
    await act(async () => { gate.resolve(); await renaming; });
    await show('Plan.md');
    await settle(600);
    const written = disk.saves.slice(savesBefore);
    expect(written.map((s) => s.path)).toEqual(['Plan.md']);
    expect(disk.files.get('Plan.md')).toBe(`${FM}# Plan\n\nFirst point`);
    expect(disk.files.has('Untitled.md')).toBe(false);
  });

  it('a failed move keeps the note where it is, and what was typed meanwhile is saved there', async () => {
    const ed = await newNoteTitled('Taken');
    disk.files.set('Taken.md', 'another note');
    const key = hook.remountKey;
    const gate = deferred();
    let renaming!: Promise<string>;
    let called = false;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Taken.md', async () => { await gate.promise; moveOnDisk('Untitled.md', 'Taken.md'); }, () => { called = true; });
    });
    await type(ed, '# Taken\n\nmore');
    await act(async () => { gate.resolve(); await expect(renaming).rejects.toMatchObject({ status: 409 }); });
    expect(called).toBe(false);
    await settle(600);
    expect(hook.remountKey).toBe(key);
    expect(disk.files.get('Untitled.md')).toBe(`${FM}# Taken\n\nmore`);
    expect(disk.files.get('Taken.md'), 'the other note is untouched').toBe('another note');
  });

  it('busy, and nothing moved, while an edit is not saved yet or another note is open', async () => {
    const ed = await newNoteTitled('Busy');
    const move = vi.fn(async () => {});
    await type(ed, '# Busy typing');
    let result: string | undefined;
    await act(async () => { result = await hook.renameOpenNote('Untitled.md', 'Busy.md', move, () => {}); });
    expect(result).toBe('busy');
    await settle(600);
    await act(async () => { result = await hook.renameOpenNote('Other.md', 'Busy.md', move, () => {}); });
    expect(result).toBe('busy');
    expect(move).not.toHaveBeenCalled();
  });

  it('a note left while its move was out: its unsaved text goes where the note ended up', async () => {
    const ed = await newNoteTitled('Draft');
    disk.files.set('Other.md', 'other');
    const gate = deferred();
    let renaming!: Promise<string>;
    let moved: string | null = null;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Draft.md', async () => { await gate.promise; moveOnDisk('Untitled.md', 'Draft.md'); }, (to) => { moved = to; });
    });
    await type(ed, '# Draft\n\nleft mid-move');
    // The click on another note unmounts this editor, then the page shows the other note.
    ed.destroy();
    await show('Other.md');
    await act(async () => { gate.resolve(); await renaming; });
    await settle(0);
    expect(moved).toBe('Draft.md');
    expect(disk.files.get('Draft.md')).toBe(`${FM}# Draft\n\nleft mid-move`);
    expect(disk.files.has('Untitled.md')).toBe(false);
    expect(disk.files.get('Other.md')).toBe('other');
  });

  it('switching notes still gets a new editor every time', async () => {
    disk.files.set('A.md', 'a');
    disk.files.set('B.md', 'b');
    await show('A.md');
    const a = hook.remountKey;
    await show('B.md');
    const b = hook.remountKey;
    await show('A.md');
    expect(new Set([a, b, hook.remountKey]).size).toBe(3);
    expect(hook.content).toBe('a');
  });
});

describe('only this editor\'s own save starts a rename; another writer keeps the name', () => {
  it('ownSave is set by a save of the open note, never by a load, and is cleared for another note', async () => {
    disk.files.set('Other.md', 'other');
    disk.files.set('Untitled.md', FM);
    await show('Untitled.md');
    expect(hook.ownSave, 'a load is not a save').toBeNull();
    const ed = fakeEditor('');
    await type(ed, '# Mine');
    await settle(600);
    expect(hook.ownSave?.path).toBe('Untitled.md');
    await show('Other.md');
    expect(hook.ownSave, 'another note waits for its own save').toBeNull();
    await show('Untitled.md');
    expect(hook.ownSave, 'back on the note: still no save of it by this editor').toBeNull();
  });

  it('a write from the notes chat (a notes:updated reload) ends the auto-naming and is no own save', async () => {
    disk.files.set('Untitled.md', FM);
    markAutoNamed('Untitled.md');
    await show('Untitled.md');
    // The AI writes the agenda into "the note you are viewing".
    disk.files.set('Untitled.md', `${FM}# Agenda\n\n- one`);
    await act(async () => { ws.handlers.get('notes:updated')!({ source: 'notes/Untitled', contentHash: hashOf(`${FM}# Agenda\n\n- one`) }); });
    await settle(0);
    expect(hook.content).toBe('# Agenda\n\n- one');
    expect(isAutoNamed('Untitled.md'), 'the writer still holds this path').toBe(false);
    expect(hook.ownSave).toBeNull();
  });

  it('a save of the same note from another view of this page ends the auto-naming', async () => {
    disk.files.set('Untitled.md', FM);
    markAutoNamed('Untitled.md');
    await show('Untitled.md');
    const theirs = `${FM}# From the Files panel`;
    await act(async () => {
      publishDocSaved({ key: noteDocKey('Untitled.md'), contentHash: hashOf(theirs), content: theirs, origin: 'files-panel' });
    });
    expect(hook.content).toBe('# From the Files panel');
    expect(isAutoNamed('Untitled.md')).toBe(false);
    expect(hook.ownSave).toBeNull();
  });

  it('typing on while a save is on its way does not leave a timer that keeps the rename busy', async () => {
    const ed = await newNoteTitled('Fast');
    let release!: () => void;
    disk.saveGate = new Promise<void>((r) => { release = r; });
    await type(ed, '# Fast typist');
    await settle(600); // that save is now waiting on the server
    await type(ed, '# Fast typist here');
    await settle(600); // the edit made during the save waits for it
    disk.saveGate = null;
    await act(async () => { release(); });
    await settle(600); // the follow-up save goes out and lands
    expect(disk.files.get('Untitled.md')).toBe(`${FM}# Fast typist here`);
    let result: string | undefined;
    await act(async () => {
      result = await hook.renameOpenNote('Untitled.md', 'Fast typist here.md', async () => moveOnDisk('Untitled.md', 'Fast typist here.md'), () => {});
    });
    expect(result).toBe('moved');
  });
});

describe('a move whose answer was lost', () => {
  it('timed out but happened on the server: the note follows, and the old file never comes back', async () => {
    const ed = await newNoteTitled('Lost');
    const gate = deferred();
    let renaming!: Promise<string>;
    let moved: string | null = null;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Lost.md', async () => {
        await gate.promise;
        moveOnDisk('Untitled.md', 'Lost.md');
        throw Object.assign(new Error('The request timed out'), { name: 'TimeoutError' });
      }, (to) => { moved = to; });
    });
    await type(ed, '# Lost\n\ntyped during the move');
    let result: string | undefined;
    await act(async () => { gate.resolve(); result = await renaming; });
    expect(result).toBe('moved');
    expect(moved).toBe('Lost.md');
    await show('Lost.md');
    await settle(600);
    expect(disk.files.get('Lost.md')).toBe(`${FM}# Lost\n\ntyped during the move`);
    expect(disk.files.has('Untitled.md'), 'nothing written back to the old path').toBe(false);
    expect(disk.saves.filter((s) => s.path === 'Untitled.md' && s.content.includes('typed during'))).toEqual([]);
  });

  it('a 502 that did not move it: the note keeps its path and its text is saved there', async () => {
    const ed = await newNoteTitled('Proxy');
    const gate = deferred();
    let renaming!: Promise<string>;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Proxy.md', async () => {
        await gate.promise;
        throw Object.assign(new Error('Bad gateway'), { status: 502 });
      }, () => {});
    });
    await type(ed, '# Proxy\n\nmore');
    await act(async () => { gate.resolve(); await expect(renaming).rejects.toMatchObject({ status: 502 }); });
    await settle(600);
    expect(disk.files.get('Untitled.md')).toBe(`${FM}# Proxy\n\nmore`);
    expect(disk.files.has('Proxy.md')).toBe(false);
  });

  it('when the server answers no read either, the note keeps its old path after a few tries', async () => {
    await newNoteTitled('Away');
    disk.offline = true;
    const readsBefore = disk.reads.length;
    let renaming!: Promise<string>;
    await act(async () => {
      renaming = hook.renameOpenNote('Untitled.md', 'Away.md', async () => { throw new Error('Failed to fetch'); }, () => {});
      renaming.catch(() => {});
    });
    await settle(2500);
    await act(async () => { await expect(renaming).rejects.toThrow('Failed to fetch'); });
    expect(disk.reads.length - readsBefore, 'the old path was read three times').toBe(3);
  });
});

describe('useNoteAutoName', () => {
  let renames: Array<[string, string]>;
  let renameAnswer: () => Promise<'moved' | 'busy'>;
  let failures: Array<[string, string]>;
  function AutoProbe(props: { path: string; body: string; ownSave: { path: string; seq: number } | null; existing: Set<string> }) {
    useNoteAutoName({
      ...props,
      rename: (from, to) => { renames.push([from, to]); return renameAnswer(); },
      onFailed: (from, to) => { failures.push([from, to]); },
    });
    return null;
  }
  async function auto(props: Parameters<typeof AutoProbe>[0]): Promise<void> {
    if (!root) root = createRoot((globalThis as unknown as { document: Document }).document.createElement('div'));
    await act(async () => { root!.render(createElement(AutoProbe, props)); });
  }
  const none = new Set<string>(['Untitled.md']);
  beforeEach(() => {
    renames = [];
    failures = [];
    renameAnswer = async () => 'moved';
  });

  it('renames after its own save once the title settled, and never on a load alone', async () => {
    markAutoNamed('Untitled.md');
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: null, existing: none });
    await settle(AUTO_NAME_SETTLE_MS * 3);
    expect(renames, 'no save of its own yet').toEqual([]);
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: { path: 'Untitled.md', seq: 1 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS - 10);
    expect(renames).toEqual([]);
    await settle(20);
    expect(renames).toEqual([['Untitled.md', 'Plan.md']]);
  });

  it('a save of another note, or a note no longer auto-named, starts nothing', async () => {
    markAutoNamed('Untitled.md');
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: { path: 'Other.md', seq: 4 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS * 2);
    forgetAutoName('Untitled.md');
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: { path: 'Untitled.md', seq: 5 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS * 2);
    expect(renames).toEqual([]);
  });

  it('a taken name (409) is not tried again; a lost answer is tried again after the next save', async () => {
    markAutoNamed('Untitled.md');
    renameAnswer = async () => { throw Object.assign(new Error('Destination note already exists'), { status: 409 }); };
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: { path: 'Untitled.md', seq: 1 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS + 10);
    await auto({ path: 'Untitled.md', body: '# Plan', ownSave: { path: 'Untitled.md', seq: 2 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS + 10);
    expect(renames).toEqual([['Untitled.md', 'Plan.md']]);

    renameAnswer = async () => { throw Object.assign(new Error('The Mac is away'), { status: 503 }); };
    await auto({ path: 'Untitled.md', body: '# Goals', ownSave: { path: 'Untitled.md', seq: 3 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS + 10);
    renameAnswer = async () => 'moved';
    await auto({ path: 'Untitled.md', body: '# Goals', ownSave: { path: 'Untitled.md', seq: 4 }, existing: none });
    await settle(AUTO_NAME_SETTLE_MS + 10);
    expect(renames.slice(1)).toEqual([['Untitled.md', 'Goals.md'], ['Untitled.md', 'Goals.md']]);
    expect(failures.length).toBe(2);
  });
});
