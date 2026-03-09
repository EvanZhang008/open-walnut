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
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<'success' | 'error' | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);

  if (!sessionId) return null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';

  const handleFork = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (forking) return;
    setForking(true);
    setForkResult(null);
    setForkError(null);
    try {
      const result = await forkSessionInWalnut(sessionId);
      setForkResult('success');
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

  const btnLabel = forking ? 'Forking...' : forkResult === 'success' ? 'Forked!' : forkResult === 'error' ? 'Error' : 'Fork in Walnut';

  return (
    <span className="session-copy-buttons">
      <CopyChip label="ID" value={sessionId} />
      <CopyChip label="Resume" value={`${cdPrefix}claude -r ${sessionId}`} />
      <CopyChip label="Fork" value={`${cdPrefix}claude --fork-session -r ${sessionId}`} />
      {taskId && (
        <button
          className={`session-fork-btn${forkResult === 'success' ? ' session-fork-btn-success' : ''}`}
          onClick={handleFork}
          disabled={forking || forkResult === 'success'}
          title={forkError ?? `Fork session into a child task "${taskTitle ?? 'task'}"`}
        >
          {btnLabel}
        </button>
      )}
    </span>
  );
}
