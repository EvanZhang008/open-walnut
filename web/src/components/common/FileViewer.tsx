/**
 * FileViewer — full-screen overlay for browsing + viewing files.
 *
 * Opens via portal. Embeds the SessionFileExplorer (VS Code-style tree + preview)
 * rooted at the clicked file's parent directory, with that file pre-selected — so
 * the user can read it AND navigate sibling files without leaving the popup.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { SessionFileExplorer } from '../sessions/SessionFileExplorer';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { remoteHostTag } from '@/utils/host-display-label';

interface FileViewerProps {
  path: string;
  line?: number;
  host?: string;
  onClose: () => void;
}

export function FileViewer({ path: filePath, line, host, onClose }: FileViewerProps) {
  const [copied, setCopied] = useState(false);
  const remote = host && host !== '__local__' ? host : null;
  const hostName = useHostDisplayLabel(remote);

  // Escape key closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [filePath]);

  const filename = filePath.split('/').pop() ?? filePath;

  const overlay = (
    <div className="file-viewer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="file-viewer-panel file-viewer-panel-explorer">
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">&#x1F4C2;</span>
            <span className="file-viewer-path" title={filePath}>{filename}</span>
            {line && <span className="file-viewer-line">:{line}</span>}
          </div>
          <div className="file-viewer-actions">
            <button
              className="file-viewer-btn"
              onClick={handleCopyPath}
              title="Copy file path"
            >
              {copied ? 'Copied!' : 'Copy Path'}
            </button>
            <button className="file-viewer-close" onClick={onClose} title="Close (Esc)">
              &#x2715;
            </button>
          </div>
        </div>
        <div className="file-viewer-body file-viewer-body-explorer">
          {/* cwd = the clicked path: backend lists its parent dir and flags the file
              for preview (VS Code style), so the tree opens to its folder + selects it. */}
          <SessionFileExplorer cwd={filePath} host={host} initialLine={line} />
        </div>
        <div className="file-viewer-footer">
          <span className="file-viewer-full-path" title={filePath}>{filePath}</span>
          {remote && <span className="file-viewer-host">{remoteHostTag(remote, hostName)}</span>}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
