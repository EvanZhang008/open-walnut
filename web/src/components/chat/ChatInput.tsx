import { useState, useRef, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent, useLayoutEffect } from 'react';
import { searchCommands, getCommand } from '@/commands/index';
import type { SlashCommand } from '@/commands/types';
import type { ImageAttachment } from '@/api/chat';
import type { SlashCommandItem } from '@/api/slash-commands';
import { MAX_QUEUE_SIZE } from '@/hooks/useChat';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import type { Task } from '@open-walnut/core';
import { StatusBadge } from '../common/StatusBadge';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;

interface ChatInputProps {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onCommand?: (cmd: SlashCommand, args?: string) => void;
  onStop?: () => void;
  onInterruptSend?: (text: string, images?: ImageAttachment[]) => void;
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
  /** Session-mode: control commands like /model are intercepted and trigger UI actions */
  onControlCommand?: (command: string) => void;
}

export function ChatInput({ onSend, onCommand, onStop, onInterruptSend, onClearQueue, disabled, isStreaming, focusedTaskTitle, focusedTask, onClearFocus, queueCount, placeholder, showCommands = true, sessionCommands, searchSessionCommands, onControlCommand }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const queueFull = isStreaming && (queueCount ?? 0) >= MAX_QUEUE_SIZE;

  const isSessionMode = !!(sessionCommands && searchSessionCommands);

  // Slash command state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteResults, setPaletteResults] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Ref mirror for palette state — guarantees handleKeyDown always reads latest values
  // even if React hasn't flushed the re-render from onChange before the next keydown fires
  const paletteRef = useRef({ open: false, results: [] as PaletteItem[], selectedIndex: 0 });
  useLayoutEffect(() => {
    paletteRef.current = { open: paletteOpen, results: paletteResults, selectedIndex };
  }, [paletteOpen, paletteResults, selectedIndex]);

  const processFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (!ALLOWED_TYPES.has(file.type)) continue;

      setImages((prev) => {
        if (prev.length >= MAX_IMAGES) return prev;
        // Read file as base64
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
        return prev;
      });
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const resetInput = () => {
    setValue('');
    setImages([]);
    closePalette();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
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
    onSend(text, images.length > 0 ? images : undefined);
    resetInput();
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
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  }, [onControlCommand, closePalette]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Read palette state from ref to avoid stale closure issues —
    // React may not have flushed re-render from onChange before keydown fires
    const ps = paletteRef.current;
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
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handleChange = (newValue: string) => {
    setValue(newValue);
    handleInput();

    // Slash command detection: text starts with "/" and no space yet (still typing command name)
    const enablePalette = showCommands || isSessionMode;
    if (enablePalette && newValue.startsWith('/') && !newValue.includes(' ')) {
      const query = newValue.slice(1);
      let results: PaletteItem[];
      if (isSessionMode) {
        results = searchSessionCommands!(query);
        // Inject control commands into palette
        if ('model'.startsWith(query.toLowerCase())) {
          results = [{ name: 'model', description: 'Switch model (opus / sonnet / haiku)', source: 'control' }, ...results];
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
    const text = value.trim();
    if ((!text && images.length === 0) || disabled) return;
    onInterruptSend?.(text, images.length > 0 ? images : undefined);
    resetInput();
  };

  const canSend = !disabled && !queueFull && (value.trim() || images.length > 0);

  // Determine send button label
  // When onInterruptSend is set (session context with stream-json), keep "Send" even while streaming
  let sendLabel = 'Send';
  if (isStreaming && !onInterruptSend) {
    if (queueFull) sendLabel = 'Queue full';
    else sendLabel = 'Queue';
  }

  return (
    <div
      className={`chat-input-container${dragOver ? ' drag-over' : ''}`}
      style={{ position: 'relative' }}
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
        />
      )}
      {/* Queue indicator bar */}
      {isStreaming && (queueCount ?? 0) > 0 && (
        <div className="chat-queue-indicator">
          <span>{queueCount} message{(queueCount ?? 0) > 1 ? 's' : ''} queued</span>
          {onClearQueue && (
            <button className="chat-queue-clear" onClick={onClearQueue} type="button">Clear all</button>
          )}
        </div>
      )}
      {/* Unified input box: pill + images + textarea share one border */}
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
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <div className="chat-input-buttons">
        <button
          className="btn chat-attach-btn"
          onClick={handleAttachClick}
          type="button"
          disabled={disabled || images.length >= MAX_IMAGES}
          aria-label="Attach image"
          title="Attach image (or paste/drag-drop)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        {isStreaming && onStop && (
          <button
            className="btn chat-stop-btn"
            onClick={onStop}
            type="button"
          >
            Stop
          </button>
        )}
        {isStreaming && onInterruptSend && (
          <button
            className="btn chat-interrupt-btn"
            onClick={handleInterruptSend}
            disabled={!canSend}
            type="button"
            title="Stop the running turn and send this message"
          >
            ⚡ Interrupt
          </button>
        )}
        <button
          className="btn btn-primary chat-send-btn"
          onClick={handleSend}
          disabled={!canSend}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
