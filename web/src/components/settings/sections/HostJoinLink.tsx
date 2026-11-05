/**
 * Settings > Remote Hosts: the join link, the first row of Hosts while it is in use
 * (useHostNetwork.ts). The command and its Copy come first, for the system the new machine
 * runs (macOS, Linux or Windows; the pick is remembered); the notes (Windows signing, the
 * PowerShell way, how the machines reach each other) fold under "More about this link".
 * 2026-11-04 review: six lines of notes stood before the command, so the command did not
 * stand out. Close puts the card away; a link that still waits keeps working, and the list says
 * so in its place ("Link still works for 9 min", with Cancel link: HostJoinClosed). While a link
 * is made, "Making a link..." holds its place; a link that could not be made says why there,
 * with the fix its reason names (join-link-model.ts): start the host network, Phones & Cloud,
 * or Try again.
 */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { NetInvite, NetRelay } from '@/api/hosts-net';
import { closedLinkNote, joinFix, type JoinFailure } from './join-link-model';
import { focusLanded } from '@/utils/focus-landed';
import { usePageView } from '@/utils/view-memory';
import { oneOf } from '@/hooks/usePersistentState';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { ChevronGlyph, SpinnerGlyph } from '../settings-glyphs';

type JoinOs = 'mac' | 'linux' | 'windows';
const isOs = oneOf(['mac', 'linux', 'windows'] as const);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function left(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How the machines reach this Mac, for the relay in use. */
export function relayNote(relay: NetRelay): string {
  if (relay === 'none') return 'The machine needs no SSH: it reaches this Mac directly. Only Walnut can use this connection.';
  if (relay === 'public') return 'The machine needs no SSH: it reaches this Mac directly, or through a public relay that cannot read the traffic. Only Walnut can use this connection.';
  return 'The machine needs no SSH: it reaches this Mac directly, or through the relay on your cloud companion. Only Walnut can use this connection.';
}

function Command({ text, testId, copyId }: { text: string; testId: string; copyId: string }) {
  return (
    <span className="rh-join-command">
      <code className="settings-addons-mono" data-testid={testId}>{text}</code>
      <CopyButton text={text} variant="default" data-testid={copyId} />
    </span>
  );
}

interface Props {
  invite: NetInvite;
  /** A cloud companion is paired (false: this Mac keeps the list, so it must stay awake). */
  companion: boolean | undefined;
  relay: NetRelay;
  making: boolean;
  onNewLink: () => void;
  onDone: () => void;
  /** The person did something with the card (copied, picked a system): it is no longer untouched. */
  onTouched?: () => void;
}

/** The row in the link's place while it is made (in view, and focused, from the press). */
export function HostJoinMaking() {
  return (
    <SettingsRow
      className="rh-join rh-join-making"
      data-testid="host-network-making"
      role="status"
      aria-live="polite"
      tabIndex={-1}
      label={<span className="rh-join-making-label"><SpinnerGlyph size={12} />Making a link...</span>}
      help="A link works once, for 10 minutes."
    />
  );
}

/** Why the link could not be made, in its place, with the fix its reason names (which takes the focus). */
export function HostJoinError({ error, liveLink, starting, onRetry, onStart, onShowOpen, onDone }: {
  error: JoinFailure;
  /** A link made earlier still waits (out of sight). */
  liveLink: boolean;
  starting: boolean;
  onRetry: () => void;
  onStart: () => void;
  onShowOpen: () => void;
  onDone: () => void;
}) {
  const fix = joinFix(error.code, liveLink);
  const pageLink = (words: string) => (
    <Link className="settings-button settings-button-default rh-join-fix" to="/settings#cloud" data-testid="host-network-open-cloud">
      <span className="settings-button-stack"><span className="settings-button-label">{words}</span></span>
    </Link>
  );
  const why = fix === 'start' ? 'Start it here, and Walnut makes the link.'
    : fix === 'pair' ? 'Pair a cloud companion in Phones & Cloud, then make the link.'
    : fix === 'companion' ? 'Update your cloud companion in Phones & Cloud, then make the link.'
    : fix === 'show-open' ? 'Your link made a moment ago still works.'
    : null;
  return (
    <SettingsRow
      className="rh-join rh-join-error"
      state="error"
      data-testid="host-network-invite-error"
      data-fix={fix}
      label="Could not make a link"
      help={
        <span className="rh-join-error-text" role="alert">
          {`${error.text}.`}
          {why && <span className="rh-join-error-why"> {why}</span>}
        </span>
      }
      control={
        <>
          <SettingsButton variant="text" onClick={onDone} data-testid="host-network-error-done">Close</SettingsButton>
          {fix === 'start' && (
            <SettingsButton holdFocus busy={starting} busyLabel="Starting..." reserve={['Start the host network', 'Starting...']} onClick={onStart} data-testid="host-network-start">
              Start the host network
            </SettingsButton>
          )}
          {fix === 'pair' && pageLink('Open Phones & Cloud')}
          {fix === 'companion' && pageLink('Open Phones & Cloud')}
          {fix === 'show-open' && <SettingsButton onClick={onShowOpen} data-testid="host-network-show-open">Show the link</SettingsButton>}
          {fix === 'retry' && <SettingsButton onClick={onRetry} data-testid="host-network-try-again">Try again</SettingsButton>}
        </>
      }
    />
  );
}

/**
 * In the closed card's place: a link that still waits says how long it works, with Cancel link
 * beside it; one called back says so, with Close. The minutes tick here, not in the section.
 */
export function HostJoinClosed({ invite, cancelling, error, onCancel, onDone }: {
  invite: NetInvite;
  cancelling: boolean;
  error: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = invite.state === 'waiting';
  const doneId = `rh-join-closed-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    if (!waiting) return;
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(clock);
  }, [waiting]);
  // Cancel link went away with its press: the focus goes to Close, beside the words that say what it did.
  const cancelled = invite.state === 'cancelled';
  useEffect(() => {
    if (!cancelled) return;
    const raf = requestAnimationFrame(() => focusLanded(document.getElementById(doneId)));
    return () => cancelAnimationFrame(raf);
  }, [cancelled, doneId]);
  if (cancelled) {
    return (
      <SettingsRow
        className="rh-join rh-join-closed"
        data-testid="host-network-closed"
        data-invite-state="cancelled"
        label={<span role="status">Link cancelled.</span>}
        help="No machine can join with it now."
        control={<SettingsButton variant="text" onClick={onDone} id={doneId} data-testid="host-network-closed-done">Close</SettingsButton>}
      />
    );
  }
  if (!waiting || now > invite.expiresAt) return null;
  return (
    <SettingsRow
      className="rh-join rh-join-closed"
      data-testid="host-network-closed"
      data-invite-state="waiting"
      label={<span role="status">{closedLinkNote(invite.expiresAt, now)}</span>}
      help="A machine that runs it still joins. Add host, Join a machine with a link, shows it again."
      error={error ?? undefined}
      control={
        <SettingsButton variant="text" holdFocus busy={cancelling} busyLabel="Cancelling..." reserve={['Cancel link', 'Cancelling...']} onClick={onCancel} data-testid="host-network-cancel">
          Cancel link
        </SettingsButton>
      }
    />
  );
}

export function HostJoinLink({ invite, companion, relay, making, onNewLink, onDone, onTouched }: Props) {
  // The countdown ticks here, so only this row re-renders each second.
  const [now, setNow] = useState(() => Date.now());
  const waiting = invite.state === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [waiting, invite.id]);
  const [picked, setPicked] = usePageView<JoinOs>('settings-remote-hosts', 'joinOs', 'mac', isOs);
  const [notes, setNotes] = usePageView<boolean>('settings-remote-hosts', 'joinNotes', false, isBool);
  const notesId = useId();
  const expired = invite.state === 'expired' || (invite.state === 'waiting' && now > invite.expiresAt);
  const hasWindows = !!(invite.windowsApp || invite.windowsCommand);
  const os: JoinOs = picked === 'windows' && !hasWindows ? 'mac' : picked;
  const state = expired ? 'expired' : invite.state;

  if (state !== 'waiting') {
    const label = state === 'joined'
      ? `${invite.member?.name ?? 'The machine'} joined.`
      : state === 'failed' ? `This link did not work${invite.error ? `: ${invite.error}` : '.'}`
      : state === 'cancelled' ? 'This link was cancelled.' : 'This link expired.';
    return (
      <SettingsRow
        className="rh-join"
        data-testid="host-network-invite"
        data-invite-state={state}
        label={label}
        help={state === 'joined' ? 'It is in the list below.' : 'A link works once, for 10 minutes.'}
        control={
          <>
            <SettingsButton variant={state === 'joined' ? 'default' : 'text'} onClick={onDone} data-testid="host-network-done">Close</SettingsButton>
            {state !== 'joined' && <SettingsButton onClick={onNewLink} disabled={making} data-testid="host-network-new-link">New link</SettingsButton>}
          </>
        }
      />
    );
  }

  const windowsNotes = os === 'windows';
  return (
    <SettingsRow
      className="settings-row-stacked rh-join"
      data-testid="host-network-invite"
      data-invite-state="waiting"
      data-os={os}
      onPointerDown={onTouched}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') onTouched?.();
        // Escape is Close, like every other card on the page (2026-11-05 reviews): the link keeps
        // working and the list says so in its place.
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onDone(); }
      }}
      wide
      label="Run this on the new machine"
      control={
        <span className="rh-join-body">
          <SegmentedControl<JoinOs>
            aria-label="The new machine's system"
            value={os}
            onChange={setPicked}
            options={[
              { value: 'mac', label: 'macOS', testId: 'host-network-os-mac' },
              { value: 'linux', label: 'Linux', testId: 'host-network-os-linux' },
              ...(hasWindows ? [{ value: 'windows' as const, label: 'Windows', testId: 'host-network-os-windows' }] : []),
            ]}
          />
          {os !== 'windows' && (
            <>
              <span className="rh-join-step">{os === 'mac' ? 'In Terminal on the new Mac:' : 'In a terminal on the new machine:'}</span>
              <Command text={invite.command} testId="host-network-command" copyId="host-network-copy" />
            </>
          )}
          {os === 'windows' && invite.windowsApp && (
            <>
              <span className="rh-join-step" data-testid="host-network-windows-app">
                Download <a href={invite.windowsApp} target="_blank" rel="noreferrer">Walnut for Windows</a> on the PC, open it, choose Add this PC to my Walnut, and paste this link:
              </span>
              <Command text={invite.link} testId="host-network-windows-link" copyId="host-network-windows-link-copy" />
            </>
          )}
          {os === 'windows' && !invite.windowsApp && invite.windowsCommand && (
            <>
              <span className="rh-join-step">In PowerShell on the PC:</span>
              <Command text={invite.windowsCommand} testId="host-network-windows-command" copyId="host-network-windows-copy" />
            </>
          )}
          <span className="rh-join-foot">
            <span className="rh-join-wait" data-testid="host-network-wait">
              {`Waiting for the machine... The link works once, for 10 minutes (${left(invite.expiresAt - now)} left).`}
              {companion === false && ' Keep this Mac awake and online until it joins.'}
            </span>
            <SettingsButton onClick={onDone} title="Put this link away. It still works until it ends, and you can cancel it." data-testid="host-network-done">Close</SettingsButton>
          </span>
          <button
            type="button"
            className="rh-join-more"
            aria-expanded={notes}
            aria-controls={notesId}
            data-testid="host-network-more"
            onClick={() => setNotes(!notes)}
          >
            <ChevronGlyph size={10} className="settings-disclosure-chevron" />
            More about this link
          </button>
          <span className="rh-join-notes" id={notesId} hidden={!notes}>
            {windowsNotes && invite.windowsApp && invite.windowsCommand && (
              <span className="rh-join-note">
                <span>Or in PowerShell on the PC:</span>
                <Command text={invite.windowsCommand} testId="host-network-windows-command" copyId="host-network-windows-copy" />
              </span>
            )}
            {windowsNotes && invite.windowsApp && (
              <span className="rh-join-note">The Windows app is not signed yet: when Windows says &ldquo;Windows protected your PC&rdquo;, click More info, then Run anyway.</span>
            )}
            {windowsNotes && (
              <span className="rh-join-note">On Windows, Walnut runs in WSL (Linux inside Windows). A PC without WSL asks once for an administrator to turn it on, then a restart and a new link.</span>
            )}
            <span className="rh-join-note">{relayNote(relay)} You pick the relay under More settings.</span>
          </span>
        </span>
      }
    />
  );
}
