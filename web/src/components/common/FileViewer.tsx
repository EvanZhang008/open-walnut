/**
 * FileViewer — full-screen overlay for browsing + viewing files.
 *
 * Opens via portal. Embeds the SessionFileExplorer (VS Code-style tree + preview)
 * rooted at the clicked file's parent directory, with that file pre-selected — so
 * the user can read it AND navigate sibling files without leaving the popup.
 *
 * The path is looked up first (useClickedPathOpener): one the given host lacks
 * opens from the host that has it, and one no host has says so in one line.
 * A path whose writer's machine is unknown (`anywhere`) is looked up on every
 * machine, its task's first, and opens from the one that has it: the viewer never
 * asks the person to pick a machine (2026-11-23, Evan: "Why walnut not auto pic the
 * host it need me to pick"; tests/web/file-viewer-never-asks-machine.test.ts).
 */
import { useState, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { SessionFileExplorer } from '../sessions/SessionFileExplorer';
import { useHostDisplayLabel, useHostRoute } from '@/hooks/useHostDisplayLabel';
import { remoteHostTag } from '@/utils/host-display-label';
import { locateClickedPath, missingPathLine, type ClickedPathTarget } from '@/hooks/useClickedPathOpener';
import { ICON_CLOSE } from './Icons';

const LOCAL = '__local__';
const LOCAL_ALIASES = new Set(['', 'local', LOCAL]);

interface FileViewerProps {
  path: string;
  line?: number;
  endLine?: number;
  host?: string;
  sourceOnly?: boolean;
  /** The writer's machine is unknown: every machine is asked, `taskId`'s first. */
  anywhere?: boolean;
  taskId?: string;
  /** With `anywhere`: the sessions that wrote the words ('__local__' the person), asked first of all. */
  hintSessions?: readonly string[];
  onClose: () => void;
}

export function FileViewer({ path: filePath, line, endLine, host: askedHost, sourceOnly, anywhere, taskId, hintSessions, onClose }: FileViewerProps) {
  const [copied, setCopied] = useState(false);
  const everywhere = !!anywhere && !sourceOnly && LOCAL_ALIASES.has(askedHost ?? '');
  const hints = (hintSessions ?? []).join(',');
  // A machine that did not answer may have the file: "Try again" asks every machine once more.
  const [attempt, setAttempt] = useState(0);
  // The lookup a target answers: render shows only the current one's, so a stale or late answer never draws.
  const lookKey = JSON.stringify([filePath, LOCAL_ALIASES.has(askedHost ?? '') ? '' : askedHost, !!sourceOnly, everywhere, taskId ?? '', hints, line ?? null, endLine ?? null, attempt]);
  const [located, setLocated] = useState<{ key: string; target: ClickedPathTarget } | null>(null);
  const target = located?.key === lookKey ? located.target : null;
  useLayoutEffect(() => {
    // Before paint: an answer kept from an earlier lookup is dropped, so returning to its key asks again.
    setLocated(null);
    let live = true;
    const ctx = everywhere
      ? { anywhere: true, ...(taskId ? { taskId } : {}), ...(hints ? { hintSessions: hints.split(',') } : {}) }
      : { host: askedHost, sourceOnly };
    void locateClickedPath(filePath, ctx, { line, endLine }).then((t) => { if (live) setLocated({ key: lookKey, target: t }); });
    return () => { live = false; };
  }, [lookKey, filePath, askedHost, sourceOnly, everywhere, taskId, hints, line, endLine]);
  const host = target ? target.host : askedHost;
  const remote = host && host !== LOCAL ? host : null;
  const hostName = useHostDisplayLabel(remote);
  const hostVia = useHostRoute(remote);

  // Escape closes (the newest dialog only), and the page behind stops scrolling.
  useModalOverlay(onClose);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [filePath]);

  const filename = filePath.split('/').pop() ?? filePath;

  const overlay = (
    <div className="file-viewer-overlay wn-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="file-viewer-panel file-viewer-panel-explorer wn-dialog">
        <div className="file-viewer-header wn-dialog-head">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">&#x1F4C2;</span>
            <span className="file-viewer-path" title={filePath}>{filename}</span>
            {line && <span className="file-viewer-line">:{line}</span>}
          </div>
          <div className="file-viewer-actions">
            <button
              className="btn btn-sm"
              onClick={handleCopyPath}
              title="Copy file path"
            >
              {copied ? 'Copied!' : 'Copy Path'}
            </button>
            <button className="btn btn-icon file-viewer-close wn-dialog-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
              {ICON_CLOSE}
            </button>
          </div>
        </div>
        <div className="file-viewer-body file-viewer-body-explorer">
          {/* cwd = the clicked path: backend lists its parent dir and flags the file
              for preview (VS Code style), so the tree opens to its folder + selects it. */}
          {!target ? (
            <div className="sfe-notice" role="status">Looking for {filename}…</div>
          ) : target.missing ? (
            <div className="file-viewer-missing">
              <div className="sfe-notice" data-testid="file-viewer-missing">{missingPathLine(filePath, target.missing.checked, everywhere, target.missing.unreachable)}</div>
              {everywhere && !!target.missing.unreachable?.length && (
                <div className="file-viewer-missing-actions">
                  <button type="button" className="btn btn-sm" data-testid="file-viewer-try-again" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
                </div>
              )}
            </div>
          ) : (
            <SessionFileExplorer
              cwd={target.path}
              host={target.host}
              initialLine={target.line}
              initialEndLine={target.endLine}
              onHostNote={target.elsewhere ? { host: target.host, ...(everywhere ? { found: true } : { sessionHost: askedHost }) } : undefined}
            />
          )}
        </div>
        <div className="file-viewer-footer">
          <span className="file-viewer-full-path">{filePath}</span>
          {remote && <span className="file-viewer-host">{remoteHostTag(remote, hostName, hostVia)}</span>}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
