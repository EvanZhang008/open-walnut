/**
 * "Browse libraries" inside Walnut: the public catalog of drawing libraries, read through Walnut's
 * server (drawing-library.ts), searchable, with each library's preview and an Add button. Add
 * puts its items in the tab's library, which saves them on the server for every drawing and
 * device. It replaces the editor's own Browse link, which left the app (ExcalidrawCanvas.tsx).
 *
 * A dialog portalled to the body (web/src/AGENTS.md, menus and overlays): it sits over the
 * composer's Draw dialog too, takes its own Escape before the dialog under it sees the key, and
 * closes on a press that begins and ends outside it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { SearchField } from '@/components/common/SearchField';
import { addCatalogLibrary, drawingLibraryApi, searchCatalog, tabLibrary, type CatalogItem, type DrawingLibraryApi, type LibraryStore } from './drawing-library';
import { OutsidePress } from './drawing-overlay';
import { drawingErrorMessage } from './drawing-api';
import { ICON_CLOSE } from '../common/Icons';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';

export interface LibraryBrowserProps {
  onClose(): void;
  /** Items were added: the editor shows its Library panel. */
  onAdded?(count: number): void;
  api?: DrawingLibraryApi;
  store?: LibraryStore;
}

type RowState = { state: 'adding' } | { state: 'added'; count: number } | { state: 'error'; message: string };

export function LibraryBrowser({ onClose, onAdded, api = drawingLibraryApi, store = tabLibrary }: LibraryBrowserProps) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const search = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const press = useRef(new OutsidePress()).current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useModalOverlay(onClose);
  // Escape is this dialog's wherever the focus is: it is also the top overlay layer, whose window
  // listener takes the key first. Adding a library opens the editor's Library panel, which takes the
  // focus; without this, the same Escape also reached the editor's own document listener (a listener
  // beside the modal's, which stopPropagation does not stop) and closed the Library panel behind the
  // dialog. A press outside is the dialog's own (OutsidePress below), and Tab stays in it.
  useOverlayLayer({ open: true, refs: [panel], closeOnOutside: false, onClose: (reason) => { if (reason === 'escape') onClose(); } });

  const load = () => {
    setError(null);
    setItems(null);
    api.catalog().then((answer) => { if (mounted.current) { setItems(answer.items); setStale(answer.stale); } }).catch((err) => {
      if (mounted.current) setError(`The library catalog could not be reached: ${drawingErrorMessage(err)}`);
    });
  };
  useEffect(() => { load(); search.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (items ? searchCatalog(items, query) : []), [items, query]);

  const add = async (item: CatalogItem) => {
    if (rows[item.source]?.state === 'adding') return;
    setRows((r) => ({ ...r, [item.source]: { state: 'adding' } }));
    try {
      const count = await addCatalogLibrary(item.source, store, api);
      if (!mounted.current) return;
      setRows((r) => ({ ...r, [item.source]: { state: 'added', count } }));
      onAdded?.(count);
    } catch (err) {
      if (mounted.current) setRows((r) => ({ ...r, [item.source]: { state: 'error', message: drawingErrorMessage(err) } }));
    }
  };

  const outside = (target: EventTarget | null) => !!panel.current && target instanceof Node && !panel.current.contains(target);

  return createPortal(
    <div className="drawing-library-overlay wn-scrim"
      onPointerDown={(e) => { e.stopPropagation(); press.down(outside(e.target)); }}
      onPointerUp={(e) => { if (press.up(outside(e.target))) onClose(); }}
      onPointerCancel={() => press.cancel()}
      // Keys stay in the dialog (Escape never gets here: the overlay layer takes it first).
      onKeyDown={(e) => { e.stopPropagation(); }}>
      <div ref={panel} className="drawing-library-dialog wn-dialog" role="dialog" aria-modal="true" aria-label="Browse libraries">
        <header className="drawing-library-head">
          <h2>Libraries</h2>
          <SearchField small ref={search} fieldClassName="drawing-library-search-field" type="search" data-no-draft="search" className="drawing-library-search" placeholder="Search"
            aria-label="Search libraries" value={query} setText={setQuery} onClear={() => setQuery('')} />
          <button type="button" className="btn btn-icon wn-dialog-close" aria-label="Close libraries" title="Close" onClick={onClose}>
            {ICON_CLOSE}
          </button>
        </header>
        <div className="drawing-library-body">
          {error && (
            <UnavailableState size="section" title="Couldn't load the libraries" detail={error} onRetry={load} retryLabel="Try again" />
          )}
          {!error && items === null && <LoadingState size="section" title="Loading libraries…" />}
          {stale && <p className="drawing-library-note" role="status">The catalog site is not answering, so this is the last copy Walnut saw</p>}
          {items && shown.length === 0 && (query.trim()
            ? <EmptyState size="section" title={`No library matches “${query.trim()}”`} action={{ label: 'Clear search', onClick: () => setQuery('') }} />
            : <EmptyState size="section" title="No libraries in the catalog" />)}
          {items && shown.length > 0 && (
            <ul className="drawing-library-list">
              {shown.map((item) => {
                const row = rows[item.source];
                return (
                  <li key={item.id} className="drawing-library-item" data-source={item.source}>
                    <div className="drawing-library-preview">
                      {item.preview && <img src={item.preview} alt="" loading="lazy" decoding="async" />}
                    </div>
                    <div className="drawing-library-text">
                      <span className="drawing-library-name wn-title">{item.name}</span>
                      <span className="drawing-library-meta">
                        {[item.authors.join(', '), item.itemNames.length ? `${item.itemNames.length} items` : ''].filter(Boolean).join(' · ')}
                      </span>
                      {item.description && <span className="drawing-library-desc">{item.description}</span>}
                      {row?.state === 'error' && <span className="drawing-library-error" role="alert">{row.message}</span>}
                    </div>
                    <button type="button" className="drawing-quiet-button" aria-label={`Add ${item.name}`}
                      disabled={row?.state === 'adding'} onClick={() => void add(item)}>
                      {row?.state === 'adding' ? 'Adding…' : row?.state === 'added' ? 'Added' : 'Add'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="drawing-library-foot">
          {store.error ? <span role="alert">{store.error}</span> : <span>Added items are kept in your library on every device</span>}
          <a href="https://libraries.excalidraw.com" target="_blank" rel="noreferrer noopener">Catalog by Excalidraw</a>
        </footer>
      </div>
    </div>, document.body,
  );
}

export default LibraryBrowser;
