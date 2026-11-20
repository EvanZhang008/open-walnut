/**
 * The marks of the bar's modes, one per mode (quickbar-modes.ts): the Tab list's rows, the result
 * rows of Tasks and Notes.
 */
import type { QuickMode } from './quickbar-modes';

export function TaskGlyph({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>;
}

export function NoteGlyph({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>;
}

export function AskGlyph({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4" /><path d="M12 16.8h.01" /></svg>;
}

export function ModeGlyph({ mode, size }: { mode: Exclude<QuickMode, 'send'>; size?: number }) {
  if (mode === 'tasks') return <TaskGlyph size={size} />;
  if (mode === 'notes') return <NoteGlyph size={size} />;
  return <AskGlyph size={size} />;
}
