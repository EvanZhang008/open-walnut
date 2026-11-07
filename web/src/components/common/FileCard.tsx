/**
 * A file attached to a message, drawn the same in the composer (while it
 * uploads) and in the conversation (once sent): a type badge, the name, and a
 * line of detail (size, progress, or why it failed).
 */
import type { ReactNode } from 'react';
import '@/styles/attachments.css';

type Kind = 'pdf' | 'archive' | 'code' | 'text' | 'image' | 'video' | 'audio' | 'sheet' | 'doc' | 'file';

const EXT_KIND: Record<string, Kind> = {
  pdf: 'pdf',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive', zst: 'archive',
  log: 'text', txt: 'text', md: 'text', out: 'text', err: 'text', rtf: 'text',
  csv: 'sheet', tsv: 'sheet', xls: 'sheet', xlsx: 'sheet', numbers: 'sheet',
  doc: 'doc', docx: 'doc', pages: 'doc', ppt: 'doc', pptx: 'doc', key: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image', heif: 'image', svg: 'image', bmp: 'image', tiff: 'image', avif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  json: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code', html: 'code', css: 'code', js: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code',
  cs: 'code', php: 'code', sh: 'code', zsh: 'code', bash: 'code', sql: 'code', diff: 'code', patch: 'code', ini: 'code', env: 'code', lock: 'code',
};

export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function fileKindOf(name: string, mediaType?: string): Kind {
  const byExt = EXT_KIND[extensionOf(name)];
  if (byExt) return byExt;
  const t = (mediaType ?? '').toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('text/')) return 'text';
  if (/zip|compressed|tar|gzip/.test(t)) return 'archive';
  return 'file';
}

/** The badge's short word: the extension when it is short, else the kind. */
function badgeText(name: string, kind: Kind): string {
  const ext = extensionOf(name);
  if (ext && ext.length <= 4) return ext.toUpperCase();
  return kind === 'file' ? 'FILE' : kind.toUpperCase().slice(0, 4);
}

export function FileGlyph({ name, mediaType }: { name: string; mediaType?: string }) {
  const kind = fileKindOf(name, mediaType);
  return (
    <span className={`file-glyph file-glyph-${kind}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <polyline points="14 3 14 8 19 8" />
      </svg>
      <span className="file-glyph-label">{badgeText(name, kind)}</span>
    </span>
  );
}

export function FileCard({ name, mediaType, detail, failed, progress, onOpen, actions, title }: {
  name: string;
  mediaType?: string;
  detail: ReactNode;
  failed?: boolean;
  /** 0 to 1 while uploading; absent once done. */
  progress?: number;
  /** Opens the file (a sent card). */
  onOpen?: () => void;
  actions?: ReactNode;
  title?: string;
}) {
  const body = (
    <>
      <FileGlyph name={name} mediaType={mediaType} />
      <span className="file-card-meta">
        <span className="file-card-name">{name}</span>
        <span className="file-card-detail">{detail}</span>
      </span>
    </>
  );
  return (
    <div className={`file-card${failed ? ' is-failed' : ''}${onOpen ? ' is-openable' : ''}`} role="listitem" title={title ?? name}>
      {onOpen ? (
        <button type="button" className="file-card-open" onClick={onOpen} aria-label={`Open ${name}`}>{body}</button>
      ) : (
        <span className="file-card-open">{body}</span>
      )}
      {actions}
      {progress !== undefined && (
        <span className="file-card-progress" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
        </span>
      )}
    </div>
  );
}
