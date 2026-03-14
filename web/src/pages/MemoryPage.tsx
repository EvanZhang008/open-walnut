import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchMemoryBrowse, fetchMemory, fetchGlobalMemory } from '@/api/memory';
import { MemoryTreePanel } from '@/components/memory/MemoryTreePanel';
import { MemoryContentPanel } from '@/components/memory/MemoryContentPanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { MemoryBrowseTree } from '@/api/memory';

const LS_WIDTH_KEY = 'open-walnut-memory-list-width';
const WIDTH_MIN = 260;
const WIDTH_MAX = 600;
const WIDTH_DEFAULT = 320;

function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
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
  const [contentLoading, setContentLoading] = useState(false);

  // Resizable left pane
  const [listWidth, setListWidth] = useState(readWidth);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = listWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    listPaneRef.current?.classList.add('resizing');

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = clampWidth(startWidthRef.current + (ev.clientX - startXRef.current));
      setListWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      listPaneRef.current?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [listWidth]);

  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH_KEY, String(listWidth)); } catch { /* ignore */ }
  }, [listWidth]);

  // Load tree on mount
  useEffect(() => {
    fetchMemoryBrowse()
      .then(setTree)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load content when selection changes
  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setSearchParams({ path }, { replace: true });
      setContentLoading(true);
      setContent(null);

      const fetchContent =
        path === 'MEMORY.md'
          ? fetchGlobalMemory().then((m) => ({ content: m.content, updatedAt: m.updatedAt }))
          : fetchMemory(path).then((m) => ({ content: m.content, updatedAt: m.updated_at }));

      fetchContent
        .then(({ content: c, updatedAt: u }) => {
          setContent(c);
          setUpdatedAt(u);
        })
        .catch(() => {
          setContent('*Failed to load file*');
          setUpdatedAt(null);
        })
        .finally(() => setContentLoading(false));
    },
    [setSearchParams],
  );

  // Refresh content after a save — re-fetch the file to get updated content
  const handleSaved = useCallback(
    (newUpdatedAt: string) => {
      setUpdatedAt(newUpdatedAt);
      // Re-fetch to update the rendered content with what was saved
      if (selectedPath) {
        const fetchContent =
          selectedPath === 'MEMORY.md'
            ? fetchGlobalMemory().then((m) => ({ content: m.content, updatedAt: m.updatedAt }))
            : fetchMemory(selectedPath).then((m) => ({ content: m.content, updatedAt: m.updated_at }));
        fetchContent
          .then(({ content: c, updatedAt: u }) => {
            setContent(c);
            setUpdatedAt(u);
          })
          .catch(() => { /* keep current content */ });
      }
    },
    [selectedPath],
  );

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
      <div className="memory-resize-handle" onMouseDown={handleResizeStart} />
      <div className="memory-detail-pane">
        {contentLoading ? (
          <LoadingSpinner />
        ) : (
          <MemoryContentPanel
            content={content}
            path={selectedPath}
            updatedAt={updatedAt}
            onSaved={handleSaved}
          />
        )}
      </div>
    </div>
  );
}
