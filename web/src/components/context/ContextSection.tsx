import { useState, type ReactNode } from 'react';

interface ContextSectionProps {
  title: string;
  tokens: number;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function ContextSection({ title, tokens, count, defaultOpen = false, children }: ContextSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const label = count !== undefined ? `${title} (${count})` : title;

  return (
    <div className="context-section">
      <button
        className="context-section-header"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <span className="context-section-arrow">{open ? '\u25BC' : '\u25B6\uFE0E'}</span>
        <span className="context-section-title">{label}</span>
        <span className="badge context-token-badge"><span>~{tokens.toLocaleString()} tokens</span></span>
      </button>
      {open && (
        <div className="context-section-content">
          {children}
        </div>
      )}
    </div>
  );
}
