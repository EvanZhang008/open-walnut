import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fileDocKey,
  noteDocKey,
  memoryDocKey,
  publishDocSaved,
  subscribeDocSaved,
  rememberDocSave,
  wasSavedHere,
  beginDocSave,
  endDocSave,
  isDocSaveInFlight,
  resetDocSaveSignals,
} from '@/stores/file-save-signal';

/**
 * Contract tests for the browser-local doc-saved signal — the thing that makes
 * "one browser, one document" true for files, vault notes and memory docs.
 *
 * The invariants that carry the feature:
 *  1. A save reaches every OTHER mounted view of the same document, and only
 *     that document.
 *  2. The writer never reacts to its own save, and the test for that is the
 *     ORIGIN, not the hash — two views can hold byte-identical buffers.
 *  3. The hash registry answers "did this browser write these bytes?" across
 *     surfaces, which is what lets each of them drop the server's echo instead
 *     of re-reading (and, before this, mistaking it for a foreign write).
 *  4. In-flight bookkeeping is shared, because the server emits its bus event
 *     BEFORE the PUT response carries the hash that would identify it.
 */
describe('file-save-signal', () => {
  beforeEach(() => {
    resetDocSaveSignals();
  });

  describe('document keys', () => {
    it('a file is keyed by host + path, and the local host is not another host', () => {
      expect(fileDocKey(undefined, '/a/b.ts')).toBe(fileDocKey('local', '/a/b.ts'));
      expect(fileDocKey('clouddev', '/a/b.ts')).not.toBe(fileDocKey(undefined, '/a/b.ts'));
    });

    it('a memory doc is keyed by its memory-dir-relative path, .md KEPT', () => {
      // The /memory page selects by that exact relative path, and the server's
      // `memory:updated` carries the same string — dropping the extension here
      // would make the page and the event two different documents.
      expect(memoryDocKey('MEMORY.md')).toBe(memoryDocKey('/MEMORY.md'));
      expect(memoryDocKey('daily/2026-09-03.md')).not.toBe(memoryDocKey('MEMORY.md'));
      // A memory doc and a vault note of the same name are NOT the same document.
      expect(memoryDocKey('MEMORY.md')).not.toBe(noteDocKey('MEMORY.md'));
    });

    it('a note is keyed by its vault path with .md dropped — one name per note', () => {
      // The canonical `notes/{vault-path-without-.md}` name every server emitter
      // uses. Without this, the /notes editor (which holds `x.md`) and an event
      // naming `x` would be two different documents.
      expect(noteDocKey('Folder/x.md')).toBe(noteDocKey('Folder/x'));
      expect(noteDocKey('/global-notes.md')).toBe(noteDocKey('global-notes'));
      expect(noteDocKey('a.md')).not.toBe(noteDocKey('b.md'));
    });
  });

  it('delivers a save to other views of the same document, with the bytes', () => {
    const other = vi.fn();
    subscribeDocSaved(fileDocKey(undefined, '/repo/a.ts'), other);

    publishDocSaved({
      key: fileDocKey(undefined, '/repo/a.ts'),
      contentHash: 'h2',
      content: 'next',
      size: 4,
      origin: 'view-1',
    });

    expect(other).toHaveBeenCalledTimes(1);
    expect(other.mock.calls[0][0]).toMatchObject({ contentHash: 'h2', content: 'next', size: 4, origin: 'view-1' });
  });

  it('never delivers to a different document', () => {
    const sibling = vi.fn();
    subscribeDocSaved(fileDocKey(undefined, '/repo/other.ts'), sibling);
    publishDocSaved({ key: fileDocKey(undefined, '/repo/a.ts'), contentHash: 'h', origin: 'v' });
    expect(sibling).not.toHaveBeenCalled();
  });

  it('the writer is told about its own save and identifies it by ORIGIN, not hash', () => {
    // Both views hold the same bytes, so a hash comparison could not tell them
    // apart — this is why every signal carries who wrote it.
    const received: string[] = [];
    subscribeDocSaved(fileDocKey(undefined, '/repo/a.ts'), (s) => received.push(s.origin));
    publishDocSaved({ key: fileDocKey(undefined, '/repo/a.ts'), contentHash: 'same', origin: 'view-1' });
    expect(received).toEqual(['view-1']);
  });

  it('unsubscribing stops delivery (a view that unmounted must not be called)', () => {
    const gone = vi.fn();
    const unsub = subscribeDocSaved(fileDocKey(undefined, '/repo/a.ts'), gone);
    unsub();
    publishDocSaved({ key: fileDocKey(undefined, '/repo/a.ts'), contentHash: 'h', origin: 'v' });
    expect(gone).not.toHaveBeenCalled();
  });

  it('one listener throwing does not stop the others from converging', () => {
    const good = vi.fn();
    const key = fileDocKey(undefined, '/repo/a.ts');
    subscribeDocSaved(key, () => { throw new Error('boom'); });
    subscribeDocSaved(key, good);
    expect(() => publishDocSaved({ key, contentHash: 'h', origin: 'v' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  describe('the shared "this browser wrote it" registry', () => {
    it('publishing registers the hash, so a server echo is recognizable', () => {
      const key = noteDocKey('global-notes.md');
      expect(wasSavedHere(key, 'h9')).toBe(false);
      publishDocSaved({ key, contentHash: 'h9', content: 'x', origin: 'home-panel' });
      expect(wasSavedHere(key, 'h9')).toBe(true);
    });

    it('is shared across surfaces: the /notes editor recognizes the home panel save', () => {
      // This is the whole point of moving it out of the hooks: each hook used to
      // keep a private set and so only ever recognized its OWN writes.
      const key = noteDocKey('global-notes.md');
      rememberDocSave(key, 'written-by-home-panel');
      expect(wasSavedHere(key, 'written-by-home-panel')).toBe(true);
      expect(wasSavedHere(noteDocKey('other.md'), 'written-by-home-panel')).toBe(false);
    });

    it('is bounded per document — an old hash falls out rather than growing forever', () => {
      const key = fileDocKey(undefined, '/repo/a.ts');
      for (let i = 0; i < 12; i++) rememberDocSave(key, `h${i}`);
      expect(wasSavedHere(key, 'h11')).toBe(true);
      expect(wasSavedHere(key, 'h0')).toBe(false);
    });
  });

  describe('in-flight bookkeeping', () => {
    it('reports a save as mid-air until it settles', () => {
      const key = noteDocKey('a.md');
      expect(isDocSaveInFlight(key)).toBe(false);
      beginDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(true);
      endDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(false);
    });

    it('counts, so two surfaces saving the same doc do not clear each other', () => {
      const key = noteDocKey('a.md');
      beginDocSave(key);
      beginDocSave(key);
      endDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(true);
      endDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(false);
    });

    it('never goes negative on an unbalanced end', () => {
      const key = noteDocKey('a.md');
      endDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(false);
      beginDocSave(key);
      expect(isDocSaveInFlight(key)).toBe(true);
    });
  });
});
