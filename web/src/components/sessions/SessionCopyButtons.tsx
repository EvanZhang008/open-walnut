import { useState, useRef, useEffect } from 'react';

interface SessionCopyButtonsProps {
  sessionId: string;
  cwd?: string;
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

export function SessionCopyButtons({ sessionId, cwd }: SessionCopyButtonsProps) {
  if (!sessionId) return null;
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';
  return (
    <span className="session-copy-buttons">
      <CopyChip label="ID" value={sessionId} />
      <CopyChip label="Resume" value={`${cdPrefix}claude -r ${sessionId}`} />
      <CopyChip label="Fork" value={`${cdPrefix}claude --fork-session -r ${sessionId}`} />
    </span>
  );
}
