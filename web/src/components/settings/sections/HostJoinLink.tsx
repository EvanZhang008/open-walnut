/**
 * Settings > Remote Hosts: the join link, the first row of Hosts while it is in use
 * (useHostNetwork.ts). The command and its Copy come first, for the system the new machine
 * runs (macOS, Linux or Windows; the pick is remembered); the notes (Windows signing, the
 * PowerShell way, how the machines reach each other) fold under "More about this link".
 * 2026-11-04 review: six lines of notes stood before the command, so the command did not
 * stand out.
 */
import { useEffect, useId, useState } from 'react';
import type { NetInvite, NetRelay } from '@/api/hosts-net';
import { usePageView } from '@/utils/view-memory';
import { oneOf } from '@/hooks/usePersistentState';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { ChevronGlyph } from '../settings-glyphs';

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
      <code className="settings-addons-mono" data-testid={testId} title={text}>{text}</code>
      <CopyButton text={text} variant="primary" data-testid={copyId} />
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
}

export function HostJoinLink({ invite, companion, relay, making, onNewLink }: Props) {
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
      : state === 'failed' ? `This link did not work${invite.error ? `: ${invite.error}` : '.'}` : 'This link expired.';
    return (
      <SettingsRow
        className="rh-join"
        data-testid="host-network-invite"
        data-invite-state={state}
        label={label}
        help={state === 'joined' ? 'It is in the list below.' : 'A link works once, for 10 minutes.'}
        control={state === 'joined' ? undefined : (
          <SettingsButton onClick={onNewLink} disabled={making} data-testid="host-network-new-link">New link</SettingsButton>
        )}
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
          <span className="rh-join-wait" data-testid="host-network-wait">
            {`Waiting for the machine... The link works once, for 10 minutes (${left(invite.expiresAt - now)} left).`}
            {companion === false && ' Keep this Mac awake and online until it joins.'}
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
