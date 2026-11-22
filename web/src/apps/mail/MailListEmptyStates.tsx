/**
 * What the middle pane says when it has no rows to draw, which is three different statements: the
 * folder was never fetched, it was fetched and the cache kept none of it, or it is genuinely empty.
 *
 * Split out of `MailMessageList` with the row: these are the sentences a folder-fetch answer lands
 * in, and they are read alongside `mail-folder-context-items.ts`, not alongside the paging code.
 */
import type { MailAccountDto } from '@/api/mail';
import { formatCount } from './mail-format';
import { fetchSelectedFolder, requestMailRefresh } from './mail-actions';
import { folderFetchFor, selectionKey, type MailSnapshot } from './mail-store';
import { smartPairs, type SmartRole } from './mail-smart';
import type { Section } from './mail-list-section';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';

/**
 * The accounts one merged list actually covers.
 *
 * Drafts is answered by the account list, not by folders: the Drafts row is Walnut's own and every
 * account has one whether or not its provider keeps such a folder.
 */
export function coveredBy(snapshot: MailSnapshot, role: SmartRole): MailAccountDto[] {
  if (role === 'drafts') return snapshot.accounts;
  const pairs = smartPairs(snapshot.mailboxes, snapshot.accounts, role);
  return snapshot.accounts.filter((one) => pairs.some((pair) => pair.accountId === one.accountId));
}

/**
 * A folder with nothing on screen, told apart from the other two things that look exactly like it.
 *
 * "No mail in this folder yet" used to be the answer to all three, and for a real Gmail account it
 * was the wrong one twice: the header said `SENT MAIL · 1,962 · 2 unread` (the mailbox list knows the
 * folder's true size) directly above a message list claiming the folder was empty. Nothing on screen
 * hinted that Walnut simply had not fetched it yet, so the only reading available was "Walnut lost my
 * sent mail".
 *
 * The three cases, and what makes them different:
 *
 * - NEVER FETCHED. `lastSyncAt` is absent, so no poll of this container has ever completed. It is
 *   fetched on the spot (see `fetchSelectedFolder`), and while that runs this says so.
 * - FETCHED AND KEPT NOTHING. The folder has messages on the server and none of them are inside the
 *   cache's window. The number is on screen, so the sentence has to account for it or it reads as a
 *   contradiction.
 * - ACTUALLY EMPTY. The only case the old sentence was right about.
 */
export function EmptyFolder({ snapshot, section, smart }: {
  snapshot: MailSnapshot;
  section: Section | null;
  smart: SmartRole | null;
}) {
  const selection = snapshot.selected;
  if (smart) return <SmartEmpty snapshot={snapshot} role={smart} />;
  const mailbox = selection
    ? (snapshot.mailboxes[selection.accountId] ?? []).find((one) => one.mailboxId === selection.mailboxId)
    : undefined;
  // One entry per folder now (a sidebar row can fetch a folder nobody selected), so this asks for
  // the folder ON SCREEN by its own key rather than reading a single shared slot.
  const fetch = selection ? folderFetchFor(snapshot, selectionKey(selection)) : null;
  const total = section?.count ?? mailbox?.total ?? 0;

  if (fetch?.state === 'fetching' || fetch?.state === 'running') {
    return <LoadingState title="Fetching this folder…" testId="mail-folder-fetching" />;
  }
  if (fetch?.state === 'failed') {
    // The provider's own sentence is the hint, on its OWN line rather than run on after Walnut's: a
    // plugin writes this text and nothing here can promise it starts with a capital. Joined inline it
    // read as "could not fetch this folder. this server will not open Aged", which looks like the
    // console broke its own sentence in half.
    return (
      <UnavailableState
        title="Walnut could not fetch this folder"
        hint={fetch.detail || undefined}
        action={{ label: 'Try again', onClick: () => { void fetchSelectedFolder(); }, testId: 'mail-folder-fetch' }}
        testId="mail-folder-fetch-failed"
      />
    );
  }
  // The button is here for the second visit: the automatic fetch runs once per folder per tab, so a
  // page reloaded after that would otherwise be a dead end with no way to ask.
  if (mailbox && mailbox.lastSyncAt === undefined) {
    return (
      <EmptyState
        title="Walnut has not fetched this folder yet"
        action={{ label: 'Fetch it now', onClick: () => { void fetchSelectedFolder(); }, testId: 'mail-folder-fetch' }}
        testId="mail-folder-unfetched"
      />
    );
  }
  if (total > 0) {
    // States what is OBSERVED (fetched, holding none of them) and then the rule that explains it,
    // rather than asserting that every one of those messages is old. Walnut can see the first two
    // things; the third is an inference, and it is the cache's rule that is worth telling anyway.
    return (
      <EmptyState
        title={`Walnut fetched this folder and kept none of its ${formatCount(total)} messages`}
        hint="The mail cache only keeps recent mail."
        testId="mail-folder-outside-window"
      />
    );
  }
  return <EmptyState title="No mail in this folder yet" testId="mail-list-empty" />;
}

/** What a merged list calls the folders it stands for. Drafts never reaches here (see draftsView). */
const SMART_NOUN: Record<SmartRole, { many: string; each: string }> = {
  inbox: { many: 'these inboxes', each: 'every inbox' },
  sent: { many: 'these folders', each: 'every folder' },
  drafts: { many: 'these folders', each: 'every folder' },
};

/**
 * The merged list with nothing on screen: an empty set of folders, or a set Walnut has not finished
 * fetching, which on a fresh install is most of them.
 *
 * A smart selection is NOT a folder, so there is nothing for `/mailboxes/fetch` to name here: one of
 * its mailboxes missing `lastSyncAt` is a statement about the sweep, and the sweep is what the button
 * asks for. Fetching one folder of the set would also leave the sentence true, which is the kind of
 * button that looks broken.
 */
function SmartEmpty({ snapshot, role }: { snapshot: MailSnapshot; role: SmartRole }) {
  const noun = SMART_NOUN[role];
  const pairs = smartPairs(snapshot.mailboxes, snapshot.accounts, role);
  const unfetched = pairs.some((pair) => {
    const row = (snapshot.mailboxes[pair.accountId] ?? []).find((one) => one.mailboxId === pair.mailboxId);
    return !row || row.lastSyncAt === undefined;
  });
  if (!unfetched) return <EmptyState title={`No mail in ${noun.many} yet`} testId="mail-smart-empty" />;
  return (
    <EmptyState
      title={`Walnut has not fetched ${noun.each} yet`}
      action={{ label: 'Check for new mail', onClick: () => { void requestMailRefresh(); }, testId: 'mail-smart-refresh' }}
      testId="mail-smart-unfetched"
    />
  );
}
