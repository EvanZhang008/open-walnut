/**
 * Notes store — tree + per-note content with optimistic-locking saves.
 *
 * Tree and note contents persist to AsyncStorage (stale-while-revalidate);
 * saving uses expectedHash and resolves 409 conflicts last-write-wins by
 * adopting serverContent (git history on the server keeps the loser).
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createNote, deleteNote, fetchNote, fetchNotesTree, saveNote } from '../api/client'
import { ApiError, type NoteTreeNode } from '../api/types'
import { useConnectionStore } from './connection'

interface CachedNote {
  content: string
  contentHash: string
  updatedAt: string
}

interface NotesState {
  tree: NoteTreeNode[]
  notes: Record<string, CachedNote>
  loadingTree: boolean
  /** Path → transient save state, drives per-note UI. */
  saving: boolean
  /** Set briefly after a 409 was auto-resolved — editor shows a banner. */
  conflictPath: string | null
  error: string | null

  refreshTree: () => Promise<void>
  loadNote: (path: string) => Promise<CachedNote | null>
  /** Save with optimistic locking; on 409 adopt server content (LWW). Returns adopted content if conflicted. */
  save: (path: string, content: string) => Promise<{ conflicted: boolean; content: string } | null>
  create: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<boolean>
  clearConflict: () => void
  clearError: () => void
}

function reportNet(err: unknown): void {
  if (err instanceof ApiError && err.status === 0) {
    useConnectionStore.getState().reportReachability(false)
  }
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      tree: [],
      notes: {},
      loadingTree: false,
      saving: false,
      conflictPath: null,
      error: null,

      refreshTree: async () => {
        set({ loadingTree: true })
        try {
          const tree = await fetchNotesTree()
          useConnectionStore.getState().reportReachability(true)
          set({ tree, loadingTree: false })
        } catch (err) {
          reportNet(err)
          set({ loadingTree: false })
        }
      },

      loadNote: async (path) => {
        try {
          const note = await fetchNote(path)
          useConnectionStore.getState().reportReachability(true)
          const cached: CachedNote = {
            content: note.content,
            contentHash: note.contentHash,
            updatedAt: note.updatedAt,
          }
          set((s) => ({ notes: { ...s.notes, [path]: cached } }))
          return cached
        } catch (err) {
          reportNet(err)
          // Offline / error — fall back to cache if we have it.
          return get().notes[path] ?? null
        }
      },

      save: async (path, content) => {
        const cached = get().notes[path]
        // No change — skip the write entirely.
        if (cached && cached.content === content) return { conflicted: false, content }
        set({ saving: true })
        try {
          const res = await saveNote(path, content, cached?.contentHash)
          set((s) => ({
            saving: false,
            notes: { ...s.notes, [path]: { content, contentHash: res.contentHash, updatedAt: res.updatedAt } },
          }))
          return { conflicted: false, content }
        } catch (err) {
          if (err instanceof ApiError && err.code === 'conflict') {
            // LWW: adopt server content; git history keeps the losing edit.
            const serverContent = typeof err.extra.serverContent === 'string' ? err.extra.serverContent : content
            const serverHash = typeof err.extra.serverHash === 'string' ? err.extra.serverHash : ''
            set((s) => ({
              saving: false,
              conflictPath: path,
              notes: {
                ...s.notes,
                [path]: { content: serverContent, contentHash: serverHash, updatedAt: new Date().toISOString() },
              },
            }))
            return { conflicted: true, content: serverContent }
          }
          reportNet(err)
          set({ saving: false, error: err instanceof Error ? err.message : 'Save failed' })
          return null
        }
      },

      create: async (path) => {
        try {
          const res = await createNote(path)
          set((s) => ({
            notes: { ...s.notes, [path]: { content: '', contentHash: res.contentHash, updatedAt: res.updatedAt } },
          }))
          await get().refreshTree()
          return true
        } catch (err) {
          reportNet(err)
          const exists = err instanceof ApiError && err.status === 409
          set({ error: exists ? 'A note with that name already exists.' : err instanceof Error ? err.message : 'Create failed' })
          return false
        }
      },

      remove: async (path) => {
        try {
          await deleteNote(path)
          set((s) => {
            const { [path]: _gone, ...rest } = s.notes
            return { notes: rest }
          })
          await get().refreshTree()
          return true
        } catch (err) {
          reportNet(err)
          set({ error: err instanceof Error ? err.message : 'Delete failed' })
          return false
        }
      },

      clearConflict: () => set({ conflictPath: null }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'walnut.notes',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ tree: s.tree, notes: s.notes }),
    }
  )
)
