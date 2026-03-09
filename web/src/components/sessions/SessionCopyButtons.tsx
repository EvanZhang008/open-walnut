import { useState, useRef, useEffect } from 'react';
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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [forkTitle, setForkTitle] = useState('');
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<'success' | 'error' | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);

  // Close popover on click outside
  useEffect(() => {
    if (!popoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [popoverOpen]);

  // Focus input when popover opens
  useEffect(() => {
    if (popoverOpen) {
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [popoverOpen]);

  if (!sessionId) return null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';

  const openPopover = (e: React.MouseEvent) => {
    e.stopPropagation();
    setForkTitle(`Fork of ${taskTitle || 'task'}`);
    setForkResult(null);
    setForkError(null);
    setPopoverOpen(true);
  };

  const handleFork = async () => {
    if (forking) return;
    setForking(true);
    setForkResult(null);
    setForkError(null);
    try {
      const result = await forkSessionInWalnut(sessionId, {
        child_title: forkTitle.trim() || undefined,
      });
      setForkResult('success');
      setPopoverOpen(false);
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
  };

  const btnLabel = forking ? 'Forking...' : forkResult === 'success' ? 'Forked!' : forkResult === 'error' ? 'Error' : 'Fork';

  return (
    <span className="session-copy-buttons">
      <CopyChip label="ID" value={sessionId} />
      <CopyChip label="Resume" value={`${cdPrefix}claude -r ${sessionId}`} />
      {taskId && (
        <span className="session-fork-wrapper" ref={popoverRef}>
          <button
            className={`session-fork-btn${forkResult === 'success' ? ' session-fork-btn-success' : ''}`}
            onClick={openPopover}
            disabled={forking || forkResult === 'success'}
            title={forkError ?? `Fork session into a child task`}
          >
            {btnLabel}
          </button>
          {popoverOpen && (
            <div className="session-fork-popover" onClick={(e) => e.stopPropagation()}>
              <div className="session-fork-popover-title">Fork into child task</div>
              <input
                ref={inputRef}
                className="session-fork-popover-input"
                type="text"
                value={forkTitle}
                onChange={(e) => setForkTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleFork(); if (e.key === 'Escape') setPopoverOpen(false); }}
                placeholder="Child task title"
                disabled={forking}
              />
              {forkError && <div className="session-fork-popover-error">{forkError}</div>}
              <div className="session-fork-popover-actions">
                <button className="btn btn-sm" onClick={() => setPopoverOpen(false)} disabled={forking}>Cancel</button>
                <button className="btn btn-sm btn-primary" onClick={handleFork} disabled={forking || !forkTitle.trim()}>
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
