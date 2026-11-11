import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_REF_CHANNEL, openAgentRef, parseAgentRef } from '@/utils/agent-ref-open';
import { randomId } from '@/utils/random-id';

export const OPEN_REF_PATIENCE_MS = 2500;

export function OpenAgentRefPage() {
  const navigate = useNavigate();
  const [parsed] = useState(() => parseAgentRef(window.location.href));
  const [opened, setOpened] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const expiredFile = !!parsed?.token && parsed.ref.kind === 'file';
  // The reader answers within a second as a rule, and this window closes with the answer: only a
  // wait past that is worth explaining, so a normal hand-off never flashes a sentence that reads as a fault.
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    if (!expiredFile) return;
    const timer = setTimeout(() => setWaitedLong(true), OPEN_REF_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [expiredFile]);
  useEffect(() => { if (parsed) window.history.replaceState(window.history.state, '', '/open-ref'); }, [parsed]);
  useEffect(() => {
    if (!confirmed || !parsed || expiredFile) return;
    openAgentRef(parsed.ref, navigate);
    setConfirmed(false);
  }, [confirmed, parsed, navigate, expiredFile]);
  useEffect(() => {
    if (!parsed?.token || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(AGENT_REF_CHANNEL);
    const ask = randomId();
    let live = true;
    let answered = false;
    channel.onmessage = (event) => {
      if (!live || answered || event.data?.answer !== ask) return;
      answered = true;
      setOpened(true);
      window.close();
    };
    const params = new URLSearchParams({ token: parsed.token, kind: parsed.ref.kind });
    if (parsed.ref.kind === 'file') {
      params.set('path', parsed.ref.path);
      if (parsed.ref.line) params.set('line', String(parsed.ref.line));
      if (parsed.ref.endLine) params.set('endLine', String(parsed.ref.endLine));
    } else params.set('id', parsed.ref.id);
    // StrictMode revokes its first effect before this tick; that request must never reach the reader.
    queueMicrotask(() => { if (live) channel.postMessage({ ask, href: `${window.location.origin}/open-ref#${params}` }); });
    return () => { live = false; channel.close(); };
  }, [parsed]);
  return <main className="open-agent-ref" style={{ padding: 24 }}>
    <h1>{opened ? 'Opened in Walnut' : 'Open in Walnut'}</h1>
    {!parsed ? <p>This reference is not valid.</p> : <>
      <p>{parsed.ref.kind === 'file' ? parsed.ref.path : parsed.ref.id}</p>
      {!opened && (expiredFile
        ? <p role="status">{waitedLong
          ? 'Waiting for the source document. If it was closed or reloaded, reopen it and click the path again. Walnut will not guess which machine holds this file.'
          : 'Opening in Walnut…'}</p>
        : <button type="button" onClick={() => setConfirmed(true)}>Open</button>)}
    </>}
  </main>;
}
