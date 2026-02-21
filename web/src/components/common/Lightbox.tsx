import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    // Prevent body scroll while lightbox is open
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  return createPortal(
    <div className="lightbox-overlay" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close image preview">&times;</button>
      <img
        className="lightbox-image"
        src={src}
        alt={alt || 'Image preview'}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
