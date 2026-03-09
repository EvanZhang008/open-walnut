import { useState, useRef, useEffect } from 'react';
import { forkSessionInWalnut } from '@/api/sessions';

interface SessionCopyButtonsProps {
  sessionId: string;
  cwd?: string;
  taskId?: string;
  taskTitle?: string;
  onForkComplete?: (taskId: string) => void;
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
  const [forkError, setForkError] = useState<string | null>(null);

  if (!sessionId) return null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';

  const handleFork = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (forking) return;
    setForking(true);
    setForkError(null);
    try {
      const result = await forkSessionInWalnut(sessionId);
      if (result.taskId) {
        onForkComplete?.(result.taskId);
      }
    } catch (err) {
      setForkError(err instanceof Error ? err.message : 'Fork failed');
      setTimeout(() => setForkError(null), 3000);
    } finally {
      setForking(false);
    }
  };

  return (
    <span className="session-copy-buttons">
      <CopyChip label="ID" value={sessionId} />
      <CopyChip label="Resume" value={`${cdPrefix}claude -r ${sessionId}`} />
      <CopyChip label="Fork" value={`${cdPrefix}claude --fork-session -r ${sessionId}`} />
      {taskId && (
        <button
          className="session-fork-btn"
          onClick={handleFork}
          disabled={forking}
          title={forkError ?? `Fork session into a new child task under "${taskTitle ?? taskId}"`}
        >
          {forking ? 'Forking...' : forkError ? 'Error' : 'Fork in Walnut'}
        </button>
      )}
    </span>
  );
}
