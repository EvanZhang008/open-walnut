/**
 * Home first-screen rules: the chat spot's default and the first-open draft.
 *
 * Load-bearing because three components (MainPage, the Sidebar toggle, the Focus
 * Dock) read the chat flag at mount. A reader that drifted back to "open unless
 * 'false'" would bring the generic-looking chat back on every new install while
 * the other two said hidden, and a first-draft rule that fired on a board with
 * history (or twice) would grow columns the user never asked for.
 */
import { describe, it, expect } from 'vitest';
import {
  HOME_CHAT_VISIBLE_DEFAULT,
  LS_HOME_CHAT_VISIBLE_KEY,
  firstDraftDecisionReady,
  hasHomeChatChoice,
  readHomeChatVisible,
  shouldAutoOpenFirstDraft,
  showHomeChatToggle,
  type FirstDraftInput,
} from '../../web/src/pages/home-panel-flags';

const storageWith = (value: string | null) => ({
  getItem: (key: string) => (key === LS_HOME_CHAT_VISIBLE_KEY ? value : null),
});

describe('readHomeChatVisible', () => {
  it('keeps the key the ui-prefs mirror already carries', () => {
    expect(LS_HOME_CHAT_VISIBLE_KEY).toBe('open-walnut-home-chat-visible');
  });

  it('starts hidden when the browser never chose', () => {
    expect(HOME_CHAT_VISIBLE_DEFAULT).toBe(false);
    expect(readHomeChatVisible(storageWith(null))).toBe(false);
  });

  it("honours an explicit open ('true') and an explicit close ('false')", () => {
    expect(readHomeChatVisible(storageWith('true'))).toBe(true);
    expect(readHomeChatVisible(storageWith('false'))).toBe(false);
  });

  it('reads an unknown value as no choice', () => {
    expect(readHomeChatVisible(storageWith(''))).toBe(false);
    expect(readHomeChatVisible(storageWith('1'))).toBe(false);
  });

  it('falls back to the default when storage is missing or throws', () => {
    expect(readHomeChatVisible(null)).toBe(false);
    expect(readHomeChatVisible(undefined)).toBe(false);
    expect(readHomeChatVisible({ getItem: () => { throw new Error('storage disabled'); } })).toBe(false);
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
  chatVisible: false,
  narrowLayout: false,
};

describe('showHomeChatToggle', () => {
  it('hides the Ask Walnut toggle on a browser that never opened the chat spot', () => {
    expect(hasHomeChatChoice(storageWith(null))).toBe(false);
    expect(showHomeChatToggle(storageWith(null), false)).toBe(false);
  });

  it('shows it while the spot is open, before anything is stored', () => {
    expect(showHomeChatToggle(storageWith(null), true)).toBe(true);
  });

  it('keeps it once the spot was opened or closed on purpose', () => {
    expect(hasHomeChatChoice(storageWith('true'))).toBe(true);
    expect(hasHomeChatChoice(storageWith('false'))).toBe(true);
    expect(showHomeChatToggle(storageWith('false'), false)).toBe(true);
  });

  it('treats an unknown value, missing storage or a throwing storage as no choice', () => {
    expect(showHomeChatToggle(storageWith('maybe'), false)).toBe(false);
    expect(showHomeChatToggle(null, false)).toBe(false);
    expect(showHomeChatToggle({ getItem: () => { throw new Error('denied'); } }, false)).toBe(false);
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
      { chatVisible: true },
      { narrowLayout: true },
    ]) {
      const input = { ...emptyBoard, ...patch };
      expect(firstDraftDecisionReady(input), JSON.stringify(patch)).toBe(true);
      expect(shouldAutoOpenFirstDraft(input), JSON.stringify(patch)).toBe(false);
    }
  });
});
