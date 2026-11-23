import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_REF_CHANNEL, openAgentRef, parseAgentRef } from '@/utils/agent-ref-open';
import { randomId } from '@/utils/random-id';
import { openFileAnywhere } from '@/utils/open-anywhere';

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
  // The source document did not answer (closed or reloaded): one press looks the file up on every
  // machine, instead of waiting on it (2026-11-23, Evan: "Why walnut not auto pic the host"). A press,
  // never by itself: a link in a page must not open a file the person did not ask for.
  const openAnywhere = () => {
    if (!parsed || parsed.ref.kind !== 'file') return;
    const { path, line, endLine } = parsed.ref;
    openFileAnywhere({ path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), anywhere: true });
  };
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
      {!opened && expiredFile && <p role="status">{waitedLong
        ? 'The source document did not answer. Open looks for this file on every machine.'
        : 'Opening in Walnut…'}</p>}
      {/* One Open: confirms a plain reference, or, once the source document did not answer, looks the file up everywhere. */}
      {!opened && (!expiredFile || waitedLong) && (
        <button type="button" onClick={expiredFile ? openAnywhere : () => setConfirmed(true)}>Open</button>
      )}
    </>}
  </main>;
}
