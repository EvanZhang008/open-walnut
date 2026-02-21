import { useState, useCallback } from 'react';
import { useEvent } from '@/hooks/useWebSocket';

interface CronNotification {
  id: number;
  text: string;
  jobName: string;
  timestamp: number;
}

let nextId = 0;

const TOAST_LIFETIME_MS = 8000;

export function CronToast() {
  const [toasts, setToasts] = useState<CronNotification[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEvent('cron:notification', (data) => {
    const { text, jobName, timestamp } = data as { text: string; jobName: string; timestamp: number };
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, text, jobName, timestamp }]);
    setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
  });

  if (toasts.length === 0) return null;

  return (
    <div className="cron-toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="cron-toast">
          <div className="cron-toast-header">
            <span className="cron-toast-icon">&#128337;</span>
            <span className="cron-toast-job">{toast.jobName}</span>
            <button
              className="cron-toast-close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
          <div className="cron-toast-body">{toast.text}</div>
        </div>
      ))}
    </div>
  );
}
