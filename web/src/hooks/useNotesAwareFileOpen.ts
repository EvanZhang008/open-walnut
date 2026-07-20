/**
 * Wrap a FileViewer-opening callback so clicks on files that are really NOTES
 * in the local vault (~/.open-walnut/notes/*.md) navigate to the Notes page
 * (tabs, backlinks, editing) instead of the read-only FileViewer overlay.
 *
 * Every component that owns FileViewer state (ChatMessage, SessionPanel,
 * SessionDetailPanel) should wrap its `handleFileOpen` with this.
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { vaultRelativeNotePath } from '@/utils/notes-link';

export function useNotesAwareFileOpen(
  openViewer: (path: string, line?: number) => void,
  /** Session host — remote paths never route to the local vault. */
  host?: string,
): (path: string, line?: number) => void {
  const navigate = useNavigate();
  return useCallback((path: string, line?: number) => {
    vaultRelativeNotePath(path, host)
      .then((rel) => {
        if (rel !== null) navigate(`/notes?path=${encodeURIComponent(rel)}`);
        else openViewer(path, line);
      })
      .catch(() => openViewer(path, line));
  }, [openViewer, host, navigate]);
}
