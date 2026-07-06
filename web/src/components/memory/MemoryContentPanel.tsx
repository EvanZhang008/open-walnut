import { useCallback } from 'react';
import { MarkdownEditorPanel } from '@/components/notes/MarkdownEditorPanel';
import { useFieldContent } from '@/hooks/useFieldContent';
import { saveGlobalMemory, saveUserMemory, saveMemory } from '@/api/memory';

interface MemoryContentPanelProps {
  content: string | null;
  path: string | null;
  updatedAt: string | null;
  onSaved?: (updatedAt: string) => void;
}

function formatPath(p: string): string {
  if (p === 'MEMORY.md') return 'Global / MEMORY.md';
  if (p === 'USER.md') return 'Global / USER.md';
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

/**
 * MemoryContentPanel — a memory .md file edited with the SHARED rich editor
 * (MarkdownEditorPanel), the same one /notes uses. Always-on autosave (no
 * Edit/Save buttons) via useFieldContent; memory files are flat markdown with no
 * frontmatter / no contentHash, last-write-wins.
 */
export function MemoryContentPanel({ content, path, updatedAt, onSaved }: MemoryContentPanelProps) {
  const save = useCallback(async (body: string) => {
    if (!path) return;
    const result = path === 'MEMORY.md'
      ? await saveGlobalMemory(body)
      : path === 'USER.md'
        ? await saveUserMemory(body)
        : await saveMemory(path, body);
    onSaved?.(result.updatedAt);
  }, [path, onSaved]);

  const { content: editorContent, saveStatus, onEditorUpdate } = useFieldContent(
    path,
    content ?? '',
    save,
  );

  if (!content || !path) {
    return (
      <div className="memory-content-empty">
        <div className="empty-state">
          <p>Select a memory file to view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-content-panel">
      <div className="memory-content-header">
        <div className="memory-content-header-left">
          <span className="memory-content-path">{formatPath(path)}</span>
          {updatedAt && <span className="memory-content-time">{formatTime(updatedAt)}</span>}
        </div>
      </div>
      <MarkdownEditorPanel
        content={editorContent}
        onEditorUpdate={onEditorUpdate}
        saveStatus={saveStatus}
        docId={path}
        showWidthToggle
        enableBlockTools
      />
    </div>
  );
}
