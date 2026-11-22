/**
 * One attachment, opened inside Walnut: a PDF in Walnut's own PDF viewer, an image on a dark field.
 *
 * Opened only by a click on its chip (MailReaderHead), which is the whole contract with the person
 * who said "don't auto download, I will download attachment if needed": nothing here, and nothing in
 * the chip, asks the server for a byte before that click. The bytes come from the plugin's attachment
 * route, so they reach the browser's PDF and image loaders directly and are never cached by Walnut.
 *
 * A modal through `useModalOverlay`, like every other overlay: Escape closes it, the page behind does
 * not scroll, and a click on the backdrop closes it too. Focus moves into it when it opens and back
 * to the chip when it closes (`useDialogFocus`). In a browser the Download button is a real link
 * with `download`, so saving the file is the browser's own download; in the Mac app, whose web view
 * has none, the server saves it into Downloads and the bar says so (mail-attachment-save.ts).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { mailAttachmentUrl, type MailAttachmentMeta } from '@/api/mail';
import { FitButton, HeaderFitMore, useHeaderFit } from '@/components/common/HeaderFit';
import { ICON_CLOSE, ICON_DOWNLOAD } from '@/components/common/Icons';
import { PdfPreview } from '@/components/common/PdfPreview';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';
import { attachmentFileName, attachmentName } from './mail-format';
import { saveStatusLine, savesThroughServer, useAttachmentSave } from './mail-attachment-save';

export interface OpenAttachment {
  accountId: string;
  messageId: string;
  attachment: MailAttachmentMeta & { id: string };
  kind: 'pdf' | 'image';
}

export function MailAttachmentViewer({ open, onClose }: { open: OpenAttachment; onClose: () => void }) {
  useModalOverlay(onClose);
  const { accountId, messageId, attachment, kind } = open;
  const url = mailAttachmentUrl(accountId, messageId, attachment.id);
  const name = attachmentName(attachment);
  const [imageFailed, setImageFailed] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useDialogFocus(root, name);
  const saver = useAttachmentSave(accountId, messageId);
  const status = saveStatusLine(saver.state);
  const barRef = useHeaderFit();

  return createPortal(
    <div
      ref={setRoot}
      className="mail-attachment-viewer"
      data-testid="mail-attachment-viewer"
      data-pdf-find-scope=""
      data-kind={kind}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      onClick={onClose}
      // A portal still bubbles React events to the reader behind it; nothing there may see these.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mail-attachment-viewer-bar" ref={barRef} data-fit-header="" onClick={(event) => event.stopPropagation()}>
        <span className="mail-attachment-viewer-name" data-fit-title="">{name}</span>
        {attachment.bytes ? <span className="mail-attachment-viewer-size" data-fit-sub="">{formatSize(attachment.bytes)}</span> : null}
        {status && (
          <span
            className={`mail-attachment-viewer-status${saver.state.kind === 'failed' ? ' is-failed' : ''}`}
            data-testid="mail-attachment-save-status"
            role="status"
          >
            {status}
          </span>
        )}
        {savesThroughServer() ? (
          <FitButton
            icon={ICON_DOWNLOAD}
            label="Download"
            className="mail-attachment-viewer-btn"
            data-testid="mail-attachment-download"
            disabled={saver.state.kind === 'saving'}
            onClick={() => { void saver.save(attachment); }}
          />
        ) : (
          // A link, so the browser saves it; it folds like a FitButton (its icon, then the More menu).
          <a
            className="btn btn-sm btn-ghost mail-attachment-viewer-btn"
            data-testid="mail-attachment-download"
            data-fit-button="1"
            aria-label="Download"
            href={mailAttachmentUrl(accountId, messageId, attachment.id, { download: true })}
            download={attachmentFileName(attachment)}
          >
            <span className="header-fit-icon" aria-hidden="true">{ICON_DOWNLOAD}</span>
            <span data-fit-label="">Download</span>
          </a>
        )}
        <HeaderFitMore testId="mail-attachment-more" />
        <FitButton icon={ICON_CLOSE} label="Close" keep className="mail-attachment-viewer-btn" data-testid="mail-attachment-close" onClick={onClose} />
      </div>
      <div className="mail-attachment-viewer-body" onClick={(event) => { if (kind === 'pdf') event.stopPropagation(); }}>
        {kind === 'pdf' ? (
          <div className="mail-attachment-viewer-pdf" data-testid="mail-attachment-pdf">
            <PdfPreview url={url} label={`mail attachment ${attachment.id}`} />
          </div>
        ) : imageFailed ? (
          <p className="mail-attachment-viewer-error" role="alert" onClick={(event) => event.stopPropagation()}>
            This image could not be shown. Use Download to open it on your computer.
          </p>
        ) : (
          <img
            className="mail-attachment-viewer-image"
            data-testid="mail-attachment-image"
            src={url}
            alt={name}
            referrerPolicy="no-referrer"
            onClick={(event) => event.stopPropagation()}
            onError={() => {
              log.warn('mail', 'attachment image could not load', { accountId, messageId, attachmentId: attachment.id });
              setImageFailed(true);
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
