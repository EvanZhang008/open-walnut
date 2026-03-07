type Status = 'connected' | 'error' | 'unknown' | 'testing';

interface StatusIndicatorProps {
  status: Status;
  text?: string;
}

export function StatusIndicator({ status, text }: StatusIndicatorProps) {
  const dotClass = `status-dot status-dot-${status}`;
  const defaultText =
    status === 'connected' ? 'Connected' :
    status === 'error' ? 'Connection failed' :
    status === 'testing' ? 'Testing...' :
    'Not configured';

  return (
    <span className="status-indicator">
      <span className={dotClass} />
      <span className="status-text">{text ?? defaultText}</span>
    </span>
  );
}
