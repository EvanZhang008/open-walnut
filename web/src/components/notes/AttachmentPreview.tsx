import { attachmentUrl, revealNote } from '@/api/notes-v2';
import './notes-attachment.css';

/**
 * Preview pane for a vault attachment selected in the tree.
 *
 * Attachments are NOT markdown notes — clicking one in the tree must NOT run it
 * through the markdown editor (it would 404 / garble). This renders the raw
 * file via the notes-owned /api/notes-v2/attachment endpoint:
 *   - images (png/jpg/jpeg/gif/webp) → <img>
 *   - pdf → <iframe> inline preview (browser-native PDF viewer)
 *   - Office docs (docx/xlsx/pptx/…) → open card: local app (Word/Excel) via
 *     /reveal, plus a browser download fallback. Never rendered inline.
 */
export function AttachmentPreview({ notePath }: { notePath: string }) {
  const name = notePath.split('/').pop() || notePath;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const url = attachmentUrl(notePath);
  const breadcrumb = notePath.split('/');

  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  const isPdf = ext === 'pdf';

  return (
    <div className="notes-editor-panel">
      <div className="notes-editor-header">
        <div className="notes-editor-breadcrumb">
          {breadcrumb.map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="notes-breadcrumb-sep">/</span>}
              <span className={i === breadcrumb.length - 1 ? 'notes-breadcrumb-current' : 'notes-breadcrumb-parent'}>
                {part}
              </span>
            </span>
          ))}
        </div>
        <div className="notes-editor-meta">
          <a className="notes-attachment-open" href={url} target="_blank" rel="noreferrer">
            {isImage || isPdf ? 'Open in new tab' : 'Download'}
          </a>
        </div>
      </div>
      <div className="notes-attachment-preview">
        {isImage ? (
          <img className="notes-attachment-image" src={url} alt={name} />
        ) : isPdf ? (
          <iframe className="notes-attachment-pdf" src={url} title={name} />
        ) : (
          // Office & other non-renderable files: open with the local default
          // app (Word/Excel/…). On failure (cloud mode, disallowed type, app
          // missing) point at the Download fallback in the header.
          <button
            type="button"
            className="notes-attachment-card"
            onClick={() =>
              revealNote(notePath, 'app').catch((err) => {
                alert(`Could not open ${name} locally (${err instanceof Error ? err.message : 'failed'}). Use the Download link instead.`);
              })
            }
          >
            Open {name}
          </button>
        )}
      </div>
    </div>
  );
}
