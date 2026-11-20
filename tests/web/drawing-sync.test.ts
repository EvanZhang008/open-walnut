/**
 * DrawingSync (web/src/components/drawing/drawing-sync.ts): saving, conflicts, drafts and the
 * composer's sketch, against a fake drawings server whose answers the test holds and releases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import { DrawingConflictError, type DrawingApi } from '../../web/src/components/drawing/drawing-api';
import { emptyScene, parseScene, sceneFromEditor, type DrawingDocument, type DrawingScene } from '../../web/src/components/drawing/drawing-scene';
import { DrawingSync, fileDraftKey, hasUnsavedSketch, newSketchKey, sketchDraftKey, type DraftStore, type DrawingSnapshot, type DrawingSource } from '../../web/src/components/drawing/drawing-sync';

type Op = 'get' | 'put' | 'create' | 'rename';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

class FakeServer implements DrawingApi {
  files = new Map<string, DrawingDocument>();
  calls: Array<{ op: Op; path?: string; revision?: string; scene?: DrawingScene; known?: string; title?: string; firstText?: string; taskId?: string; clientId?: string }> = [];
  /** The next answers of an op are lost on the way back: the server did the work, the caller sees a network failure. */
  lose: Partial<Record<Op, number>> = {};
  /** Creates by id, as the server remembers them (store.ts createDrawing). */
  private created = new Map<string, string>();
  /** The appState a new file gets (the server's name mode). */
  createAppState: Record<string, unknown> = {};
  hold = false;
  /** The next answers carry this Notes-entry warning (the scene itself saved). */
  indexWarning: string | null = null;
  held: Array<() => void> = [];
  fail: Partial<Record<Op, unknown[]>> = {};
  private rev = 0;
  private next = 1;

  add(path: string, scene: DrawingScene = emptyScene(), title = 'Plan'): DrawingDocument {
    const doc = { path, title, revision: `r${++this.rev}`, scene: clone(scene) };
    this.files.set(path, doc);
    return clone(doc);
  }
  /** Someone else (an agent) writes the file. */
  writeElsewhere(path: string, scene: DrawingScene): DrawingDocument {
    const doc = { ...this.files.get(path)!, revision: `r${++this.rev}`, scene: clone(scene) };
    this.files.set(path, doc);
    return clone(doc);
  }
  private run<T>(op: Op, call: (typeof this.calls)[number], fn: () => T): Promise<T> {
    this.calls.push(call);
    const exec = () => {
      const failure = this.fail[op]?.shift();
      if (failure) throw failure;
      const value = fn();
      if (this.lose[op]) { this.lose[op]!--; throw new TypeError('Failed to fetch'); }
      return value;
    };
    if (!this.hold) return Promise.resolve().then(exec);
    return new Promise<T>((resolve, reject) => this.held.push(() => { try { resolve(exec()); } catch (e) { reject(e); } }));
  }
  get(path: string, known?: string) {
    return this.run('get', { op: 'get', path, known }, () => {
      const doc = this.files.get(path);
      if (!doc) throw new ApiError(404, 'Not found');
      return known === doc.revision ? null : { ...clone(doc), ...(this.indexWarning ? { indexWarning: this.indexWarning } : {}) };
    });
  }
  put(path: string, revision: string, scene: DrawingScene) {
    return this.run('put', { op: 'put', path, revision, scene: clone(scene) }, () => {
      const doc = this.files.get(path);
      if (!doc) throw new ApiError(404, 'Not found');
      if (doc.revision !== revision) throw new DrawingConflictError(clone(doc));
      return { ...this.writeElsewhere(path, scene), ...(this.indexWarning ? { indexWarning: this.indexWarning } : {}) };
    });
  }
  create(input: { taskId?: string; sessionId?: string; firstText?: string; title?: string; clientId?: string }) {
    return this.run('create', { op: 'create', firstText: input.firstText, taskId: input.taskId, title: input.title, clientId: input.clientId }, () => {
      const made = input.clientId ? this.created.get(input.clientId) : undefined;
      if (made && this.files.has(made)) return clone(this.files.get(made)!);
      const scene = emptyScene();
      scene.appState = { ...scene.appState, ...this.createAppState };
      const doc = this.add(`${input.taskId ? `Tasks/${input.taskId}` : 'Inbox'}/drawing-${this.next++}.excalidraw`, scene, input.title ?? 'Drawing 2026-11-16 10.00');
      if (input.clientId) this.created.set(input.clientId, doc.path);
      return doc;
    });
  }
  rename(path: string, revision: string, title: string) {
    return this.run('rename', { op: 'rename', path, revision, title }, () => {
      const doc = this.files.get(path);
      if (!doc) throw new ApiError(404, 'Not found');
      if (doc.revision !== revision) throw new DrawingConflictError(clone(doc));
      const to = `${path.slice(0, path.lastIndexOf('/') + 1)}${title}.excalidraw`;
      this.files.delete(path);
      const scene = { ...clone(doc.scene), appState: { ...doc.scene.appState, walnutTitle: 'set' } };
      const moved = { path: to, title, revision: `r${++this.rev}`, scene };
      this.files.set(to, moved);
      return clone(moved);
    });
  }
  renames() { return this.calls.filter((c) => c.op === 'rename'); }
  async list() { return []; }
  puts() { return this.calls.filter((c) => c.op === 'put'); }
  async release(n = Infinity) {
    while (n-- > 0 && this.held.length) { this.held.shift()!(); await settle(); }
  }
}

class MemoryStore implements DraftStore {
  map = new Map<string, string>();
  refuse = false;
  adopted: string[] = [];
  adopt(key: string) { this.adopted.push(key); }
  read(key: string) { return this.map.get(key) ?? ''; }
  write(key: string, text: string) {
    if (this.refuse) return;
    if (text) this.map.set(key, text); else this.map.delete(key);
  }
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await settle(); }

const rect = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version + 100, ...extra });
const sceneOf = (...els: Array<Record<string, unknown>>) => sceneFromEditor(els, {}, {});

let server: FakeServer;
let store: MemoryStore;
let seen: DrawingSnapshot[];

function open(source: DrawingSource, scope?: { taskId?: string }) {
  const sync = new DrawingSync(source, { api: server, store, scope, onChange: (s) => seen.push(s) });
  return sync;
}
const last = () => seen[seen.length - 1];

/** Open a file and let the editor report its first (own) form of the scene. */
async function openShown(path: string) {
  const sync = open({ kind: 'file', path });
  await sync.start();
  sync.edit(clone(last().scene!), last().sceneKey);
  return sync;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  store = new MemoryStore();
  seen = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('a drawing file', () => {
  it('opens without saving, then saves an edit once, against the revision it began from', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('a')));
    const sync = await openShown('Inbox/a.excalidraw');
    await tick(5_000);
    expect(server.puts()).toHaveLength(0);
    expect(last().state).toBe('saved');
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    expect(last()).toMatchObject({ state: 'unsaved', unsaved: true });
    await tick(1_000);
    expect(server.puts()).toHaveLength(1);
    expect(server.puts()[0]).toMatchObject({ revision: 'r1' });
    expect(last()).toMatchObject({ state: 'saved', unsaved: false, revision: 'r2' });
    expect(store.read(fileDraftKey('Inbox/a.excalidraw'))).toBe('');
  });

  it('keeps an edit made while a save is on its way, and saves it after', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.hold = true;
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('saving');
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    await tick(1_000);
    await server.release(1);
    // The first save answered, but the screen holds more: not saved yet.
    expect(last().state).not.toBe('saved');
    expect(last().unsaved).toBe(true);
    await server.release();
    await tick(1_000);
    await server.release();
    const puts = server.puts();
    expect(puts).toHaveLength(2);
    expect(puts[1].revision).toBe('r2');
    expect(puts[1].scene!.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(last()).toMatchObject({ state: 'saved', unsaved: false });
  });

  it('sends what was there when the save was taken, though the editor mutates the element meanwhile', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.hold = true;
    const line = { id: 'l', type: 'line', version: 2, versionNonce: 1, points: [[0, 0], [5, 5]] };
    sync.edit(sceneFromEditor([line], {}, {}), last().sceneKey);
    await tick(1_000);
    line.points[1] = [50, 50];
    line.version = 3;
    await server.release();
    expect(server.puts()[0].scene!.elements[0].points).toEqual([[0, 0], [5, 5]]);
  });

  it('a 409 merges by element: what only one side changed is kept from that side, with no question', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('shared'), rect('theirsEdit'), rect('mineEdit'), rect('gone')));
    const sync = await openShown('Inbox/a.excalidraw');
    // Elsewhere: one shape moved, one deleted, one added.
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('shared'), rect('theirsEdit', 2), rect('mineEdit'), rect('theirsNew')));
    // Here, meanwhile: another shape moved, one added.
    sync.edit(sceneOf(rect('shared'), rect('theirsEdit'), rect('mineEdit', 2), rect('gone'), rect('mineNew')), last().sceneKey);
    const key = last().sceneKey;
    await tick(1_000);
    const saved = server.files.get('Inbox/a.excalidraw')!.scene.elements.map((e) => `${e.id}@${e.version}`);
    expect(saved).toEqual(['shared@1', 'theirsEdit@2', 'mineEdit@2', 'theirsNew@1', 'mineNew@1']);
    expect(server.puts().at(-1)).toMatchObject({ revision: 'r2' });
    // The merge went on screen (a new load: not an undo step) and nothing asks the person.
    expect(last().sceneKey).toBe(key + 1);
    expect(last()).toMatchObject({ state: 'saved', conflict: null, unsaved: false });
  });

  it('only shapes both sides changed are a conflict; Keep mine keeps my version of them and every other change', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('shared'), rect('other')));
    const sync = await openShown('Inbox/a.excalidraw');
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('shared', 3), rect('other'), rect('theirsNew')));
    sync.edit(sceneOf(rect('shared', 2), rect('other', 2)), last().sceneKey);
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'conflict', conflictShapes: 1 });
    // More drawing while in conflict saves nothing, and the edits stay in the store.
    sync.edit(sceneOf(rect('shared', 2), rect('other', 2), rect('more')), last().sceneKey);
    await tick(60_000);
    expect(server.puts()).toHaveLength(1);
    expect(JSON.parse(store.read(fileDraftKey('Inbox/a.excalidraw')))).toMatchObject({ baseRevision: 'r1' });
    await sync.keepMine();
    expect(server.files.get('Inbox/a.excalidraw')!.scene.elements.map((e) => `${e.id}@${e.version}`))
      .toEqual(['shared@2', 'other@2', 'theirsNew@1', 'more@1']);
    expect(last()).toMatchObject({ state: 'saved', conflict: null });
  });

  it('Use theirs takes their version of the shapes both changed and still keeps my other changes', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('shared')));
    const sync = await openShown('Inbox/a.excalidraw');
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('shared', 3)));
    sync.edit(sceneOf(rect('shared', 2), rect('mineNew')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('conflict');
    const key = last().sceneKey;
    sync.useTheirs();
    await tick(10);
    expect(last().sceneKey).toBe(key + 1);
    expect(server.files.get('Inbox/a.excalidraw')!.scene.elements.map((e) => `${e.id}@${e.version}`)).toEqual(['shared@3', 'mineNew@1']);
    expect(last()).toMatchObject({ state: 'saved', conflict: null, unsaved: false });
    expect(store.read(fileDraftKey('Inbox/a.excalidraw'))).toBe('');
  });

  it('edits restored from an older revision, with no copy of it to merge against, ask about the whole drawing', async () => {
    server.add('Inbox/a.excalidraw');
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('agent')));
    store.write(fileDraftKey('Inbox/a.excalidraw'), JSON.stringify({ v: 1, baseRevision: 'r1', scene: sceneOf(rect('mine')) }));
    const sync = open({ kind: 'file', path: 'Inbox/a.excalidraw' });
    await sync.start();
    await tick(10);
    expect(last()).toMatchObject({ state: 'conflict', conflictShapes: 0 });
    sync.useTheirs();
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['agent']);
  });

  it('a 409 whose copy is exactly what this save sent (an earlier try reached the server) is a success', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    const mine = sceneOf(rect('a'));
    // The first try timed out here after the server wrote it.
    server.fail.put = [new TypeError('The request timed out')];
    sync.edit(mine, last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('offline');
    server.writeElsewhere('Inbox/a.excalidraw', mine);
    await tick(2_000);
    expect(last()).toMatchObject({ state: 'saved', conflict: null, revision: 'r2' });
    expect(server.puts()).toHaveLength(2);
  });

  it('Save mine as a copy saves the copy first, with strokes drawn while it was made, then shows their copy here', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('shared')));
    const sync = open({ kind: 'file', path: 'Inbox/a.excalidraw' }, { taskId: 't1' });
    await sync.start();
    sync.edit(clone(last().scene!), last().sceneKey);
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('shared', 3)));
    sync.edit(sceneOf(rect('shared', 2)), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('conflict');
    server.fail.create = [new Error('offline')];
    expect(await sync.saveAsCopy()).toBeNull();
    expect(last().state).toBe('conflict');
    expect(store.read(fileDraftKey('Inbox/a.excalidraw'))).not.toBe('');
    // A stroke lands while the copy's first save is on its way.
    server.hold = true;
    const copying = sync.saveAsCopy();
    await server.release(1);
    sync.edit(sceneOf(rect('shared', 2), rect('late')), last().sceneKey);
    await server.release();
    await server.release();
    const copy = await copying;
    expect(copy).toMatch(/^Tasks\/t1\//);
    expect(server.files.get(copy!)!.scene.elements.map((e) => e.id)).toEqual(['shared', 'late']);
    expect(last()).toMatchObject({ state: 'saved', conflict: null });
    expect(last().scene!.elements.map((e) => `${e.id}@${e.version}`)).toEqual(['shared@3']);
  });

  it('a refused save (too large, invalid) stops with the reason, keeps the drawing, and tries again on request', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.fail.put = [new ApiError(413, 'The drawing is too large to save')];
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'error', unsaved: true });
    expect(last().error).toMatch(/too large/);
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    await tick(60_000);
    expect(server.puts()).toHaveLength(1);
    expect(JSON.parse(store.read(fileDraftKey('Inbox/a.excalidraw'))).scene.elements).toHaveLength(2);
    await sync.retrySave();
    expect(last()).toMatchObject({ state: 'saved', unsaved: false, error: null });
  });

  it('takes in a change made elsewhere only while clean, with a conditional read', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    await sync.refresh();
    expect(server.calls.at(-1)).toMatchObject({ op: 'get', known: 'r1' });
    const key = last().sceneKey;
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('agent')));
    await sync.refresh();
    expect(last().sceneKey).toBe(key + 1);
    expect(last()).toMatchObject({ revision: 'r2', state: 'saved' });
    // Drawn while the read was out: the read is dropped, the edit stays.
    sync.edit(clone(last().scene!), last().sceneKey);
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('agent2')));
    server.hold = true;
    const reading = sync.refresh();
    sync.edit(sceneOf(rect('agent'), rect('mine')), last().sceneKey);
    await server.release();
    await reading;
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['agent', 'mine']);
    expect(last().sceneKey).toBe(key + 1);
  });

  it('a change announced while a read is out is read once that read ends, not at the next poll', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.hold = true;
    const first = sync.refresh(); // a poll's read, out when the agent's edit lands
    void sync.refresh(); // the server's push arrives while that read is out
    await server.release(1); // the poll's read answers from before the edit: no change
    await first;
    server.writeElsewhere('Inbox/a.excalidraw', sceneOf(rect('agent')));
    await server.release(); // the read the push asked for
    await vi.waitFor(() => expect(last()).toMatchObject({ revision: 'r2', state: 'saved' }));
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['agent']);
  });

  it("an agent's update of existing elements (new text, one deleted) shows while clean, and meets the conflict flow while dirty", async () => {
    const label = { id: 'label', type: 'text', text: 'Draft', x: 0, y: 0, version: 1, versionNonce: 1 };
    server.add('Inbox/a.excalidraw', sceneOf(label, rect('sketchy')));
    const sync = await openShown('Inbox/a.excalidraw');
    const key = last().sceneKey;
    // POST /api/drawings/update: the text rewritten, the hand-drawn shape removed (isDeleted).
    server.writeElsewhere('Inbox/a.excalidraw', parseScene({ elements: [{ ...label, text: 'Final', version: 2 }, rect('sketchy', 2, { isDeleted: true }), rect('neat')] })!);
    await sync.refresh();
    expect(last().sceneKey).toBe(key + 1);
    expect(last().scene!.elements.map((e) => [e.id, e.text ?? null])).toEqual([['label', 'Final'], ['neat', null]]);
    expect(last()).toMatchObject({ state: 'saved', unsaved: false });
    // The editor's form of that scene is no edit: nothing is saved back.
    sync.edit(clone(last().scene!), last().sceneKey);
    await tick(5_000);
    expect(server.puts()).toHaveLength(0);

    // Now with an unsaved edit here: the agent's next update is not taken in over it; the save
    // meets a 409 and merges, keeping both: their new label text and deletion, my new shape.
    sync.edit(sceneOf(last().scene!.elements[0], last().scene!.elements[1], rect('mine')), last().sceneKey);
    server.writeElsewhere('Inbox/a.excalidraw', parseScene({ elements: [{ ...label, text: 'Final v2', version: 3 }] })!);
    await sync.refresh();
    expect(last().scene!.elements.map((e) => e.id)).toContain('mine');
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'saved', conflict: null });
    expect(server.files.get('Inbox/a.excalidraw')!.scene.elements.map((e) => [e.id, e.text ?? null])).toEqual([['label', 'Final v2'], ['mine', null]]);
  });

  it('an edit as the editor first reports is saved, not mistaken for the loaded scene', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('a')));
    const sync = open({ kind: 'file', path: 'Inbox/a.excalidraw' });
    await sync.start();
    sync.edit(sceneOf(rect('a', 2)), last().sceneKey);
    await tick(1_000);
    expect(server.puts()).toHaveLength(1);
  });

  it('after a close, its last edits are kept and sent; it reports nothing more; a reopen waits for that save', async () => {
    server.add('Inbox/a.excalidraw');
    const first = await openShown('Inbox/a.excalidraw');
    first.edit(sceneOf(rect('a')), last().sceneKey);
    server.hold = true;
    first.dispose();
    expect(JSON.parse(store.read(fileDraftKey('Inbox/a.excalidraw'))).scene.elements[0].id).toBe('a');
    const reported = seen.length;
    expect(server.puts()).toHaveLength(1);
    // Reopened while that save is still out.
    const second = open({ kind: 'file', path: 'Inbox/a.excalidraw' });
    const starting = second.start();
    await settle();
    expect(server.calls.filter((c) => c.op === 'get')).toHaveLength(1);
    await server.release();
    await starting;
    await server.release();
    await starting;
    expect(seen.slice(reported).every((s) => s.source === second.source)).toBe(true);
    // It opens the saved file, clean, and the old save left no draft behind.
    expect(last()).toMatchObject({ state: 'saved', revision: 'r2', unsaved: false });
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['a']);
    expect(store.read(fileDraftKey('Inbox/a.excalidraw'))).toBe('');
  });

  it('a reload brings back unsaved edits and saves them against the revision they began from', async () => {
    server.add('Inbox/a.excalidraw');
    store.write(fileDraftKey('Inbox/a.excalidraw'), JSON.stringify({ v: 1, baseRevision: 'r1', scene: sceneOf(rect('kept')) }));
    const sync = open({ kind: 'file', path: 'Inbox/a.excalidraw' });
    await sync.start();
    expect(last()).toMatchObject({ state: 'unsaved', unsaved: true });
    await tick(10);
    expect(server.puts()[0]).toMatchObject({ revision: 'r1' });
    expect(last().state).toBe('saved');
    // Changed elsewhere since: the restored edits meet a 409, not an overwrite.
    store.write(fileDraftKey('Inbox/a.excalidraw'), JSON.stringify({ v: 1, baseRevision: 'r1', scene: sceneOf(rect('older')) }));
    const again = open({ kind: 'file', path: 'Inbox/a.excalidraw' });
    await again.start();
    await tick(10);
    expect(last().state).toBe('conflict');
    expect(sync).toBeTruthy();
  });

  it('a draft that does not parse is kept aside, never read as an empty drawing', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('server')));
    store.write(fileDraftKey('Inbox/a.excalidraw'), '{"v":1,"baseRevision":"r1","scene":{"elements":"broken"}}');
    const sync = await openShown('Inbox/a.excalidraw');
    expect(store.read(`${fileDraftKey('Inbox/a.excalidraw')}:unreadable`)).toContain('broken');
    expect(last().error).toMatch(/kept aside/);
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['server']);
    await tick(5_000);
    expect(server.puts()).toHaveLength(0);
    expect(sync).toBeTruthy();
  });

  it('retries a failed save, and an unreadable 409 stops with an error instead of retrying', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.fail.put = [new TypeError('Failed to fetch')];
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('offline');
    await tick(2_000);
    expect(last().state).toBe('saved');
    const { DrawingUnreadableError } = await import('../../web/src/components/drawing/drawing-api');
    server.fail.put = [new DrawingUnreadableError('unreadable')];
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'error', error: 'unreadable' });
    await tick(60_000);
    expect(server.puts()).toHaveLength(3);
  });

  it('a save whose Notes entry failed is saved, says so, and a read again clears it once repaired', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.indexWarning = 'the note could not be written';
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'saved', unsaved: false });
    expect(last().warning).toMatch(/Notes entry was not updated: the note could not be written/);
    await sync.retryIndex();
    expect(last().warning).toMatch(/not updated/);
    server.indexWarning = null;
    await sync.retryIndex();
    expect(last().warning).toBeNull();
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('says so when the draft store refuses the unsaved edits', async () => {
    server.add('Inbox/a.excalidraw');
    const sync = await openShown('Inbox/a.excalidraw');
    server.fail.put = [new TypeError('Failed to fetch')];
    store.refuse = true;
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(400);
    expect(last().kept).toBe(false);
  });
});

describe("the composer's sketch", () => {
  const key = sketchDraftKey('draft-1');

  it('makes its file with the first content, saves what was drawn meanwhile, and the draft points at it', async () => {
    const sync = open({ kind: 'sketch', key }, { taskId: 't1' });
    await sync.start();
    expect(last()).toMatchObject({ state: 'sketch', path: null });
    // The very first report is already the person's stroke.
    server.hold = true;
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(400);
    expect(JSON.parse(store.read(key)).scene.elements[0].id).toBe('a');
    await tick(1_000);
    expect(server.calls.map((c) => c.op)).toEqual(['create']);
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    await server.release();
    // The file is known before its save: a reload would not make a second one.
    expect(JSON.parse(store.read(key))).toMatchObject({ path: 'Tasks/t1/drawing-1.excalidraw' });
    await server.release();
    await tick(1_000);
    await server.release();
    expect(server.files.get('Tasks/t1/drawing-1.excalidraw')!.scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(last()).toMatchObject({ state: 'saved', path: 'Tasks/t1/drawing-1.excalidraw' });
    expect(JSON.parse(store.read(key))).toEqual({ v: 1, path: 'Tasks/t1/drawing-1.excalidraw' });
    // The next Draw of this draft opens the same file.
    sync.dispose();
    server.hold = false;
    const again = open({ kind: 'sketch', key });
    await again.start();
    expect(last()).toMatchObject({ path: 'Tasks/t1/drawing-1.excalidraw', state: 'saved' });
  });

  it('an empty sketch makes no file', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    sync.edit(emptyScene(), last().sceneKey);
    await tick(10_000);
    sync.dispose();
    await settle();
    expect(server.calls).toHaveLength(0);
    expect(store.read(key)).toBe('');
  });

  it('a failed create keeps the sketch in the draft and tries again', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    server.fail.create = [new TypeError('Failed to fetch')];
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('offline');
    expect(JSON.parse(store.read(key)).scene.elements[0].id).toBe('a');
    expect(server.files.size).toBe(0);
    await tick(2_000);
    expect(last().state).toBe('saved');
    expect(server.files.size).toBe(1);
  });

  it('a sketch drawn and closed at once still reaches its file; reopening waits for it', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    server.hold = true;
    sync.dispose();
    const again = open({ kind: 'sketch', key });
    const starting = again.start();
    await server.release();
    await server.release();
    await server.release();
    await starting;
    expect(server.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(last()).toMatchObject({ state: 'saved', path: 'Inbox/drawing-1.excalidraw' });
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('an unreadable sketch draft is kept aside and the sketch starts empty', async () => {
    store.write(key, '{"v":1,"scene":{"elements":7}}');
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    expect(store.read(`${key}:unreadable`)).toContain('"elements":7');
    expect(last()).toMatchObject({ state: 'sketch', error: expect.stringMatching(/kept aside/) });
    expect(sync).toBeTruthy();
  });

  it('after Attach the draft lets go of a saved file; an unsaved one is kept for the next Draw', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('saved');
    expect(await sync.releaseComposerDraft()).toBe(true);
    expect(store.read(key)).toBe('');
    expect(server.files.size).toBe(1);

    const other = open({ kind: 'sketch', key: sketchDraftKey('draft-2') });
    await other.start();
    server.fail.create = [new TypeError('Failed to fetch')];
    other.edit(sceneOf(rect('b')), last().sceneKey);
    expect(await other.releaseComposerDraft()).toBe(false);
    expect(JSON.parse(store.read(sketchDraftKey('draft-2'))).scene.elements[0].id).toBe('b');
  });

  it('opening a file from the list points the draft at it only after the sketch left behind is written', async () => {
    server.add('Inbox/old.excalidraw', parseScene({ elements: [rect('old')] })!);
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    server.hold = true;
    sync.dispose();
    const picked = open({ kind: 'sketch', key, open: 'Inbox/old.excalidraw' });
    const starting = picked.start();
    for (let i = 0; i < 4; i++) await server.release();
    await starting;
    expect(last()).toMatchObject({ path: 'Inbox/old.excalidraw', state: 'saved' });
    expect(JSON.parse(store.read(key))).toEqual({ v: 1, path: 'Inbox/old.excalidraw' });
    // The sketch left behind became its own file.
    expect([...server.files.values()].some((d) => d.scene.elements[0]?.id === 'a')).toBe(true);
  });

  it('a sketch not in Notes yet is never written over by opening another drawing in its draft', async () => {
    server.add('Inbox/other.excalidraw', sceneOf(rect('other')));
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    server.fail.create = [new TypeError('Failed to fetch'), new TypeError('Failed to fetch')];
    sync.edit(sceneOf(rect('offline-sketch')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('offline');
    sync.dispose();
    await settle();
    const picked = open({ kind: 'sketch', key, open: 'Inbox/other.excalidraw' });
    await picked.start();
    expect(last().error).toMatch(/not in Notes yet/);
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['offline-sketch']);
    expect(JSON.parse(store.read(key)).scene.elements[0].id).toBe('offline-sketch');
  });

  it("keeps what the editor does not know (appState keys, top-level keys) when it saves", async () => {
    server.add('Inbox/a.excalidraw', parseScene({ elements: [rect('a')], appState: { viewBackgroundColor: '#fff', customTool: 'x' }, libraryVersion: 3 } as unknown)!);
    const sync = await openShown('Inbox/a.excalidraw');
    // The editor reports only its own view settings.
    sync.edit(sceneFromEditor([rect('a', 2)], { viewBackgroundColor: '#eee', scrollX: 50 }, {}), last().sceneKey);
    await tick(1_000);
    const sent = server.puts()[0].scene!;
    expect(sent.appState).toEqual({ viewBackgroundColor: '#eee', customTool: 'x' });
    expect(sent.extra).toEqual({ libraryVersion: 3 });
  });
});

const text = (id: string, words: string, x = 0, y = 0, version = 1) => ({ id, type: 'text', x, y, width: 50, height: 20, text: words, originalText: words, version, versionNonce: version + 100 });

describe('naming', () => {
  it("a file Walnut named follows its first text line once, after a save; the new path is adopted", async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Drawing 2026-11-16 10.00');
    const sync = await openShown('Inbox/d.excalidraw');
    sync.edit(sceneOf(text('t', 'Order review\nsecond line', 10, 40), text('u', 'later', 0, 300)), last().sceneKey);
    await tick(1_000);
    // The editor reports only its own view settings: the name mode comes from the loaded file.
    expect(server.puts()[0].scene!.appState.walnutTitle).toBe('auto');
    expect(server.renames()).toHaveLength(1);
    expect(server.renames()[0]).toMatchObject({ path: 'Inbox/d.excalidraw', title: 'Order review' });
    expect(last()).toMatchObject({ path: 'Inbox/Order review.excalidraw', title: 'Order review', state: 'saved', unsaved: false });
    // The next edit saves to the new path, carrying the name mode the server set.
    sync.edit(sceneOf(text('t', 'Order review\nsecond line', 10, 40), text('u', 'later', 0, 300), rect('r')), last().sceneKey);
    await tick(1_000);
    const lastPut = server.puts().at(-1)!;
    expect(lastPut.path).toBe('Inbox/Order review.excalidraw');
    expect(lastPut.scene!.appState.walnutTitle).toBe('set');
    // Once: a changed first line never renames again.
    sync.edit(sceneOf(text('t', 'Another title', 10, 40, 2)), last().sceneKey);
    await tick(1_000);
    expect(server.renames()).toHaveLength(1);
  });

  it('never renames a name a person set, or a file with no text', async () => {
    server.add('Inbox/set.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'set' } })!, 'My plan');
    const a = await openShown('Inbox/set.excalidraw');
    a.edit(sceneOf(text('t', 'Something else')), last().sceneKey);
    await tick(1_000);
    server.add('Inbox/auto.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Drawing 1');
    const b = await openShown('Inbox/auto.excalidraw');
    b.edit(sceneOf(rect('r')), last().sceneKey);
    await tick(1_000);
    expect(server.puts()).toHaveLength(2);
    expect(server.renames()).toHaveLength(0);
  });

  it('waits while a text box is open, then renames', async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Drawing 1');
    let editing = true;
    const sync = new DrawingSync({ kind: 'file', path: 'Inbox/d.excalidraw' }, { api: server, store, onChange: (s) => seen.push(s), canAutoRename: () => !editing });
    await sync.start();
    sync.edit(clone(last().scene!), last().sceneKey);
    sync.edit(sceneOf(text('t', 'Hel')), last().sceneKey);
    await tick(1_000);
    expect(server.renames()).toHaveLength(0);
    editing = false;
    sync.edit(sceneOf(text('t', 'Hello world', 0, 0, 2)), last().sceneKey);
    await tick(1_000);
    expect(server.renames().map((r) => r.title)).toEqual(['Hello world']);
  });

  it('a rename that waited for a text box runs when the box closes, though closing it saves nothing more', async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Plan the review');
    let editing = true;
    const sync = new DrawingSync({ kind: 'file', path: 'Inbox/d.excalidraw' }, { api: server, store, onChange: (s) => seen.push(s), canAutoRename: () => !editing });
    await sync.start();
    sync.edit(clone(last().scene!), last().sceneKey);
    // The whole text is typed and saved while its box is still open.
    sync.edit(sceneOf(text('t', 'Order\nreview')), last().sceneKey);
    await tick(1_000);
    expect(last()).toMatchObject({ state: 'saved', unsaved: false });
    expect(server.renames()).toHaveLength(0);
    // The box closes with nothing new to save.
    editing = false;
    sync.textEditEnded();
    await tick(1_000);
    expect(server.renames().map((r) => r.title)).toEqual(['Order']);
    expect(server.puts()).toHaveLength(1);
  });

  it('a 409 on rename with the same content is retried once on the newer revision; changed content is not renamed over', async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'set' } })!, 'Plan');
    const sync = await openShown('Inbox/d.excalidraw');
    // The revision moved with nothing changed (a repaired Notes entry).
    const doc = server.files.get('Inbox/d.excalidraw')!;
    server.files.set('Inbox/d.excalidraw', { ...doc, revision: 'r99' });
    expect(await sync.rename('Plan B')).toBeNull();
    expect(server.renames().map((r) => r.revision)).toEqual(['r1', 'r99']);
    expect(last()).toMatchObject({ path: 'Inbox/Plan B.excalidraw', title: 'Plan B' });

    server.add('Inbox/e.excalidraw', sceneOf(rect('a')), 'E');
    const other = await openShown('Inbox/e.excalidraw');
    server.writeElsewhere('Inbox/e.excalidraw', sceneOf(rect('a'), rect('agent')));
    const before = server.renames().length;
    expect(await other.rename('E2')).toMatch(/changed somewhere else/);
    expect(server.renames().length - before).toBe(1);
    expect(server.files.has('Inbox/e.excalidraw')).toBe(true);
  });

  it('a manual rename saves what is on screen first, and the old file draft is cleared', async () => {
    server.add('Inbox/d.excalidraw', sceneOf(rect('a')), 'Plan');
    const sync = await openShown('Inbox/d.excalidraw');
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    expect(await sync.rename('  Better   plan ')).toBeNull();
    expect(server.calls.map((c) => c.op).filter((o) => o !== 'get')).toEqual(['put', 'rename']);
    expect(server.renames()[0].title).toBe('Better plan');
    expect(server.files.get('Inbox/Better plan.excalidraw')!.scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store.read(fileDraftKey('Inbox/d.excalidraw'))).toBe('');
  });

  it('follows a rename made elsewhere and reads the file at its new path', async () => {
    server.add('Inbox/d.excalidraw', sceneOf(rect('a')), 'Plan');
    const sync = await openShown('Inbox/d.excalidraw');
    const moved = await server.rename('Inbox/d.excalidraw', 'r1', 'Moved');
    sync.followMove('Inbox/d.excalidraw', moved.path);
    await tick(10);
    expect(last()).toMatchObject({ path: 'Inbox/Moved.excalidraw', title: 'Moved', revision: moved.revision, state: 'saved' });
  });
});

describe('a rename made elsewhere while a save is out', () => {
  it('a save that found the old path gone leaves "missing" once the move is heard, and saves at the new path', async () => {
    server.add('Inbox/d.excalidraw', sceneOf(rect('a')), 'Plan');
    const sync = await openShown('Inbox/d.excalidraw');
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    const moved = await server.rename('Inbox/d.excalidraw', 'r1', 'Moved');
    await tick(1_000);
    expect(last().state).toBe('missing');
    sync.followMove('Inbox/d.excalidraw', moved.path);
    await tick(10);
    expect(last()).toMatchObject({ path: 'Inbox/Moved.excalidraw', state: 'saved', unsaved: false, error: null });
    expect(server.files.get('Inbox/Moved.excalidraw')!.scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
    // The 5 s poll reads the new path.
    server.writeElsewhere('Inbox/Moved.excalidraw', sceneOf(rect('a'), rect('b'), rect('agent')));
    await sync.refresh();
    expect(server.calls.at(-1)).toMatchObject({ op: 'get', path: 'Inbox/Moved.excalidraw' });
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['a', 'b', 'agent']);
  });

  it('a 404 that answers a save sent before the move was heard is saved again at the new path', async () => {
    server.add('Inbox/d.excalidraw', sceneOf(rect('a')), 'Plan');
    const sync = await openShown('Inbox/d.excalidraw');
    server.hold = true;
    sync.edit(sceneOf(rect('a'), rect('b')), last().sceneKey);
    await tick(1_000);
    expect(server.held).toHaveLength(1);
    server.hold = false;
    const moved = await server.rename('Inbox/d.excalidraw', 'r1', 'Moved');
    sync.followMove('Inbox/d.excalidraw', moved.path);
    await server.release();
    await tick(10);
    expect(last()).toMatchObject({ path: 'Inbox/Moved.excalidraw', state: 'saved', unsaved: false });
    expect(server.files.get('Inbox/Moved.excalidraw')!.scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('a create whose answer was lost', () => {
  const key = sketchDraftKey('draft-lost');

  it('is sent again with the same id, so the server answers the file it made: never a second one', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    server.lose.create = 1;
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('offline');
    expect(server.files.size).toBe(1);
    await tick(2_000);
    const creates = server.calls.filter((c) => c.op === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0].clientId).toBeTruthy();
    expect(creates[1].clientId).toBe(creates[0].clientId);
    expect(server.files.size).toBe(1);
    expect(last()).toMatchObject({ state: 'saved', path: 'Inbox/drawing-1.excalidraw' });
  });

  it('keeps its id in the draft, so a reload sends the same one', async () => {
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    server.lose.create = 1;
    sync.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    const first = server.calls.find((c) => c.op === 'create')!.clientId;
    expect(JSON.parse(store.read(key)).createId).toBe(first);
    sync.dispose();
    await settle();
    const again = open({ kind: 'sketch', key });
    await again.start();
    await tick(10);
    expect(server.calls.filter((c) => c.op === 'create').map((c) => c.clientId)).toEqual([first, first]);
    expect(server.files.size).toBe(1);
    expect(last()).toMatchObject({ state: 'saved', path: 'Inbox/drawing-1.excalidraw' });
  });
});

describe('closing right after typing', () => {
  it('runs the auto-rename with the final save, and the next controller on the old path follows it', async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Drawing 2026-11-16 10.00');
    const sync = await openShown('Inbox/d.excalidraw');
    sync.edit(sceneOf(text('t', 'Order review')), last().sceneKey);
    await tick(100);
    sync.dispose();
    await tick(1_000);
    expect(server.renames().map((r) => r.title)).toEqual(['Order review']);
    expect(server.files.get('Inbox/Order review.excalidraw')!.scene.elements.map((e) => e.id)).toEqual(['t']);
    const next = open({ kind: 'file', path: 'Inbox/d.excalidraw' });
    await next.start();
    expect(last()).toMatchObject({ path: 'Inbox/Order review.excalidraw', state: 'saved' });
  });

  it('runs a rename that waited for a text box when the editor closes, and never one for a name a person set', async () => {
    server.add('Inbox/d.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'auto' } })!, 'Drawing 1');
    const sync = new DrawingSync({ kind: 'file', path: 'Inbox/d.excalidraw' }, { api: server, store, onChange: (s) => seen.push(s), canAutoRename: () => false });
    await sync.start();
    sync.edit(clone(last().scene!), last().sceneKey);
    sync.edit(sceneOf(text('t', 'Hello world')), last().sceneKey);
    await tick(1_000);
    expect(server.renames()).toHaveLength(0);
    sync.dispose();
    await tick(10);
    expect(server.renames().map((r) => r.title)).toEqual(['Hello world']);

    server.add('Inbox/set.excalidraw', parseScene({ elements: [], appState: { walnutTitle: 'set' } })!, 'My plan');
    const set = await openShown('Inbox/set.excalidraw');
    set.edit(sceneOf(text('t', 'Something else')), last().sceneKey);
    set.dispose();
    await tick(1_000);
    expect(server.renames()).toHaveLength(1);
  });

  it("a sketch's draft names the renamed file, so the next Draw opens it", async () => {
    const key = sketchDraftKey('draft-close');
    server.createAppState = { walnutTitle: 'auto' };
    const sync = open({ kind: 'sketch', key });
    await sync.start();
    sync.edit(sceneOf(text('t', 'Queue design')), last().sceneKey);
    await tick(100);
    sync.dispose();
    await tick(1_000);
    expect(server.renames().map((r) => r.title)).toEqual(['Queue design']);
    expect(JSON.parse(store.read(key))).toEqual({ v: 1, path: 'Inbox/Queue design.excalidraw' });
  });
});

describe("a gone tab's drafts", () => {
  it('are offered to the store when a file or a sketch opens', async () => {
    server.add('Inbox/a.excalidraw', sceneOf(rect('a')));
    await open({ kind: 'file', path: 'Inbox/a.excalidraw' }).start();
    await open({ kind: 'sketch', key: sketchDraftKey('d9') }).start();
    expect(store.adopted).toEqual([fileDraftKey('Inbox/a.excalidraw'), sketchDraftKey('d9')]);
  });
});

describe('"New drawing" is a sketch until its first content', () => {
  const key = newSketchKey('task:t1');

  it('makes no file when nothing is drawn, then one with its first text and the place it belongs to', async () => {
    server.createAppState = { walnutTitle: 'auto' };
    const sync = open({ kind: 'sketch', key, fresh: 1 }, { taskId: 't1' });
    await sync.start();
    await tick(5_000);
    expect(server.calls.filter((c) => c.op === 'create')).toHaveLength(0);
    sync.edit(sceneOf(text('t', 'Payments flow\nv2'), rect('r')), last().sceneKey);
    await tick(1_000);
    const creates = server.calls.filter((c) => c.op === 'create');
    expect(creates).toEqual([expect.objectContaining({ taskId: 't1', firstText: 'Payments flow\nv2' })]);
    // The created file is named by the server ('auto'), and the save carries that mode.
    expect(server.puts()[0].scene!.appState.walnutTitle).toBe('auto');
  });

  // 2026-11-20, the user: "I click this new but doesn't work". The composer's drawing waited on a
  // conflict, which counted as "not in Notes yet", and the refusal hid behind the conflict bar.
  it('a New over a drawing in Notes that waits on a conflict starts blank; the file keeps my edits and asks again', async () => {
    const path = 'Tasks/t1/plan.excalidraw';
    server.add(path, sceneOf(rect('shared')));
    const first = open({ kind: 'sketch', key, open: path }, { taskId: 't1' });
    await first.start();
    first.edit(last().scene!, last().sceneKey);
    server.writeElsewhere(path, sceneOf(rect('shared', 3)));
    first.edit(sceneOf(rect('shared', 2), rect('mine')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('conflict');
    first.flushDraft();
    first.dispose();
    await settle();
    const fresh = open({ kind: 'sketch', key, fresh: 2 }, { taskId: 't1' });
    await fresh.start();
    expect(last()).toMatchObject({ state: 'sketch', path: null, error: null });
    expect(last().scene!.elements).toHaveLength(0);
    fresh.dispose();
    await settle();
    // Back to that drawing: my edits are there, and the choice is asked again.
    const again = open({ kind: 'sketch', key, open: path }, { taskId: 't1' });
    await again.start();
    await tick(1_000);
    expect(last().scene!.elements.map((e) => e.id)).toContain('mine');
    expect(last().state).toBe('conflict');
    expect(server.files.get(path)!.scene.elements.map((e) => `${e.id}@${e.version}`)).toEqual(['shared@3']);
  });

  it('a New over a drawing just made in Notes, its first save still out, hands those edits to the file', async () => {
    const first = open({ kind: 'sketch', key, fresh: 1 }, { taskId: 't1' });
    await first.start();
    server.fail.put = Array.from({ length: 5 }, () => new TypeError('Failed to fetch'));
    first.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    const made = last().path!;
    expect(made).toMatch(/^Tasks\/t1\//);
    first.flushDraft();
    first.dispose();
    await settle();
    server.fail.put = [];
    const fresh = open({ kind: 'sketch', key, fresh: 2 }, { taskId: 't1' });
    await fresh.start();
    expect(last()).toMatchObject({ state: 'sketch', path: null, error: null });
    expect(JSON.parse(store.read(fileDraftKey(made))).scene.elements.map((e: { id: string }) => e.id)).toEqual(['a']);
  });

  it('a fresh New starts blank over a sketch already in Notes, and keeps one that is not', async () => {
    const first = open({ kind: 'sketch', key, fresh: 1 }, { taskId: 't1' });
    await first.start();
    first.edit(sceneOf(rect('a')), last().sceneKey);
    await tick(1_000);
    expect(last().state).toBe('saved');
    first.dispose();
    const second = open({ kind: 'sketch', key, fresh: 2 }, { taskId: 't1' });
    await second.start();
    expect(last()).toMatchObject({ state: 'sketch', path: null });
    expect(last().scene!.elements).toHaveLength(0);
    // Offline: the new sketch is not in Notes, so the next New keeps it and says so.
    server.fail.create = Array.from({ length: 5 }, () => new TypeError('Failed to fetch'));
    second.edit(sceneOf(rect('b')), last().sceneKey);
    await tick(1_000);
    second.flushDraft();
    second.dispose();
    expect(hasUnsavedSketch(store, key)).toBe(true);
    const third = open({ kind: 'sketch', key, fresh: 3 }, { taskId: 't1' });
    await third.start();
    expect(last().scene!.elements.map((e) => e.id)).toEqual(['b']);
    expect(last().error).toMatch(/not in Notes yet/);
  });
});
