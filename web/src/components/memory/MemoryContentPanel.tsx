import { useState, useCallback, useEffect, useRef } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { saveGlobalMemory, saveMemory } from '@/api/memory';

interface MemoryContentPanelProps {
  content: string | null;
  path: string | null;
  updatedAt: string | null;
  onSaved?: (updatedAt: string) => void;
}

function formatPath(p: string): string {
  if (p === 'MEMORY.md') return 'Global / MEMORY.md';
  return p.split('/').join(' / ');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export function MemoryContentPanel({ content, path, updatedAt, onSaved }: MemoryContentPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset edit state when path changes
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [path]);

  const handleEdit = useCallback(() => {
    setDraft(content ?? '');
    setEditing(true);
    setError(null);
    // Focus textarea after render
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [content]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setDraft('');
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!path) return;
    setSaving(true);
    setError(null);
    try {
      const result = path === 'MEMORY.md'
        ? await saveGlobalMemory(draft)
        : await saveMemory(path, draft);
      setEditing(false);
      onSaved?.(result.updatedAt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [path, draft, onSaved]);

  // Ctrl+S / Cmd+S to save while editing
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  }, [handleSave, handleCancel]);

  if (!content || !path) {
    return (
      <div className="memory-content-empty">
        <div className="empty-state">
          <p>Select a memory file to view</p>
        </div>
      </div>
    );
  }

  const html = renderMarkdownWithRefs(content);

  return (
    <div className="memory-content-panel">
      <div className="memory-content-header">
        <div className="memory-content-header-left">
          <span className="memory-content-path">{formatPath(path)}</span>
          {updatedAt && <span className="memory-content-time">{formatTime(updatedAt)}</span>}
        </div>
        <div className="memory-content-header-actions">
          {editing ? (
            <>
              {error && <span className="memory-edit-error">{error}</span>}
              <button
                className="memory-edit-btn memory-cancel-btn"
                onClick={handleCancel}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="memory-edit-btn memory-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <button className="memory-edit-btn memory-edit-toggle" onClick={handleEdit} title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="memory-edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      ) : (
        <div
          className="memory-content-body markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
