/**
 * One host's row in "<Engine> sign-in" (EngineSignInGroup): its state as a dot and a word, its
 * one action, and, while a sign-in is open, ONE compact row under it: the account's link, the
 * pasted code and Finish, with "Use a <key> instead" leading to the group's one API key row (the
 * key is one setting for every machine, EngineApiKeyRow).
 *
 * Every step that answers late is read against the row's generation: a Cancel moves it on, so a
 * link that arrives after it is ended on the host at once, and a code refused after it starts
 * nothing new.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { HostCommands } from '@/components/hosts/HostCommands';
import { log } from '@/utils/log';
import {
  cancelEngineSignIn, engineInstallStatus, engineSignInStatus, finishEngineSignIn, signOutEngine, startEngineInstall, startEngineSignIn,
  type EngineSignInLink, type EngineSignInStatus,
} from '@/api/engine-sign-in';
import {
  ENGINE_SIGN_IN_UI, codeEndsSignIn, refusalCode, refusalWords, rowView, signInRowId, takeSignInRequest,
  type SignInEngine, type SignInRequest,
} from './engine-sign-in-model';

type Busy = 'start' | 'finish' | 'sign-out' | 'install' | 'check' | null;
const INSTALL_POLL_MS = 2_000;

export function EngineSignInRow({ engine, status, onStatus, onUseKey, request }: {
  engine: SignInEngine;
  status: EngineSignInStatus;
  onStatus: (s: EngineSignInStatus) => void;
  /** "Use a <key> instead": the group's API key row takes over (this row's sign-in is ended). */
  onUseKey: () => void;
  /** The chat's "Open Settings to sign in" naming some host (the row takes it if it is this one). */
  request: SignInRequest | null;
}) {
  const ui = ENGINE_SIGN_IN_UI[engine];
  const { host, hostName } = status;
  const [link, setLink] = useState<EngineSignInLink | null>(status.signIn);
  const [open, setOpen] = useState(!!status.signIn);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy>(status.install.state === 'running' ? 'install' : null);
  const [error, setError] = useState<string | null>(null);
  const [codeBad, setCodeBad] = useState(false);
  const alive = useRef(true);
  // Set again on every mount: StrictMode mounts twice, and a flag cleared by the first unmount left every answer unread.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** Moves on at every Cancel: an answer of an older generation changes nothing here. */
  const gen = useRef(0);
  const ctx = { engine, host };

  const run = useLeanCallback(async <T,>(what: Exclude<Busy, null>, work: () => Promise<T>): Promise<T | undefined> => {
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

  /** A link that came back for a sign-in this row no longer waits on (a Cancel came first): ended on the host. */
  const dropLate = (late: EngineSignInLink) => {
    log.info('settings', 'engine sign-in link came after a cancel: ending it', { ...ctx, id: late.id });
    void cancelEngineSignIn(engine, host, late.id).catch((err: unknown) => log.warn('settings', 'engine sign-in cancel failed', { ...ctx, id: late.id, error: String(err) }));
  };

  const startGoogle = useLeanCallback(async (restart = false) => {
    const g = gen.current;
    const started = await run('start', () => startEngineSignIn(engine, host, restart));
    if (!started) return;
    if (g !== gen.current || !alive.current) return dropLate(started);
    log.info('settings', 'engine sign-in link ready', { ...ctx, id: started.id, reused: started.reused === true });
    setLink(started);
    setOpen(true);
  }, [run, engine, host]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = useLeanCallback(async () => {
    const s = await run('check', () => engineSignInStatus(engine, host, true));
    if (s && alive.current) onStatus(s);
    return s;
  }, [run, engine, host, onStatus]);

  /** Install the engine on the host: its button, and a link that asked for it. The run is followed below. */
  const install = useLeanCallback(async () => {
    const st = await run('install', () => startEngineInstall(engine, host));
    if (st?.state === 'running') setBusy('install');
    else if (st) void check();
  }, [run, engine, host, check]);

  // The chat asked to sign this host in: land here and open its sign-in (a host never asked yet is checked first).
  useEffect(() => {
    if (!request || !takeSignInRequest(status)) return;
    log.info('settings', 'engine sign-in opened from a link', { ...ctx, state: status.state, connected: status.connected !== false });
    void (async () => {
      const s = status.state === 'unknown' ? await check() : status;
      // Not on the host yet (the picker's "Install" on a locked engine): the install starts here.
      if (s?.state === 'not_installed' && s.install?.canInstall) await install();
      else if (s?.state === 'not_signed_in' && !s.signIn) await startGoogle();
      else if (s?.signIn) { setLink(s.signIn); setOpen(true); }
    })();
  }, [request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // An install runs on the host: follow it, then read the host again before the row lets go of "Installing".
  useEffect(() => {
    if (busy !== 'install') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const st = await engineInstallStatus(engine, host);
        if (!alive.current) return;
        if (st.state === 'running') { timer = setTimeout(() => void tick(), INSTALL_POLL_MS); return; }
        log.info('settings', 'engine install ended', { ...ctx, state: st.state, exitCode: st.exitCode ?? null });
        const s = await engineSignInStatus(engine, host, true).catch(() => null);
        if (!alive.current) return;
        if (st.state === 'failed') setError(`The install on ${hostName} failed${st.error ? `: ${st.error}` : st.exitCode != null ? ` (exit ${st.exitCode})` : ''}.`);
        if (s) onStatus(s);
        setBusy(null);
      } catch (err) {
        if (!alive.current) return;
        setBusy(null);
        setError(refusalWords(err, 'install', hostName));
      }
    };
    timer = setTimeout(() => void tick(), INSTALL_POLL_MS);
    return () => { if (timer) clearTimeout(timer); };
  }, [busy === 'install']); // eslint-disable-line react-hooks/exhaustive-deps

  const close = async () => {
    gen.current += 1;
    const id = link?.id;
    setOpen(false); setLink(null); setCode(''); setError(null); setCodeBad(false);
    // The host ends a waiting sign-in by itself after a while too: a cancel it did not hear is said in the log only.
    if (id) await cancelEngineSignIn(engine, host, id).catch((err: unknown) => log.warn('settings', 'engine sign-in cancel failed', { ...ctx, id, error: String(err) }));
  };

  // The CLI ended that sign-in (a refused code, a timeout): a new one, its link behind the same words; Finish waits for it.
  const renewLink = async (g: number) => {
    setBusy('start');
    try {
      const fresh = await startEngineSignIn(engine, host, true);
      if (g !== gen.current || !alive.current) return dropLate(fresh);
      setLink(fresh);
    } catch (e) {
      log.warn('settings', 'engine sign-in restart failed', { ...ctx, error: String(e) });
      if (alive.current && g === gen.current) setError(refusalWords(e, 'start', hostName));
    } finally {
      if (alive.current) setBusy((b) => (b === 'start' ? null : b));
    }
  };

  const finish = async () => {
    if (!link || !code.trim()) return;
    const g = gen.current;
    setCodeBad(false);
    setBusy('finish');
    setError(null);
    try {
      const { status: s } = await finishEngineSignIn(engine, host, link.id, code.trim());
      if (!alive.current) return;
      log.info('settings', 'engine signed in', { ...ctx, method: s.method });
      // Signed in is the host's truth, a Cancel pressed meanwhile or not.
      onStatus(s);
      if (g === gen.current) { setOpen(false); setLink(null); setCode(''); }
    } catch (err) {
      const why = refusalCode(err);
      log.warn('settings', 'engine sign-in code refused', { ...ctx, code: why, late: g !== gen.current });
      if (!alive.current || g !== gen.current) return;
      setError(refusalWords(err, 'finish', hostName));
      setCodeBad(why === 'bad_code' || why === 'invalid_code');
      // The CLI ended that sign-in: a new link waits behind "Open Google sign-in" for the next code.
      if (codeEndsSignIn(why)) void renewLink(g);
    } finally {
      if (alive.current) setBusy((b) => (b === 'finish' ? null : b));
    }
  };

  const useKey = () => { void close(); onUseKey(); };

  const act = async () => {
    const view = rowView(status, engine);
    if (view.action === 'sign-in') return startGoogle();
    if (view.action === 'check') return void check();
    if (view.action === 'sign-out') {
      const r = await run('sign-out', () => signOutEngine(engine, host));
      if (r && alive.current) { log.info('settings', 'engine signed out', ctx); onStatus(r.status); }
      return;
    }
    if (view.action === 'install') await install();
  };

  const view = rowView(status, engine);
  const installing = busy === 'install';
  const busyLabel = installing ? `Installing on ${hostName}...` : busy === 'start' && !open ? 'Opening...' : busy === 'sign-out' ? 'Signing out...'
    : busy === 'check' ? 'Checking...' : undefined;
  const actionLabel = error && view.action === 'install' ? 'Try again' : view.actionLabel;

  return (
    // The whole host (its row and its sign-in line) is the deep link's target, so the landing points at both.
    <div className="settings-addons-rows" id={signInRowId(engine, host)} data-testid={`engine-sign-in-${host}`} data-state={status.state} data-open={open ? 'true' : 'false'}>
      <SettingsRow
        // This machine is "This Mac" at a row's start (the server says "this Mac" for a sentence).
        label={host === '__local__' ? hostName.charAt(0).toUpperCase() + hostName.slice(1) : hostName}
        help={<NoticeStatus tone={installing ? 'live' : view.tone} title={view.title}>{installing ? 'Installing' : view.word}</NoticeStatus>}
        error={open ? null : error}
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
        {view.installCommand && <HostCommands wrap commands={[view.installCommand]} testId="engine-sign-in-install-command" />}
      </SettingsRow>
      {open && (
        <SettingsRow
          indent
          label={link
            ? <a className="btn btn-sm btn-link" href={link.link} target="_blank" rel="noopener noreferrer" data-testid="engine-sign-in-link"
                onClick={() => log.info('settings', 'engine sign-in link opened', { ...ctx, id: link.id })}>Open {ui.account} sign-in ↗</a>
            : <span className="settings-addons-muted">Getting a new link...</span>}
          help={<>Paste the code it shows.{' '}
            <SettingsButton variant="text" onClick={useKey} data-testid="engine-sign-in-use-key">Use a {ui.keyName} instead</SettingsButton></>}
          error={error}
          state={error ? 'error' : undefined}
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
              <SettingsButton variant="primary" disabled={!code.trim() || !link || busy === 'start'} busy={busy === 'finish'} busyLabel="Signing in..."
                onClick={() => void finish()} data-testid="engine-sign-in-finish">Finish</SettingsButton>
            </span>
          )}
          data-testid="engine-sign-in-step"
        />
      )}
    </div>
  );
}
