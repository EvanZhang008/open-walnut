/**
 * OfficePreview — read-only, client-side render of office documents.
 *
 * Fetches the file's bytes from the raw-bytes endpoint (same URL the PDF/image
 * previews use, so local AND remote-daemon files both work) and renders them in
 * the browser with lazily-imported open-source libraries:
 *   word   (.docx)                       → docx-preview (paginated, styled)
 *   sheet  (.xlsx/.xls/.xlsm/.xlsb/.ods) → SheetJS → HTML table per sheet, tab bar
 *   slides (.pptx)                       → pptx-preview
 *
 * Preview only — no editing (the formats can't survive a text round-trip).
 * This component is itself lazy-loaded from FileContentView, and each renderer
 * is a dynamic import inside it, so none of these libraries touch the main
 * bundle or the office-free path.
 *
 * Sanitization: only the sheet path pipes library output through DOMPurify —
 * docx-preview and pptx-preview build the DOM themselves from parsed XML. That
 * asymmetry follows the raw endpoint's threat model (file-content.ts: files the
 * user explicitly opened on their own machine; no untrusted-upload surface).
 */
import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { rawFileContentUrl } from '@/api/files';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';

export type OfficeKind = 'word' | 'sheet' | 'slides';

/** Whole-file fetch into browser memory — cap it. Office docs this large are
 *  rare; past the cap the Download button is the honest answer. Enforced from
 *  Content-Length BEFORE the body is consumed (the raw endpoint always sets
 *  it), so an oversized file is refused without transferring it. */
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

interface OfficePreviewProps {
  path: string;
  host?: string;
  kind: OfficeKind;
  /** Bumped by the explorer's Refresh — re-fetch the same path. */
  reloadToken?: number;
}

interface SheetDoc {
  names: string[];
  /** Sanitized HTML table per sheet, rendered lazily on tab switch. */
  tableHtml: (index: number) => string;
}

/**
 * Sanitizer allowlist for the spreadsheet HTML.
 *
 * This is NOT belt-and-suspenders: SheetJS emits a rich-text cell's `.h` field
 * as RAW markup, so an XML-escaped `<script>` in a shared string reaches the
 * output as real markup, and a cell hyperlink's target is entity-escaped but
 * never scheme-checked. DOMPurify's defaults already stop script tags, event
 * handler attributes and `javascript:` URLs; the narrow allowlist additionally
 * drops what a table has no use for and an attacker does: style (app-wide CSS
 * overlay), form/input (phishing inside the trusted UI), img (external beacon).
 */
const SHEET_SANITIZE = {
  ALLOWED_TAGS: ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'span', 'b', 'i', 'u', 's', 'sub', 'sup', 'br', 'a'],
  // `style` stays: SheetJS carries a cell's underline/strike that way.
  ALLOWED_ATTR: ['colspan', 'rowspan', 'id', 'href', 'style', 'data-t', 'data-v', 'data-z'],
  FORBID_TAGS: ['style', 'form', 'input', 'img'],
};

/**
 * Neutralize link targets in library-rendered DOM.
 *
 * docx-preview copies a hyperlink's relationship Target into `href` verbatim
 * with no scheme check, so `javascript:…` in a crafted document runs in our
 * origin on click. Anything that isn't plain web navigation loses its href;
 * what survives opens in a new tab so a document can never navigate the SPA
 * away from itself.
 */
function hardenRenderedLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    // Whitespace and control characters are stripped BEFORE the scheme test:
    // browsers ignore them inside a scheme, so a tab-split "javascript:" is
    // still live code.
    const probe = href.replace(/[\s\u0000-\u001f]/g, '');
    // In-document anchors (#bookmark) are docx-preview's own navigation.
    const inDoc = probe.startsWith('#');
    if (!inDoc && !/^(https?:|mailto:)/i.test(probe)) {
      a.removeAttribute('href');
      continue;
    }
    if (!inDoc) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/** The raw endpoint answers most errors as short text/plain, but sandbox
 *  rejections (FileContentError) arrive as {"error": "..."} JSON — show the
 *  message, not the envelope. */
function errorBodyText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string') return parsed.error;
  } catch { /* plain text */ }
  return body || `Could not load the file (HTTP ${status}).`;
}

export function OfficePreview({ path, host, kind, reloadToken = 0 }: OfficePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [sheetDoc, setSheetDoc] = useState<SheetDoc | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  // Monotonic run id: a slow, superseded run must never touch the DOM/state —
  // docx-preview's renderAsync clears-then-fills the container itself, so a
  // late run from a previous file would REPLACE the current file's document.
  const runRef = useRef(0);
  // Distinguishes "first load" from an actual Refresh: the explorer's token is
  // a per-panel counter that never resets, so `token > 0` alone would make
  // every later file fetch no-store forever (same rule as FileContentView's
  // lastTokenRef).
  const lastTokenRef = useRef<number | null>(null);

  useEffect(() => {
    const run = ++runRef.current;
    const live = () => runRef.current === run;
    const aborter = new AbortController();
    const isReload = lastTokenRef.current !== null && lastTokenRef.current !== reloadToken;
    lastTokenRef.current = reloadToken;
    setPhase('loading');
    setError('');
    setSheetDoc(null);
    setActiveSheet(0);

    const fail = (msg: string) => {
      if (!live()) return;
      setPhase('error');
      setError(msg);
      log.warn('office-preview', 'preview failed', { path, host, kind, error: msg });
    };

    (async () => {
      let buf: ArrayBuffer;
      try {
        const res = await fetch(rawFileContentUrl(path, host), {
          signal: aborter.signal,
          ...(isReload ? { cache: 'no-store' as const } : {}),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 300);
          fail(errorBodyText(body, res.status));
          return;
        }
        // Refuse oversized files BEFORE consuming the body — for a remote host
        // the transfer is 1MB-chunk daemon RPCs over the tunnel, exactly the
        // cost this cap exists to avoid.
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_PREVIEW_BYTES) {
          void res.body?.cancel().catch(() => {});
          fail(`This file is ${formatSize(declared)} — too large to preview in the browser. Use Download instead.`);
          return;
        }
        buf = await res.arrayBuffer();
      } catch (err) {
        if (aborter.signal.aborted) return;
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!live()) return;
      if (buf.byteLength > MAX_PREVIEW_BYTES) {
        fail(`This file is ${formatSize(buf.byteLength)} — too large to preview in the browser. Use Download instead.`);
        return;
      }

      // Each run renders into its OWN mount node swapped into the container.
      // A superseded run that already started rendering keeps appending into
      // its detached node — never into the node the current run owns (both
      // renderers clear-then-fill their target, so sharing one node would let
      // a slow previous file overwrite the current one mid-render).
      const mount = (): HTMLDivElement | null => {
        const root = containerRef.current;
        if (!root) return null;
        const el = document.createElement('div');
        el.className = 'fv-office-mount';
        root.replaceChildren(el);
        return el;
      };

      try {
        if (kind === 'word') {
          const { renderAsync } = await import('docx-preview');
          if (!live()) return;
          const target = mount();
          if (!target) return;
          await renderAsync(buf, target, undefined, {
            // Renders the doc as paginated white "sheets" (the wrapper), which
            // keeps a Word document readable on the dark theme too.
            inWrapper: true,
            ignoreLastRenderedPageBreak: true,
            // SECURITY, do not flip back on. docx-preview renders a w:altChunk
            // part into an iframe with `srcdoc` = the part's raw bytes and NO
            // sandbox attribute, so a crafted .docx executes arbitrary JS in
            // Walnut's own origin — enough to read the pairing token out of
            // localStorage and drive every /api route as the user. Turning the
            // feature off is the whole mitigation; altChunk is an embedded
            // external-document part almost no real file uses.
            renderAltChunks: false,
          });
          if (!live()) return;
          hardenRenderedLinks(target);
        } else if (kind === 'sheet') {
          const XLSX = await import('xlsx');
          if (!live()) return;
          const wb = XLSX.read(buf, { type: 'array' });
          const names = wb.SheetNames;
          if (!names.length) { fail('This workbook has no sheets.'); return; }
          // Sanitized per sheet ON DEMAND (a 30-sheet workbook shouldn't pay
          // 30 conversions to show one), memoized so tab flips are instant.
          // tableHtml runs in the RENDER phase, outside this try/catch — it
          // must swallow its own errors (SheetJS silently drops a sheet it
          // couldn't parse, leaving wb.Sheets[name] undefined) or a corrupt
          // sheet would escalate to the app-level error boundary.
          const cache = new Map<number, string>();
          setSheetDoc({
            names,
            tableHtml: (i: number) => {
              const hit = cache.get(i);
              if (hit != null) return hit;
              let html: string;
              try {
                const ws = wb.Sheets[names[i]];
                if (!ws) throw new Error('sheet failed to parse');
                // header/footer '' strip SheetJS's default full <html><body>
                // wrapper so the output is a bare <table> DOMPurify can clean.
                html = DOMPurify.sanitize(
                  XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }),
                  SHEET_SANITIZE,
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                html = `<div class="file-viewer-error">Could not render sheet "${names[i]?.replace(/[<>&"]/g, '') ?? i}" (${msg.replace(/[<>&"]/g, '')}).</div>`;
              }
              cache.set(i, html);
              return html;
            },
          });
        } else {
          const { init } = await import('pptx-preview');
          if (!live() || !containerRef.current) return;
          // pptx-preview needs a concrete slide width; derive it from the pane
          // (minus its padding) so slides fit without horizontal scrolling.
          // A hidden/zero-width pane falls back to 960 instead of the clamp floor.
          const paneWidth = containerRef.current.clientWidth;
          const width = Math.max(320, Math.min(1280, paneWidth > 64 ? paneWidth - 32 : 960));
          const target = mount();
          if (!target) return;
          const previewer = init(target, { width, height: Math.round(width * 0.5625) });
          await previewer.preview(buf);
          if (!live()) {
            // Superseded mid-render: tear down (pptx-preview registers
            // module-global chart hooks; leaving instances behind leaks).
            (previewer as { destroy?: () => void }).destroy?.();
            return;
          }
        }
        if (live()) setPhase('ready');
      } catch (err) {
        if (!live()) return;
        // Typical: a corrupt/partial file, or a Word owner-lock stub (~$x.docx).
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Could not render this document (${msg}). It may be corrupt or an unsupported variant — use Download to open it locally.`);
      }
    })();

    return () => { aborter.abort(); };
  }, [path, host, kind, reloadToken]);

  return (
    <div className={`fv-office-preview fv-office-${kind}`}>
      {phase === 'loading' && <div className="file-viewer-loading">Loading preview…</div>}
      {phase === 'error' && <div className="file-viewer-error">{error}</div>}
      {kind === 'sheet' && sheetDoc && phase === 'ready' && (
        <>
          {sheetDoc.names.length > 1 && (
            <div className="fv-sheet-tabs" role="tablist">
              {sheetDoc.names.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={i === activeSheet}
                  className={`fv-sheet-tab${i === activeSheet ? ' active' : ''}`}
                  onClick={() => setActiveSheet(i)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <div
            className="fv-sheet-table"
            // Sanitized above with SHEET_SANITIZE. Load-bearing, not cosmetic:
            // SheetJS emits rich-text cells as raw markup (see that comment).
            dangerouslySetInnerHTML={{ __html: sheetDoc.tableHtml(activeSheet) }}
          />
        </>
      )}
      {/* word/slides render imperatively into this node; hidden while erroring. */}
      {kind !== 'sheet' && (
        <div ref={containerRef} className="fv-office-body" style={phase === 'error' ? { display: 'none' } : undefined} />
      )}
    </div>
  );
}
