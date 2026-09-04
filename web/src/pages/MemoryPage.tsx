import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchMemoryBrowse, fetchMemory, fetchGlobalMemory, fetchUserMemory } from '@/api/memory';
import { useEvent } from '@/hooks/useWebSocket';
import { memoryDocKey, wasSavedHere, isDocSaveInFlight } from '@/stores/file-save-signal';
import { MemoryTreePanel } from '@/components/memory/MemoryTreePanel';
import { MemoryContentPanel } from '@/components/memory/MemoryContentPanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useDragGesture } from '@/hooks/useDragGesture';
import { visibleInterval } from '@/utils/page-visibility';
import type { MemoryBrowseTree } from '@/api/memory';

const LS_WIDTH_KEY = 'open-walnut-memory-list-width';
const WIDTH_MIN = 260;
const WIDTH_MAX = 600;
const WIDTH_DEFAULT = 320;

function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
}

/**
 * ONE read path for a memory document, whichever section it lives in. It also
 * carries the `contentHash` the editor sends back as its optimistic-lock token —
 * these files are editable from the Files panel too, so a write must be able to
 * fail rather than clobber a change this page never showed.
 */
function readMemoryDoc(
  path: string,
): Promise<{ content: string; updatedAt: string; contentHash?: string }> {
  if (path === 'MEMORY.md') {
    return fetchGlobalMemory().then((m) => ({ content: m.content, updatedAt: m.updatedAt, contentHash: m.contentHash }));
  }
  if (path === 'USER.md') {
    return fetchUserMemory().then((m) => ({ content: m.content, updatedAt: m.updatedAt, contentHash: m.contentHash }));
  }
  return fetchMemory(path).then((m) => ({ content: m.content, updatedAt: m.updated_at, contentHash: m.contentHash }));
}

function readWidth(): number {
  try {
    const stored = localStorage.getItem(LS_WIDTH_KEY);
    if (stored) return clampWidth(Number(stored));
  } catch { /* ignore */ }
  return WIDTH_DEFAULT;
}

export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tree, setTree] = useState<MemoryBrowseTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(() => searchParams.get('path'));
  const [content, setContent] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [contentHash, setContentHash] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  // Read from a WS callback that must not re-subscribe on every selection.
  const selectedPathRef = useRef<string | null>(selectedPath);
  selectedPathRef.current = selectedPath;

  // Resizable left pane. Shared drag primitive: pointer capture (never sticks)
  // + one persist on release instead of a synchronous localStorage write per
  // mousemove frame.
  const [listWidth, setListWidth] = useState(readWidth);
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const startWidthRef = useRef(listWidth);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const { onPointerDown: resizePointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => {
      startWidthRef.current = listWidthRef.current;
      listPaneRef.current?.classList.add('resizing');
    },
    onMove: ({ dx }) => setListWidth(clampWidth(startWidthRef.current + dx)),
    onEnd: () => {
      listPaneRef.current?.classList.remove('resizing');
      try { localStorage.setItem(LS_WIDTH_KEY, String(listWidthRef.current)); } catch { /* ignore */ }
    },
  });

  // Load tree on mount + poll every 15s for live refresh
  useEffect(() => {
    let cancelled = false;
    const loadTree = () => {
      fetchMemoryBrowse()
        .then((t) => { if (!cancelled) setTree(t); })
        .catch((e: Error) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    loadTree();
    // Live refresh: poll every 15s so new daily logs, topics, compaction snapshots
    // appear without manual refresh. Backend `/api/memory/browse` is cheap (metadata only).
    // visibleInterval: hidden tabs skip the poll and catch up once on return.
    const cancel = visibleInterval(loadTree, 15_000);
    return () => { cancelled = true; cancel(); };
  }, []);

  // Load content when selection changes
  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setSearchParams({ path }, { replace: true });
      setContentLoading(true);
      setContent(null);

      readMemoryDoc(path)
        .then(({ content: c, updatedAt: u, contentHash: h }) => {
          setContent(c);
          setUpdatedAt(u);
          setContentHash(h ?? null);
        })
        .catch(() => {
          setContent('*Failed to load file*');
          setUpdatedAt(null);
          setContentHash(null);
        })
        .finally(() => setContentLoading(false));
    },
    [setSearchParams],
  );

  /** Re-read the open document from disk (post-save, conflict, external write). */
  const reloadSelected = useCallback((path: string) => {
    readMemoryDoc(path)
      .then(({ content: c, updatedAt: u, contentHash: h }) => {
        if (selectedPathRef.current !== path) return;
        setContent(c);
        setUpdatedAt(u);
        setContentHash(h ?? null);
      })
      .catch(() => { /* keep current content */ });
  }, []);

  // Refresh content after a save — re-fetch the file to get updated content
  const handleSaved = useCallback(
    (newUpdatedAt: string) => {
      setUpdatedAt(newUpdatedAt);
      if (selectedPath) reloadSelected(selectedPath);
    },
    [selectedPath, reloadSelected],
  );

  /**
   * The open document changed on disk. Two ways this reaches us, and neither
   * used to: the 15s poll only ever refreshed the metadata TREE, so a memory file
   * saved through the Files panel left this page showing pre-edit text until the
   * user re-selected it — and its next autosave then wrote that stale text back.
   *  - `memory:updated`: emitted by every writer of a file under the memory dir
   *    (this page's own PUT, and PUT /api/file-content for such a path).
   *  - `onConflict`: our own write was refused because the bytes had moved.
   *
   * Our OWN write must never come back as a re-read, and a hash comparison alone
   * cannot see that: the server emits the event before it answers the PUT, so at
   * that instant `contentHash` here is still the pre-save token. The shared
   * doc-save bookkeeping answers it either way round — mid-air, or landed.
   */
  useEvent('memory:updated', (data: unknown) => {
    const d = data as { path?: unknown; contentHash?: unknown };
    const open = selectedPathRef.current;
    if (!open || typeof d?.path !== 'string' || d.path !== open) return;
    if (typeof d.contentHash === 'string' && d.contentHash === contentHash) return;
    const key = memoryDocKey(open);
    if (isDocSaveInFlight(key)) return; // our own PUT, echo ahead of its response
    if (typeof d.contentHash === 'string' && wasSavedHere(key, d.contentHash)) return;
    reloadSelected(open);
  });

  const handleConflict = useCallback(() => {
    if (selectedPath) reloadSelected(selectedPath);
  }, [selectedPath, reloadSelected]);

  // Auto-select from URL on initial load
  useEffect(() => {
    const urlPath = searchParams.get('path');
    if (urlPath && tree) {
      handleSelect(urlPath);
    }
  // Only run once when tree loads
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div className="memory-split-view">
      <div
        className="memory-list-pane"
        ref={listPaneRef}
        style={{ width: listWidth, flex: `0 0 ${listWidth}px` }}
      >
        <MemoryTreePanel
          tree={tree}
          selectedPath={selectedPath}
          onSelect={handleSelect}
        />
      </div>
      <div className="memory-resize-handle" onPointerDown={resizePointerDown} />
      <div className="memory-detail-pane">
        {contentLoading ? (
          <LoadingSpinner />
        ) : (
          <MemoryContentPanel
            content={content}
            path={selectedPath}
            updatedAt={updatedAt}
            contentHash={contentHash}
            onSaved={handleSaved}
            onConflict={handleConflict}
          />
        )}
      </div>
    </div>
  );
}
