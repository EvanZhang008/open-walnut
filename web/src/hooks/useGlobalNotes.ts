import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';

export interface UseGlobalNotesReturn {
  content: string;
  updateContent: (val: string) => void;
  saving: boolean;
  saveError: string | null;
  collapsed: boolean;
  toggleCollapse: () => void;
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
}

const COLLAPSE_KEY = 'walnut-global-notes-collapsed';

export function useGlobalNotes(): UseGlobalNotesReturn {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [popupOpen, setPopupOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContent = useRef(content);
  const dirty = useRef(false);

  // Load on mount with cancellation guard
  useEffect(() => {
    let mounted = true;
    fetchGlobalNotes()
      .then(c => { if (mounted) setContent(c); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Keep ref in sync
  useEffect(() => {
    latestContent.current = content;
  }, [content]);

  // Debounced save
  const updateContent = useCallback((val: string) => {
    setContent(val);
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    setSaveError(null);
    saveTimer.current = setTimeout(() => {
      saveGlobalNotes(val)
        .then(() => { dirty.current = false; })
        .catch((err) => { setSaveError(err instanceof Error ? err.message : 'Save failed'); })
        .finally(() => setSaving(false));
    }, 500);
  }, []);

  // Cleanup timer on unmount — only flush if content was actually modified
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (dirty.current) {
          saveGlobalNotes(latestContent.current).catch(() => {});
        }
      }
    };
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  }, []);

  const openPopup = useCallback(() => setPopupOpen(true), []);
  const closePopup = useCallback(() => setPopupOpen(false), []);

  return { content, updateContent, saving, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup };
}
