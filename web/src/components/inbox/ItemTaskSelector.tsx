import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { lockScroll, unlockScroll } from '@/hooks/useModalOverlay';
import { searchItemTasks, type InboxTaskCandidate, type InboxTaskPage } from '@/api/human-inbox-items';
import { ItemTaskPreview } from './ItemTaskPreview';
import { PHASE_TEXT } from './item-receipt-model';
import { useItemDraft } from './item-drafts';

export function ItemTaskSelector({ open, letterId, itemId, onClose, onChoose, onNavigate }: {
  open: boolean; letterId: string; itemId: string; onClose: () => void; onChoose: (task: InboxTaskCandidate) => void;
  onNavigate: (to: string) => void;
}) {
  const searchId = useId();
  const draftKey = JSON.stringify([letterId, itemId]);
  const [query, setQuery] = useItemDraft(draftKey, 'query', '');
  const [page, setPage] = useState<InboxTaskPage>();
  const [selected, setSelected] = useItemDraft<InboxTaskCandidate | undefined>(draftKey, 'selected', undefined);
  const [preview, setPreview] = useItemDraft<InboxTaskCandidate | undefined>(draftKey, 'preview', undefined);
  const [scrollTop, setScrollTop] = useItemDraft(draftKey, 'scroll', 0);
  const previewOrigin = useRef<string | undefined>(preview?.id);
  const [moreLoading, setMoreLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroll = useRef(scrollTop);
  const generation = useRef(0);
  const fetching = useRef(false);
  useOverlayLayer({ open, refs: [root], onClose: () => preview ? setPreview(undefined) : onClose() });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    lockScroll(); input.current?.focus({ preventScroll: true });
    if (list.current) list.current.scrollTop = scroll.current;
    return () => { unlockScroll(); previous?.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    const gen = ++generation.current;
    const abort = new AbortController();
    setLoading(true); setError(false); setPage(undefined);
    const timer = setTimeout(() => {
      searchItemTasks(letterId, itemId, query, 0, abort.signal).then(next => {
        if (gen === generation.current && !abort.signal.aborted) setPage(next);
      }).catch(() => { if (!abort.signal.aborted && gen === generation.current) setError(true); })
        .finally(() => { if (gen === generation.current) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [letterId, itemId, query, retry]);
  useEffect(() => {
    if (!open || preview || !list.current) return;
    list.current.scrollTop = scroll.current;
    if (previewOrigin.current) {
      const button = Array.from(list.current.querySelectorAll<HTMLButtonElement>('[data-preview-task]'))
        .find(button => button.dataset.previewTask === previewOrigin.current);
      if (button) { button.focus({ preventScroll: true }); previewOrigin.current = undefined; }
    }
  }, [open, preview, page]);
  useEffect(() => { if (preview) root.current?.querySelector<HTMLButtonElement>('.hii-task-preview button')?.focus({ preventScroll: true }); }, [preview]);
  async function more() {
    if (!page || fetching.current) return;
    const gen = generation.current; fetching.current = true; setMoreLoading(true);
    try {
      const next = await searchItemTasks(letterId, itemId, query, page.tasks.length);
      if (gen === generation.current) setPage(old => old && ({ ...next, tasks: [...old.tasks, ...next.tasks] }));
    } catch { if (gen === generation.current) setError(true); }
    finally { fetching.current = false; setMoreLoading(false); }
  }
  if (!open) return null;
  return createPortal(<div className="hii-selector-overlay" onPointerDown={e => e.stopPropagation()}>
    <div className="hii-selector" role="dialog" aria-modal="true" aria-label="Choose a task" ref={root}>
      <header><h2>Choose a task</h2><button type="button" className="hib-row-btn" onClick={onClose} aria-label="Close task selector">×</button></header>
      <label htmlFor={searchId} className={preview ? 'hii-hidden' : ''}>Search tasks
        <input id={searchId} aria-label="Search tasks" ref={input} value={query} placeholder="Search by title, project, or full task ID" onChange={e => setQuery(e.target.value)} />
      </label>
      {preview ? <div className="hii-selector-list"><ItemTaskPreview letterId={letterId} itemId={itemId} task={preview}
        onBack={() => setPreview(undefined)} onNavigate={onNavigate} /></div>
        : <div className="hii-selector-list" ref={list} onScroll={() => { if (page && !loading) { scroll.current = list.current?.scrollTop ?? 0; setScrollTop(scroll.current); } }}>
          {loading && <p>Loading tasks…</p>}
          {error && <p>Could not load tasks <button type="button" className="hib-row-btn" onClick={() => setRetry(n => n + 1)}>Try again</button></p>}
          {!loading && !error && page?.tasks.length === 0 && <p>No matching tasks<br />Try another search</p>}
          {page?.tasks.map((task, index) => <div className="hii-candidate" key={task.id}>
            <button type="button" className="hii-candidate-pick" aria-pressed={selected?.id === task.id}
              onClick={() => setSelected(task)} onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault(); const next = index + (e.key === 'ArrowDown' ? 1 : -1);
                  list.current?.querySelectorAll<HTMLButtonElement>('.hii-candidate-pick')[next]?.focus();
                }
              }}><span>{task.title}</span><small>{task.project || 'Inbox'} · {PHASE_TEXT[task.phase] ?? task.phase}</small></button>
            <button type="button" className="hib-row-btn" data-preview-task={task.id}
              onClick={() => { previewOrigin.current = task.id; setPreview(task); }} aria-label={`Preview task ${task.title}`}>Preview task</button>
            <details><summary>Task ID</summary><code>{task.id}</code></details>
          </div>)}
          {page && page.tasks.length > 0 && <p>Showing {page.tasks.length} of {page.total}.{page.hasMore ? ' Refine your search.' : ''}</p>}
          {page?.hasMore && <button type="button" className="hib-row-btn" disabled={moreLoading} onClick={() => void more()}>{moreLoading ? 'Loading more…' : 'Load more'}</button>}
        </div>}
      <footer><div>Selected task: {selected?.title ?? 'None'}
        {selected?.phase === 'COMPLETE' && <p>This task is completed. Open it to review or choose an open task.</p>}</div>
        <button type="button" className="hib-row-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="hib-send-btn" disabled={!selected || selected.phase === 'COMPLETE' || loading || error}
          onClick={() => { if (selected) onChoose(selected); }}>Continue</button>
      </footer>
    </div>
  </div>, document.body);
}
