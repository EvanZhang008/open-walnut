/**
 * React NodeView for the `![[embed]]` node (wiki-embed-node.ts) — renders the
 * referenced vault attachment inline in the editor (BUG 2).
 *
 *   - image (png/jpg/jpeg/gif/webp/...) → <img>, click opens it large in a lightbox
 *   - pdf                           → <iframe> inline preview + "Open" affordance
 *   - other (e.g. `.base`)          → click-to-open card (never crash / never
 *                                     try to render an unknown type inline)
 *
 * The file is fetched from the single notes-owned endpoint via attachmentUrl();
 * that endpoint resolves bare names / vault-relative / legacy `Notion/` paths,
 * so this view passes the raw `target` through untouched. A failed image load
 * degrades to the same click-to-open card (so a missing/renamed attachment is
 * visible, not a broken-image glyph).
 */

import { useEffect, useReducer, useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { attachmentUrl } from '@/api/notes-v2';
import { browserCanInlinePdf } from '@/utils/pdf-support';
import { NOTE_IMAGE_EXTS } from './notes-image-types';
import { failureOf, knownUndrawable, noteMissing, onPageReturn, recentlyMissing, retryDue } from './image-load';
import './wiki-embed.css';

const IMAGE_EXTS = NOTE_IMAGE_EXTS;

/**
 * The embed target may carry an Obsidian display size (`![[x.png|300]]`). That
 * suffix is presentation, not part of the filename — extension sniffing and the
 * fetch path both have to see through it.
 */
function pathOf(target: string): string {
  return target.split('|')[0].trim();
}

/**
 * Obsidian's display size, `|300` (width) or `|300x200`. Anything else after the
 * bar (an alias) is not a size.
 */
export function embedSizeOf(target: string): { width: number; height?: number } | null {
  const m = /\|\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/i.exec(target);
  if (!m) return null;
  const width = Number(m[1]);
  if (!width) return null;
  return m[2] ? { width, height: Number(m[2]) } : { width };
}

function extOf(target: string): string {
  const base = pathOf(target).split('/').pop() || target;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function fileNameOf(target: string): string {
  const p = pathOf(target);
  return p.split('/').pop() || p;
}

export function WikiEmbedView({ node, editor }: ReactNodeViewProps) {
  const target = String(node.attrs.target || '');
  const ext = extOf(target);
  // `notePath` lets the server break duplicate-filename ties by proximity to
  // this note (see attachmentUrl); absent it falls back to the old behavior.
  const notePath = (editor?.storage?.wikiEmbed?.notePath as string | undefined) || undefined;
  const url = attachmentUrl(pathOf(target), notePath);
  // Why the picture did not draw (image-load.ts): missing, or here but of a type
  // this browser cannot draw. A missing one is asked again on a repaint a few
  // seconds later, so a file put back shows without reopening the note.
  const [failure, setFailure] = useState<{ kind: 'missing' | 'undrawable'; at: number; url: string } | null>(() =>
    recentlyMissing(url) ? { kind: 'missing', at: Date.now(), url }
      : knownUndrawable(url) ? { kind: 'undrawable', at: Date.now(), url } : null);
  const failed = failure && failure.url === url ? failure : null;
  // A retry keeps the card up and asks with a hidden picture until it answers.
  const retrying = failed?.kind === 'missing' && retryDue(failed.at);
  const imgFailed = !!failed;
  // Coming back to the page asks a missing picture again (a file put back from Finder).
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const missingAt = failed?.kind === 'missing' ? failed.at : 0;
  useEffect(() => {
    if (!missingAt) return;
    return onPageReturn(() => { if (retryDue(missingAt)) recheck(); });
  }, [missingAt]);
  const onImageError = () => {
    void failureOf(url).then((kind) => {
      if (kind === 'missing') noteMissing(url);
      setFailure({ kind, at: Date.now(), url });
    });
  };
  const size = embedSizeOf(target);

  // NodeViewWrapper is inline to match the inline atom node (block elements
  // inside an inline node throw in ProseMirror). `contentEditable={false}` so
  // the embed is selected as one unit and never typed into.
  const isImage = IMAGE_EXTS.has(ext) && !imgFailed;
  // Only iframe-embed a PDF when the browser will actually render it inline.
  // With the viewer disabled (Firefox "Save File"/"Open in Preview", Chrome
  // "Download PDFs"), each iframe fires a download + external-app launch the
  // moment the note opens — so those browsers get the click-to-open card.
  const isPdf = ext === 'pdf' && browserCanInlinePdf();

  return (
    <NodeViewWrapper as="span" className="notes-wikiembed-view" contentEditable={false}>
      {isImage ? (
        // A click opens it large (NotesEditor's lightbox), never a new tab: the
        // Mac app's window has no tabs to open one in.
        <span className="notes-wikiembed-imglink">
          <img
            src={url}
            alt={fileNameOf(target)}
            className="notes-wikiembed-img"
            data-lightbox-src={url}
            // Obsidian's `|300`: a width cap that still shrinks to fit the column.
            style={size ? { width: `${size.width}px`, ...(size.height ? { height: `${size.height}px` } : {}) } : undefined}
            draggable={false}
            onError={onImageError}
          />
        </span>
      ) : failed ? (
        // The same card a markdown image shows (resolved-image.ts).
        <span className="notes-image-missing" title={`![[${target}]]`}>
          <span className="notes-image-missing-icon" aria-hidden>{failed.kind === 'missing' ? '!' : '\u2193'}</span>
          <span className="notes-image-missing-label">{failed.kind === 'missing' ? 'Image not found' : "Can't preview here"}</span>
          <span className="notes-image-missing-name">{fileNameOf(target)}</span>
          {retrying && (
            <img src={url} alt="" hidden onLoad={() => setFailure(null)} onError={onImageError} />
          )}
          {failed.kind === 'undrawable' && (
            <a className="notes-image-download" href={url} download={fileNameOf(target)}>Download</a>
          )}
        </span>
      ) : isPdf ? (
        <span className="notes-wikiembed-pdf">
          <iframe src={url} title={fileNameOf(target)} className="notes-wikiembed-pdf-frame" />
          <a href={url} target="_blank" rel="noreferrer" className="notes-wikiembed-open">
            Open {fileNameOf(target)}
          </a>
        </span>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className="notes-wikiembed-card">
          <span className="notes-wikiembed-card-icon" aria-hidden>
            {'\u{1F4CE}'}
          </span>
          <span className="notes-wikiembed-card-name">{fileNameOf(target)}</span>
          <span className="notes-wikiembed-card-raw">{`![[${target}]]`}</span>
        </a>
      )}
    </NodeViewWrapper>
  );
}
