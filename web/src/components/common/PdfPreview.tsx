import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { rawFileContentUrl } from '@/api/files';
import { log } from '@/utils/log';
import { PdfFind } from '@/components/common/PdfFind';
import '@/styles/pdf-preview.css';

interface PdfLink { id: string; rect: number[]; url?: string; dest?: string | unknown[] }
function safePdfUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch { /* Invalid links are not navigable. */ }
}


interface Props { path: string; host?: string; reloadToken?: number }
interface PageSize { width: number; height: number; userUnit: number }
const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
const LOAD_TIMEOUT_MS = 120_000;
type PdfModule = typeof import('pdfjs-dist');
type Gesture = Event & { scale: number; clientX: number; clientY: number };

function PdfPage({ pdf, lib, number, size, scale, root, onSize, onJump }: {
  pdf: PDFDocumentProxy; lib: PdfModule; number: number; size: PageSize; scale: number;
  root: React.RefObject<HTMLDivElement | null>; onSize: (number: number, size: PageSize) => void;
  /** A link took the reader to this page. */
  onJump: (number: number) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<PDFPageProxy>(undefined);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current, rootMargin: '600px',
    });
    observer.observe(pageRef.current!);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) { setLinks([]); return; }
    let disposed = false;
    void pdf.getPage(number).then((page) => page.getAnnotations()).then((annotations: PdfLink[]) => {
      if (!disposed) setLinks(annotations.filter((item) => item.rect && (safePdfUrl(item.url) || item.dest)));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [pdf, number, visible]);

  function goToDestination(dest: string | unknown[]) {
    void (async () => {
      const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!resolved) return;
      const ref = resolved[0];
      const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
      const target = root.current?.querySelector<HTMLElement>(`[data-page="${index + 1}"]`);
      if (!target) return;
      const targetPage = await pdf.getPage(index + 1);
      if (!target.isConnected) return;
      const viewport = targetPage.getViewport({ scale: 1 });
      const kind = (resolved[1] as { name?: string })?.name;
      const left = kind === 'XYZ' && typeof resolved[2] === 'number' ? resolved[2] : viewport.viewBox[0];
      const topIndex = kind === 'XYZ' ? 3 : 2;
      const top = ['XYZ', 'FitH', 'FitBH'].includes(kind ?? '') && typeof resolved[topIndex] === 'number'
        ? resolved[topIndex] : viewport.viewBox[3];
      const [x, y] = viewport.convertToViewportPoint(left, top);
      onSize(index + 1, { width: viewport.width, height: viewport.height, userUnit: targetPage.userUnit });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const scroll = root.current;
      if (!scroll || !target.isConnected) return;
      const box = target.getBoundingClientRect();
      const pane = scroll.getBoundingClientRect();
      scroll.scrollLeft += box.left - pane.left + x * box.width / viewport.width;
      scroll.scrollTop += box.top - pane.top + y * box.height / viewport.height;
      onJump(index + 1);
    })().catch(() => {});
  }

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let render: ReturnType<PDFPageProxy['render']> | undefined;
    let page: PDFPageProxy | undefined;
    let text: InstanceType<PdfModule['TextLayer']> | undefined;
    const canvas = canvasRef.current!;
    const container = textRef.current!;
    const timeout = setTimeout(() => {
      disposed = true;
      render?.cancel();
      text?.cancel();
      container.replaceChildren();
      canvas.width = canvas.height = 0;
      setError(true);
    }, LOAD_TIMEOUT_MS);
    setError(false);
    void (async () => {
      page = await pdf.getPage(number);
      if (disposed) return;
      proxyRef.current = page;
      const original = page.getViewport({ scale: 1 });
      onSize(number, { width: original.width, height: original.height, userUnit: page.userUnit });
      const viewport = page.getViewport({ scale });
      // Bound backing pixels, not the document's CSS size, so a large zoom cannot exhaust WebKit's canvas budget.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      text = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      await Promise.all([render.promise, text.render()]);
      clearTimeout(timeout);
    })().catch((err: unknown) => {
      clearTimeout(timeout);
      if (disposed) return;
      log.warn('pdf-preview', 'PDF page could not render', { number, error: String(err) });
      setError(true);
    });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      render?.cancel();
      text?.cancel();
      container.replaceChildren();
      canvas.width = canvas.height = 0;
    };
  }, [pdf, lib, number, scale, visible, onSize]);

  // Keep decoded operators during a zoom; evict them only when this page leaves
  // the viewport. PDF.js finishes a pending cleanup after its last render stops.
  useEffect(() => {
    if (!visible) proxyRef.current?.cleanup();
    return () => { proxyRef.current?.cleanup(); };
  }, [pdf, visible]);

  return (
    <div ref={pageRef} className="fv-pdf-page" data-page={number}
      style={{ width: size.width * scale, height: size.height * scale, '--total-scale-factor': scale * size.userUnit,
        '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties}
      aria-label={`Page ${number}`}>
      <canvas ref={canvasRef} width={0} height={0} aria-hidden="true" />
      <div ref={textRef} className="fv-pdf-text" />
      {links.map((link) => {
        const viewport = proxyRef.current?.getViewport({ scale });
        if (!viewport) return null;
        const [x1, y1] = viewport.convertToViewportPoint(link.rect[0], link.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(link.rect[2], link.rect[3]);
        const href = safePdfUrl(link.url);
        return <a key={link.id} className="fv-pdf-link" aria-label={href ?? 'Go to linked page'}
          href={href ?? '#'} target={href ? '_blank' : undefined} rel="noopener noreferrer"
          style={{ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }}
          onClick={href ? undefined : (event) => { event.preventDefault(); if (link.dest) goToDestination(link.dest); }} />;
      })}
      {error && <div role="alert" className="fv-pdf-error">This page could not render. Reopen the file to try again.</div>}
    </div>
  );
}

export function PdfPreview({ path, host, reloadToken }: Props) {
  const [document, setDocument] = useState<{ pdf: PDFDocumentProxy; lib: PdfModule; sizes: PageSize[] }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [passwordRequest, setPasswordRequest] = useState<{ submit: (password: string) => void; incorrect: boolean }>();
  const [password, setPassword] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const fitRef = useRef(1);
  const anchorRef = useRef<{ page: number; x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const gestureRef = useRef<{ scale: number } | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<PdfModule['getDocument']> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const destroy = () => { void task?.destroy().catch(() => {}); };
    const armDeadline = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        disposed = true;
        setPasswordRequest(undefined);
        setError('This PDF took too long to load. Retry or use Download to open it locally.');
        destroy();
      }, LOAD_TIMEOUT_MS);
    };
    armDeadline();
    setPasswordRequest(undefined);
    setPassword('');
    anchorRef.current = undefined;
    gestureRef.current = undefined;
    setDocument(undefined);
    setError('');
    setZoom(null);
    setPageNumber(1);
    void (async () => {
      const lib = await import('pdfjs-dist');
      const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      if (disposed) return;
      lib.GlobalWorkerOptions.workerSrc = workerSrc;
      task = lib.getDocument({
        url: rawFileContentUrl(path, host, reloadToken),
        cMapUrl: `/pdf-assets/${lib.version}/cmaps/`, cMapPacked: true,
        standardFontDataUrl: `/pdf-assets/${lib.version}/standard_fonts/`,
        wasmUrl: `/pdf-assets/${lib.version}/wasm/`,
      });
      task.onPassword = (submit: (password: string) => void, reason: number) => {
        if (disposed) return;
        // A user deciding which password to enter is not a stalled load.
        clearTimeout(timeout);
        setPassword('');
        setPasswordRequest({ incorrect: reason === lib.PasswordResponses.INCORRECT_PASSWORD, submit: (value) => {
          if (disposed) return;
          setPasswordRequest(undefined);
          setPassword('');
          armDeadline();
          submit(value);
        } });
      };
      const pdf = await task.promise;
      if (disposed) return;
      const page = await pdf.getPage(1);
      if (disposed) return;
      const viewport = page.getViewport({ scale: 1 });
      const initial = { width: viewport.width, height: viewport.height, userUnit: page.userUnit };
      // Other pages learn their real dimensions when they approach the viewport.
      const sizes = Array.from({ length: pdf.numPages }, () => initial);
      clearTimeout(timeout);
      setDocument({ pdf, lib, sizes });
    })().catch((err: unknown) => {
      if (disposed) return;
      clearTimeout(timeout);
      setPasswordRequest(undefined);
      destroy();
      log.warn('pdf-preview', 'PDF could not load', { path, error: String(err) });
      setError('This PDF could not load. Retry or use Download to open it locally.');
    });
    return () => { disposed = true; clearTimeout(timeout); destroy(); };
  }, [path, host, reloadToken, attempt]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(scrollRef.current!);
    return () => observer.disconnect();
  }, []);

  const onPageSize = useCallback((number: number, size: PageSize) => {
    setDocument((current) => {
      if (!current) return current;
      const previous = current.sizes[number - 1];
      if (previous.width === size.width && previous.height === size.height && previous.userUnit === size.userUnit) return current;
      const sizes = current.sizes.slice();
      sizes[number - 1] = size;
      return { ...current, sizes };
    });
  }, []);
  const widest = document?.sizes.reduce((max, size) => Math.max(max, size.width), 0) ?? 0;
  const fit = widest ? Math.max(MIN_SCALE, (width - 32) / widest) : 1;
  // A tiny page may fit above the usual zoom ceiling; leaving Fit must still
  // take one ordinary step, rather than snapping straight back to that ceiling.
  const maxScale = Math.max(MAX_SCALE, fit);
  const scale = zoom ?? fit;
  scaleRef.current = scale;
  fitRef.current = fit;

  function changeZoom(next: number | null, clientX?: number, clientY?: number) {
    const root = scrollRef.current!;
    const rect = root.getBoundingClientRect();
    const x = clientX ?? rect.left + root.clientWidth / 2;
    const y = clientY ?? rect.top + root.clientHeight / 2;
    const pages = Array.from(pagesRef.current?.children ?? []) as HTMLElement[];
    const page = pages.find((el) => el.getBoundingClientRect().bottom >= y) ?? pages.at(-1);
    if (page) {
      const box = page.getBoundingClientRect();
      anchorRef.current = { page: Number(page.dataset.page), x: (x - box.left) / box.width,
        y: (y - box.top) / box.height, clientX: x, clientY: y };
    }
    const value = next === null ? null : Math.max(MIN_SCALE, Math.min(maxScale, next));
    scaleRef.current = value ?? fitRef.current;
    setZoom(value);
  }
  const changeZoomRef = useRef(changeZoom);
  changeZoomRef.current = changeZoom;

  useLayoutEffect(() => {
    const root = scrollRef.current!;
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = undefined;
    const page = pagesRef.current?.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
    if (!page) return;
    const box = page.getBoundingClientRect();
    root.scrollLeft += box.left + anchor.x * box.width - anchor.clientX;
    root.scrollTop += box.top + anchor.y * box.height - anchor.clientY;
  }, [scale]);

  useEffect(() => {
    const root = scrollRef.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !pagesRef.current?.children.length) return;
      event.preventDefault();
      if (gestureRef.current) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1);
      changeZoomRef.current(scaleRef.current * Math.exp(-delta * 0.01), event.clientX, event.clientY);
    };
    const start = (event: Event) => {
      if (!pagesRef.current?.children.length) return;
      event.preventDefault();
      gestureRef.current = { scale: scaleRef.current };
    };
    const change = (event: Event) => {
      const gesture = event as Gesture;
      if (!gestureRef.current || !Number.isFinite(gesture.scale)) return;
      event.preventDefault();
      changeZoomRef.current(gestureRef.current.scale * gesture.scale, gesture.clientX, gesture.clientY);
    };
    const end = (event: Event) => {
      if (!gestureRef.current) return;
      event.preventDefault();
      gestureRef.current = undefined;
    };
    root.addEventListener('wheel', wheel, { passive: false });
    root.addEventListener('gesturestart', start, { passive: false });
    root.addEventListener('gesturechange', change, { passive: false });
    root.addEventListener('gestureend', end, { passive: false });
    return () => {
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('gesturestart', start);
      root.removeEventListener('gesturechange', change);
      root.removeEventListener('gestureend', end);
    };
  }, []);

  // The page a link jumped to is the page count's until the reader scrolls on:
  // a destination low on its page leaves the next page across the reading line.
  const jumpRef = useRef<{ page: number; top: number } | undefined>(undefined);
  const onJump = useCallback((page: number) => {
    const root = scrollRef.current;
    if (!root) return;
    jumpRef.current = { page, top: root.scrollTop };
    setPageNumber(page);
  }, []);

  function onScroll() {
    const root = scrollRef.current!;
    const jump = jumpRef.current;
    if (jump && Math.abs(root.scrollTop - jump.top) < 2) { setPageNumber(jump.page); return; }
    jumpRef.current = undefined;
    const y = root.getBoundingClientRect().top + root.clientHeight / 3;
    const page = Array.from(pagesRef.current?.children ?? []).find((el) => el.getBoundingClientRect().bottom >= y) as HTMLElement | undefined;
    if (page) setPageNumber(Number(page.dataset.page));
  }

  return (
    <div className="fv-pdf-preview" data-scale={scale}>
      <div className="fv-pdf-toolbar" aria-label="PDF controls">
        <button type="button" className="fv-html-tab" aria-label="Zoom out" disabled={!document || scale <= MIN_SCALE}
          onClick={() => changeZoom(scale / 1.2)}>−</button>
        <output aria-label="PDF zoom">{Math.round(scale * 100)}%</output>
        <button type="button" className="fv-html-tab" aria-label="Zoom in" disabled={!document || scale >= maxScale}
          onClick={() => changeZoom(scale * 1.2)}>+</button>
        <button type="button" className={`fv-html-tab${zoom === null ? ' active' : ''}`} disabled={!document}
          onClick={() => changeZoom(null)}>Fit width</button>
        <PdfFind pdf={document?.pdf} root={scrollRef} />
        <span className="fv-pdf-page-count">{document ? `${pageNumber} / ${document.pdf.numPages}` : 'PDF'}</span>
      </div>
      <div ref={scrollRef} className="fv-pdf-scroll" onScroll={onScroll} tabIndex={0} aria-label="PDF document">
        {error ? <div role="alert" className="fv-pdf-error">{error} <button type="button" className="fv-html-tab"
          onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
          : passwordRequest ? <form className="fv-pdf-password" onSubmit={(event) => {
            event.preventDefault(); passwordRequest.submit(password);
          }}>
            <label>This PDF needs a password.
              <input data-no-draft="secret" type="password" aria-label="PDF password" value={password} autoComplete="off"
                onChange={(event) => setPassword(event.target.value)} />
            </label>
            {passwordRequest.incorrect && <div role="alert">Incorrect password. Try again.</div>}
            <button type="submit" className="fv-html-tab">Unlock PDF</button>
          </form>
          : !document ? <div className="fv-pdf-status" role="status">Loading PDF…</div> : null}
        <div ref={pagesRef} className="fv-pdf-pages">
          {document?.sizes.map((size, index) => <PdfPage key={index} pdf={document.pdf} lib={document.lib}
            number={index + 1} size={size} scale={scale} root={scrollRef} onSize={onPageSize} onJump={onJump} />)}
        </div>
      </div>
    </div>
  );
}
