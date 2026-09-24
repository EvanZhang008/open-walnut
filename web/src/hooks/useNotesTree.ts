import { useState, useEffect, useCallback } from 'react';
import { fetchNotesTree, createFolder, deleteNote, deleteFolder, deleteAttachment, moveNote } from '@/api/notes-v2';
import type { NoteTreeNode } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';

/**
 * The last tree any mount saw, kept for the page lifetime. Leaving the Notes
 * page unmounts the hook; coming back used to start from an empty sidebar and
 * a spinner until the ~470 KB tree arrived again. Now the previous tree paints
 * at once and the refetch runs behind it (stale-while-revalidate); the idle
 * prefetch fills it before the first visit.
 */
let cachedTree: NoteTreeNode[] | null = null;
let prefetchInFlight: Promise<void> | null = null;

/**
 * Warm the tree cache while the user is elsewhere. Low priority: waits for a
 * free connection so the page the user is on is never slowed by it.
 */
export function prefetchNotesTree(): Promise<void> {
  if (cachedTree) return Promise.resolve();
  if (!prefetchInFlight) {
    prefetchInFlight = fetchNotesTree({ priority: 'low' })
      .then((tree) => { cachedTree = tree; })
      .catch(() => {})
      .finally(() => { prefetchInFlight = null; });
  }
  return prefetchInFlight;
}

/** Test hook: forget the cached tree. */
export function resetNotesTreeCacheForTests(): void {
  cachedTree = null;
}

export function useNotesTree() {
  const [tree, setTree] = useState<NoteTreeNode[]>(() => cachedTree ?? []);
  const [loading, setLoading] = useState(cachedTree == null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchNotesTree();
      cachedTree = data;
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
  // created lazily on first upload, or a note written by another program (the
  // vault watcher relays those). Without this, the sidebar tree never shows it
  // until the user happens to trigger some other refresh (new note, rename).
  useEvent('notes:tree-changed', () => { refresh(); });

  const addFolder = useCallback(async (folderPath: string) => {
    await createFolder(folderPath);
    await refresh();
  }, [refresh]);

  const removeNote = useCallback(async (notePath: string) => {
    await deleteNote(notePath);
    await refresh();
  }, [refresh]);

  const removeFolder = useCallback(async (folderPath: string) => {
    await deleteFolder(folderPath);
    await refresh();
  }, [refresh]);

  const removeAttachment = useCallback(async (attachmentPath: string) => {
    await deleteAttachment(attachmentPath);
    await refresh();
  }, [refresh]);

  const renameNote = useCallback(async (from: string, to: string) => {
    await moveNote(from, to);
    await refresh();
  }, [refresh]);

  return { tree, loading, error, refresh, addFolder, removeNote, removeFolder, removeAttachment, renameNote };
}
