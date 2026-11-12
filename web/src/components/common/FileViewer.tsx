/**
 * FileViewer — full-screen overlay for browsing + viewing files.
 *
 * Opens via portal. Embeds the SessionFileExplorer (VS Code-style tree + preview)
 * rooted at the clicked file's parent directory, with that file pre-selected — so
 * the user can read it AND navigate sibling files without leaving the popup.
 *
 * The path is looked up first (useClickedPathOpener): one the given host lacks
 * opens from the host that has it, and one no host has says so in one line.
 * A path whose source machine is unknown reads nothing until the person names a machine.
 */
import { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { SessionFileExplorer } from '../sessions/SessionFileExplorer';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { hostDisplayLabel, remoteHostTag } from '@/utils/host-display-label';
import { locateClickedPath, missingPathLine, type ClickedPathTarget } from '@/hooks/useClickedPathOpener';
import { sourceFailureNeedsPick, type SourceFailReason } from '@/utils/agent-text-source';
import { forgetMachine, rememberMachine, rememberedMachine } from '@/utils/path-machine-memory';

const LOCAL = '__local__';
const LOCAL_ALIASES = new Set(['', 'local', LOCAL]);

/** The machines a person may name for a path whose source is unknown: this one and every known host. */
function SourceChoices({ picked, onPick }: { picked: string | null; onPick: (host: string) => void }) {
  const hosts = useAllHostStatus();
  const choices = [{ host: LOCAL, label: hostDisplayLabel(LOCAL) }];
  // One Local button: a host entry naming this machine, or one listed twice, is dropped.
  for (const h of hosts) {
    const alias = (h.host ?? '').trim();
    if (LOCAL_ALIASES.has(alias) || choices.some((c) => c.host === alias)) continue;
    choices.push({ host: alias, label: hostDisplayLabel(alias, h.label) });
  }
  return (
    <div className="file-viewer-source-choices" role="group" aria-label="Choose a machine" data-testid="file-source-choice">
      <div className="file-viewer-source-choices-title">Choose a machine</div>
      <div className="file-viewer-source-choices-hint">Pick the machine that has this file; Walnut looks only there. Local is the machine running Walnut.</div>
      <div className="file-viewer-source-choices-row">
        {choices.map((c) => (
          <button
            key={c.host}
            type="button"
            className="file-viewer-btn"
            data-testid={c.host === LOCAL ? 'file-source-local' : 'file-source-host'}
            {...(c.host === LOCAL ? {} : { 'data-host': c.host })}
            aria-pressed={picked === c.host}
            {...(c.host === LOCAL ? { title: 'The machine running Walnut' } : {})}
            onClick={() => onPick(c.host)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface FileViewerProps {
  path: string;
  line?: number;
  endLine?: number;
  host?: string;
  sourceOnly?: boolean;
  sourceFailure?: string;
  /** Why the machine is unknown: a pick answers all but a failed lookup, which offers `onRetry`. */
  sourceReason?: SourceFailReason;
  onRetry?: () => void;
  onClose: () => void;
}

export function FileViewer({ path: filePath, line, endLine, host: askedHost, sourceOnly, sourceFailure, sourceReason, onRetry, onClose }: FileViewerProps) {
  const [copied, setCopied] = useState(false);
  // A machine the person named for an unknown source: this viewer only, void once the path or failure changes.
  const failureKey = sourceFailure ? `${filePath}\n${sourceFailure}` : '';
  const needsPick = !!sourceFailure && (!sourceReason || sourceFailureNeedsPick(sourceReason));
  const [pick, setPick] = useState<{ key: string; host: string } | null>(null);
  // The person's earlier choice for this path in this tab: used once, shown as theirs, undone in one click.
  const [forgot, setForgot] = useState(false);
  const remembered = needsPick && !forgot ? rememberedMachine(filePath) : null;
  const picked = failureKey && pick?.key === failureKey ? pick.host : remembered;
  const fromMemory = picked !== null && picked === remembered && !(pick?.key === failureKey);
  const failure = picked ? undefined : sourceFailure;
  const lookHost = picked ?? askedHost;
  const lookOnly = picked ? true : sourceOnly;
  // The lookup a target answers: render shows only the current one's, so a stale or late answer never draws.
  const lookKey = JSON.stringify([filePath, LOCAL_ALIASES.has(lookHost ?? '') ? '' : lookHost, !!lookOnly, line ?? null, endLine ?? null, failure ?? '']);
  const [located, setLocated] = useState<{ key: string; target: ClickedPathTarget } | null>(null);
  const target = !failure && located?.key === lookKey ? located.target : null;
  useLayoutEffect(() => {
    // Before paint: an answer kept from an earlier lookup is dropped, so returning to its key asks again.
    setLocated(null);
    if (failure) return;
    let live = true;
    void locateClickedPath(filePath, { host: lookHost, sourceOnly: lookOnly }, { line, endLine }).then((t) => { if (live) setLocated({ key: lookKey, target: t }); });
    return () => { live = false; };
  }, [lookKey, filePath, lookHost, lookOnly, line, endLine, failure]);
  useEffect(() => { setPick(null); }, [failureKey]);
  const choose = useCallback((h: string) => {
    if (needsPick) rememberMachine(filePath, h);
    setPick({ key: failureKey, host: h });
  }, [failureKey, needsPick, filePath]);
  const chooseAnother = useCallback(() => {
    forgetMachine(filePath);
    setForgot(true);
    setPick(null);
  }, [filePath]);
  const host = target ? target.host : askedHost;
  const remote = host && host !== LOCAL ? host : null;
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

  // Its own row between the header and the body: inside the body it would be a column beside the explorer.
  const showRemembered = fromMemory && !failure && !!target && !target.missing;

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
        {showRemembered && (
          <div className="file-viewer-remembered" data-testid="file-viewer-remembered">
            <span>Opened on {hostDisplayLabel(picked || LOCAL)}, the machine you chose for this path before.</span>
            <button type="button" className="file-viewer-btn" data-testid="file-viewer-choose-another" onClick={chooseAnother}>Choose another machine</button>
          </div>
        )}
        <div className="file-viewer-body file-viewer-body-explorer">
          {/* cwd = the clicked path: backend lists its parent dir and flags the file
              for preview (VS Code style), so the tree opens to its folder + selects it. */}
          {failure ? (
            <div className="file-viewer-source-failure">
              <div className="sfe-notice" role={needsPick ? 'status' : 'alert'} data-testid="file-viewer-source-error">{failure}</div>
              {!needsPick && onRetry && (
                <div><button type="button" className="file-viewer-btn" data-testid="file-viewer-source-retry" onClick={onRetry}>Try again</button></div>
              )}
              <SourceChoices picked={null} onPick={choose} />
            </div>
          ) : !target ? (
            <div className="sfe-notice" role="status">Looking for {filename}…</div>
          ) : target.missing ? (
            picked ? (
              <div className="file-viewer-source-failure">
                <div className="sfe-notice" data-testid="file-viewer-missing">{missingPathLine(filePath, target.missing.checked)}</div>
                <SourceChoices picked={picked} onPick={choose} />
              </div>
            ) : (
              <div className="sfe-notice" data-testid="file-viewer-missing">{missingPathLine(filePath, target.missing.checked)}</div>
            )
          ) : (
            <SessionFileExplorer
              cwd={target.path}
              host={target.host}
              initialLine={target.line}
              initialEndLine={target.endLine}
              onHostNote={target.elsewhere ? { host: target.host, sessionHost: askedHost } : undefined}
            />
          )}
        </div>
        <div className="file-viewer-footer">
          <span className="file-viewer-full-path">{filePath}</span>
          {remote && <span className="file-viewer-host">{remoteHostTag(remote, hostName)}</span>}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
