import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  useModalOverlay(onClose);

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
