/**
 * First-screen rules for the home page that more than one component reads.
 *
 * THE CHAT SPOT STARTS HIDDEN. On a browser that never chose, the Ask Walnut slot
 * is closed: a first screen with a chat column next to an empty board read as a
 * generic chatbot, and new users could not tell whether they had to talk to it
 * before doing anything else. A stored 'true' (the user opened it) or 'false'
 * (the user closed it) is honoured as chosen. MainPage, the Sidebar toggle and the
 * Focus Dock all read through `readHomeChatVisible`, so the three can never start
 * out of step on the default.
 */

/** localStorage key (mirrored by ui-prefs-sync like the other layout flags). */
export const LS_HOME_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';

/** What a browser with no stored choice shows. */
export const HOME_CHAT_VISIBLE_DEFAULT = false;

/** The chat spot's starting visibility. Storage that throws counts as "no choice". */
export function readHomeChatVisible(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    const stored = storage?.getItem(LS_HOME_CHAT_VISIBLE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch { /* storage disabled */ }
  return HOME_CHAT_VISIBLE_DEFAULT;
}

/** Has this browser ever opened (or then closed) the chat spot? */
export function hasHomeChatChoice(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    const stored = storage?.getItem(LS_HOME_CHAT_VISIBLE_KEY);
    return stored === 'true' || stored === 'false';
  } catch {
    return false;
  }
}

/**
 * THE ASK WALNUT TOGGLE STARTS HIDDEN TOO. The sidebar's "Ask Walnut" button and
 * the Focus Dock's chat cell show only once the spot is open or was once opened
 * (user, 2026-10-01: a second Ask Walnut entry beside New task made a new user ask
 * which one to use). The spot still opens on its own when an ask is located from
 * the board, and that first open stores the choice, so the toggle appears exactly
 * when there is something to close and stays for good after that.
 */
export function showHomeChatToggle(storage: Pick<Storage, 'getItem'> | null | undefined, chatVisible: boolean): boolean {
  return chatVisible || hasHomeChatChoice(storage);
}

/** Everything the first-open decision looks at, read once per render. */
export interface FirstDraftInput {
  /** MainPage is the route on screen (it stays mounted behind other routes). */
  visible: boolean;
  /** The first task fetch has not landed yet. */
  tasksLoading: boolean;
  /** The task fetch failed: an unknown board, not an empty one. */
  tasksError: boolean;
  /** A deep link (`?task=`, `?session=`) is still being applied. */
  urlPending: boolean;
  taskCount: number;
  /** Completed tasks older than the loaded window: a board with history, not a new one. */
  completedHidden: number;
  /** Session columns in the strip, drafts included. */
  columnCount: number;
  draftCount: number;
  /** The chat spot is open: the user chose it, and a draft would borrow its place. */
  chatVisible: boolean;
  /** Phone-width layout, where any column is a full-screen overlay over the board. */
  narrowLayout: boolean;
}

/**
 * Is the board settled enough to decide? Until it is, the decision waits; once it
 * is, MainPage decides exactly once per page load (whatever the answer), so a
 * board that becomes empty later (the user deleted their last task) never grows
 * a column on its own.
 */
export function firstDraftDecisionReady(input: Pick<FirstDraftInput, 'visible' | 'tasksLoading' | 'tasksError' | 'urlPending'>): boolean {
  return input.visible && !input.tasksLoading && !input.tasksError && !input.urlPending;
}

/**
 * Open ONE "New task" draft column on the first open of an empty board, so a new
 * user lands on the one place a task is made instead of an empty list. Only for a
 * board with nothing on it and nothing open: any task (loaded or archived), any
 * column, an open chat, or a phone-width screen keeps the page as it is.
 */
export function shouldAutoOpenFirstDraft(input: FirstDraftInput): boolean {
  return firstDraftDecisionReady(input)
    && input.taskCount === 0
    && input.completedHidden === 0
    && input.columnCount === 0
    && input.draftCount === 0
    && !input.chatVisible
    && !input.narrowLayout;
}
