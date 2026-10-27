/**
 * The result an island offered the AI, shown under it, sent only by the user's press.
 *
 * The user's two rules (2026-10-27): they can see exactly what is sent, and nothing
 * goes out on their behalf. So this card lives OUTSIDE the frame (a page cannot draw
 * or press it), shows the whole text that will be sent, character for character, and
 * the one way it reaches the session is the Send button. Sent is remembered with the
 * island (island-store.ts), so a reload does not offer the same result again.
 */
import { useEffect, useRef, useState } from 'react';
import { log } from '@/utils/log';
import { copyTextRobust } from '@/utils/clipboard';
import { ISLAND_RESULT_MAX, isCommandLike } from './island-runtime';
import { dismissIslandResult, markIslandResultSent, readIsland, type IslandResult } from './island-store';
import './island-result.css';

type SendState = 'idle' | 'sending' | 'failed';

/**
 * Send waits this long after the text last changed (ms). The page can report new text
 * at any moment, also between the user reading the card and the press (on the pointer
 * leaving the frame, say); a press must send what they read, so a fresh change makes
 * them look again first.
 */
const SETTLE_MS = 1200;

export function IslandResultCard({ storeKey, result, onChange, sendResult }: {
  storeKey: string;
  result: IslandResult;
  onChange: (next: IslandResult | undefined) => void;
  sendResult?: (text: string) => Promise<boolean>;
}) {
  const [state, setState] = useState<SendState>('idle');
  const [copied, setCopied] = useState(false);
  // The text as it stood when the pointer went down on Send: the press sends that.
  const pressedText = useRef<string | null>(null);
  const [settling, setSettling] = useState(false);
  const firstText = useRef(result.text);
  useEffect(() => {
    // The text the card opened with is not a change; every later one is.
    if (result.text === firstText.current) return;
    firstText.current = result.text;
    setState('idle');
    setSettling(true);
    const t = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [result.text]);
  const tooLong = result.text.length > ISLAND_RESULT_MAX;
  const empty = result.text.trim() === '';
  const command = isCommandLike(result.text);
  const blocked = tooLong || empty || command;

  const send = async () => {
    // An activation with no pointer or key before it (assistive tech) sends the text on
    // screen; the settle wait still covers a change made just before it.
    const text = pressedText.current ?? result.text;
    pressedText.current = null;
    if (!sendResult || blocked || settling || state === 'sending') return;
    // Changed between the press and the release: send nothing, the card shows the new text.
    if (text !== result.text) return;
    setState('sending');
    let ok = false;
    try { ok = await sendResult(text); } catch { ok = false; }
    log.info('island', ok ? 'result sent' : 'result send failed', { storeKey, chars: text.length });
    if (ok) {
      markIslandResultSent(storeKey, text);
      // The store's copy: the page may have offered newer text while this was sending.
      onChange(readIsland(storeKey).result);
      setState('idle');
    } else {
      setState('failed');
    }
  };

  const dismiss = () => {
    dismissIslandResult(storeKey);
    onChange(undefined);
  };

  const copy = async () => {
    setCopied((await copyTextRobust(result.text)) !== 'failed');
  };

  return (
    <div className="island-result" data-sent={result.sent ? 'true' : 'false'} role="group" aria-label="Result from this block">
      <div className="island-result-head">
        <span className="island-result-title">{result.sent ? 'Sent to the AI' : 'Result for the AI'}</span>
        {!result.sent && <span className="island-result-note">Nothing is sent until you press Send.</span>}
      </div>
      <pre className="island-result-text">{result.text}</pre>
      <div className="island-result-actions">
        {tooLong && (
          <span className="island-result-error">
            Too long to send ({result.text.length.toLocaleString()} of {ISLAND_RESULT_MAX.toLocaleString()} characters).
          </span>
        )}
        {command && (
          <span className="island-result-error">Starts with “/”, so it would run as a command. Not sendable.</span>
        )}
        {settling && !blocked && <span className="island-result-note">Updated just now.</span>}
        {state === 'failed' && <span className="island-result-error">Not sent. Try again.</span>}
        {!result.sent && sendResult && (
          <button
            type="button"
            className="island-result-send"
            onPointerDown={() => { pressedText.current = result.text; }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') pressedText.current = result.text; }}
            onClick={() => { void send(); }}
            disabled={blocked || settling || state === 'sending'}
          >
            {state === 'sending' ? 'Sending…' : 'Send to AI'}
          </button>
        )}
        <button type="button" className="island-result-secondary" onClick={() => { void copy(); }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="island-result-secondary" onClick={dismiss} aria-label="Dismiss result">
          Dismiss
        </button>
      </div>
    </div>
  );
}
