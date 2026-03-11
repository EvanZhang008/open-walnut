import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface PlanPopupProps {
  content: string;
  onClose: () => void;
}

export function PlanPopup({ content, onClose }: PlanPopupProps) {
  useModalOverlay(onClose);

  const html = useMemo(() => renderMarkdownWithRefs(content), [content]);

  return createPortal(
    <div className="plan-popup-overlay" role="dialog" aria-modal="true" aria-label="Plan preview" onClick={onClose}>
      <div className="plan-popup-container" onClick={(e) => e.stopPropagation()}>
        <div className="plan-popup-header">
          <span className="plan-popup-title">Plan</span>
          <button className="plan-popup-close" onClick={onClose} aria-label="Close plan popup">&times;</button>
        </div>
        <div className="plan-popup-body">
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
