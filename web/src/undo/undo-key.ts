/**
 * When mod+z belongs to the task undo stack rather than to the page.
 *
 * Text fields keep their own undo: in a box with text, mod+z takes back typing, as everywhere
 * else. The one exception is an EMPTY composer: completing a task from the keyboard moves the
 * caret into the next task's composer, and that is exactly where the person presses mod+z to
 * take the completion back; an empty composer has no typing worth undoing. Code editors and
 * terminals (their own undo, and xterm's hidden textarea is always empty) never give it up.
 *
 * In the Mac app the page sees the key before the Edit menu's Undo (WKWebView sends a key
 * equivalent to the page first and only an unclaimed one to the menu), so preventDefault here
 * keeps the menu's text undo from also running.
 */
import { isMacPlatform } from '@/hooks/usePanelKeyRouter';

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented' | 'isComposing'>;

export function isUndoChord(e: Pick<KeyLike, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = isMacPlatform()): boolean {
  if (e.shiftKey || e.altKey) return false;
  if (e.code !== 'KeyZ' && e.key.toLowerCase() !== 'z') return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function undoKeyApplies(e: KeyLike, active: Element | null, mac = isMacPlatform()): boolean {
  if (e.defaultPrevented || e.isComposing || !isUndoChord(e, mac)) return false;
  if (!active || (typeof document !== 'undefined' && active === document.body)) return true;
  const el = active as HTMLElement;
  if (el.closest?.('.cm-editor, .xterm, .monaco-editor')) return false;
  if (el.isContentEditable) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return el.classList.contains('chat-input-textarea') && (el as HTMLTextAreaElement).value === '';
  }
  if (el.tagName === 'SELECT') return false;
  return true;
}

/** The chord as the toast shows it. */
export function undoKeyLabel(mac = isMacPlatform()): string {
  return mac ? '⌘Z' : 'Ctrl+Z';
}
