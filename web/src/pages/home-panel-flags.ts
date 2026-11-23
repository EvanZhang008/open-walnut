/**
 * First-screen rules for the home page that more than one component reads.
 *
 * THE CHAT SPOT STARTS OPEN, on the main agent. On a browser that never chose, the
 * Ask Walnut slot is open and shows Main, the one conversation that sees all the
 * user's work (user, 2026-10-21: new users had no way to find it; it was hidden
 * from 2026-09-30, together with its toggle). A stored 'true' (the user opened it)
 * or 'false' (the user closed it) is honoured as chosen. MainPage, the Sidebar
 * toggle and the Focus Dock all read through `readHomeChatVisible`, so the three
 * can never start out of step on the default.
 */

/** localStorage key (mirrored by ui-prefs-sync like the other layout flags). */
export const LS_HOME_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';

/** What a browser with no stored choice shows. */
export const HOME_CHAT_VISIBLE_DEFAULT = true;

/** The chat spot's starting visibility. Storage that throws counts as "no choice". */
export function readHomeChatVisible(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    const stored = storage?.getItem(LS_HOME_CHAT_VISIBLE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch { /* storage disabled */ }
  return HOME_CHAT_VISIBLE_DEFAULT;
}

/** Did the user open the chat spot themselves (as opposed to its default)? */
export function homeChatChosenOpen(storage: Pick<Storage, 'getItem'> | null | undefined, chatVisible: boolean): boolean {
  try {
    return chatVisible && storage?.getItem(LS_HOME_CHAT_VISIBLE_KEY) === 'true';
  } catch {
    return false;
  }
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
 * Whether the Quick question slot had anything to read when this browser last drew Home. The slot
 * says nothing while it loads, and the session area's share depends on the answer (columnSizing.ts
 * sessionAreaShownPct: an empty slot leaves the columns 65%, one with content 50%), so a reload that
 * started from a fixed guess redrew every open column 15% of the row to the side once the task list
 * and the slot's history arrived (2026-11-23: 138 px at 1280, under a click aimed at Files). Starting
 * from the last answer draws the split the page had before the reload. Per device: the 'walnut.'
 * prefix keeps it out of the ui-prefs mirror (it changes with every conversation picked).
 */
export const LS_ASK_SLOT_HAS_CONTENT_KEY = 'walnut.home.askSlotHasContent';

/** The slot's last answer, or `true` (the smaller share for the columns) when none is stored. */
export function readAskSlotHasContent(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(LS_ASK_SLOT_HAS_CONTENT_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Keep the slot's answer for the next page load. Storage that throws keeps nothing. */
export function writeAskSlotHasContent(storage: Pick<Storage, 'setItem'> | null | undefined, has: boolean): void {
  try { storage?.setItem(LS_ASK_SLOT_HAS_CONTENT_KEY, has ? 'true' : 'false'); } catch { /* storage disabled */ }
}

/**
 * THE ASK WALNUT TOGGLE IS ALWAYS THERE. The sidebar's "Ask Walnut" button and the
 * Focus Dock's chat cell are how a closed chat comes back. From 2026-10-01 they
 * showed only after the spot had been opened once, which left a new user with no
 * way to the main agent at all.
 */
export function showHomeChatToggle(_storage: Pick<Storage, 'getItem'> | null | undefined, _chatVisible: boolean): boolean {
  return true;
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
  /** The user's own tasks: Main and the VPs (org nodes) are Walnut's, not work on the board. */
  taskCount: number;
  /** Completed tasks older than the loaded window: a board with history, not a new one. */
  completedHidden: number;
  /** Session columns in the strip, drafts included. */
  columnCount: number;
  draftCount: number;
  /**
   * The user opened the chat spot themselves (a stored 'true'). The spot's default
   * open state is not a choice: a new browser starts with it open, and counting
   * that kept every new user on the CEO's chat instead of the New task draft
   * (2026-11-12, the user: "it should show the new task!!! not CEO"). The draft
   * borrows the open spot and gives it back when it closes or starts.
   */
  chatChosen: boolean;
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
 * column, a chat the user opened, or a phone-width screen keeps the page as it is.
 */
export function shouldAutoOpenFirstDraft(input: FirstDraftInput): boolean {
  return firstDraftDecisionReady(input)
    && input.taskCount === 0
    && input.completedHidden === 0
    && input.columnCount === 0
    && input.draftCount === 0
    && !input.chatChosen
    && !input.narrowLayout;
}

/** What holds the keyboard at the moment the first draft opens. */
export interface FocusHolder {
  /** 'none': focus is on the page itself; 'field': a box the person types in; 'other': any other control. */
  active: 'none' | 'field' | 'other';
  /** A menu, list popup or modal dialog is open (the first-run dialog, a row's context menu). */
  overlayOpen: boolean;
}

/**
 * May the auto-opened first draft take the caret? It was opened FOR the person, not by them, so it
 * takes focus only when nothing else holds it. A field they type in, a control they focused, or an
 * open menu or modal dialog keeps the keyboard where it is: the draft's caret closed a Sidebar context
 * menu the person had just opened (a menu closes when focus leaves it), and took Escape away from the
 * first-run dialog (2026-11-13).
 */
export function autoDraftMayTakeFocus(holder: FocusHolder): boolean {
  return holder.active === 'none' && !holder.overlayOpen;
}

/**
 * Elements that are an open overlay holding the person's attention: one role per kind of popup
 * the app opens (`aria-haspopup`'s menu, listbox and dialog; `true` means menu), plus a modal.
 * tests/web/home-panel-flags.test.ts fails when the app opens a popup kind this does not name.
 */
export const OVERLAY_ROLES = ['menu', 'listbox', 'dialog', 'alertdialog'] as const;
export const OPEN_OVERLAY_SELECTOR = [...OVERLAY_ROLES.map((r) => `[role="${r}"]`), '[aria-modal="true"]', 'dialog[open]'].join(', ');

/** Read the FocusHolder from a document (a minimal shape, so it is graded without a DOM). */
export function focusHolderOf(doc: {
  activeElement: Element | null;
  body: Element | null;
  documentElement: Element | null;
  querySelector(selector: string): Element | null;
}): FocusHolder {
  const a = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
  const active = !a || a === doc.body || a === doc.documentElement
    ? 'none'
    : a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable
      ? 'field'
      : 'other';
  return { active, overlayOpen: !!doc.querySelector(OPEN_OVERLAY_SELECTOR) };
}

/** What Home holds besides the task panel, as MainPage renders it. */
export interface HomeBesideTasks {
  /** The Ask Walnut slot. */
  chat: boolean;
  /** Session, draft and placeholder columns. */
  columns: number;
  triage: boolean;
  calendar: boolean;
  scratchpad: boolean;
  routines: boolean;
}

/**
 * HOME NEVER DRAWS NOTHING. The task panel shows while its flag says so, on a phone
 * (where it is the home screen), and whenever nothing else is open beside it
 * (2026-10-31: a synced "task panel hidden" with the chat and every column closed
 * left a fresh browser, and any window that adopted the prefs, an empty page).
 */
export function homeTaskPanelShown(todoVisible: boolean, phone: boolean, beside: HomeBesideTasks): boolean {
  if (todoVisible || phone) return true;
  return !(beside.chat || beside.columns > 0 || beside.triage || beside.calendar || beside.scratchpad || beside.routines);
}
