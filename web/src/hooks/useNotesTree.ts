import { useState, useEffect, useCallback } from 'react';
import { fetchNotesTree, createFolder, deleteNote, moveNote } from '@/api/notes-v2';
import type { NoteTreeNode } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';

export function useNotesTree() {
  const [tree, setTree] = useState<NoteTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchNotesTree();
      setTree(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load notes tree');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A file/folder appeared outside the normal create/delete/move actions this
  // hook already refreshes after — e.g. a pasted image's `_attachment/` folder,
  // created lazily on first upload. Without this, the sidebar tree never shows
  // it until the user happens to trigger some other refresh (new note, rename).
  useEvent('notes:tree-changed', () => { refresh(); });

  const addFolder = useCallback(async (folderPath: string) => {
    await createFolder(folderPath);
    await refresh();
  }, [refresh]);

  const removeNote = useCallback(async (notePath: string) => {
    await deleteNote(notePath);
    await refresh();
  }, [refresh]);

  const renameNote = useCallback(async (from: string, to: string) => {
    await moveNote(from, to);
    await refresh();
  }, [refresh]);

  return { tree, loading, error, refresh, addFolder, removeNote, renameNote };
}
