/**
 * One host's row in "<Engine> sign-in" (EngineSignInGroup): its state as a dot and a word, its
 * one action, and, while a sign-in is open, ONE compact row under it: the account's link, the
 * pasted code and Finish (or the API key and Save), with the other way in as a text link. The
 * two views keep the same field and button widths, so switching moves nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { HostCommands } from '@/components/hosts/HostCommands';
import { log } from '@/utils/log';
import {
  cancelEngineSignIn, engineInstallStatus, engineSignInStatus, finishEngineSignIn, removeEngineApiKey,
  saveEngineApiKey, signOutEngine, startEngineInstall, startEngineSignIn,
  type EngineSignInLink, type EngineSignInStatus,
} from '@/api/engine-sign-in';
import {
  ENGINE_SIGN_IN_UI, codeEndsSignIn, refusalCode, refusalWords, rowView, signInRowId, takeSignInRequest,
  type SignInEngine, type SignInRequest,
} from './engine-sign-in-model';

type Busy = 'start' | 'finish' | 'sign-out' | 'key' | 'install' | 'check' | null;
/** Both submit keys reserve the widest label either shows, so the field left of them never moves. */
const SUBMIT_RESERVE = ['Signing in...', 'Saving...'];
const INSTALL_POLL_MS = 3_000;

export function EngineSignInRow({ engine, status, onStatus, onKeyChanged, request }: {
  engine: SignInEngine;
  status: EngineSignInStatus;
  onStatus: (s: EngineSignInStatus) => void;
  /** The API key is one setting for every host: the group reads every row again. */
  onKeyChanged: () => void;
  /** The chat's "Open Settings to sign in" naming some host (the row takes it if it is this one). */
  request: SignInRequest | null;
}) {
  const ui = ENGINE_SIGN_IN_UI[engine];
  const { host, hostName } = status;
  const [mode, setMode] = useState<'idle' | 'google' | 'key'>(status.signIn ? 'google' : 'idle');
  const [link, setLink] = useState<EngineSignInLink | null>(status.signIn);
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<Busy>(status.install.state === 'running' ? 'install' : null);
  const [error, setError] = useState<string | null>(null);
  const [codeBad, setCodeBad] = useState(false);
  const alive = useRef(true);
  // Set again on every mount: StrictMode mounts twice, and a flag cleared by the first unmount left every answer unread.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ctx = { engine, host };

  const run = useCallback(async <T,>(what: Exclude<Busy, null>, work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what);
    setError(null);
    try {
      return await work();
    } catch (err) {
      log.warn('settings', 'engine sign-in step refused', { ...ctx, step: what, code: refusalCode(err), error: String(err) });
      if (alive.current) setError(refusalWords(err, what, hostName));
      return undefined;
    } finally {
      if (alive.current) setBusy((b) => (b === what ? null : b));
    }
  }, [engine, host, hostName]); // eslint-disable-line react-hooks/exhaustive-deps

  const startGoogle = useCallback(async (restart = false) => {
    const started = await run('start', () => startEngineSignIn(engine, host, restart));
    if (!started || !alive.current) return;
    log.info('settings', 'engine sign-in link ready', { ...ctx, id: started.id, reused: started.reused === true });
    setLink(started);
    setMode('google');
  }, [run, engine, host]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = useCallback(async () => {
    const s = await run('check', () => engineSignInStatus(engine, host, true));
    if (s && alive.current) onStatus(s);
    return s;
  }, [run, engine, host, onStatus]);

  // The chat asked to sign this host in: land here and open its sign-in (a host never asked yet is checked first).
  useEffect(() => {
    if (!request || !takeSignInRequest(status)) return;
    log.info('settings', 'engine sign-in opened from a link', { ...ctx, state: status.state, connected: status.connected !== false });
    void (async () => {
      const s = status.state === 'unknown' ? await check() : status;
      if (s?.state === 'not_signed_in' && !s.signIn) await startGoogle();
      else if (s?.signIn) { setLink(s.signIn); setMode('google'); }
    })();
  }, [request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // An install runs on the host: follow it, then read the host again.
  useEffect(() => {
    if (busy !== 'install') return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const st = await engineInstallStatus(engine, host);
        if (stop) return;
        if (st.state === 'running') { setTimeout(() => void tick(), INSTALL_POLL_MS); return; }
        log.info('settings', 'engine install ended', { ...ctx, state: st.state, exitCode: st.exitCode ?? null });
        if (st.state === 'failed') setError(`The install on ${hostName} failed${st.error ? `: ${st.error}` : st.exitCode != null ? ` (exit ${st.exitCode})` : ''}.`);
        setBusy(null);
        const s = await engineSignInStatus(engine, host, true).catch(() => null);
        if (s && !stop) onStatus(s);
      } catch (err) {
        if (stop) return;
        setBusy(null);
        setError(refusalWords(err, 'install', hostName));
      }
    };
    const t = setTimeout(() => void tick(), INSTALL_POLL_MS);
    return () => { stop = true; clearTimeout(t); };
  }, [busy === 'install']); // eslint-disable-line react-hooks/exhaustive-deps

  const close = async () => {
    const id = link?.id;
    setMode('idle'); setLink(null); setCode(''); setKey(''); setError(null); setCodeBad(false);
    // The host ends a waiting sign-in by itself after a while too: a cancel it did not hear is said in the log only.
    if (id) await cancelEngineSignIn(engine, host, id).catch((err: unknown) => log.warn('settings', 'engine sign-in cancel failed', { ...ctx, id, error: String(err) }));
  };

  // The CLI ended that sign-in (a refused code, a timeout): a new one, its link behind the same words; Finish waits for it.
  const renewLink = async () => {
    setBusy('start');
    try {
      const fresh = await startEngineSignIn(engine, host, true);
      if (alive.current) setLink(fresh);
    } catch (e) {
      log.warn('settings', 'engine sign-in restart failed', { ...ctx, error: String(e) });
      if (alive.current) setError(refusalWords(e, 'start', hostName));
    } finally {
      if (alive.current) setBusy((b) => (b === 'start' ? null : b));
    }
  };

  const finish = async () => {
    if (!link || !code.trim()) return;
    setCodeBad(false);
    setBusy('finish');
    setError(null);
    try {
      const { status: s } = await finishEngineSignIn(engine, host, link.id, code.trim());
      if (!alive.current) return;
      log.info('settings', 'engine signed in', { ...ctx, method: s.method });
      setMode('idle'); setLink(null); setCode('');
      onStatus(s);
    } catch (err) {
      const why = refusalCode(err);
      log.warn('settings', 'engine sign-in code refused', { ...ctx, code: why });
      if (!alive.current) return;
      setError(refusalWords(err, 'finish', hostName));
      setCodeBad(why === 'bad_code' || why === 'invalid_code');
      // The CLI ended that sign-in: a new link waits behind "Open Google sign-in" for the next code.
      if (codeEndsSignIn(why)) void renewLink();
    } finally {
      if (alive.current) setBusy((b) => (b === 'finish' ? null : b));
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    const r = await run('key', () => saveEngineApiKey(engine, key.trim(), host));
    if (!r || !alive.current) return;
    log.info('settings', 'engine api key saved', ctx);
    if (link) void cancelEngineSignIn(engine, host, link.id).catch(() => {});
    setMode('idle'); setLink(null); setKey('');
    if (r.status) onStatus(r.status);
    onKeyChanged();
  };

  const act = async () => {
    const view = rowView(status, engine);
    if (view.action === 'sign-in') return startGoogle();
    if (view.action === 'check') return void check();
    if (view.action === 'sign-out') {
      const r = await run('sign-out', () => signOutEngine(engine, host));
      if (r) { log.info('settings', 'engine signed out', ctx); onStatus(r.status); }
      return;
    }
    if (view.action === 'remove-key') {
      const r = await run('key', () => removeEngineApiKey(engine, host));
      if (r) { log.info('settings', 'engine api key removed', ctx); if (r.status) onStatus(r.status); onKeyChanged(); }
      return;
    }
    if (view.action === 'install') {
      const st = await run('install', () => startEngineInstall(engine, host));
      if (st?.state === 'running') setBusy('install');
      else if (st) void check();
    }
  };

  const view = rowView(status, engine);
  const open = mode !== 'idle';
  const installing = busy === 'install';
  const busyLabel = installing ? `Installing on ${hostName}...` : busy === 'start' ? 'Opening...' : busy === 'sign-out' ? 'Signing out...'
    : busy === 'check' ? 'Checking...' : busy === 'key' && !open ? 'Removing...' : undefined;
  const actionLabel = error && view.action === 'install' ? 'Try again' : view.actionLabel;
  const rowError = open ? null : error;
  const stepError = open ? error : null;

  return (
    <div className="settings-addons-rows" data-testid={`engine-sign-in-${host}`} data-state={status.state} data-mode={mode}>
      <SettingsRow
        anchor={signInRowId(engine, host)}
        // This machine is "This Mac" at a row's start (the server says "this Mac" for a sentence).
        label={host === '__local__' ? hostName.charAt(0).toUpperCase() + hostName.slice(1) : hostName}
        help={<NoticeStatus tone={installing ? 'live' : view.tone} title={view.title}>{installing ? 'Installing' : view.word}</NoticeStatus>}
        error={rowError}
        control={open
          ? <SettingsButton onClick={() => void close()} data-testid="engine-sign-in-cancel">Cancel</SettingsButton>
          : view.action && (
            <SettingsButton
              onClick={() => void act()}
              busy={busy !== null && busy !== 'finish'}
              busyLabel={busyLabel}
              reserve={busyLabel ? [busyLabel] : undefined}
              data-testid="engine-sign-in-action"
            >{actionLabel}</SettingsButton>
          )}
        data-testid="engine-sign-in-row"
      >
        {view.installCommand && !open && <HostCommands commands={[view.installCommand]} testId="engine-sign-in-install-command" />}
      </SettingsRow>
      {mode === 'google' && (
        <SettingsRow
          indent
          label={link
            ? <a className="btn btn-sm btn-link" href={link.link} target="_blank" rel="noopener noreferrer" data-testid="engine-sign-in-link"
                onClick={() => log.info('settings', 'engine sign-in link opened', { ...ctx, id: link.id })}>Open {ui.account} sign-in ↗</a>
            : <span className="settings-addons-muted">Getting a new link...</span>}
          help={<>Paste the code it shows.{' '}
            <SettingsButton variant="text" onClick={() => { setMode('key'); setError(null); setCodeBad(false); }} data-testid="engine-sign-in-use-key">Use a {ui.keyName} instead</SettingsButton></>}
          error={stepError}
          state={stepError ? 'error' : undefined}
          control={(
            <span className="settings-control-cluster">
              <input
                className="settings-input settings-input--short"
                type="text"
                aria-label={`Code from ${ui.account}`}
                placeholder={`Code from ${ui.account}`}
                autoComplete="off"
                spellCheck={false}
                data-no-draft="secret"
                value={code}
                aria-invalid={codeBad || undefined}
                onChange={(e) => { setCode(e.target.value); if (codeBad) setCodeBad(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void finish(); }}
                data-testid="engine-sign-in-code"
              />
              <SettingsButton variant="primary" disabled={!code.trim() || !link || busy === 'start'} busy={busy === 'finish'} busyLabel="Signing in..." reserve={SUBMIT_RESERVE}
                onClick={() => void finish()} data-testid="engine-sign-in-finish">Finish</SettingsButton>
            </span>
          )}
          data-testid="engine-sign-in-step"
        />
      )}
      {mode === 'key' && (
        <SettingsRow
          indent
          label={ui.keyName}
          help={<>Only {ui.name} uses it.{' '}
            <SettingsButton variant="text" onClick={() => { setMode('google'); setError(null); if (!link) void startGoogle(); }} data-testid="engine-sign-in-use-google">Use {ui.account} sign-in instead</SettingsButton></>}
          error={stepError}
          state={stepError ? 'error' : undefined}
          control={(
            <span className="settings-control-cluster">
              <input
                className="settings-input settings-input--short"
                type="password"
                aria-label={ui.keyName}
                autoComplete="off"
                spellCheck={false}
                data-no-draft="secret"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
                data-testid="engine-sign-in-key"
              />
              <SettingsButton variant="primary" disabled={!key.trim()} busy={busy === 'key'} busyLabel="Saving..." reserve={SUBMIT_RESERVE}
                onClick={() => void saveKey()} data-testid="engine-sign-in-save-key">Save</SettingsButton>
            </span>
          )}
          data-testid="engine-sign-in-step"
        />
      )}
    </div>
  );
}
