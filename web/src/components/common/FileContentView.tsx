/**
 * FileContentView — shared file-content renderer.
 *
 * Fetches a file from /api/file-content (local + remote via host) and renders
 * it with line numbers + optional line highlight/scroll-to. Used by both the
 * full-screen FileViewer overlay and the inline right pane of SessionFileExplorer.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchFileContent, rawFileContentUrl, downloadFileUrl, type FileContentResponse } from '@/api/files';
import { formatSize } from '@/utils/format';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { ICON_NEW_TAB } from '@/components/common/Icons';
import { openPopout } from '@/popout/openPopout';

interface FileContentViewProps {
  path: string;
  line?: number;
  host?: string;
  /** Hide the "pop out to window" button (e.g. when already rendered inside a pop-out). */
  hidePopout?: boolean;
}

/** Build line-numbered HTML from raw file content. */
function buildLineNumberedHtml(content: string, highlightLine?: number): string {
  const lines = content.split('\n');
  const rows = lines.map((lineText, i) => {
    const lineNum = i + 1;
    const isHighlighted = lineNum === highlightLine;
    const escaped = lineText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div class="fv-line${isHighlighted ? ' fv-line-highlight' : ''}" data-line="${lineNum}"><span class="fv-line-num">${lineNum}</span><span class="fv-line-text">${escaped}</span></div>`;
  });
  return rows.join('');
}

/** Whether a file extension is HTML and thus previewable as rendered markup. */
function isHtmlExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'html' || e === 'htm';
}

/** Whether a file extension is Markdown and thus previewable as rendered markup. */
function isMarkdownExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'md' || e === 'markdown' || e === 'mdx';
}

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);

/** Speed steps shared by the toolbar select and the </> keyboard shortcuts. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Media kind from the path alone — media never goes through the JSON content
 *  fetch (a remote whole-file read of a 100MB video would kill the tunnel). */
function mediaKind(path: string): 'video' | 'audio' | null {
  const e = (path.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  return null;
}

export function FileContentView({ path: filePath, line, host, hidePopout }: FileContentViewProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // For HTML/Markdown files, default to the rendered preview; toggle to source on demand.
  const [showSource, setShowSource] = useState(false);
  // Fullscreen the preview (md/html) — CSS-fixed overlay, no remount.
  const [fullscreen, setFullscreen] = useState(false);
  // Media playback speed — applied to the <video>/<audio> element directly.
  const [playbackRate, setPlaybackRate] = useState(1);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Skip: back 3s (small — re-hear the last sentence), forward 10s (skip dead air).
  const skipBy = (deltaSec: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = Math.min(Math.max(0, el.currentTime + deltaSec), dur);
  };

  const media = mediaKind(filePath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setShowSource(false);
    setFullscreen(false);
    setPlaybackRate(1);
    // Media plays straight from the raw URL — no JSON content fetch (which
    // would whole-file-read a potentially huge binary on the remote side).
    if (mediaKind(filePath)) { setLoading(false); return; }
    fetchFileContent(filePath, host)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setData({
          content: null, size: 0, truncated: false, binary: false,
          error: err instanceof Error ? err.message : String(err),
          extension: '',
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, host]);

  // Scroll to highlighted line after content renders
  useEffect(() => {
    if (!line || !contentRef.current) return;
    const el = contentRef.current.querySelector(`[data-line="${line}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [line, data]);

  // Media keyboard shortcuts. Capture phase so we beat the browser's native
  // focused-<video> handling; preventDefault stops a double-seek. Skipped while
  // typing in an input/textarea/editor. These fire in NATIVE video fullscreen
  // too (keydown still reaches window) — the only way to change speed there,
  // since the toolbar select isn't part of the fullscreened <video> element.
  //   ← back 3s   → forward 10s   > speed up   < slow down (YouTube-style)
  useEffect(() => {
    if (!media) return;
    const handler = (e: KeyboardEvent) => {
      const isSeek = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const isSpeed = e.key === '>' || e.key === '<';
      if (!isSeek && !isSpeed) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (isSeek) {
        skipBy(e.key === 'ArrowLeft' ? -3 : 10);
        return;
      }
      setPlaybackRate((prev) => {
        const idx = PLAYBACK_RATES.indexOf(prev);
        const at = idx === -1 ? PLAYBACK_RATES.indexOf(1) : idx;
        const next = PLAYBACK_RATES[Math.min(Math.max(at + (e.key === '>' ? 1 : -1), 0), PLAYBACK_RATES.length - 1)];
        if (mediaRef.current) mediaRef.current.playbackRate = next;
        return next;
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [media]);

  // Escape exits fullscreen (capture phase so it fires before the FileViewer's own
  // Escape-to-close handler, letting the first Escape just leave fullscreen).
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [fullscreen]);

  const lineNumberedHtml = useMemo(() => {
    if (!data?.content) return '';
    return buildLineNumberedHtml(data.content, line);
  }, [data, line]);

  const isHtml = data?.content != null && isHtmlExt(data.extension, filePath);
  const isMarkdown = data?.content != null && isMarkdownExt(data.extension, filePath);
  const isRenderable = isHtml || isMarkdown;
  const showPreview = isRenderable && !showSource;

  const downloadBtn = (
    <a
      className="fv-html-tab fv-download-btn"
      href={downloadFileUrl(filePath, host)}
      download
      title="Download file"
    >
      ⬇ Download
    </a>
  );

  const markdownHtml = useMemo(() => {
    if (!isMarkdown || !data?.content) return '';
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : undefined;
    return renderMarkdownWithRefs(data.content, dir, host);
  }, [isMarkdown, data, host, filePath]);

  // Open the file in its own standalone browser TAB (zero-WS, one-shot fetch).
  // Hidden in fullscreen (fullscreen is the in-app expand) and when already popped out.
  const popoutBtn =
    !hidePopout && !fullscreen ? (
      <button
        type="button"
        className="fv-html-tab fv-popout-btn"
        onClick={() => openPopout('file', { path: filePath, host, line })}
        title="Open in new tab"
        aria-label="Open in new tab"
      >
        {ICON_NEW_TAB}
      </button>
    ) : null;

  return (
    <div className={`file-content-view${fullscreen ? ' fv-fullscreen' : ''}`} ref={contentRef}>
      {loading && <div className="file-viewer-loading">Loading file...</div>}
      {!loading && data?.error && <div className="file-viewer-error">{data.error}</div>}
      {!loading && !media && data?.binary && (
        <>
          <div className="fv-html-toolbar fv-toolbar-popout-only">{downloadBtn}{popoutBtn}</div>
          <div className="file-viewer-error">
            Binary file ({formatSize(data.size)}) — cannot display. Use Download to save it.
          </div>
        </>
      )}
      {!loading && media && (
        <>
          <div className="fv-html-toolbar">
            {downloadBtn}
            <button
              type="button"
              className="fv-html-tab fv-skip-btn"
              onClick={() => skipBy(-3)}
              title="Back 3 seconds (←)"
              aria-label="Back 3 seconds"
            >
              ↺ 3s
            </button>
            <button
              type="button"
              className="fv-html-tab fv-skip-btn"
              onClick={() => skipBy(10)}
              title="Forward 10 seconds (→)"
              aria-label="Forward 10 seconds"
            >
              10s ↻
            </button>
            <select
              className="fv-html-tab fv-speed-select"
              value={playbackRate}
              onChange={(e) => {
                const rate = Number(e.target.value);
                setPlaybackRate(rate);
                if (mediaRef.current) mediaRef.current.playbackRate = rate;
              }}
              title="Playback speed"
              aria-label="Playback speed"
            >
              {PLAYBACK_RATES.map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
            <button
              className="fv-html-tab fv-fullscreen-btn"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
            </button>
            {popoutBtn}
          </div>
          <div className="fv-media-preview">
            {media === 'video' ? (
              <video
                controls
                preload="metadata"
                src={rawFileContentUrl(filePath, host)}
                ref={(el) => { mediaRef.current = el; if (el) el.playbackRate = playbackRate; }}
                // Some browsers reset playbackRate to 1 once metadata loads — re-apply.
                onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate; }}
              />
            ) : (
              <audio
                controls
                preload="metadata"
                src={rawFileContentUrl(filePath, host)}
                ref={(el) => { mediaRef.current = el; if (el) el.playbackRate = playbackRate; }}
                onLoadedMetadata={(e) => { e.currentTarget.playbackRate = playbackRate; }}
              />
            )}
          </div>
        </>
      )}
      {!loading && isRenderable && (
        <div className="fv-html-toolbar">
          <button
            className={`fv-html-tab${showPreview ? ' active' : ''}`}
            onClick={() => setShowSource(false)}
          >
            Preview
          </button>
          <button
            className={`fv-html-tab${!showPreview ? ' active' : ''}`}
            onClick={() => setShowSource(true)}
          >
            Source
          </button>
          {downloadBtn}
          <button
            className="fv-html-tab fv-fullscreen-btn"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
          </button>
          {popoutBtn}
        </div>
      )}
      {/* Non-renderable files (plain code) have no preview/source toolbar — give them
          a minimal one for Download + pop-out. Media/binary render their own. */}
      {!loading && !isRenderable && !media && !data?.binary && !data?.error && (
        <div className="fv-html-toolbar fv-toolbar-popout-only">{downloadBtn}{popoutBtn}</div>
      )}
      {!loading && showPreview && isHtml && (
        <iframe
          className="fv-html-preview"
          // `src` (not `srcDoc`) so the page has its OWN document URL — in-page
          // anchors, relative links and scripts resolve against the file itself
          // instead of navigating the Walnut SPA. Files the user explicitly opened
          // are trusted; allow scripts/forms/popups so the page is interactive.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
          src={rawFileContentUrl(filePath, host)}
          title={filePath}
        />
      )}
      {!loading && showPreview && isMarkdown && (
        <div className="fv-md-preview markdown-body" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      )}
      {!loading && !showPreview && data?.content != null && data.content !== '' && (
        <pre className="file-viewer-code" dangerouslySetInnerHTML={{ __html: lineNumberedHtml }} />
      )}
      {!loading && data && !data.error && !data.binary && data.content === '' && (
        <div className="file-viewer-loading">Empty file</div>
      )}
      {!loading && data?.truncated && (
        <div className="file-viewer-truncated">
          Showing first {formatSize(512 * 1024)} of {formatSize(data.size)}
        </div>
      )}
    </div>
  );
}
