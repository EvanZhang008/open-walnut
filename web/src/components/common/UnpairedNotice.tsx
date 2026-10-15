/**
 * The sign-in page (spec 3): what a browser without a working sign-in sees,
 * full screen and opaque, so nothing of the console shows or takes a tap.
 *
 *   unpaired      no token; main.tsx renders this page alone (sign-in-gate.ts)
 *   revoked       a token the server refuses; it covers the booted console
 *   signed-out    this browser signed itself out (Settings > Phones & Cloud
 *                 sets sessionStorage['walnut.signedOut'] = 'self', then reloads)
 *   probe-failed  no token and GET /api/v1/me did not answer; the gate passes
 *                 `probeFailed` and `onRetryProbe` (spec D5)
 *   pending       a scanned `#pair=` code is being traded
 *
 * A code comes from the person at the computer Walnut runs on (Settings >
 * Phones & Cloud). Every string lives in sign-in-copy.ts.
 *
 * Portalled to <body> for the same reason as StaleBuildPill: a `contain: paint`
 * ancestor turns `position: fixed` into "fixed inside that box".
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getUnpairedState, subscribeUnpaired } from '@/api/unpaired';
import {
  exchangeBrowserCode, getFragmentPairState, subscribeFragmentPair, type FragmentPairState,
} from '@/api/browser-pair';
import { log } from '@/utils/log';
import { formatSignInCode } from './sign-in-code';
import {
  pickSignInState, signInCopy, SIGN_IN_PENDING_LINE, SIGN_IN_PENDING_SLOW, SIGN_IN_PENDING_TITLE, SIGN_IN_FAILED_SCAN_HEADING,
  SIGN_IN_SIGNED_OUT_FLAG, type SignInCopy, type SignInState,
} from './sign-in-copy';
import { UnpairedCodeField } from './UnpairedCodeField';
import '@/styles/unpaired-notice.css';

export interface UnpairedNoticeProps {
  /** No token and the sign-in probe did not answer (spec D5). */
  probeFailed?: boolean;
  /** Ask the probe again; the button stays busy until it settles. */
  onRetryProbe?: () => void | Promise<unknown>;
}

const SLOW_PENDING_MS = 6_000;

function matches(query: string): boolean {
  try { return window.matchMedia(query).matches; } catch { return false; }
}

/** Touch and Home Screen app, read once: neither changes while the page lives. */
function readEnv(): { touch: boolean; standalone: boolean } {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    touch: matches('(pointer: coarse)'),
    standalone: matches('(display-mode: standalone)') || nav.standalone === true,
  };
}

function signedOutBySelf(): boolean {
  try { return sessionStorage.getItem(SIGN_IN_SIGNED_OUT_FLAG) === 'self'; } catch { return false; }
}

function clearSignedOut(): void {
  try { sessionStorage.removeItem(SIGN_IN_SIGNED_OUT_FLAG); } catch { /* private mode */ }
}

export function UnpairedNotice({ probeFailed = false, onRetryProbe }: UnpairedNoticeProps = {}) {
  const state = useSyncExternalStore(subscribeUnpaired, getUnpairedState);
  const fragment = useSyncExternalStore(subscribeFragmentPair, getFragmentPairState);
  const [env] = useState(readEnv);
  // A scanned code is a new sign-in: the "Signed out" page no longer applies.
  useEffect(() => { if (fragment.phase === 'pending') clearSignedOut(); }, [fragment.phase]);
  // A `#pair=` code being traded shows its pending page before the console
  // boots (main.tsx), so the phone never sits on a blank page. A scanned code
  // that failed while an older sign-in still works (a used QR scanned again)
  // leaves that console alone: the gate booted it, and nothing is wrong.
  if (state === 'ok' && fragment.phase !== 'pending' && !probeFailed) return null;
  const signInState = pickSignInState(state, probeFailed, signedOutBySelf());
  const page = fragment.phase === 'pending'
    ? <PendingPage />
    : <SignInPage
        state={signInState}
        copy={signInCopy({ state: signInState, ...env })}
        fragment={fragment}
        onRetryProbe={onRetryProbe}
      />;
  return createPortal(page, document.body);
}

function Brand() {
  return <img className="unpaired-notice-icon" src="/walnut-icon.png" alt="" width={64} height={64} />;
}

/** A scanned code being traded: no steps, no form, one line and a ring. */
function PendingPage() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_PENDING_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="unpaired-notice unpaired-notice-pending" role="status" aria-busy="true" data-testid="unpaired-notice">
      <div className="unpaired-notice-column">
        <Brand />
        <h1 className="unpaired-notice-title">{SIGN_IN_PENDING_TITLE}</h1>
        <p className="unpaired-notice-tagline">{SIGN_IN_PENDING_LINE}</p>
        <span className="unpaired-notice-ring" aria-hidden="true" data-testid="unpaired-pending-ring" />
        {slow && <p className="unpaired-notice-slow" data-testid="unpaired-pending-slow">{SIGN_IN_PENDING_SLOW}</p>}
      </div>
    </div>
  );
}

function SignInPage({ state, copy, fragment, onRetryProbe }: {
  state: SignInState;
  copy: SignInCopy;
  fragment: FragmentPairState;
  onRetryProbe?: () => void | Promise<unknown>;
}) {
  const steps = (
    <ol className="unpaired-notice-steps" data-testid="unpaired-steps">
      {copy.steps.map((step, i) => (
        <li key={i}><span className="unpaired-notice-step-n" aria-hidden="true">{i + 1}</span><span>{step}</span></li>
      ))}
    </ol>
  );
  const code = (
    <section
      className={copy.codeFirst ? 'unpaired-notice-code unpaired-notice-code-first' : 'unpaired-notice-code'}
      aria-labelledby="unpaired-code-heading"
      data-testid="unpaired-code-section"
    >
      {/* After a scanned link failed, "Can't scan it?" no longer fits: the scan worked. */}
      <h2 className="unpaired-notice-h2" id="unpaired-code-heading">{fragment.phase === 'failed' ? SIGN_IN_FAILED_SCAN_HEADING : copy.codeHeading}</h2>
      {copy.codeHint && <p className="unpaired-notice-hint">{copy.codeHint}</p>}
      <CodeForm copy={copy} fragment={fragment} />
    </section>
  );
  return (
    <div className="unpaired-notice" aria-labelledby="unpaired-notice-title" data-testid="unpaired-notice" data-sign-in-state={state}>
      <div className="unpaired-notice-column">
        <Brand />
        <h1 className="unpaired-notice-title" id="unpaired-notice-title">{copy.title}</h1>
        <p className="unpaired-notice-tagline">{copy.tagline}</p>
        {copy.retry && (
          <button type="button" className="unpaired-notice-text-btn" onClick={() => window.location.reload()} data-testid="unpaired-retry">
            {copy.retry}
          </button>
        )}
        {copy.probeError && <ProbeRetry message={copy.probeError} label={copy.probeRetry ?? 'Try again'} onRetry={onRetryProbe} />}
        {copy.codeFirst ? <>{code}<hr className="unpaired-notice-rule" />{steps}</> : <>{steps}<hr className="unpaired-notice-rule" />{code}</>}
        <p className="unpaired-notice-more">{copy.footer}</p>
      </div>
    </div>
  );
}

function ProbeRetry({ message, label, onRetry }: { message: string; label: string; onRetry?: () => void | Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    if (busy) return;
    if (!onRetry) { window.location.reload(); return; }
    setBusy(true);
    Promise.resolve().then(onRetry).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <div className="unpaired-notice-probe">
      <p className="unpaired-notice-error" role="alert" data-testid="unpaired-probe-error">
        {message}
      </p>
      <button type="button" className="unpaired-notice-text-btn" onClick={retry} disabled={busy} aria-busy={busy || undefined} data-testid="unpaired-probe-retry">
        {busy && <span className="unpaired-notice-spinner" aria-hidden="true" />}
        <span>{label}</span>
      </button>
    </div>
  );
}

/** api/browser-pair.ts's answer when no response came back at all. */
function isNetworkFailure(message: string): boolean {
  return /did not answer/i.test(message);
}

function CodeForm({ copy, fragment }: { copy: SignInCopy; fragment: FragmentPairState }) {
  const [code, setCode] = useState(fragment.phase === 'failed' ? formatSignInCode(fragment.code).display : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(fragment.phase === 'failed' ? fragment.message : null);
  // The server's answer was about the code itself (not "Walnut did not
  // answer"): the same code would be refused again, so it waits for an edit.
  const [refused, setRefused] = useState(fragment.phase === 'failed' && !isNetworkFailure(fragment.message));
  // A scanned code that failed: the code stays in the field with the reason.
  useEffect(() => {
    if (fragment.phase !== 'failed') return;
    setCode(formatSignInCode(fragment.code).display);
    setError(fragment.message);
    setRefused(!isNetworkFailure(fragment.message));
  }, [fragment]);

  const submit = (display: string) => {
    if (busy) return;
    // Busy in the same frame as the tap (a discrete event renders at once),
    // before the request even leaves.
    setBusy(true);
    setError(null);
    void exchangeBrowserCode(display).then((result) => {
      if (result.ok) {
        clearSignedOut();
        // Every request and the WebSocket start over with the new token; the
        // button stays busy until the page is replaced.
        window.location.reload();
        return;
      }
      log.info('pairing', 'sign-in page: code refused', { message: result.message });
      setBusy(false);
      setError(result.message);
      setRefused(!isNetworkFailure(result.message));
    });
  };

  return (
    <UnpairedCodeField
      value={code}
      onValueChange={(next) => { if (next !== code) { setRefused(false); setError(null); } setCode(next); }}
      error={error}
      busy={busy}
      refused={refused}
      label={copy.inputLabel}
      placeholder={copy.placeholder}
      submitLabel={copy.submit}
      busyLabel={copy.submitBusy}
      onSubmit={submit}
    />
  );
}
