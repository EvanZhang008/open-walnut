/**
 * Shared click-delegation handler for containers that render markdown
 * with .task-link, .session-link, and .file-link anchors.
 *
 * EVERY component that renders task-ref / session-ref / file links should use
 * this hook instead of duplicating the event-delegation pattern.
 *
 * Behavior:
 *  - task-link click → onTaskClick(taskId) → select + scroll + open session (no detail)
 *  - session-link click → onSessionClick(sessionId) → open session panel
 *  - file-link click → onFileOpen(path, line?) → open FileViewer overlay
 *  - Fallback: navigate to /tasks/:id or /sessions?id=:id when callbacks are absent
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolvePath } from '@/api/files';

export function useEntityClickHandler(
  onTaskClick?: (taskId: string) => void,
  onSessionClick?: (sessionId: string) => void,
  onFileOpen?: (path: string, line?: number) => void,
  /** Host for resolving relative paths (remote sessions). Local when omitted. */
  fileHost?: string,
  /** Session whose transcript should inform path resolution. Strongly wanted:
   *  it lets the backend match against paths this session actually opened, which
   *  is the cheapest and most accurate way to resolve what the model wrote. */
  fileSessionId?: string,
) {
  const navigate = useNavigate();

  // .task-link and .session-link anchors are created by entityRefsToHtml()
  // and injectJsonIdLinks() in utils/markdown.ts, with data-task-id / data-session-id attributes.
  // .file-link anchors are created by filePathsToHtml() with data-file-path / data-file-line.
  // preventDefault() is called but NOT stopPropagation() — callers that need
  // stopPropagation (e.g. TriagePanel inside a toggle button) wrap this handler.
  return useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      e.preventDefault();
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
      return;
    }

    const sessionAnchor = target.closest('a.session-link') as HTMLAnchorElement | null;
    if (sessionAnchor) {
      e.preventDefault();
      const sessionId = sessionAnchor.dataset.sessionId;
      if (sessionId) {
        onSessionClick ? onSessionClick(sessionId) : navigate(`/sessions?id=${sessionId}`);
      }
      return;
    }

    const fileAnchor = target.closest('a.file-link') as HTMLAnchorElement | null;
    if (fileAnchor) {
      e.preventDefault();
      if (!onFileOpen) return;
      const fileLine = fileAnchor.dataset.fileLine;
      const line = fileLine ? parseInt(fileLine, 10) : undefined;
      const filePath = fileAnchor.dataset.filePath;
      if (filePath) {
        // Absolute path — open directly. The Files panel self-heals if it turns
        // out not to exist (a stale or wrong-prefix path), so no round trip here.
        onFileOpen(filePath, line);
        return;
      }
      // Relative path — the host resolves it (transcript, ancestor walk, git
      // index with submodules, pruned find), so a path from a deeper directory
      // than cwd still opens.
      const rel = fileAnchor.dataset.relPath;
      const cwd = fileAnchor.dataset.cwd;
      if (rel && cwd) {
        resolvePath(rel, cwd, fileHost, fileSessionId)
          // The anchor's own line wins when present (the markdown layer already
          // parsed it); otherwise take whatever position the reference carried,
          // which the resolver reports even for shapes markdown doesn't linkify
          // (`#L42`, `(42,7)`, `, line 42`).
          .then((r) => onFileOpen(r.path, line ?? r.line))
          .catch(() => onFileOpen(`${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`, line));
      }
    }
  }, [onTaskClick, onSessionClick, onFileOpen, fileHost, fileSessionId, navigate]);
}
