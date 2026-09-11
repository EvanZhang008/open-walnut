/**
 * The right pane: one message, on a reading column.
 *
 * The body is the whole risk surface of this console, so the rules are strict and visible:
 *
 * - HTML renders inside a sandboxed iframe (no scripts, no same-origin) built by
 *   `buildMailBodyFrame`: hardened as a string, then DOMPurify, then wrapped in a document whose
 *   CSP allows no network subresource. Nothing in a body reaches this origin's storage or the
 *   rest of the page.
 * - REMOTE IMAGES ARE BLOCKED until the human asks, per message, and the ask is not remembered.
 *   A tracking pixel reports the moment and the IP of the read as soon as it renders, so the
 *   count is shown and the opt-in is one click for this one body.
 * - Plain text is never handed to a markdown renderer. A message that contains `# 1` or `*sale*`
 *   means those characters; only its URLs become links, and they carry `rel="noopener"`.
 *
 * Attachments are metadata in v1: names, kinds and sizes, no download.
 *
 * The LAYOUT is a reading column (760px, centred) with a fixed header and the body on a white
 * paper card. The header does not scroll: an html body can only ever scroll INSIDE its frame,
 * because a sandbox with no same-origin cannot be measured from here, so a header that scrolled
 * with it would need a height this page is not allowed to know.
 */
import type { MailAccountDto, MailProviderSummary } from '@/api/mail';
import { MailReaderHead } from './MailReaderHead';
import { MailReaderBody } from './MailReaderBody';
import { closeMailMessage } from './mail-actions';
import type { MailOpenMessage } from './mail-store';
import { BackIcon, ReaderEmptyIcon } from './mail-icons';
import './mail-reader.css';

interface ReaderProps {
  open: MailOpenMessage | null;
  narrow: boolean;
  accounts: MailAccountDto[];
  providers: MailProviderSummary[];
}

export function MailReader({ open, narrow, accounts, providers }: ReaderProps) {
  if (!open) {
    return (
      <section className="mail-reader-pane mail-reader-blank" data-testid="mail-reader">
        <div className="mail-reader-nothing">
          <span className="mail-reader-nothing-glyph" aria-hidden="true"><ReaderEmptyIcon /></span>
          <p className="mail-reader-nothing-text" data-testid="mail-no-message">Pick a message</p>
        </div>
      </section>
    );
  }

  const message = open.message;
  return (
    <section className="mail-reader-pane" data-testid="mail-reader" data-message-id={open.messageId}>
      {narrow && (
        <div className="mail-pane-head mail-reader-back-bar">
          <button type="button" className="mail-icon-btn" data-testid="mail-reader-back" onClick={closeMailMessage} aria-label="Back to the list">
            <BackIcon />
          </button>
        </div>
      )}

      {/* Keyed on the message: the Details disclosure is per message, and carrying it open into
          the next one would show somebody else's recipients under a subject that changed. */}
      {message ? (
        <MailReaderHead
          key={open.messageId}
          open={open}
          message={message}
          accounts={accounts}
          providers={providers}
        />
      ) : open.loading ? (
        <HeadSkeleton />
      ) : null}

      <MailReaderBody open={open} />
    </section>
  );
}

/**
 * What the header looks like while the envelope is still on its way.
 *
 * A spinner in a three-pane console says "something is happening somewhere"; these bars say what
 * is coming and where it will be, so the pane does not jump when it lands. It is shaped like the
 * real header: subject bar, sender row, three body lines.
 */
function HeadSkeleton() {
  return (
    <div className="mail-reader-head mail-reader-column mail-skeleton" data-testid="mail-reader-skeleton" aria-hidden="true">
      <div className="mail-skeleton-bar w-subject" />
      <div className="mail-skeleton-sender">
        <div className="mail-skeleton-circle" />
        <div className="mail-skeleton-lines">
          <div className="mail-skeleton-bar w-name" />
          <div className="mail-skeleton-bar w-address" />
        </div>
      </div>
      <div className="mail-skeleton-bar w-body" />
      <div className="mail-skeleton-bar w-body" />
      <div className="mail-skeleton-bar w-body-short" />
    </div>
  );
}
