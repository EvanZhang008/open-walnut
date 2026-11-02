/**
 * Shared click-delegation handler for containers that render markdown
 * with .task-link, .session-link, .project-link, and .file-link anchors.
 *
 * EVERY component that renders task-ref / session-ref / project-ref / file links
 * should use this hook instead of duplicating the event-delegation pattern.
 *
 * Behavior:
 *  - task-link click → onTaskClick(taskId) → select + scroll + open session (no detail)
 *  - session-link click → onSessionClick(sessionId) → open session panel
 *  - project-link click → navigate('/tasks') (no per-project route exists yet)
 *  - file-link click → onFileOpen(path, line?, undefined, endLine?) → open FileViewer overlay
 *    (a range reference such as `x.go:31-34` carries data-file-end-line)
 *  - Fallback: the task on Home (openTaskOnHome) or /sessions?id=:id when callbacks are absent;
 *    a file with no onFileOpen opens in the app's own FileViewer (utils/open-anywhere.ts)
 *  - letter-link anchors are the app's (useAgentLinkClickFallback opens them)
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { locatePath } from '@/api/files';
import { openTaskOnHome } from '@/utils/open-session';
import { claimAgentLinkClick, openFileAnywhere } from '@/utils/open-anywhere';

export function useEntityClickHandler(
  onTaskClick?: (taskId: string) => void,
  onSessionClick?: (sessionId: string) => void,
  /** The third parameter is the session panel's jump term, never set here; the
   *  fourth is the last line of a range reference. */
  onFileOpen?: (path: string, line?: number, term?: undefined, endLine?: number) => void,
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
        onTaskClick ? onTaskClick(taskId) : openTaskOnHome(taskId, navigate);
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

    // Project pills have no per-project route to deep-link to, so every one of
    // them lands on the task board. No callback parameter: there is nothing for a
    // caller to override until such a route exists.
    const projectAnchor = target.closest('a.project-link') as HTMLAnchorElement | null;
    if (projectAnchor) {
      e.preventDefault();
      navigate('/tasks');
      return;
    }

    const fileAnchor = target.closest('a.file-link') as HTMLAnchorElement | null;
    if (fileAnchor) {
      e.preventDefault();
      // This surface opens it; the app-level fallback must not open it twice.
      claimAgentLinkClick(e.nativeEvent);
      // No opener of its own: the app's viewer, still resolved from this surface's host.
      const open = onFileOpen ?? ((path: string, line?: number, _term?: undefined, endLine?: number) =>
        openFileAnywhere({ path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(fileHost ? { host: fileHost } : {}) }));
      const fileLine = fileAnchor.dataset.fileLine;
      const line = fileLine ? parseInt(fileLine, 10) : undefined;
      const fileEndLine = fileAnchor.dataset.fileEndLine;
      const endLine = line && fileEndLine ? parseInt(fileEndLine, 10) : undefined;
      const filePath = fileAnchor.dataset.filePath;
      if (filePath) {
        // Absolute path: the sink looks it up on every host (useClickedPathOpener).
        open(filePath, line, undefined, endLine);
        return;
      }
      // Relative path — the host resolves it (transcript, ancestor walk, git
      // index with submodules, pruned find), so a path from a deeper directory
      // than cwd still opens.
      const rel = fileAnchor.dataset.relPath;
      const cwd = fileAnchor.dataset.cwd;
      if (rel && cwd) {
        // A miss answers the path joined to cwd (never a stand-in folder), which
        // the sink then reports as not found.
        locatePath(rel, { host: fileHost, cwd, sessionId: fileSessionId })
          // The anchor's own line wins when present (the markdown layer already
          // parsed it); otherwise take whatever position the reference carried,
          // which the resolver reports even for shapes markdown doesn't linkify
          // (`#L42`, `(42,7)`, `, line 42`).
          .then((r) => open(r.found || r.missing ? r.path : `${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`, line ?? r.line, undefined, line ? endLine : r.endLine));
      }
    }
  }, [onTaskClick, onSessionClick, onFileOpen, fileHost, fileSessionId, navigate]);
}
