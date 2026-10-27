import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { log } from '@/utils/log';

export function PdfFind({ pdf, root }: { pdf?: PDFDocumentProxy; root: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef(new Map<number, string>());
  const generation = useRef(0);

  useEffect(() => { textRef.current.clear(); generation.current++; setMatches([]); setQuery(''); }, [pdf]);
  useEffect(() => {
    const element = root.current!;
    const owner = element.closest('.file-content-view')!;
    const key = (event: Event) => {
      const e = event as KeyboardEvent;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      e.preventDefault(); e.stopPropagation();
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    owner.addEventListener('keydown', key, true);
    return () => owner.removeEventListener('keydown', key, true);
  }, [root]);

  useEffect(() => {
    const current = ++generation.current;
    setMatches([]); setIndex(0); setError(false);
    if (!pdf || !open || !query.trim()) { setSearching(false); return; }
    setSearching(true);
    let activeReader: ReadableStreamDefaultReader<TextContent> | undefined;
    const timer = setTimeout(() => {
      void (async () => {
        const found: number[] = [];
        const needle = query.toLocaleLowerCase();
        for (let number = 1; number <= pdf.numPages; number++) {
          if (generation.current !== current) return;
          let text = textRef.current.get(number);
          if (text === undefined) {
            const page = await pdf.getPage(number);
            try {
              // WebKit has stream readers but not ReadableStream's async iterator.
              const reader = page.streamTextContent().getReader() as ReadableStreamDefaultReader<TextContent>;
              activeReader = reader;
              const parts: string[] = [];
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  parts.push(...(value as TextContent).items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''));
                }
              } finally { reader.releaseLock(); activeReader = undefined; }
              text = parts.join('');
              if (generation.current !== current) return;
              textRef.current.set(number, text);
            } finally {
              const canvas = root.current?.querySelector<HTMLCanvasElement>(`[data-page="${number}"] canvas`);
              if (!canvas?.width) page.cleanup();
            }
          }
          if (generation.current !== current) return;
          if (text.toLocaleLowerCase().includes(needle)) found.push(number);
        }
        if (generation.current !== current) return;
        setMatches(found); setSearching(false);
        if (found.length) root.current?.querySelector(`[data-page="${found[0]}"]`)?.scrollIntoView({ block: 'start', inline: 'nearest' });
      })().catch((err: unknown) => { if (generation.current === current) {
        log.warn('pdf-preview', 'PDF search failed', { error: String(err) });
        setError(true); setSearching(false);
      } });
    }, 250);
    return () => { clearTimeout(timer); generation.current++; void activeReader?.cancel().catch(() => {}); };
  }, [pdf, open, query, root]);

  function next(delta: number) {
    if (!matches.length) return;
    const value = (index + delta + matches.length) % matches.length;
    setIndex(value);
    root.current?.querySelector(`[data-page="${matches[value]}"]`)?.scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  return <>
    <button type="button" className={`fv-html-tab${open ? ' active' : ''}`} disabled={!pdf}
      title="Find in PDF (⌘F)" onClick={() => { setOpen((value) => !value); requestAnimationFrame(() => inputRef.current?.focus()); }}>Find</button>
    {open && <div className="fv-pdf-find">
      <input data-no-draft="search" ref={inputRef} type="search" aria-label="Find in PDF" placeholder="Find in PDF" value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); next(event.shiftKey ? -1 : 1); }
          if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
        }} />
      <span role="status">{searching ? 'Searching…' : error ? 'Search failed. Try again.' : matches.length ? `${index + 1} / ${matches.length} pages` : query ? 'No matches' : ''}</span>
      <button type="button" className="fv-html-tab" aria-label="Previous matching page" disabled={!matches.length} onClick={() => next(-1)}>↑</button>
      <button type="button" className="fv-html-tab" aria-label="Next matching page" disabled={!matches.length} onClick={() => next(1)}>↓</button>
      <button type="button" className="fv-html-tab" aria-label="Close PDF search" onClick={() => setOpen(false)}>×</button>
    </div>}
  </>;
}
