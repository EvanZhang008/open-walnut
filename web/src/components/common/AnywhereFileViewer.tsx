/**
 * The app's one FileViewer for a path opened from a surface with no viewer of
 * its own (utils/open-anywhere.ts): a Thread card, the Brief, a card, a drawer.
 * Mounted once in App.tsx; a newer open replaces the one on screen.
 */
import { useEffect, useState } from 'react';
import { LazyFileViewer } from './LazyFileViewer';
import { OPEN_FILE_EVENT, type OpenFileRequest } from '@/utils/open-anywhere';
import { log } from '@/utils/log';
import '@/styles/agent-links.css';

export function AnywhereFileViewer() {
  const [req, setReq] = useState<OpenFileRequest | null>(null);
  // Every open is a fresh viewer, so a machine chosen for an earlier unknown-source path never carries over.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenFileRequest>).detail;
      if (!detail?.path) return;
      log.info('file-open', 'path opened in the app viewer', { path: detail.path, host: detail.host ?? 'local' });
      setReq({ ...detail });
      setGeneration((n) => n + 1);
    };
    window.addEventListener(OPEN_FILE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpen);
  }, []);
  if (!req) return null;
  // Loaded on the first open (LazyFileViewer): every window mounts this viewer.
  return (
    <LazyFileViewer
      key={generation}
      path={req.path}
      {...(req.line ? { line: req.line } : {})}
      {...(req.endLine ? { endLine: req.endLine } : {})}
      {...(req.host ? { host: req.host } : {})}
      {...(req.sourceOnly ? { sourceOnly: true } : {})}
      {...(req.sourceFailure ? { sourceFailure: req.sourceFailure } : {})}
      {...(req.sourceReason ? { sourceReason: req.sourceReason } : {})}
      {...(req.retry ? { onRetry: req.retry } : {})}
      onClose={() => setReq(null)}
    />
  );
}
