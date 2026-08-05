import { useCallback, useMemo, useRef } from 'react';
import { MarkdownEditorPanel } from '@/components/notes/MarkdownEditorPanel';
import { useFieldContent } from '@/hooks/useFieldContent';
import { saveGlobalMemory, saveUserMemory, saveMemory } from '@/api/memory';
import {
  splitMemoryFile,
  joinMemoryFile,
  escapeUnknownTags,
  type SplitMemoryFile,
} from './memory-file-io';

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
 * Edit/Save buttons) via useFieldContent; no contentHash, last-write-wins.
 *
 * FRONTMATTER IS SPLIT OFF BEFORE THE EDITOR SEES IT (and re-attached verbatim on
 * save) — the same pattern hooks/useNoteContent.ts uses for vault notes. Memory
 * files DO carry a leading YAML block (`name:` / `description: >`), and feeding it
 * to the WYSIWYG editor destroys it: markdown-it reads the closing `---` as a
 * setext-H2 underline, collapsing the whole block into one
 * `## name: … description: &gt; …` heading. For MEMORY.md / USER.md that heading
 * then reads as a real `## Title` ENTRY of a bounded store injected into the
 * butler's prompt every turn — it eats the char budget and is a legal
 * replace/remove target. See components/memory/memory-file-io.ts.
 */
export function MemoryContentPanel({ content, path, updatedAt, onSaved }: MemoryContentPanelProps) {
  // The frontmatter + boundary whitespace of the file as LOADED. Held in a ref so
  // the debounced save always re-attaches the block that belongs to the bytes the
  // editor was seeded from, even if a re-render is in flight.
  const splitRef = useRef<SplitMemoryFile | null>(null);
  const pathRef = useRef<string | null>(null);

  // Body-only content for the editor. Recomputed (not memo-keyed on path alone)
  // whenever the loaded bytes change, e.g. the post-save re-fetch in MemoryPage.
  const editorSeed = useMemo(() => {
    const split = splitMemoryFile(content ?? '');
    splitRef.current = split;
    pathRef.current = path;
    // Pre-escape tag-shaped prose (`<id>`) the parser would otherwise DELETE.
    return escapeUnknownTags(split.body);
  }, [content, path]);

  const save = useCallback(async (body: string) => {
    if (!path) return;
    // Re-attach the preserved frontmatter (and decode the `&gt;`/`&lt;` the
    // serializer's escapeHTML added) so the bytes on disk stay valid YAML + prose.
    // Guard against a stale split from a previous file: if the ref does not
    // belong to this path, fall back to writing the body alone rather than
    // prepending the WRONG file's frontmatter.
    const split = pathRef.current === path ? splitRef.current : null;
    const full = split
      ? joinMemoryFile(split, body)
      : joinMemoryFile({ frontmatter: '', leadingGap: '', body: '', trailingGap: '' }, body);
    const result = path === 'MEMORY.md'
      ? await saveGlobalMemory(full)
      : path === 'USER.md'
        ? await saveUserMemory(full)
        : await saveMemory(path, full);
    onSaved?.(result.updatedAt);
  }, [path, onSaved]);

  const { content: editorContent, saveStatus, onEditorUpdate } = useFieldContent(
    path,
    editorSeed,
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
