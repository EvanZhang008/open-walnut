/**
 * The attachments above a composer's text: picture tiles and file cards, each
 * with its own upload progress, a Retry on one that failed and a remove button,
 * and one line below saying what the message waits for. A limit is said only on
 * the attachment that hit it, or when one was refused: never as a standing line.
 */
import { FileCard } from '@/components/common/FileCard';
import { type ComposerAttachment, type ComposerAttachments } from '@/components/common/composer-attachments';
import { formatBytes } from '@/api/file-upload';
import '@/styles/attachments.css';

function percent(a: ComposerAttachment): number {
  return a.size > 0 ? Math.min(100, Math.round((a.sent / a.size) * 100)) : 0;
}

function fileDetail(a: ComposerAttachment): string {
  const size = formatBytes(a.size);
  if (a.status === 'failed') return a.error ? `Not uploaded: ${a.error}` : 'Not uploaded';
  // Short first: in a narrow column the end of the line is cut off.
  // A limit it hit leads, so a narrow card cuts the size, not the reason.
  const limit = a.limit ? `${a.limit} · ` : '';
  if (a.status === 'preparing') return `${limit}Waiting · ${size}`;
  if (a.status === 'uploading') return `${limit}${percent(a)}% of ${size}`;
  return `${limit}${a.converted ? `${size} · Converted to JPEG` : size}`;
}

/** Retry, with its word on a card; a picture tile is too small for the word, so only the arrow. */
function RetryButton({ a, onRetry, iconOnly }: { a: ComposerAttachment; onRetry: (id: string) => void; iconOnly?: boolean }) {
  return (
    <button type="button" className={`attachment-retry${iconOnly ? ' is-icon' : ''}`} onClick={() => onRetry(a.id)} aria-label={`Retry uploading ${a.name}`} title="Retry">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
      </svg>
      {!iconOnly && <span>Retry</span>}
    </button>
  );
}

function RemoveButton({ a, onRemove, className }: { a: ComposerAttachment; onRemove: (id: string) => void; className: string }) {
  return (
    <button type="button" className={className} onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`} title="Remove">
      &times;
    </button>
  );
}

/** A picture tile: the preview, a ring while it uploads, a Retry when it failed. */
function ImageTile({ a, onRetry, onRemove }: { a: ComposerAttachment; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const busy = a.status === 'preparing' || a.status === 'uploading';
  const failed = a.status === 'failed';
  const p = percent(a);
  return (
    <div className={`chat-image-preview${busy ? ' is-uploading' : ''}${failed ? ' is-failed' : ''}`} role="listitem"
      title={failed ? `${a.name}: ${a.error ?? 'not uploaded'}` : a.converted ? `${a.name} (converted to JPEG)` : a.name}>
      {a.image && <img src={a.image.data ? `data:${a.image.mediaType};base64,${a.image.data}` : a.image.url} alt={a.name} />}
      {busy && (
        <span className="attachment-ring" role="progressbar" aria-label={`Uploading ${a.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
          <svg viewBox="0 0 36 36" width="28" height="28">
            <circle cx="18" cy="18" r="15" className="attachment-ring-track" />
            <circle cx="18" cy="18" r="15" className="attachment-ring-fill" strokeDasharray={`${(Math.max(4, p) / 100) * 94.25} 94.25`} />
          </svg>
        </span>
      )}
      {failed && !a.orphan && <span className="attachment-tile-failed"><RetryButton a={a} onRetry={onRetry} iconOnly /></span>}
      <RemoveButton a={a} onRemove={onRemove} className="chat-image-remove" />
    </div>
  );
}

export function ComposerAttachmentStrip({ attachments, notice, sendWhenReady, kept, onCancelSend }: {
  attachments: ComposerAttachments;
  /** What the last add left out, said once under the strip. */
  notice?: string | null;
  /** The message goes by itself once every upload is done (sent while they ran). */
  sendWhenReady?: boolean;
  /** Uploaded ones are kept with the draft over a reload (only an unfinished one would be lost). */
  kept?: boolean;
  onCancelSend?: () => void;
}) {
  const { items, retry, remove, pending, failed } = attachments;
  if (items.length === 0 && !notice) return null;
  const orphans = items.filter((a) => a.orphan).length;
  const status = failed > 0
    ? orphans === failed
      ? `${orphans === 1 ? '1 attachment' : `${orphans} attachments`} did not finish uploading: remove and attach again to send`
      : `${failed === 1 ? '1 upload' : `${failed} uploads`} failed: retry or remove ${failed === 1 ? 'it' : 'them'} to send`
    : sendWhenReady && pending === 0
      ? 'Sends when you stop typing'
    : pending > 0
      ? sendWhenReady
        ? `Sends when ${pending === 1 ? 'the upload finishes' : `the ${pending} uploads finish`}`
        : `Uploading ${pending === 1 ? '1 attachment' : `${pending} attachments`}; press Enter to send once ${pending === 1 ? 'it is' : 'they are'} done`
      : null;
  // A picture tile has no room for words: why it failed is said here (a file card says it itself).
  const pictureFailures = items.filter((a) => a.kind === 'image' && a.status === 'failed');
  return (
    <div className="chat-attachments">
      {items.length > 0 && (
        <div className="chat-image-previews chat-attachment-list" role="list" aria-label="Attachments" data-kept={kept ? 'true' : undefined}>
          {[...items.filter((a) => a.kind === 'image'), ...items.filter((a) => a.kind !== 'image')].map((a) => (a.kind === 'image' ? (
            <ImageTile key={a.id} a={a} onRetry={retry} onRemove={remove} />
          ) : (
            <FileCard
              key={a.id}
              name={a.name}
              mediaType={a.mediaType}
              detail={fileDetail(a)}
              failed={a.status === 'failed'}
              progress={a.status === 'uploading' || a.status === 'preparing' ? (a.size > 0 ? a.sent / a.size : 0) : undefined}
              title={a.status === 'failed' && a.error ? `${a.name}: ${a.error}` : a.limit ? `${a.name}: ${a.limit}` : a.name}
              actions={(
                <>
                  {a.status === 'failed' && !a.orphan && <RetryButton a={a} onRetry={retry} />}
                  <RemoveButton a={a} onRemove={remove} className="file-card-remove" />
                </>
              )}
            />
          )))}
        </div>
      )}
      <div className={`chat-attachments-note${failed > 0 || notice ? ' is-warning' : ''}`} aria-live="polite">
        {notice ? <span>{notice}</span> : status ? <span>{status}</span> : null}
        {sendWhenReady && failed === 0 && onCancelSend && (
          <button type="button" className="chat-attachments-cancel" onClick={onCancelSend}>Don&apos;t send yet</button>
        )}
        {pictureFailures.map((a) => (
          <span key={a.id} className="chat-attachments-failure">{`${a.name}: ${a.error ?? 'not uploaded'}`}</span>
        ))}
      </div>
    </div>
  );
}
