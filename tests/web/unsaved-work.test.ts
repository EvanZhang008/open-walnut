/**
 * What a reload or an app restart would lose (web/src/utils/unsaved-work.ts).
 *
 * The bug this pins (2026-10-24): every non-empty `<textarea>` counted, so one
 * composer draft that was already saved in storage (and comes back after the
 * restart) blocked "Restart" with "Could not restart Walnut" and an OK button.
 * A composer now confirms its save through DRAFT_FLUSH_EVENT; only text nobody
 * saved still counts, and every item says where it is.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { DRAFT_FLUSH_EVENT, listUnsavedWork, type DraftFlushDetail } from '../../web/src/utils/unsaved-work';

function page(html: string) {
  const { window, document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
  } });
  return { window, document: document as unknown as Document, store };
}

/** A composer answering the flush the way ChatInput does: save, then claim. */
function composer(window: { addEventListener: (t: string, l: (e: Event) => void) => void }, store: Map<string, string>, el: Element, key: string, opts: { popout?: boolean } = {}) {
  window.addEventListener(DRAFT_FLUSH_EVENT, (e: Event) => {
    const detail = (e as CustomEvent<DraftFlushDetail>).detail;
    if (detail.scope === 'leave' && opts.popout) return;
    const text = (el as HTMLTextAreaElement).value;
    store.set(key, text);
    detail.claims.push({ element: el, key, text });
  });
}

function list(html: string, activeSelector?: string) {
  const { document } = page(html);
  const active = activeSelector ? document.querySelector(activeSelector) : null;
  return listUnsavedWork(document, active);
}

/** The Files panel as it actually renders: a CodeMirror editor holding a file. */
const FILE_OPEN = `
  <div class="file-content-view">
    <div class="cm-editor"><div class="cm-content" contenteditable="true">package informers\nfunc F() {}</div></div>
  </div>
  <textarea class="composer"></textarea>`;

describe('unsaved work: what counts', () => {
  it('an open file with an empty composer is safe', () => {
    // .cm-content is contenteditable and holds the whole file; a naive scan
    // called this "unsaved" and the tab never healed.
    expect(list(FILE_OPEN)).toEqual([]);
    expect(list(FILE_OPEN, '.cm-content')).toEqual([]);
  });

  it('the dirty dot next to Save counts', () => {
    expect(list(`${FILE_OPEN}<span class="fv-dirty-dot">●</span>`).map((i) => i.kind)).toEqual(['file']);
  });

  it.each(['notes-save-status saving', 'notes-save-status error', 'global-notes-saving', 'global-notes-error'])('a note with %s counts', (cls) => {
    expect(list(`<span class="${cls}">Save status</span>`).map((i) => i.kind)).toEqual(['note']);
  });

  it('a saved note does not count', () => {
    expect(list('<span class="notes-save-status saved">Saved</span>')).toEqual([]);
  });

  it('text in a box nobody saved counts even without focus', () => {
    const items = list('<textarea aria-label="Reply to the thread">half a thought</textarea>');
    expect(items).toMatchObject([{ kind: 'message', what: 'Unsent text', where: 'the “Reply to the thread” box' }]);
  });

  it('an image pasted into a composer counts once per composer, though it has no text', () => {
    const items = list('<textarea></textarea><div class="chat-image-previews"><div class="chat-image-preview"><img src="a.png"></div><div class="chat-image-preview"><img src="b.png"></div></div>');
    expect(items.map((i) => i.kind)).toEqual(['attachment']);
  });

  it('a task title being edited inline counts; a checkbox and an unfocused search box do not', () => {
    expect(list('<div class="todo-title" contenteditable="true">renaming this</div>', '.todo-title').map((i) => i.kind)).toEqual(['field']);
    expect(list('<input id="c" type="checkbox" value="on">', '#c')).toEqual([]);
    expect(list('<input type="search" value="SetTransform">')).toEqual([]);
  });

  it('the search box being typed in right now counts', () => {
    const { document } = page('<input id="q" type="search">');
    const input = document.querySelector('#q') as unknown as HTMLInputElement;
    input.value = 'SetTrans';
    expect(listUnsavedWork(document, input as unknown as Element).map((i) => i.kind)).toEqual(['field']);
  });
});

describe('unsaved work: a saved composer draft is not lost', () => {
  const PANELS = `
    <div class="session-panel" data-session-id="s-1"><span class="session-panel-title">Fix the login</span>
      <textarea id="saved">a draft already in storage</textarea></div>
    <div class="session-panel" data-session-id="s-2"><span class="session-panel-title">Board notes</span>
      <textarea id="unsaved">typed into a box with no storage</textarea></div>`;

  it('a composer that confirms its save does not hold the restart, the other one does and says where', () => {
    const { window, document, store } = page(PANELS);
    composer(window, store, document.querySelector('#saved')!, 'draft:session:s-1')
    const items = listUnsavedWork(document, null);
    expect(store.get('draft:session:s-1')).toBe('a draft already in storage');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', sessionId: 's-2', where: 'session “Board notes”' });
    expect(items[0].element).toBe(document.querySelector('#unsaved'));
  });

  it('with no composer answering (an old bundle in the page, or storage refused), every draft counts', () => {
    expect(list(PANELS).map((i) => i.sessionId)).toEqual(['s-1', 's-2']);
  });

  it('two boxes on one key: only the one whose text is in storage at the end is saved', () => {
    const { window, document, store } = page(PANELS);
    composer(window, store, document.querySelector('#saved')!, 'draft:session:shared');
    composer(window, store, document.querySelector('#unsaved')!, 'draft:session:shared');
    expect(listUnsavedWork(document, null).map((i) => i.sessionId)).toEqual(['s-1']);
  });

  it('a popout composer is saved for a reload in place but not for a restart, which does not reopen it', () => {
    const { window, document, store } = page(PANELS);
    composer(window, store, document.querySelector('#saved')!, 'draft:session:s-1:popout', { popout: true });
    composer(window, store, document.querySelector('#unsaved')!, 'draft:session:s-2');
    expect(listUnsavedWork(document, null, 'reload')).toEqual([]);
    expect(listUnsavedWork(document, null, 'leave').map((i) => i.sessionId)).toEqual(['s-1']);
  });

  it('a pasted image still counts in a composer whose text was saved', () => {
    const { window, document, store } = page(`${PANELS}<div class="session-panel" data-session-id="s-3"><textarea id="t3">x</textarea><div class="chat-image-previews"><div class="chat-image-preview"></div></div></div>`);
    for (const [id, key] of [['#saved', 'a'], ['#unsaved', 'b'], ['#t3', 'c']]) composer(window, store, document.querySelector(id)!, key);
    expect(listUnsavedWork(document, null)).toMatchObject([{ kind: 'attachment', sessionId: 's-3', where: 'a session' }]);
  });
});
