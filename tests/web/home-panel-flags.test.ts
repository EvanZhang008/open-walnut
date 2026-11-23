/**
 * Home first-screen rules: the chat spot's default and the first-open draft.
 *
 * Load-bearing because three components (MainPage, the Sidebar toggle, the Focus
 * Dock) read the chat flag at mount, and must agree that a new install opens on
 * the chat spot open, and a first-draft rule that fired on a board with
 * history (or twice) would grow columns the user never asked for.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HOME_CHAT_VISIBLE_DEFAULT,
  LS_HOME_CHAT_VISIBLE_KEY,
  OPEN_OVERLAY_SELECTOR,
  OVERLAY_ROLES,
  autoDraftMayTakeFocus,
  firstDraftDecisionReady,
  focusHolderOf,
  LS_ASK_SLOT_HAS_CONTENT_KEY,
  hasHomeChatChoice,
  readAskSlotHasContent,
  readHomeChatVisible,
  writeAskSlotHasContent,
  shouldAutoOpenFirstDraft,
  homeChatChosenOpen,
  showHomeChatToggle,
  type FirstDraftInput,
} from '../../web/src/pages/home-panel-flags';
import { syncable } from '../../web/src/utils/ui-prefs-sync';

const storageWith = (value: string | null) => ({
  getItem: (key: string) => (key === LS_HOME_CHAT_VISIBLE_KEY ? value : null),
});

describe('readHomeChatVisible', () => {
  it('keeps the key the ui-prefs mirror already carries', () => {
    expect(LS_HOME_CHAT_VISIBLE_KEY).toBe('open-walnut-home-chat-visible');
  });

  it('starts OPEN when the browser never chose: a new user lands on the main agent', () => {
    expect(HOME_CHAT_VISIBLE_DEFAULT).toBe(true);
    expect(readHomeChatVisible(storageWith(null))).toBe(true);
  });

  it("honours an explicit open ('true') and an explicit close ('false')", () => {
    expect(readHomeChatVisible(storageWith('true'))).toBe(true);
    expect(readHomeChatVisible(storageWith('false'))).toBe(false);
  });

  it('reads an unknown value as no choice', () => {
    expect(readHomeChatVisible(storageWith(''))).toBe(true);
    expect(readHomeChatVisible(storageWith('1'))).toBe(true);
  });

  it('falls back to the default when storage is missing or throws', () => {
    expect(readHomeChatVisible(null)).toBe(true);
    expect(readHomeChatVisible(undefined)).toBe(true);
    expect(readHomeChatVisible({ getItem: () => { throw new Error('storage disabled'); } })).toBe(true);
  });
});

const emptyBoard: FirstDraftInput = {
  visible: true,
  tasksLoading: false,
  tasksError: false,
  urlPending: false,
  taskCount: 0,
  completedHidden: 0,
  columnCount: 0,
  draftCount: 0,
  chatChosen: false,
  narrowLayout: false,
};

describe('showHomeChatToggle', () => {
  it('always shows the Ask Walnut toggle: a closed chat must have a way back, a new user included', () => {
    expect(hasHomeChatChoice(storageWith(null))).toBe(false);
    for (const storage of [storageWith(null), storageWith('true'), storageWith('false'), storageWith('maybe'), null]) {
      expect(showHomeChatToggle(storage, false)).toBe(true);
      expect(showHomeChatToggle(storage, true)).toBe(true);
    }
    expect(showHomeChatToggle({ getItem: () => { throw new Error('denied'); } }, false)).toBe(true);
  });

  it('still tells a stored choice from none', () => {
    expect(hasHomeChatChoice(storageWith('true'))).toBe(true);
    expect(hasHomeChatChoice(storageWith('false'))).toBe(true);
    expect(hasHomeChatChoice(storageWith('maybe'))).toBe(false);
  });
});

describe('shouldAutoOpenFirstDraft', () => {
  it('opens on a settled, empty board with nothing open', () => {
    expect(firstDraftDecisionReady(emptyBoard)).toBe(true);
    expect(shouldAutoOpenFirstDraft(emptyBoard)).toBe(true);
  });

  it('waits (not ready) while the list loads, after a failed load, behind another route, or during a deep link', () => {
    for (const patch of [
      { tasksLoading: true },
      { tasksError: true },
      { visible: false },
      { urlPending: true },
    ]) {
      const input = { ...emptyBoard, ...patch };
      expect(firstDraftDecisionReady(input), JSON.stringify(patch)).toBe(false);
      expect(shouldAutoOpenFirstDraft(input), JSON.stringify(patch)).toBe(false);
    }
  });

  it('is ready but declines for a board with anything on it or open', () => {
    for (const patch of [
      { taskCount: 1 },
      { completedHidden: 12 },
      { columnCount: 1 },
      { draftCount: 1 },
      { chatChosen: true },
      { narrowLayout: true },
    ]) {
      const input = { ...emptyBoard, ...patch };
      expect(firstDraftDecisionReady(input), JSON.stringify(patch)).toBe(true);
      expect(shouldAutoOpenFirstDraft(input), JSON.stringify(patch)).toBe(false);
    }
  });
});

describe('a new user lands on New task, not the CEO chat', () => {
  // 2026-11-12, the user: "it keep first show the CEO panel ... it should show the new task!!! not CEO".
  // The chat spot starts open on a new browser; the first-draft rule had read that default as the
  // user's choice, so the draft never opened. The input here is built the way MainPage builds it.
  const inputFor = (stored: string | null) => {
    const storage = storageWith(stored);
    const chatVisible = readHomeChatVisible(storage);
    return { ...emptyBoard, chatChosen: homeChatChosenOpen(storage, chatVisible) };
  };

  it('a browser that never chose: the chat is open by default, and the draft still opens', () => {
    expect(readHomeChatVisible(storageWith(null))).toBe(true);
    expect(shouldAutoOpenFirstDraft(inputFor(null))).toBe(true);
  });

  it('a chat the user opened keeps its place; one they closed opens the draft too', () => {
    expect(shouldAutoOpenFirstDraft(inputFor('true'))).toBe(false);
    expect(shouldAutoOpenFirstDraft(inputFor('false'))).toBe(true);
  });

  it('storage that throws is no choice', () => {
    expect(homeChatChosenOpen({ getItem: () => { throw new Error('denied'); } }, true)).toBe(false);
  });

  it('MainPage counts the user\'s own tasks only: Main and the VPs are no work on the board', () => {
    const src = readFileSync(join(__dirname, '../../web/src/pages/MainPage.tsx'), 'utf8');
    expect(src).toContain('taskCount: tasks.filter(t => !t.org_role).length');
    expect(src).toContain('chatChosen: homeChatChosenOpen(localStorage, chatVisible)');
  });
});

describe('the auto-opened first draft takes the caret only when nothing else holds it', () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
  const body = el('BODY');
  const html = el('HTML');
  const doc = (active: Element | null, overlay = false) => ({
    activeElement: active, body, documentElement: html,
    querySelector: (sel: string) => (overlay && sel === OPEN_OVERLAY_SELECTOR ? el('DIV') : null),
  });

  it('takes it from the page itself', () => {
    for (const active of [null, body, html]) {
      expect(autoDraftMayTakeFocus(focusHolderOf(doc(active)))).toBe(true);
    }
  });

  it('keeps a field, a focused control and an open menu or dialog where they are', () => {
    expect(focusHolderOf(doc(el('INPUT'))).active).toBe('field');
    expect(focusHolderOf(doc(el('TEXTAREA'))).active).toBe('field');
    expect(focusHolderOf(doc(el('DIV', true))).active).toBe('field');
    // A context menu's item, the first-run dialog itself: a focused control that is not a field.
    expect(focusHolderOf(doc(el('BUTTON'))).active).toBe('other');
    expect(focusHolderOf(doc(el('DIV'))).active).toBe('other');
    for (const active of [el('INPUT'), el('BUTTON'), el('DIV')]) {
      expect(autoDraftMayTakeFocus(focusHolderOf(doc(active)))).toBe(false);
    }
    // WebKit does not focus a pressed button, so an open menu can leave focus on the page.
    expect(autoDraftMayTakeFocus(focusHolderOf(doc(body, true)))).toBe(false);
  });

  it('counts every kind of popup the app opens as an overlay', () => {
    // A new popup kind (aria-haspopup="tree", say) must join OVERLAY_ROLES, or the draft's caret
    // closes it the way it closed the Sidebar's context menu.
    const root = join(__dirname, '../../web/src');
    const kinds = new Set<string>();
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(ent.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/aria-haspopup[=:]\s*["'{]+([a-z]+)["'}]/g)) kinds.add(m[1]);
        }
      }
    };
    walk(root);
    kinds.delete('true'); // ARIA: true is menu
    expect(kinds.size).toBeGreaterThan(0);
    const missing = [...kinds].filter((k) => !(OVERLAY_ROLES as readonly string[]).includes(k));
    expect(missing).toEqual([]);
    expect(OPEN_OVERLAY_SELECTOR).toContain('[aria-modal="true"]');
  });

  it('MainPage asks before the first draft takes focus', () => {
    const src = readFileSync(join(__dirname, '../../web/src/pages/MainPage.tsx'), 'utf8');
    expect(src).toContain('const holder = focusHolderOf(document);');
    expect(src).toContain('if (!takeFocus) setFocusDraftId(');
  });
});

describe('the Quick question slot answer a page load starts from', () => {
  // The session area's share depends on it, so a reload that guessed wrong moved every open column.
  it('reads the last answer kept, and the smaller share for the columns when none is', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(readAskSlotHasContent(storage)).toBe(true);
    writeAskSlotHasContent(storage, false);
    expect(store.get(LS_ASK_SLOT_HAS_CONTENT_KEY)).toBe('false');
    expect(readAskSlotHasContent(storage)).toBe(false);
    writeAskSlotHasContent(storage, true);
    expect(readAskSlotHasContent(storage)).toBe(true);
  });

  it('treats storage that throws as nothing kept', () => {
    const broken = { getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); } };
    expect(readAskSlotHasContent(broken)).toBe(true);
    expect(() => writeAskSlotHasContent(broken, false)).not.toThrow();
    expect(readAskSlotHasContent(null)).toBe(true);
  });

  it('stays on this device: it changes with every conversation picked, so the ui-prefs mirror never sends it', () => {
    expect(syncable(LS_ASK_SLOT_HAS_CONTENT_KEY)).toBe(false);
  });
});
