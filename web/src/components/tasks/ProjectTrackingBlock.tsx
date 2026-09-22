/**
 * The `Tracking` section of the project detail pane: the project's tracking note
 * (`task_projects.metadata.tracking_note`) rendered as plain markdown.
 *
 * Deliberately NOT `NoteView` (web/src/plugins/views.tsx) — that component IS the
 * whole Notes page (tree + search + editor), and a ~320px detail pane cannot host
 * a second scroll container and a second selection model. This reads the note
 * (fetchNoteContent) and renders it with the VAULT'S OWN renderer
 * (renderNoteMarkdown, already DOMPurify'd with the note policy, same as the task
 * detail panes), plus one escape hatch: Open in Notes.
 *
 * `[[task:ab12cd34]]` renders as PLAIN TEXT. The note renderer has no task-ref
 * extension, and inventing one only here would make the pane and Obsidian
 * disagree about the same bytes. Pinned by tests/web/project-tracking-block.test.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { fetchNoteContent } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';
import { splitFrontmatter } from '@/components/notes/frontmatter';
import { renderNoteMarkdown } from '@/utils/markdown';
import { ProjectTrackingView, hasTrackingNote, type TrackingNoteState } from './ProjectTrackingView';

interface ProjectTrackingBlockProps {
  /** `metadata.tracking_note`. Absent/empty = this project has no tracking note. */
  notePath?: string;
}

export function ProjectTrackingBlock({ notePath }: ProjectTrackingBlockProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<TrackingNoteState>({ status: 'loading' });
  // Generation guard: the pane survives a rename and a project switch, so a slow
  // read of the OLD note must not land on top of the new one's.
  const generation = useRef(0);

  const load = useCallback(async (path: string) => {
    const mine = ++generation.current;
    try {
      const { content } = await fetchNoteContent(path);
      if (generation.current !== mine) return;
      // Frontmatter is METADATA, not prose. Rendered, its closing `---` reads as a
      // setext underline, so `project: … kind: project-tracking updated: …` came
      // out as an <h2> at the top of the section. Same split the notes editor uses
      // (its own comment records the same lesson).
      const body = splitFrontmatter(content).body;
      setState({ status: 'present', sanitizedHtml: renderNoteMarkdown(body) });
    } catch (err) {
      if (generation.current !== mine) return;
      // 404 is the only answer that means "the note is gone". Everything else is
      // a read that failed, and saying "gone" for those would be a wrong claim
      // about the user's vault.
      if (err instanceof ApiError && err.status === 404) {
        setState({ status: 'missing' });
        return;
      }
      setState({ status: 'unreadable', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (!hasTrackingNote(notePath)) return;
    setState({ status: 'loading' });
    void load(notePath);
  }, [notePath, load]);

  // The whole point of a tracking note is that an agent writes it while the human
  // watches, so a write to THIS note refreshes the section. One small read per
  // write of one note; every other note in the vault is ignored. `source` is the
  // shared `notes/<path without .md>` contract (api-v1.ts writeNote).
  useEvent('notes:updated', (data: unknown) => {
    if (!notePath) return;
    const source = (data as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') return;
    if (source !== `notes/${notePath.replace(/\.md$/, '')}`) return;
    void load(notePath);
  });

  // No key → no section at all (not an empty box). After the hooks, because hook
  // order may not depend on props.
  if (!hasTrackingNote(notePath)) return null;

  return (
    <ProjectTrackingView
      notePath={notePath}
      state={state}
      onOpenInNotes={() => navigate(`/notes?path=${encodeURIComponent(notePath)}`)}
    />
  );
}
