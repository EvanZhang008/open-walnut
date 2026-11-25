/**
 * The note a pressed locked engine shows at the top of the model picker's pane: why it cannot be
 * picked. An engine Walnut sets up itself (installs it on the host, signs it in: Settings >
 * Sessions, engine-sign-in-model.ts) also gets the one button that does it: it goes to that
 * host's row there and starts the install, or the sign-in when the engine is installed.
 * 2026-11-25: Antigravity read "Not installed here" on a draft on the Mac, with nothing to do
 * about it ("why anto gravity is not instlal here").
 */
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { hasSignInUi, openEngineSignIn, ENGINE_SIGN_IN_UI } from '@/components/settings/sections/engine-sign-in-model';
import { log } from '@/utils/log';

export interface LockedPick {
  /** "<Engine>: <why>", as the rail's second line says it. */
  text: string;
  engine: string;
  /** The short reason (utils/engines.ts shortLockReason). */
  why: string;
}

/** Locks no setup lifts: the caller's own rules, or a machine the engine never runs on. */
const NOT_A_SETUP = new Set(['Needs a new session', 'A fork keeps its engine', 'Quick questions use Claude Code', 'Runs on this computer only']);

/** Pressing it would set the engine up on the host, so the note offers it. */
export function setupLiftsLock(pick: Pick<LockedPick, 'engine' | 'why'>): boolean {
  return hasSignInUi(pick.engine) && !NOT_A_SETUP.has(pick.why);
}

export function LockedEngineNote({ pick, host, onClose }: { pick: LockedPick; host?: string; onClose?: () => void }) {
  return (
    <div className="model-picker-locked-note" role="status" data-testid="model-picker-locked-note">
      {pick.text}
      {setupLiftsLock(pick) && <SetUpEngine pick={pick} host={host} onClose={onClose} />}
    </div>
  );
}

function SetUpEngine(props: { pick: LockedPick; host?: string; onClose?: () => void }) {
  // The browser extension's popout has no Settings page to go to.
  if (!useInRouterContext()) return null;
  return <SetUpEngineButton {...props} />;
}

function SetUpEngineButton({ pick, host, onClose }: { pick: LockedPick; host?: string; onClose?: () => void }) {
  const navigate = useNavigate();
  const name = hasSignInUi(pick.engine) ? ENGINE_SIGN_IN_UI[pick.engine].name : pick.engine;
  // The row of the host the draft or session is on ('__local__' for this machine).
  const hostKey = host && host !== 'local' ? host : '__local__';
  const label = pick.why === 'Not installed here' ? `Install ${name}` : `Set up ${name}`;
  return (
    <button
      type="button"
      className="btn btn-sm model-picker-locked-setup"
      data-testid="model-picker-locked-setup"
      onClick={() => {
        log.info('session', 'set up a locked engine from the model picker', { engine: pick.engine, host: hostKey, why: pick.why });
        onClose?.();
        openEngineSignIn(navigate, { engine: pick.engine, host: hostKey });
      }}
    >
      {label}
    </button>
  );
}
