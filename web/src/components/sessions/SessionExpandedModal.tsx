import { createPortal } from 'react-dom';
import { SessionPanel } from './SessionPanel';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface SessionExpandedModalProps {
  sessionId: string;
  onClose: () => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onSessionReplaced?: (newSessionId: string) => void;
}

export function SessionExpandedModal({ sessionId, onClose, onTaskClick, onSessionClick, onSessionReplaced }: SessionExpandedModalProps) {
  useModalOverlay(onClose);

  return createPortal(
    <div className="session-expanded-overlay" role="dialog" aria-modal="true" aria-label="Expanded session" onClick={onClose}>
      <div className="session-expanded-container" onClick={(e) => e.stopPropagation()}>
        <SessionPanel
          sessionId={sessionId}
          onClose={onClose}
          onTaskClick={onTaskClick}
          onSessionClick={onSessionClick}
          onSessionReplaced={onSessionReplaced}
          expanded
        />
      </div>
    </div>,
    document.body,
  );
}
