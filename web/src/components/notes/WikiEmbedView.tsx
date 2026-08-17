/**
 * React NodeView for the `![[embed]]` node (wiki-embed-node.ts) — renders the
 * referenced vault attachment inline in the editor (BUG 2).
 *
 *   - image (png/jpg/jpeg/gif/webp) → <img>, click opens full size in a new tab
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

import { useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { attachmentUrl } from '@/api/notes-v2';
import { browserCanInlinePdf } from '@/utils/pdf-support';
import './wiki-embed.css';

// heic/heif are what an iPhone camera writes. Safari renders them inline; other
// browsers fail the <img> load and fall through to the click-to-open card, which
// is the correct degrade (previously they never even tried).
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif']);

/**
 * The embed target may carry an Obsidian display size (`![[x.png|300]]`). That
 * suffix is presentation, not part of the filename — extension sniffing and the
 * fetch path both have to see through it.
 */
function pathOf(target: string): string {
  return target.split('|')[0].trim();
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
  const [imgFailed, setImgFailed] = useState(false);

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
        <a href={url} target="_blank" rel="noreferrer" className="notes-wikiembed-imglink">
          <img
            src={url}
            alt={fileNameOf(target)}
            className="notes-wikiembed-img"
            draggable={false}
            onError={() => setImgFailed(true)}
          />
        </a>
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
            {imgFailed ? '!' : '\u{1F4CE}'}
          </span>
          <span className="notes-wikiembed-card-name">{fileNameOf(target)}</span>
          <span className="notes-wikiembed-card-raw">{`![[${target}]]`}</span>
        </a>
      )}
    </NodeViewWrapper>
  );
}
