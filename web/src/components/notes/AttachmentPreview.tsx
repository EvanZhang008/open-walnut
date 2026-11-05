import { useEffect, useReducer, useState } from 'react';
import { attachmentUrl, revealNote } from '@/api/notes-v2';
import { browserCanInlinePdf } from '@/utils/pdf-support';
import { NOTE_IMAGE_EXTS } from './notes-image-types';
import { failureOf, knownUndrawable, noteMissing, onPageReturn, retryDue } from './image-load';
import './notes-attachment.css';
// The picture card's styles (shared with the editor's inline pictures).
import './notes-editor.css';

/**
 * Preview pane for a vault attachment selected in the tree.
 *
 * Attachments are NOT markdown notes — clicking one in the tree must NOT run it
 * through the markdown editor (it would 404 / garble). This renders the raw
 * file via the notes-owned /api/notes-v2/attachment endpoint:
 *   - images (NOTE_IMAGE_EXTS) → <img>
 *   - pdf → <iframe> inline preview (browser-native PDF viewer)
 *   - Office docs (docx/xlsx/pptx/…) → open card: local app (Word/Excel) via
 *     /reveal, plus a browser download fallback. Never rendered inline.
 */
export function AttachmentPreview({ notePath, findQuery }: { notePath: string; findQuery?: string }) {
  const name = notePath.split('/').pop() || notePath;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const url = attachmentUrl(notePath);
  const breadcrumb = notePath.split('/');

  // A picture this browser cannot draw (HEIC, TIFF outside Safari) or that is
  // gone: the same card the note shows inline, with a download for the former.
  const [failed, setFailed] = useState<{ url: string; kind: 'missing' | 'undrawable'; at: number } | null>(() =>
    knownUndrawable(url) ? { url, kind: 'undrawable', at: Date.now() } : null);
  const failure = failed?.url === url ? failed.kind : null;
  // A missing one is asked again when the user comes back to the page a few
  // seconds later (a file put back, a connection back), as inline pictures are.
  const [retry, bump] = useReducer((n: number) => n + 1, 0);
  const missingAt = failure === 'missing' ? failed!.at : 0;
  useEffect(() => {
    if (!missingAt) return;
    return onPageReturn(() => { if (retryDue(missingAt)) { setFailed(null); bump(); } });
  }, [missingAt]);
  const isImage = NOTE_IMAGE_EXTS.has(ext) && !failure;
  // Same guard as WikiEmbedView: with the browser's PDF viewer disabled an
  // <iframe> is a silent download, so route those users to the open card
  // (local app via /reveal) instead of downloading on every tree click.
  const isPdf = ext === 'pdf' && browserCanInlinePdf();

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
          {isImage || isPdf ? (
            <a className="notes-attachment-open" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
          ) : failure !== 'missing' && (
            <a className="notes-attachment-open" href={url} download={name}>Download</a>
          )}
        </div>
      </div>
      <div className="notes-attachment-preview">
        {isImage ? (
          <img
            key={retry}
            className="notes-attachment-image"
            src={url}
            alt={name}
            onError={() => {
              void failureOf(url).then((kind) => {
                if (kind === 'missing') noteMissing(url);
                setFailed({ url, kind, at: Date.now() });
              });
            }}
          />
        ) : failure ? (
          <div className="notes-image-missing notes-attachment-failed">
            <span className="notes-image-missing-icon" aria-hidden>{failure === 'missing' ? '!' : '\u2193'}</span>
            <span className="notes-image-missing-label">{failure === 'missing' ? 'Image not found' : "Can't preview here"}</span>
            <span className="notes-image-missing-name">{name}</span>
            {failure === 'undrawable' && (
              <a className="notes-image-download" href={url} download={name}>Download</a>
            )}
          </div>
        ) : isPdf ? (
          // Opened from a search hit: the PDF viewer searches the word itself
          // (Chromium's viewer reads #search=; WebKit's ignores it).
          <iframe className="notes-attachment-pdf" src={findQuery ? `${url}#search=${encodeURIComponent(findQuery)}` : url} title={name} />
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
