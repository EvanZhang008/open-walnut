/**
 * The message body, on paper.
 *
 * The card is WHITE IN BOTH THEMES and so is the sandboxed frame inside it. HTML mail is authored
 * for white: the theme-aware reset this replaced turned the page dark and left the sender's own
 * colours where they were, which is how a newsletter's blue headings ended up on a black field.
 * A plain-text body gets the same card, because a text mail and an html mail are the same kind of
 * object and switching surface between them makes the reader look like two different apps.
 *
 * The blocked-images notice sits INSIDE the paper, at the top, as a slim pill row: it is a fact
 * about this document, not a banner about the app.
 */
import { useMemo } from 'react';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { truncatedNotice } from './mail-format';
import { allowRemoteImagesForOpenMessage, retryOpenMessageBody } from './mail-actions';
import type { MailOpenMessage } from './mail-store';
import { buildMailBodyFrame } from './mail-sanitize';
import { MAIL_IFRAME_SANDBOX } from './mail-html';
import { hasBodyContent, looksLikeCode } from './mail-reader-format';
import { ImageIcon } from './mail-icons';

export function MailReaderBody({ open }: { open: MailOpenMessage }) {
  const body = open.body;
  const html = body?.html;
  const frame = useMemo(
    () => (html ? buildMailBodyFrame(html, open.allowRemoteImages) : null),
    [html, open.allowRemoteImages],
  );

  if (open.loading && !body) {
    return (
      <div className="mail-reader-body mail-reader-column">
        <div className="mail-paper mail-skeleton" data-testid="mail-body-skeleton" aria-hidden="true">
          <div className="mail-skeleton-bar w-body" />
          <div className="mail-skeleton-bar w-body" />
          <div className="mail-skeleton-bar w-body-short" />
        </div>
      </div>
    );
  }

  if (open.error) {
    return (
      <Notice testId="mail-reader-error" text={open.error} />
    );
  }

  if (open.bodyError) {
    return (
      <Notice testId="mail-body-error" text={bodyErrorSentence(open.bodyError)} />
    );
  }

  // Two different facts, and saying the wrong one sends the human looking for the wrong problem:
  // a message the provider says HAS a body, which is not here, is a fetch that has not happened;
  // a message with no body is just an empty message (a calendar invite, a bare attachment).
  if (!body) {
    return (
      <div className="mail-reader-body mail-reader-column">
        <p className="mail-pane-empty" data-testid="mail-body-missing">
          {open.message?.hasBody
            ? 'Walnut has not fetched this body yet.'
            : 'This message has no body.'}
        </p>
      </div>
    );
  }

  // A body can arrive with a format and no content: an `html` part that is empty, or a text part
  // that is whitespace. Rendering the frame anyway is a blank pane that reads as a broken reader.
  if (!hasBodyContent(body)) {
    return (
      <div className="mail-reader-body mail-reader-column">
        <p className="mail-pane-empty" data-testid="mail-body-empty">
          {body.html?.trim()
            ? 'This message arrived with no readable content: its markup has no text and no images.'
            : 'No text content.'}
        </p>
      </div>
    );
  }

  const text = body.text ?? '';
  return (
    <div className="mail-reader-body mail-reader-column">
      <div className="mail-paper">
        {frame && frame.remoteImages > 0 && !open.allowRemoteImages && (
          <div className="mail-blocked-images" data-testid="mail-blocked-images">
            <span className="mail-blocked-glyph" aria-hidden="true"><ImageIcon size={13} /></span>
            <span className="mail-blocked-text">
              {frame.remoteImages === 1
                ? '1 remote image blocked'
                : `${frame.remoteImages} remote images blocked`}
            </span>
            <button
              type="button"
              className="mail-paper-btn"
              data-testid="mail-load-images"
              onClick={allowRemoteImagesForOpenMessage}
            >
              Load images
            </button>
          </div>
        )}

        {frame ? (
          <iframe
            className="mail-html-frame"
            data-testid="mail-html-frame"
            sandbox={MAIL_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={frame.srcdoc}
            title={open.message?.subject || 'Message'}
          />
        ) : (
          <pre
            className="mail-body-text"
            data-testid="mail-body-text"
            data-shape={looksLikeCode(text) ? 'code' : 'prose'}
          >
            <LinkifiedText text={text} />
          </pre>
        )}
      </div>

      {body.truncated && (
        <p className="mail-body-footnote" data-testid="mail-body-truncated">
          {truncatedNotice(body.bytes)}
        </p>
      )}
    </div>
  );
}

/** A body that did not arrive, with the one control that can change that. */
function Notice({ testId, text }: { testId: string; text: string }) {
  return (
    <div className="mail-reader-body mail-reader-column">
      <div className="mail-body-notice" data-testid={testId}>
        <p>{text}</p>
        <button type="button" className="mail-text-btn" onClick={() => { void retryOpenMessageBody(); }}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** The plugin answers with a provider error CODE; a code is not an explanation. */
function bodyErrorSentence(code: string): string {
  if (code === 'too-large') return 'This message body is too big to cache, so Walnut did not fetch it.';
  if (code === 'auth') return 'The provider refused the credentials while fetching this body.';
  if (code === 'not-found') return 'The provider no longer has this message.';
  if (code === 'unreachable') return 'The provider did not answer in time. It may be offline.';
  return `Walnut could not fetch this body (${code}).`;
}
