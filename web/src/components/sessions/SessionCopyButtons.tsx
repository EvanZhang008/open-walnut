import { useState, useRef, useEffect, useCallback } from 'react';
import { forkSessionInWalnut } from '@/api/sessions';

interface SessionCopyButtonsProps {
  sessionId: string;
  cwd?: string;
  taskId?: string;
  taskTitle?: string;
  onForkComplete?: (taskId: string, sessionId?: string) => void;
}

function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <button
      className="session-copy-chip"
      onClick={copy}
      title={`Copy: ${value}`}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

export function SessionCopyButtons({ sessionId, cwd, taskId, taskTitle, onForkComplete }: SessionCopyButtonsProps) {
  const [showForkInput, setShowForkInput] = useState(false);
  const [forkMessage, setForkMessage] = useState('');
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<'success' | 'error' | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);

  // Focus textarea when popover opens
  useEffect(() => {
    if (showForkInput) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [showForkInput]);

  // Close popover on outside click
  useEffect(() => {
    if (!showForkInput) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowForkInput(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showForkInput]);

  const doFork = useCallback(async (message?: string) => {
    if (forking) return;
    setForking(true);
    setForkResult(null);
    setForkError(null);
    try {
      const result = await forkSessionInWalnut(sessionId, {
        ...(message ? { message } : {}),
      });
      setForkResult('success');
      setShowForkInput(false);
      setForkMessage('');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setForkResult(null), 2000);
      if (result.taskId) {
        onForkComplete?.(result.taskId, result.sessionId);
      }
    } catch (err) {
      setForkResult('error');
      setForkError(err instanceof Error ? err.message : 'Fork failed');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { setForkResult(null); setForkError(null); }, 3000);
    } finally {
      setForking(false);
    }
  }, [forking, sessionId, onForkComplete]);

  const handleForkClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (forking || forkResult === 'success') return;
    setShowForkInput(true);
  };

  const handleSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    doFork(forkMessage.trim() || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doFork(forkMessage.trim() || undefined);
    } else if (e.key === 'Escape') {
      setShowForkInput(false);
    }
  };

  if (!sessionId) return null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';

  const btnLabel = forking ? 'Forking...' : forkResult === 'success' ? 'Forked!' : forkResult === 'error' ? 'Error' : 'Fork';

  return (
    <span className="session-copy-buttons">
      {cwd && <CopyChip label="CWD" value={cwd} />}
      <CopyChip label="ID" value={sessionId} />
      <CopyChip label="Resume" value={`${cdPrefix}claude -r ${sessionId}`} />
      <CopyChip label="CLI Fork" value={`${cdPrefix}claude --fork-session -r ${sessionId}`} />
      {taskId && (
        <span className="session-fork-wrapper">
          <button
            className={`session-fork-btn${forkResult === 'success' ? ' session-fork-btn-success' : ''}`}
            onClick={handleForkClick}
            disabled={forking || forkResult === 'success'}
            title={forkError ?? `Fork session into a child task`}
          >
            {btnLabel}
          </button>
          {showForkInput && (
            <div className="session-fork-popover" ref={popoverRef} onClick={e => e.stopPropagation()}>
              <textarea
                ref={inputRef}
                className="session-fork-input"
                value={forkMessage}
                onChange={e => setForkMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message for the forked session (optional)"
                rows={2}
                disabled={forking}
              />
              <div className="session-fork-popover-actions">
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
            </div>
          )}
        </span>
      )}
    </span>
  );
}
