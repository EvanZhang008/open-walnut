import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent, useLayoutEffect } from 'react';
import { searchCommands, getCommand } from '@/commands/index';
import type { SlashCommand } from '@/commands/types';
import type { ImageAttachment } from '@/api/chat';
import type { SlashCommandItem } from '@/api/slash-commands';
import { MAX_QUEUE_SIZE } from '@/hooks/useChat';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { FileMentionPopup, type FileMentionHandle } from './FileMentionPopup';
import type { Task } from '@open-walnut/core';
import { StatusBadge } from '../common/StatusBadge';
import { MicButton } from '../common/MicButton';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;

/**
 * Detect an active "@" file mention at the caret.
 * Triggers only when the "@" sits at the start of input or right after
 * whitespace (so emails `a@b` and decorators don't false-fire), and there's
 * no whitespace between the "@" and the caret. Returns the "@" index and the
 * query typed after it, or null if no mention is active.
 */
export function detectMention(
  text: string,
  caret: number,
): { atIndex: number; query: string } | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  const before = at === 0 ? '' : text[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = text.slice(at + 1, caret);
  if (/\s/.test(query)) return null;
  return { atIndex: at, query };
}

/**
 * Format a selected path as an "@" reference token for insertion into the message.
 * Paths with spaces are quoted so the ref stays a single token. The consumer is
 * the Claude Code CLI on the other end (the message is sent as plain text) — Claude
 * Code natively understands @path / @"quoted path" mentions, so no Walnut-side parser
 * decodes this; it travels verbatim in the message body.
 */
function formatMentionPath(relPath: string): string {
  return /\s/.test(relPath) ? `@"${relPath}"` : `@${relPath}`;
}

/**
 * Read the computed max-height of a textarea element in pixels.
 * Falls back to 200 because getComputedStyle returns "none" when max-height is
 * unset, which makes parseFloat return NaN.
 */
function getMaxHeight(el: HTMLTextAreaElement): number {
  return parseFloat(getComputedStyle(el).maxHeight) || 200;
}

interface ChatInputProps {
  /** May return a Promise<boolean> — false means the send failed and the draft must be preserved. */
  onSend: (text: string, images?: ImageAttachment[]) => void | Promise<boolean>;
  onCommand?: (cmd: SlashCommand, args?: string) => void;
  onStop?: () => void;
  onInterruptSend?: (text: string, images?: ImageAttachment[]) => void | Promise<boolean>;
  onClearQueue?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  focusedTaskTitle?: string;
  /** Task object for inline context pill inside the input box */
  focusedTask?: Task | null;
  /** Callback to clear the focused task */
  onClearFocus?: () => void;
  queueCount?: number;
  placeholder?: string;
  showCommands?: boolean;
  /** Session-mode: external slash commands for autocomplete. Selecting inserts text instead of executing. */
  sessionCommands?: SlashCommandItem[];
  /** Callback to search/filter session commands (provided by useSlashCommands hook). */
  searchSessionCommands?: (query: string) => SlashCommandItem[];
  /** Session-mode: force a re-scan of skills/commands (e.g. after creating one remotely). */
  onRefreshSessionCommands?: () => void;
  /** Session-mode: control commands like /model are intercepted and trigger UI actions */
  onControlCommand?: (command: string) => void;
  /** localStorage key for persisting draft text. When set, input value is saved on change (debounced) and restored on mount. */
  draftKey?: string;
  /** Toggle Execution / Plan mode (triggered by Shift+Tab) */
  onToggleMode?: () => void;
  /** Root dir for "@" file mentions. When set, typing "@" opens a file picker. */
  mentionCwd?: string;
  /** SSH host for "@" mentions (undefined = local). */
  mentionHost?: string;
  /** External prefill: text to drop into the input (e.g. an agent-builder template). */
  prefillText?: string;
  /** Bump this (monotonic, >0) to apply prefillText — replaces the input + focuses,
   *  WITHOUT sending. Keyed on the nonce so the same text can be re-applied. */
  prefillNonce?: number;
  /** Extra controls rendered in the card's bottom row, between the "+" and the
   *  mic/send cluster (e.g. the session's Bypass / btw / Note text buttons). */
  controlsSlot?: React.ReactNode;
}

export function ChatInput({ onSend, onCommand, onStop, onInterruptSend, onClearQueue, disabled, isStreaming, focusedTaskTitle, focusedTask, onClearFocus, queueCount, placeholder, showCommands = true, sessionCommands, searchSessionCommands, onRefreshSessionCommands, onControlCommand, draftKey, onToggleMode, mentionCwd, mentionHost, prefillText, prefillNonce, controlsSlot }: ChatInputProps) {
  const [value, setValue] = useState(() => {
    if (!draftKey) return '';
    try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; }
  });
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // "+" attach menu + send split-button dropdown (Claude-style). Both close on
  // outside click; refs anchor the click-outside test to each group.
  const [plusOpen, setPlusOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const plusGroupRef = useRef<HTMLDivElement>(null);
  const sendGroupRef = useRef<HTMLDivElement>(null);

  // Draft persistence: debounce save to localStorage
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  // Track whether the component has mounted so the effect below can skip the
  // initial run (the useState initializer above already handles first render).
  const mountedRef = useRef(false);

  // Restore draft when switching sessions (draftKey change).
  // Initial mount is handled by useState initializer above — skip here to avoid double-read.
  useEffect(() => {
    // Cancel any pending debounce timer for the previous session's key before
    // restoring the new session's draft. Without this, the stale timer could
    // fire after the key has changed and write the old text under the new key.
    clearTimeout(draftTimerRef.current);

    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    if (!draftKey) return;
    try {
      const saved = localStorage.getItem(draftKey) ?? '';
      setValue(saved);
      // Resize textarea to fit restored content
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el && saved) {
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
        }
      });
    } catch { /* localStorage unavailable */ }
  }, [draftKey]);

  // Cancel pending debounce timer on unmount
  useEffect(() => {
    return () => { clearTimeout(draftTimerRef.current); };
  }, []);

  // External prefill (e.g. "Create by chat" agent-builder template): replace the
  // input value + focus + cursor-to-end, but DON'T send — the user reviews/edits
  // (fills in purpose/name) and presses Send themselves. Keyed on the nonce so the
  // parent can re-apply the same text; nonce 0/undefined = no-op (initial mount).
  useEffect(() => {
    if (!prefillNonce || !prefillText) return;
    setValue(prefillText);
    // Persist immediately (don't rely on the later-declared debounced saveDraft).
    try { if (draftKeyRef.current) localStorage.setItem(draftKeyRef.current, prefillText); } catch { /* unavailable */ }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prefillText.length, prefillText.length);
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  // Close the "+" and send dropdowns on outside click / Escape.
  useEffect(() => {
    if (!plusOpen && !sendMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (plusOpen && plusGroupRef.current && !plusGroupRef.current.contains(t)) setPlusOpen(false);
      if (sendMenuOpen && sendGroupRef.current && !sendGroupRef.current.contains(t)) setSendMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { setPlusOpen(false); setSendMenuOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [plusOpen, sendMenuOpen]);

  const queueFull = isStreaming && (queueCount ?? 0) >= MAX_QUEUE_SIZE;

  // Queue dismiss state: user can close the indicator, re-appears when new messages are queued
  const [queueDismissed, setQueueDismissed] = useState(false);
  const prevQueueCount = useRef(0);
  useEffect(() => {
    const current = queueCount ?? 0;
    const prev = prevQueueCount.current;
    prevQueueCount.current = current;
    // Only re-surface when queue goes from empty→non-empty, not on every increment — otherwise dismiss-while-streaming is impossible
    if (prev === 0 && current > 0) {
      setQueueDismissed(false);
    }
  }, [queueCount]);

  const showQueue = isStreaming && (queueCount ?? 0) > 0 && !queueDismissed;

  const isSessionMode = !!(sessionCommands && searchSessionCommands);

  // Slash command state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteResults, setPaletteResults] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Re-scan session commands (remote skill list), keeping the palette open. The
  // spinner is cleared (and the open palette reflows) by the sessionCommands effect
  // below when the new list lands; a ceiling guards against a fetch that errors out.
  const handleRefreshCommands = useCallback(() => {
    if (!onRefreshSessionCommands) return;
    setRefreshing(true);
    onRefreshSessionCommands();
    window.setTimeout(() => setRefreshing(false), 8000);
  }, [onRefreshSessionCommands]);

  // Auto-resize (single source of truth): after EVERY value change — typing,
  // draft restore on mount (useState initializer bypasses all handlers), prefill,
  // voice insert — grow the textarea to fit, capped by the CSS max-height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
  }, [value]);

  // Re-fit when the textarea's WIDTH changes (panel resize / composer overlay
  // reflow re-wraps lines). Width-guarded so our own height writes don't loop.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ref mirror for palette state — guarantees handleKeyDown always reads latest values
  // even if React hasn't flushed the re-render from onChange before the next keydown fires
  const paletteRef = useRef({ open: false, results: [] as PaletteItem[], selectedIndex: 0 });
  useLayoutEffect(() => {
    paletteRef.current = { open: paletteOpen, results: paletteResults, selectedIndex };
  }, [paletteOpen, paletteResults, selectedIndex]);

  // When a refresh brings in a new sessionCommands list, reflow the open palette to
  // show it (and stop the spinner) without the user needing to retype.
  useEffect(() => {
    if (!refreshing) return;
    setRefreshing(false);
    if (!paletteOpen || !isSessionMode || !value.startsWith('/') || value.includes(' ')) return;
    const results = searchSessionCommands!(value.slice(1));
    setPaletteResults(results);
    setSelectedIndex(0);
    paletteRef.current = { open: results.length > 0, results, selectedIndex: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCommands]);

  // "@" file mention state. mentionAtIndexRef/mentionEndRef bracket the "@query"
  // span in `value` so selection can splice in the path without relying on the
  // live caret (which is unreliable for mouse-driven picks — the textarea may have
  // lost focus). Both are recomputed on every detect. Imperative handle drives
  // popup keyboard nav from handleKeyDown.
  const mentionEnabled = !!mentionCwd;
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const mentionAtIndexRef = useRef<number>(-1);
  const mentionEndRef = useRef<number>(-1);
  // Index of an "@" the user dismissed with Esc — handleChange won't auto-reopen
  // the popup for that same "@" (only a different "@" or edited text reopens).
  const mentionDismissedAtRef = useRef<number>(-1);
  const mentionPopupRef = useRef<FileMentionHandle>(null);
  // Ref mirror so handleKeyDown reads latest open-state without stale closure.
  const mentionOpenRef = useRef(false);
  mentionOpenRef.current = mentionOpen;

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery('');
    mentionAtIndexRef.current = -1;
    mentionEndRef.current = -1;
    mentionOpenRef.current = false;
  }, []);

  const processFiles = useCallback((files: FileList | File[]) => {
    // Start the FileReader OUTSIDE any setState updater. The reader is a side effect;
    // React invokes state updaters more than once (always in StrictMode, and possibly
    // on a concurrent re-render), so kicking off the read inside a setImages(prev => …)
    // updater fired two FileReaders per file and appended the same image twice — every
    // pasted/dropped photo showed up doubled. Keep the updater pure; do the read here.
    const imageFiles = Array.from(files).filter((f) => ALLOWED_TYPES.has(f.type));
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // Strip "data:image/png;base64," prefix
        const base64 = dataUrl.split(',')[1];
        if (!base64) return;
        setImages((curr) => {
          if (curr.length >= MAX_IMAGES) return curr;
          return [...curr, {
            data: base64,
            mediaType: file.type,
            name: file.name || 'pasted-image',
          }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const saveDraft = useCallback((text: string) => {
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const key = draftKeyRef.current;
      if (!key) return;
      try {
        if (text) localStorage.setItem(key, text);
        else localStorage.removeItem(key);
      } catch { /* quota exceeded or unavailable */ }
    }, 300);
  }, []);

  const clearDraft = useCallback(() => {
    clearTimeout(draftTimerRef.current);
    const key = draftKeyRef.current;
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }, []);

  // Clear the input UI. By default the persisted draft is cleared too, but callers
  // that send asynchronously pass keepDraft=true so the draft survives until the
  // send is confirmed successful (otherwise a failed send loses the user's text).
  const resetInput = (keepDraft = false) => {
    setValue('');
    setImages([]);
    closePalette();
    closeMention();
    if (!keepDraft) clearDraft();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // Restore the input box to the given text + images after a failed send, and make
  // sure the draft is persisted so a page refresh still recovers it. This is the
  // hard guarantee: the user's input must never silently disappear.
  const restoreInput = (text: string, imgs: ImageAttachment[]) => {
    setValue(text);
    setImages(imgs);
    saveDraft(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  };

  // Fire a send callback, then settle the draft based on the outcome. A callback
  // that resolves to `false` (RPC rejected) restores the input; anything else
  // (success, or a void return) clears the draft.
  const dispatchSend = (
    cb: (text: string, images?: ImageAttachment[]) => void | Promise<boolean>,
    text: string,
    imgs: ImageAttachment[],
  ) => {
    // Optimistically clear the box for snappy feel, but keep the draft until we know
    // the send was accepted server-side.
    resetInput(true);
    const result = cb(text, imgs.length > 0 ? imgs : undefined);
    if (result instanceof Promise) {
      result.then((ok) => {
        if (ok) clearDraft();
        else restoreInput(text, imgs);
      }).catch(() => restoreInput(text, imgs));
    } else {
      clearDraft();
    }
  };

  const handleSend = () => {
    const text = value.trim();
    if ((!text && images.length === 0) || disabled || queueFull) return;

    // Control commands: intercepted by UI, not sent as text to Claude
    if (isSessionMode && text === '/model' && onControlCommand) {
      onControlCommand('model');
      resetInput();
      return;
    }

    // In session mode, slash commands are sent as regular text (to Claude Code)
    // Only intercept in main chat mode (showCommands + no sessionCommands)
    if (showCommands && !isSessionMode && text.startsWith('/')) {
      const spaceIndex = text.indexOf(' ');
      const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
      const args = spaceIndex === -1 ? undefined : text.slice(spaceIndex + 1).trim() || undefined;

      if (name) {
        const cmd = getCommand(name);
        if (cmd) {
          resetInput();
          onCommand?.(cmd, args);
          return;
        }
      }
    }

    // Send as regular message (includes session slash commands)
    dispatchSend(onSend, text, images);
  };

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteResults([]);
    setSelectedIndex(0);
  }, []);

  const handleSelectCommand = useCallback((cmd: PaletteItem) => {
    // Control commands: trigger UI action, don't insert text
    if (cmd.source === 'control' && onControlCommand) {
      onControlCommand(cmd.name);
      resetInput();
      return;
    }
    // Both modes: insert command text into input (user presses Enter to execute)
    const text = `/${cmd.name} `;
    setValue(text);
    closePalette();
    // Resize textarea and move cursor to end
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  }, [onControlCommand, closePalette]);

  // Replace the active "@query" span with the selected path, then close the popup.
  // The popup hands back an absolute path (avoids ambiguity about what a relative
  // ref resolves against). Splice between the stored "@" index and query-end index
  // rather than the live caret — mouse picks don't reliably keep the caret in place.
  const handleMentionSelect = useCallback((absPath: string) => {
    const at = mentionAtIndexRef.current;
    const end = mentionEndRef.current;
    if (at < 0 || end < at) { closeMention(); return; }
    const ref = formatMentionPath(absPath) + ' ';
    const newValue = value.slice(0, at) + ref + value.slice(end);
    setValue(newValue);
    saveDraft(newValue);
    closeMention();
    const newCaret = at + ref.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, getMaxHeight(ta)) + 'px';
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
    });
  }, [value, saveDraft, closeMention]);

  // Rewrite the "@query" span to "@<dir>/" so the popup browses that dir (used when
  // jumping to a recent folder from "@?" mode). Keeps the popup open (no close).
  const handleMentionNavigate = useCallback((absDir: string) => {
    const at = mentionAtIndexRef.current;
    const end = mentionEndRef.current;
    if (at < 0 || end < at) return;
    const inserted = `@${absDir.replace(/\/+$/, '')}/`;
    const newValue = value.slice(0, at) + inserted + value.slice(end);
    setValue(newValue);
    saveDraft(newValue);
    const newCaret = at + inserted.length;
    mentionEndRef.current = newCaret;
    setMentionQuery(inserted.slice(1)); // drop the leading "@"
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(newCaret, newCaret); }
    });
  }, [value, saveDraft]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Shift+Tab: toggle Execution / Plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      onToggleMode?.();
      return;
    }

    // "@" file mention popup keyboard nav (takes priority over command palette;
    // they're mutually exclusive since one starts with "/" and the other "@").
    //   ↑/↓ move highlight · →/Enter open dir (or pick file) · ← parent dir ·
    //   Cmd/Ctrl+Enter select highlighted file OR folder · Esc close.
    // ← / → are only intercepted when the caret sits at the very edge of the input
    // so normal text cursor movement inside the @query still works.
    if (mentionOpenRef.current) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionPopupRef.current?.move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionPopupRef.current?.move(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); mentionPopupRef.current?.into(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); mentionPopupRef.current?.up(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Remember this "@" was dismissed so handleChange doesn't immediately reopen
        // it on the next keystroke (which fires onChange without changing the @).
        mentionDismissedAtRef.current = mentionAtIndexRef.current;
        closeMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // Cmd/Ctrl+Enter → select current (file or dir) regardless of type. Plain
        // Enter/Tab → open dir / pick file. This deliberately swallows Cmd/Ctrl+Enter
        // (the global "send" shortcut) while the popup is open so the user can pick.
        if (e.metaKey || e.ctrlKey) mentionPopupRef.current?.selectCurrent();
        else mentionPopupRef.current?.into();
        return;
      }
    }

    // Read palette state from ref to avoid stale closure issues —
    // React may not have flushed re-render from onChange before keydown fires
    const ps = paletteRef.current;
    // Skip IME composition (e.g. Chinese input selecting candidate)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (ps.open && ps.results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % ps.results.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + ps.results.length) % ps.results.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        handleSelectCommand(ps.results[ps.selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
        return;
      }
    }

    if (e.key === 'Enter') {
      if (e.shiftKey || e.altKey) {
        // Shift+Enter or Option+Enter → newline (default behavior)
        return;
      }
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, getMaxHeight(el)) + 'px';
  };

  const handleChange = (newValue: string) => {
    setValue(newValue);
    handleInput();
    saveDraft(newValue);

    // "@" file mention detection: caret follows an "@" (at start or after whitespace)
    // with no whitespace in between. The text after "@" is interpreted as a path
    // (navigate + filter) by the popup.
    if (mentionEnabled) {
      const caret = textareaRef.current?.selectionStart ?? newValue.length;
      const m = detectMention(newValue, caret);
      if (m) {
        // Don't reopen a popup the user just dismissed with Esc for this same "@".
        if (m.atIndex === mentionDismissedAtRef.current) {
          mentionAtIndexRef.current = m.atIndex;
          mentionEndRef.current = caret;
          return;
        }
        mentionDismissedAtRef.current = -1; // a live "@" — clear any stale dismissal
        mentionAtIndexRef.current = m.atIndex;
        mentionEndRef.current = caret; // end of the "@query" span = current caret
        setMentionQuery(m.query);
        setMentionOpen(true);
        mentionOpenRef.current = true;
        return; // "@" and "/" are mutually exclusive triggers
      }
      mentionDismissedAtRef.current = -1; // no active "@" — reset dismissal memory
      if (mentionOpenRef.current) closeMention();
    }

    // Slash command detection: text starts with "/" and no space yet (still typing command name)
    const enablePalette = showCommands || isSessionMode;
    if (enablePalette && newValue.startsWith('/') && !newValue.includes(' ')) {
      const query = newValue.slice(1);
      let results: PaletteItem[];
      if (isSessionMode) {
        results = searchSessionCommands!(query);
        // Inject control commands into palette
        if ('model'.startsWith(query.toLowerCase())) {
          results = [{ name: 'model', description: 'Switch model (opus / sonnet / haiku / fable)', source: 'control' }, ...results];
        }
      } else {
        results = searchCommands(query);
      }
      const open = results.length > 0;
      setPaletteResults(results);
      setPaletteOpen(open);
      setSelectedIndex(0);
      // Sync ref immediately so handleKeyDown reads correct state even before re-render
      paletteRef.current = { open, results, selectedIndex: 0 };
    } else {
      closePalette();
      paletteRef.current = { open: false, results: [], selectedIndex: 0 };
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      const imageFiles = Array.from(items).filter(f => ALLOWED_TYPES.has(f.type));
      if (imageFiles.length > 0) {
        e.preventDefault();
        processFiles(imageFiles);
      }
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      processFiles(files);
    }
  };

  const handleAttachClick = () => {
    setPlusOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileChange = () => {
    const files = fileInputRef.current?.files;
    if (files && files.length > 0) {
      processFiles(files);
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleInterruptSend = () => {
    setSendMenuOpen(false);
    const text = value.trim();
    if ((!text && images.length === 0) || disabled || !onInterruptSend) return;
    dispatchSend(onInterruptSend, text, images);
  };

  const handleStop = () => {
    setSendMenuOpen(false);
    onStop?.();
  };

  const canSend = !disabled && !queueFull && !!(value.trim() || images.length > 0);

  // The primary send action always sends the composed message. Its title reflects
  // whether a live turn is running (queue / interrupt) so the icon-only button
  // stays self-explanatory. The overflow "▾" exposes Interrupt / Stop while streaming.
  let sendTitle = 'Send';
  if (isStreaming && !onInterruptSend) {
    sendTitle = queueFull ? 'Queue full' : 'Queue message (sends after the current turn)';
  } else if (isStreaming && onInterruptSend) {
    sendTitle = 'Send (queues after the current turn)';
  }
  // The split-menu is only useful mid-turn, and only when we have an interrupt/stop action.
  const showSendMenu = !!isStreaming && (!!onInterruptSend || !!onStop);

  return (
    <div
      className={`chat-input-container${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {paletteOpen && (
        <CommandPalette
          commands={paletteResults}
          selectedIndex={selectedIndex}
          onSelect={handleSelectCommand}
          showSource={isSessionMode}
          onRefresh={isSessionMode && onRefreshSessionCommands ? handleRefreshCommands : undefined}
          refreshing={refreshing}
        />
      )}
      {mentionOpen && mentionCwd && (
        <FileMentionPopup
          ref={mentionPopupRef}
          cwd={mentionCwd}
          host={mentionHost}
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onNavigate={handleMentionNavigate}
          onClose={closeMention}
        />
      )}
      {/* Queue indicator bar — dismissable, reappears when new messages queued */}
      {showQueue && (
        <div className="chat-queue-indicator">
          <span>{queueCount} message{(queueCount ?? 0) > 1 ? 's' : ''} queued</span>
          {onClearQueue && (
            <button className="chat-queue-clear" onClick={onClearQueue} type="button">Clear all</button>
          )}
          <button
            className="chat-queue-dismiss"
            onClick={(e) => { e.stopPropagation(); setQueueDismissed(true); }}
            type="button"
            aria-label="Dismiss queue indicator"
          >
            &times;
          </button>
        </div>
      )}
      {/* Composer card (D6): ONE bordered card holding everything —
          text row on top; controls row below: [+] · slot (Bypass/btw/Note) ·
          spacer · mic · send. Mic stays next to send. */}
      <div className="chat-input-row">
        <div className="chat-input-box">
          {/* Inline task context pill */}
          {focusedTask && onClearFocus && (
            <div className={`chat-input-task-pill${(focusedTask.phase === 'AGENT_COMPLETE' || focusedTask.phase === 'AWAIT_HUMAN_ACTION') ? ' pill-attention' : ''}`}>
              <button
                className="pill-close"
                onClick={onClearFocus}
                title="Clear task focus"
                type="button"
                aria-label="Clear task focus"
              >
                &times;
              </button>
              <StatusBadge status={focusedTask.status} phase={focusedTask.phase} />
              <span className="pill-title">{focusedTask.title}</span>
            </div>
          )}
          {/* Image preview area */}
          {images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((img, i) => (
                <div key={i} className="chat-image-preview">
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                  />
                  <button
                    className="chat-image-remove"
                    onClick={() => removeImage(i)}
                    type="button"
                    aria-label="Remove image"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? (focusedTaskTitle ? `Ask about '${focusedTaskTitle}'...` : 'Type a message... (/ for commands)')}
            disabled={disabled}
            rows={1}
          />
          {/* Controls row inside the card */}
          <div className="chat-input-controls">
        {/* "+" attach menu — anchors a small popover of attachment actions */}
        <div className="chat-plus-group" ref={plusGroupRef}>
          <button
            className={`chat-plus-btn${plusOpen ? ' active' : ''}`}
            onClick={() => setPlusOpen((o) => !o)}
            type="button"
            disabled={disabled}
            aria-label="Add attachment"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            title="Add attachment"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {plusOpen && (
            <div className="chat-plus-menu" role="menu">
              <button
                className="chat-plus-menu-item"
                onClick={handleAttachClick}
                type="button"
                role="menuitem"
                disabled={images.length >= MAX_IMAGES}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
                <span>{images.length >= MAX_IMAGES ? 'Image limit reached' : 'Attach image'}</span>
              </button>
            </div>
          )}
        </div>
        {controlsSlot}
        <span className="chat-input-controls-spacer" />
        <MicButton
          onTranscribe={(text) => {
            // Insert at cursor position (or append if no selection)
            const el = textareaRef.current;
            const pos = el?.selectionStart ?? value.length;
            const before = value.slice(0, pos);
            const after = value.slice(pos);
            // Add space separator if inserting between existing text
            const needSpaceBefore = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
            const needSpaceAfter = after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n');
            const inserted = (needSpaceBefore ? ' ' : '') + text + (needSpaceAfter ? ' ' : '');
            const newValue = before + inserted + after;
            handleChange(newValue);
            // Move cursor to end of inserted text
            const newPos = pos + inserted.length;
            requestAnimationFrame(() => {
              el?.setSelectionRange(newPos, newPos);
              el?.focus();
            });
          }}
          disabled={disabled}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        {/* Send — icon button (↑). While streaming it grows a split "▾" that
            exposes Interrupt / Stop. */}
        <div className={`chat-send-group${showSendMenu ? ' has-menu' : ''}`} ref={sendGroupRef}>
          <button
            className="chat-send-btn-icon"
            onClick={handleSend}
            disabled={!canSend}
            type="button"
            aria-label={sendTitle}
            title={sendTitle}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="6 11 12 5 18 11" />
            </svg>
          </button>
          {showSendMenu && (
            <>
              <button
                className="chat-send-caret"
                onClick={() => setSendMenuOpen((o) => !o)}
                type="button"
                aria-label="More send options"
                aria-haspopup="menu"
                aria-expanded={sendMenuOpen}
                title="More send options"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {sendMenuOpen && (
                <div className="chat-send-menu" role="menu">
                  {onInterruptSend && (
                    <button
                      className="chat-send-menu-item"
                      onClick={handleInterruptSend}
                      disabled={!canSend}
                      type="button"
                      role="menuitem"
                      title="Stop the running turn and send this message now"
                    >
                      <span aria-hidden="true">⚡</span>
                      <span>Interrupt &amp; send</span>
                    </button>
                  )}
                  {onStop && (
                    <button
                      className="chat-send-menu-item danger"
                      onClick={handleStop}
                      type="button"
                      role="menuitem"
                      title="Stop the running turn"
                    >
                      <span aria-hidden="true">⏹</span>
                      <span>Stop turn</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
          </div>{/* .chat-input-controls */}
        </div>{/* .chat-input-box */}
      </div>
    </div>
  );
}
