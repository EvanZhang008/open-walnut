/**
 * The LEFT pane's three right-click menus, as data (C36 wording, C37, C38, C41, C71, C80).
 *
 * What each group defends:
 *
 * - NO DEAD CONTROLS. `Fetch this folder now` is omitted for every reserved id: the virtual Drafts
 *   row, the three smart ids, and the reserved smart account. The route takes a real pair and would
 *   answer any of them with `unknown-mailbox`, so a drawn item would fail every single time (C37).
 * - The unread switch reads THAT PAIR'S own preference (C80). A folder you are not in is the normal
 *   right-click here, so a label built from the selection describes the wrong folder, and a fixed
 *   word ("Only unread") never says which way it will go.
 * - The tail switch appears only when the account really has folders behind its collapse row (C41),
 *   and the divider above it goes with it: the primitive drops a trailing rule, which is what keeps
 *   the short menu from ending in a hairline.
 * - The five fetch ANSWERS each get their own sentence (C71), and the three that are answers rather
 *   than failures must never read as "Walnut could not fetch": that sentence sends somebody to
 *   restart the app when the thing to look at is their mail provider or this install.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeContextMenuItems, type ContextMenuItem } from '../../web/src/utils/context-menu';
import {
  DRAFTS_MAILBOX,
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  SMART_SENT,
} from '../../web/src/apps/mail/mail-store';

const actions = {
  fetchMailboxNow: vi.fn(() => Promise.resolve()),
  requestMailRefresh: vi.fn(() => Promise.resolve()),
  selectMailbox: vi.fn(),
  selectSmartMailbox: vi.fn(),
  setMailUnreadOnly: vi.fn(() => Promise.resolve()),
};
const compose = { openMailComposer: vi.fn(() => Promise.resolve()) };

vi.mock('../../web/src/apps/mail/mail-actions', () => actions);
vi.mock('../../web/src/apps/mail/compose/compose-actions', () => compose);

const {
  draftsMenuItems,
  fetchableFolder,
  folderFetchAnswerOf,
  folderFetchSentence,
  folderMenuItems,
  smartMenuItems,
} = await import('../../web/src/apps/mail/mail-folder-context-items');

const ACCOUNT = 'fixture:reader@example.invalid';
const OTHER = 'fixture:second@example.invalid';

/** The unread-only preference lives in one key per account, holding the filtered mailbox ids. */
let kept: Map<string, string>;

function install(): void {
  kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); },
      removeItem: (key: string) => { kept.delete(key); },
    },
  });
}

function filterOn(accountId: string, mailboxIds: string[]): void {
  kept.set(`walnut.mail.unreadOnly.${accountId}`, JSON.stringify(mailboxIds));
}

/** The labels a person would read, in order, dividers marked. Normalized like the primitive does. */
function labels(items: ContextMenuItem[]): string[] {
  return normalizeContextMenuItems(items).map((one) => (one.divider ? '--' : String(one.label)));
}

function itemFor(items: ContextMenuItem[], key: string): ContextMenuItem | undefined {
  return normalizeContextMenuItems(items).find((one) => one.key === key);
}

function folderTarget(overrides: Partial<Parameters<typeof folderMenuItems>[0]> = {}) {
  return {
    accountId: ACCOUNT,
    mailboxId: 'Archive',
    label: 'Archive',
    accountName: 'Harbour Mail',
    manyAccounts: false,
    hasTail: false,
    tailExpanded: false,
    ...overrides,
  };
}

beforeEach(() => {
  install();
  for (const spy of [...Object.values(actions), compose.openMailComposer]) spy.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a folder row', () => {
  it('offers the four actions in the documented order, tail last behind a divider', () => {
    expect(labels(folderMenuItems(folderTarget({ hasTail: true, onToggleTail: vi.fn() })))).toEqual([
      'Archive',
      'Open this folder',
      'Fetch this folder now',
      'Show only unread in this folder',
      '--',
      'Show all folders in this account',
    ]);
  });

  it('names the folder alone with one account and adds the account when there are more', () => {
    const one = normalizeContextMenuItems(folderMenuItems(folderTarget()))[0];
    expect(one?.info).toBe(true);
    expect(one?.label).toBe('Archive');
    expect(one?.title).toBe('Archive');
    const two = normalizeContextMenuItems(folderMenuItems(folderTarget({ manyAccounts: true })))[0];
    expect(two?.label).toBe('Archive · Harbour Mail');
    // The full string is the hover text too: the line itself is clipped at the menu's width.
    expect(two?.title).toBe('Archive · Harbour Mail');
  });

  it('opens and fetches THIS row, not the selection (C35 is the same rule on screen)', () => {
    const onFetchAsked = vi.fn();
    const items = folderMenuItems(folderTarget({ mailboxId: 'Aged/2021', onFetchAsked }));
    itemFor(items, 'open')?.onSelect?.();
    expect(actions.selectMailbox).toHaveBeenCalledWith(ACCOUNT, 'Aged/2021');
    itemFor(items, 'fetch')?.onSelect?.();
    expect(actions.fetchMailboxNow).toHaveBeenCalledWith(ACCOUNT, 'Aged/2021');
    // The pane's watcher is handed the SAME promise, which is how "it worked" can be told from
    // "it is still running": the store keeps no record of a fetch that finished.
    expect(onFetchAsked).toHaveBeenCalledTimes(1);
    expect(onFetchAsked.mock.calls[0]?.[0]).toBe(ACCOUNT);
    expect(onFetchAsked.mock.calls[0]?.[1]).toBe('Aged/2021');
    expect(onFetchAsked.mock.calls[0]?.[2]).toBeInstanceOf(Promise);
  });

  it('draws no fetch item for a reserved id (C37, G4)', () => {
    for (const mailboxId of [DRAFTS_MAILBOX, SMART_INBOX, SMART_SENT, SMART_DRAFTS]) {
      expect(fetchableFolder(ACCOUNT, mailboxId)).toBe(false);
      expect(labels(folderMenuItems(folderTarget({ mailboxId })))).not.toContain('Fetch this folder now');
    }
    // The reserved ACCOUNT too, which is what a smart row's own pair looks like.
    expect(fetchableFolder(SMART_ACCOUNT, SMART_INBOX)).toBe(false);
    expect(fetchableFolder(ACCOUNT, '')).toBe(false);
    expect(fetchableFolder(ACCOUNT, 'Archive')).toBe(true);
  });
});

describe('C80 the unread switch is about THIS pair', () => {
  it('says what it will do to the folder that was right-clicked', () => {
    filterOn(ACCOUNT, ['Archive']);
    expect(labels(folderMenuItems(folderTarget({ mailboxId: 'Archive' }))))
      .toContain('Show everything in this folder');
    // Same account, a folder with no preference of its own: the other label, in the same window.
    expect(labels(folderMenuItems(folderTarget({ mailboxId: 'Sent' }))))
      .toContain('Show only unread in this folder');
    // Same mailbox id under a DIFFERENT account is a different pair.
    expect(labels(folderMenuItems(folderTarget({ accountId: OTHER, mailboxId: 'Archive' }))))
      .toContain('Show only unread in this folder');
  });

  it('writes the flipped value for that pair', () => {
    filterOn(ACCOUNT, ['Archive']);
    itemFor(folderMenuItems(folderTarget({ mailboxId: 'Archive' })), 'unread')?.onSelect?.();
    expect(actions.setMailUnreadOnly).toHaveBeenCalledWith(ACCOUNT, 'Archive', false);
    actions.setMailUnreadOnly.mockClear();
    itemFor(folderMenuItems(folderTarget({ mailboxId: 'Sent' })), 'unread')?.onSelect?.();
    expect(actions.setMailUnreadOnly).toHaveBeenCalledWith(ACCOUNT, 'Sent', true);
  });
});

describe('C41 the tail switch', () => {
  it('is absent for an account with nothing behind its collapse row', () => {
    expect(labels(folderMenuItems(folderTarget({ hasTail: false, onToggleTail: vi.fn() }))))
      .toEqual(['Archive', 'Open this folder', 'Fetch this folder now', 'Show only unread in this folder']);
  });

  it('leaves no hairline at the end when it drops out', () => {
    // The primitive drops a trailing divider, which is the only reason the item above can be the
    // last row: a menu ending in a rule reads as a list that failed to render.
    const shown = normalizeContextMenuItems(folderMenuItems(folderTarget()));
    expect(shown[shown.length - 1]?.divider).toBeUndefined();
  });

  it('states which way it will go and toggles the account it names', () => {
    const onToggleTail = vi.fn();
    const closed = folderMenuItems(folderTarget({ hasTail: true, tailExpanded: false, onToggleTail }));
    expect(labels(closed)).toContain('Show all folders in this account');
    itemFor(closed, 'tail')?.onSelect?.();
    expect(onToggleTail).toHaveBeenCalledWith(ACCOUNT, true);
    const open = folderMenuItems(folderTarget({ hasTail: true, tailExpanded: true, onToggleTail }));
    expect(labels(open)).toContain('Show fewer folders in this account');
    itemFor(open, 'tail')?.onSelect?.();
    expect(onToggleTail).toHaveBeenLastCalledWith(ACCOUNT, false);
  });
});

describe('C37 the Drafts row', () => {
  it('names the row it is about, then offers exactly two items and never a fetch', () => {
    // The heading is not decoration: the menu lands over the rows below the cursor and the backdrop
    // freezes hover, and EVERY account has a Drafts row, so without it nothing on screen said which.
    expect(labels(draftsMenuItems({ accountId: ACCOUNT }))).toEqual([
      'Drafts', 'Open Drafts', 'New message',
    ]);
    expect(draftsMenuItems({ accountId: ACCOUNT })[0]!.info).toBe(true);
    expect(labels(draftsMenuItems({
      accountId: ACCOUNT, accountName: 'Marina mail', manyAccounts: true,
    }))[0]).toBe('Drafts · Marina mail');
    // One account listed: there is no second Drafts row to tell it apart from.
    expect(labels(draftsMenuItems({
      accountId: ACCOUNT, accountName: 'Marina mail', manyAccounts: false,
    }))[0]).toBe('Drafts');
  });

  it('opens the reserved row and composes as that account', () => {
    const items = draftsMenuItems({ accountId: ACCOUNT });
    itemFor(items, 'open')?.onSelect?.();
    expect(actions.selectMailbox).toHaveBeenCalledWith(ACCOUNT, DRAFTS_MAILBOX);
    itemFor(items, 'new')?.onSelect?.();
    // The account the ROW belongs to, which under All Drafts is not the first account listed.
    expect(compose.openMailComposer).toHaveBeenCalledWith(ACCOUNT);
  });
});

describe('C38 a smart row', () => {
  it('names the list, then offers three items, none of them a fetch', () => {
    const onToggle = vi.fn();
    expect(labels(smartMenuItems({
      id: SMART_INBOX, pref: 'inbox', label: 'All Inboxes', open: false, onToggle,
    }))).toEqual([
      'All Inboxes',
      'Open this list',
      'Check for new mail',
      'Show accounts in this list',
    ]);
    expect(labels(smartMenuItems({
      id: SMART_SENT, pref: 'sent', label: 'All Sent', open: true, onToggle,
    })))
      .toEqual(['All Sent', 'Open this list', 'Check for new mail', 'Hide accounts in this list']);
    // The heading is an `info` row, so the arrow keys still open on `Open this list`.
    const items = smartMenuItems({
      id: SMART_SENT, pref: 'sent', label: 'All Sent', open: true, onToggle,
    });
    expect(items[0]!.info).toBe(true);
    expect(items[0]!.onSelect).toBeUndefined();
  });

  it('selects the merged list, sweeps every account, and toggles its own children', () => {
    const onToggle = vi.fn();
    const items = smartMenuItems({
      id: SMART_DRAFTS, pref: 'drafts', label: 'All Drafts', open: false, onToggle,
    });
    itemFor(items, 'open')?.onSelect?.();
    expect(actions.selectSmartMailbox).toHaveBeenCalledWith(SMART_DRAFTS);
    itemFor(items, 'check')?.onSelect?.();
    // No account argument: a merged list is every account, and `requestMailRefresh` is what owns the
    // note that answer leaves behind.
    expect(actions.requestMailRefresh).toHaveBeenCalledWith();
    itemFor(items, 'accounts')?.onSelect?.();
    expect(onToggle).toHaveBeenCalledWith('drafts', true);
  });
});

describe('C71 the fetch answers each have their own sentence', () => {
  const FOLDER = 'Aged/2021';

  it('says something different for every outcome', () => {
    expect(folderFetchSentence('fetching', FOLDER)).toEqual(['Fetching Aged/2021…']);
    expect(folderFetchSentence('running', FOLDER)).toEqual(['Still fetching Aged/2021.']);
    expect(folderFetchSentence('fetched', FOLDER)).toEqual(['Fetched Aged/2021.']);
    expect(folderFetchSentence('unknown-mailbox', FOLDER)).toEqual(['Aged/2021 is no longer on the server.']);
    expect(folderFetchSentence('stopped', FOLDER)).toEqual(['Aged/2021 is no longer on the server.']);
    expect(folderFetchSentence('replica', FOLDER)).toEqual(['This copy of Walnut only reads mail.']);
    expect(folderFetchSentence('failed', FOLDER)).toEqual(['Walnut could not fetch Aged/2021.']);
    // Six inputs, five distinct answers: `unknown-mailbox` and `stopped` mean the same thing to a
    // person (the server no longer lists it), and nothing else repeats.
    const said = new Set([
      'running', 'fetched', 'unknown-mailbox', 'stopped', 'replica', 'failed',
    ].map((one) => folderFetchSentence(one as 'failed', FOLDER).join(' ')));
    expect(said.size).toBe(5);
  });

  it('only failed may say Walnut could not (G13)', () => {
    for (const answer of ['unknown-mailbox', 'stopped', 'replica', 'fetched', 'running'] as const) {
      expect(folderFetchSentence(answer, FOLDER).join(' ')).not.toContain('Walnut could not');
    }
    expect(folderFetchSentence('failed', FOLDER, 'the folder refused to open').join(' '))
      .toContain('Walnut could not');
  });

  it('keeps the provider text as its own sentence, never run on after the stop', () => {
    const lines = folderFetchSentence('failed', FOLDER, 'the folder refused to open');
    expect(lines).toEqual(['Walnut could not fetch Aged/2021.', 'the folder refused to open']);
    // A plugin writes that string: it may start lower case and may end without a stop, so it is
    // never joined onto Walnut's own sentence.
    expect(lines[0]?.endsWith('.')).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('never says "undefined" when the folder has no name yet', () => {
    expect(folderFetchSentence('fetched', '')).toEqual(['Fetched that folder.']);
  });

  it('reads the map entry as one answer', () => {
    expect(folderFetchAnswerOf('fetching')).toBe('fetching');
    expect(folderFetchAnswerOf('running')).toBe('running');
    expect(folderFetchAnswerOf('failed', 'replica')).toBe('replica');
    expect(folderFetchAnswerOf('failed', 'stopped')).toBe('stopped');
    expect(folderFetchAnswerOf('failed', 'unknown-mailbox')).toBe('unknown-mailbox');
    // A failure with no reason word at all is still the one worth pressing again.
    expect(folderFetchAnswerOf('failed')).toBe('failed');
  });
});
