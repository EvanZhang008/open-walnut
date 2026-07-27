import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { forkSessionInWalnut } from '@/api/sessions';
import type { ImageAttachment } from '@/api/chat';

/**
 * SessionForkButton — the standalone "Fork" action that stays OUTSIDE the
 * kebab dropdown (one of the four kept-visible session actions).
 *
 * Extracted from the old SessionCopyButtons so Fork can live on its own while
 * the copy chips (CWD / ID / Resume) move into the kebab Session section.
 */
interface SessionForkButtonProps {
  sessionId: string;
  cwd?: string;
  taskId?: string;
  engine?: 'claude' | 'codex';
  onForkStarted?: (cwd: string, host?: string) => void;
  /** `sessionId` is the pre-assigned id of the new forked session (always set by the server). */
  onForkComplete?: (taskId: string, sessionId?: string) => void;
  onForkFailed?: (errorMessage?: string) => void;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_FORK_IMAGES = 5;
const POPOVER_WIDTH = 320; // keep in sync with .session-fork-popover width in globals.css

export function SessionForkButton({ sessionId, cwd, taskId, engine, onForkStarted, onForkComplete, onForkFailed }: SessionForkButtonProps) {
  const [showForkInput, setShowForkInput] = useState(false);
  const [forkMessage, setForkMessage] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<'success' | 'error' | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [cliCopied, setCliCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Popover renders in a portal (so neighbouring panels can never clip it) and is
  // anchored to the button via fixed coords computed from its bounding rect. maxHeight
  // caps it to the space below the button so a tall popover (textarea + image previews +
  // CLI-copy) scrolls internally instead of spilling below the fold.
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useEffect(() => () => { clearTimeout(timerRef.current); clearTimeout(cliCopyTimerRef.current); }, []);

  // Smart placement: open to the RIGHT of the button's left edge by default, but
  // flip left / clamp so the POPOVER_WIDTH popover never spills off-screen. Computed
  // before paint (no 0,0 flash) and kept in sync while open on scroll/resize (the
  // listener is rAF-throttled since capture:true fires on any nested scroller).
  useLayoutEffect(() => {
    if (!showForkInput) { setPos(null); return; }
    const margin = 8;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      // Prefer left-aligned to the button; if that overflows the right edge, shift
      // back so the full width fits; never go past the left margin.
      let left = r.left;
      if (left + POPOVER_WIDTH + margin > window.innerWidth) {
        left = window.innerWidth - POPOVER_WIDTH - margin;
      }
      if (left < margin) left = margin;
      const top = r.bottom + 6;
      setPos({ top, left, maxHeight: window.innerHeight - top - margin });
    };
    place();
    let raf = 0;
    const onScrollOrResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [showForkInput]);

  // Focus textarea when popover opens
  useEffect(() => {
    if (showForkInput) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [showForkInput]);

  // Close popover on outside click (ignore clicks on the anchor button itself —
  // its own handler toggles state).
  useEffect(() => {
    if (!showForkInput) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target) && !btnRef.current?.contains(target)) {
        setShowForkInput(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showForkInput]);

  // Read dropped/pasted/picked image files → base64 ImageAttachment[] (same shape
  // ChatInput uses). Capped at MAX_FORK_IMAGES.
  const processFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        if (!base64) return;
        setImages((curr) => curr.length >= MAX_FORK_IMAGES
          ? curr
          : [...curr, { data: base64, mediaType: file.type, name: file.name || 'pasted-image' }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const imgs = Array.from(files).filter(f => ALLOWED_IMAGE_TYPES.has(f.type));
      if (imgs.length > 0) { e.preventDefault(); processFiles(imgs); }
    }
  }, [processFiles]);

  const doFork = useCallback(async (message?: string, imgs?: ImageAttachment[]) => {
    if (forking) return;
    setForking(true);
    setForkResult(null);
    setForkError(null);
    setShowForkInput(false);
    // Notify parent immediately so it can show a pending panel
    if (cwd) onForkStarted?.(cwd);
    try {
      const result = await forkSessionInWalnut(sessionId, {
        ...(message ? { message } : {}),
        ...(imgs && imgs.length ? { images: imgs } : {}),
      });
      setForkResult('success');
      setForkMessage('');
      setImages([]);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setForkResult(null), 2000);
      if (result.taskId) {
        // sessionId comes back immediately (server pre-assigns it via --session-id),
        // so the parent can open the real forked panel without polling.
        onForkComplete?.(result.taskId, result.sessionId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Fork failed';
      setForkResult('error');
      setForkError(errMsg);
      onForkFailed?.(errMsg);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { setForkResult(null); setForkError(null); }, 3000);
    } finally {
      setForking(false);
    }
  }, [forking, sessionId, cwd, onForkStarted, onForkComplete, onForkFailed]);

  const handleForkClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (engine === 'codex' || forking || forkResult === 'success') return;
    setShowForkInput(true);
  };

  const handleSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    doFork(forkMessage.trim() || undefined, images);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doFork(forkMessage.trim() || undefined, images);
    } else if (e.key === 'Escape') {
      setShowForkInput(false);
    }
  };

  // Fork creates a child task — only meaningful when this session has a task.
  if (!sessionId || !taskId) return null;
  const unsupportedReason = engine === 'codex'
    ? 'Fork is unavailable because this Codex adapter does not support session forking'
    : null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';
  const btnLabel = forking ? 'Forking...' : forkResult === 'success' ? 'Forked!' : forkResult === 'error' ? 'Error' : 'Fork';

  return (
    <span className="session-fork-wrapper">
      <button
        ref={btnRef}
        className={`session-action-chip${forkResult === 'success' ? ' session-fork-btn-success' : ''}`}
        onClick={handleForkClick}
        disabled={!!unsupportedReason || forking || forkResult === 'success'}
        title={unsupportedReason ?? forkError ?? 'Fork session into a child task'}
        aria-label={unsupportedReason ?? 'Fork session into a child task'}
      >
        {btnLabel}
      </button>
      {showForkInput && pos && createPortal(
        <div
          className={`session-fork-popover${dragOver ? ' is-drag-over' : ''}`}
          ref={popoverRef}
          // width is driven by the JS constant (single source of truth for the placement
          // math); maxHeight + overflow-y keep a tall popover scrollable, not clipped.
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH, maxHeight: pos.maxHeight, overflowY: 'auto' }}
          onClick={e => e.stopPropagation()}
          onPaste={handlePaste}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer?.files?.length) processFiles(e.dataTransfer.files);
          }}
        >
          <textarea
            ref={inputRef}
            className="session-fork-input"
            value={forkMessage}
            onChange={e => setForkMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message for the forked session — paste or drop an image too (optional)"
            rows={2}
            disabled={forking}
          />
          {images.length > 0 && (
            <div className="session-fork-image-previews">
              {images.map((img, i) => (
                // Stable key from the content (not the index) so removing a middle
                // image doesn't re-key/re-decode the ones after it.
                <div key={`${img.name}-${img.data.slice(0, 24)}`} className="session-fork-image-preview">
                  <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                  <button
                    type="button"
                    className="session-fork-image-remove"
                    onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                    aria-label="Remove image"
                    disabled={forking}
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={() => {
              const files = fileInputRef.current?.files;
              if (files?.length) processFiles(files);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <div className="session-fork-popover-actions">
            <button
              type="button"
              className="session-fork-attach"
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              disabled={forking || images.length >= MAX_FORK_IMAGES}
              title={images.length >= MAX_FORK_IMAGES ? `Max ${MAX_FORK_IMAGES} images` : 'Attach image'}
              aria-label="Attach image"
            >📎</button>
            <span className="session-fork-hint">{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send</span>
            <button
              className="session-fork-cancel"
              onClick={(e) => { e.stopPropagation(); setShowForkInput(false); }}
              disabled={forking}
            >
              Cancel
            </button>
            <button
              className="session-fork-submit"
              onClick={handleSubmit}
              disabled={forking}
            >
              {forking ? 'Forking...' : 'Fork'}
            </button>
          </div>
          <hr className="session-fork-divider-line" />
          <button
            className="session-fork-cli-copy"
            onClick={(e) => {
              e.stopPropagation();
              const cmd = `${cdPrefix}claude --fork-session -r ${sessionId}`;
              navigator.clipboard.writeText(cmd).then(() => {
                setCliCopied(true);
                clearTimeout(cliCopyTimerRef.current);
                cliCopyTimerRef.current = setTimeout(() => setCliCopied(false), 1500);
              }).catch(() => {});
            }}
            title={`Copy: ${cdPrefix}claude --fork-session -r ${sessionId}`}
          >
            {cliCopied ? 'Copied!' : 'Copy CLI command'}
          </button>
        </div>,
        document.body,
      )}
    </span>
  );
}
