/**
 * The attachments of a sent message, read from the headers it carries
 * (`[Images attached …]`, `[Files attached …]`, api/file-upload.ts
 * attachmentParts): pictures inline, every other file as a card that
 * opens it. Used by a person's bubble in history and by the bubble of a message
 * still on its way, so both look the same.
 */
import { useEffect, useState } from 'react';
import { FileCard, fileKindOf } from '@/components/common/FileCard';
import { formatBytes } from '@/api/file-upload';
import { clipHeaderName, type VideoClipRead } from '@open-walnut/attachment-headers';
import { fetchPathSizes } from '@/api/files';
import '@/styles/attachments.css';

const KIND_LABEL: Record<ReturnType<typeof fileKindOf>, string> = {
  pdf: 'PDF document',
  archive: 'Archive',
  code: 'Code',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  sheet: 'Spreadsheet',
  doc: 'Document',
  file: 'File',
};

/** Sizes known, by host and path (null: the host did not find it): a file a message names does not change size. */
const sizeCache = new Map<string, number | null>();
/** Asks in flight: a bubble that mounts while one runs (the live bubble replaced by the stored one) waits on it. */
const sizeAsks = new Map<string, Promise<void>>();
const sizeKey = (host: string | undefined, p: string) => `${host ?? ''}\u0000${p}`;

/**
 * The size of each file a sent message names, asked of its host once (the
 * message carries only paths). Unknown until the host answers, and stays
 * unknown for a file that is gone.
 */
function useFileSizes(paths: string[], host: string | undefined): Record<string, number> {
  const known = () => Object.fromEntries(paths.flatMap((p) => {
    const v = sizeCache.get(sizeKey(host, p));
    return typeof v === 'number' ? [[p, v]] : [];
  }));
  const [sizes, setSizes] = useState<Record<string, number>>(known);
  const joined = paths.join('\n');
  useEffect(() => {
    let live = true;
    const ask = paths.filter((p) => !sizeCache.has(sizeKey(host, p)) && !sizeAsks.has(sizeKey(host, p)));
    if (ask.length > 0) {
      const asked = fetchPathSizes(ask, host === '__local__' ? undefined : host).then(({ sizes: got, gone }) => {
        // Only a size or a "gone" is an answer; a path the host was too slow for is asked again later.
        for (const p of ask) {
          if (typeof got[p] === 'number') sizeCache.set(sizeKey(host, p), got[p]);
          else if (gone.has(p)) sizeCache.set(sizeKey(host, p), null);
        }
      }, () => { /* not answered (a host offline): asked again next time the message shows */ })
        .finally(() => { for (const p of ask) sizeAsks.delete(sizeKey(host, p)); });
      for (const p of ask) sizeAsks.set(sizeKey(host, p), asked);
    }
    const waits = [...new Set(paths.map((p) => sizeAsks.get(sizeKey(host, p))).filter((w): w is Promise<void> => !!w))];
    if (waits.length === 0) setSizes(known());
    else void Promise.all(waits).then(() => { if (live) setSizes(known()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, host]);
  return sizes;
}

/** A path line may carry a note after the path (a copy to the session's host that failed). */
const PATH_NOTE_RE = /^(.*?) \((could not be copied[^)]*)\)$/;

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function imageSrc(p: string, host?: string): string {
  if (p.startsWith('/api/')) return p;
  const hostParam = host && host !== '__local__' ? `&host=${encodeURIComponent(host)}` : '';
  return `/api/local-image?path=${encodeURIComponent(p)}${hostParam}`;
}

/** A recorded video's line on its sent card: what the AI got with it besides the file. */
function clipLine(clip: VideoClipRead): string {
  const n = clip.stills.length;
  return `${n === 1 ? '1 still' : `${n} stills`}${clip.narration ? ' · what was said' : ''}`;
}

export function MessageAttachments({ images, files, clips = [], host, onFileOpen }: {
  images: string[];
  files: string[];
  /** Recorded videos' stills and words (the person sees what the AI was given). */
  clips?: VideoClipRead[];
  /** The session's host, where a remote session's paths live. */
  host?: string;
  onFileOpen?: (path: string) => void;
}) {
  const parsed = files.map((line) => {
    const m = PATH_NOTE_RE.exec(line);
    return m ? { path: m[1], note: m[2] } : { path: line, note: null };
  });
  const sizes = useFileSizes(parsed.map((f) => f.path), host);
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="message-attachments" role="list" aria-label="Attachments">
      {images.length > 0 && (
        <div className="message-attachment-images">
          {images.map((p) => {
            const src = imageSrc(p, host);
            return (
              <span key={`i-${p}`} role="listitem" className="message-attachment-image-item">
                <img className="message-attachment-image" src={src} data-lightbox-src={src} alt={baseName(p)} title={baseName(p)} loading="lazy" />
              </span>
            );
          })}
        </div>
      )}
      {parsed.map(({ path: p, note }) => {
        const name = baseName(p);
        const kind = KIND_LABEL[fileKindOf(name)];
        const size = sizes[p];
        const clip = clips.length ? clips.find((c) => c.name === clipHeaderName(name)) : undefined;
        const detail = note ? `${kind} · ${note[0].toUpperCase()}${note.slice(1)}` : typeof size === 'number' ? `${formatBytes(size)} · ${kind}` : kind;
        const card = (
          <FileCard
            key={`f-${p}`}
            name={name}
            detail={clip ? `${detail} · ${clipLine(clip)}` : detail}
            failed={!!note}
            title={p}
            {...(onFileOpen ? { onOpen: () => onFileOpen(p) } : {})}
          />
        );
        if (!clip) return card;
        return (
          <div key={`c-${p}`} className="message-attachment-clip" data-testid="message-clip">
            {card}
            {clip.stills.length > 0 && (
              <div className="message-attachment-stills" aria-label={`Stills of ${name}`}>
                {clip.stills.map((s) => {
                  const src = imageSrc(s, host);
                  return <img key={s} className="message-attachment-still" src={src} data-lightbox-src={src} alt={baseName(s)} title={baseName(s)} loading="lazy" />;
                })}
              </div>
            )}
            {clip.narration && (
              <details className="message-attachment-said">
                <summary>What was said</summary>
                <p>{clip.narration}</p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
