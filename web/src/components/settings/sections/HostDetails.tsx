/**
 * A host's Details, open in place under its row in Remote Hosts (HostRow.tsx `panel`). 2026-11-05
 * reviews: Details ran about 2400 px as one block (one WebKit run crashed as they opened), said a
 * timeout three times, changed indents from part to part, and closed only from the row's menu.
 * Now each fact is said once, in three small parts, one indent:
 *
 *   head              the host's name and Hide details, held at the top while the Details scroll
 *                     by; Escape anywhere inside them closes them too (the focus goes back to the
 *                     row's More)
 *   Status            open: a live host's reading (one System line with Probe again, the rings,
 *                     the online bar, sessions, spend), the problems its row does not name, what
 *                     Claude Code needs there, and the facts. A host not connected says why ONCE
 *                     (its ssh output folded) and draws no rings full of question marks
 *   This host         folded: its own settings (HostThisPart.tsx)
 *   What Walnut knows folded: its kind, note, tools and folders (a saved SSH host)
 *
 * A folded part renders nothing until it is opened, so an open Details stays light; which parts
 * are open is remembered for the browser session.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import { useHostStatus } from '@/hooks/useHostStatus';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { hostProblemOf } from '@open-walnut/host-problem';
import { isLive, systemLine } from './host-fleet-dashboard-model';
import { FleetFacts, FleetProblems, FleetVitals, type SystemLine } from './HostFleetVitals';
import { RemoteHostDetail } from './RemoteHostStatus';
import { HostProfileDisclosure, profileSystemLine, useHostProfile } from './HostProfileDisclosure';
import { HostThisPart } from './HostThisPart';
import { SettingsButton } from '../inputs/SettingsButton';
import { keepPress } from '../inputs/press-keeps-target';
import { ChevronGlyph } from '../settings-glyphs';
import { readDisclosureOpen, sessionStore, writeDisclosureOpen } from '../SettingsSection';
import { hostKindLabel } from '@/components/transfer/transfer-model';

export type HostKind = 'local' | 'ssh' | 'net' | 'fleet';
export type DetailsPartId = 'status' | 'this-host' | 'knows';

interface Props {
  alias: string;
  name: string;
  card?: FleetHost;
  now: number;
  /** A saved host Walnut dials (its status and readiness are read live); not one switched off. */
  linked: boolean;
  /** Show "What Walnut knows" and probe it (a saved SSH host). */
  profile?: boolean;
  kind: HostKind;
  /** The reading's problem the row names in its warning line (problemsOf's key), else null: Status leaves it out. */
  rowProblem: string | null;
  /** Hide details (its button, or Escape inside them). */
  onClose: () => void;
}

/** One part of the Details: a heading line that folds it, and its contents only while open. */
function Part({ id, title, summary, defaultOpen, titleTestId, children }: { id: DetailsPartId; title: string; summary?: ReactNode; defaultOpen: boolean; titleTestId?: string; children: () => ReactNode }) {
  const key = `rh-details-${id}`;
  const [open, setOpen] = useState(() => readDisclosureOpen(sessionStore(), key, defaultOpen));
  return (
    <section className="rh-details-part" data-part={id} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        tabIndex={0}
        className="rh-details-part-toggle"
        aria-expanded={open}
        data-testid={`rh-details-part-${id}`}
        onClick={() => { setOpen(!open); writeDisclosureOpen(sessionStore(), key, !open); }}
        onPointerDown={(e) => keepPress(e.currentTarget, e)}
      >
        <ChevronGlyph size={10} className="settings-disclosure-chevron" />
        <span className="rh-details-part-title" data-testid={titleTestId}>{title}</span>
        {summary && !open && <span className="rh-details-part-summary">{summary}</span>}
      </button>
      {open && <div className="rh-details-part-body">{children()}</div>}
    </section>
  );
}

export function HostDetails(props: Props) {
  return props.profile ? <WithProfile {...props} /> : <DetailsBody {...props} />;
}

function WithProfile(props: Props) {
  const hp = useHostProfile(props.alias);
  const system = profileSystemLine(hp, props.card ? systemLine(props.card) : 'Not probed yet.');
  const kind = hp.profile ? `Kind: ${hostKindLabel(hp.profile.kind)}${hp.profile.kindSetByUser ? '' : ' (automatic)'}` : undefined;
  return <DetailsBody {...props} system={system} profileSummary={kind} profileBlock={() => <HostProfileDisclosure hp={hp} alias={props.alias} name={props.name} />} />;
}

function SystemOnly({ system }: { system?: SystemLine }) {
  if (!system) return null;
  return (
    <>
      <div className="hf-card-sys-row">
        <p className="hf-card-sys" data-testid="host-fleet-system"><span data-testid="host-system-line">{system.text}</span></p>
        {system.action}
      </div>
      {system.meta && <p className="hf-card-meta">{system.meta}</p>}
    </>
  );
}

function DetailsBody({ alias, name, card, now, linked, kind, rowProblem, system, profileBlock, profileSummary, onClose }: Props & { system?: SystemLine; profileBlock?: () => ReactNode; profileSummary?: string }) {
  const status = useHostStatus(alias);
  const replica = useIsReplicaServer();
  const local = kind === 'local';
  const live = !!card && isLive(card);
  // The problem the row already names is not said again here: the row says which (its rule decides,
  // so the two never drift apart).
  const skip = rowProblem;
  const host = local ? '__local__' : alias;
  // Escape anywhere in the Details (not in a list portalled out of them: the Kind picker) closes them.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    onClose();
  };
  const failure = linked && !local ? <RemoteHostDetail alias={alias} name={name} /> : null;
  // A host not connected whose failure is said above (RemoteHostDetail draws one for a connect
  // problem) does not say its connection again in the facts, nor "Up for: Not connected"; one with
  // no failure block (a fleet row) keeps its Connection row, the only place its reason is said.
  const problemType = hostProblemOf(status, { replica })?.type;
  const saidAbove = !!failure && (problemType === 'connect' || problemType === 'reconnecting');
  const omit = live || !saidAbove ? [] : ['connection', 'online', ...(card?.daemon && !card.daemon.vitals ? [] : ['now'])];
  return (
    <div className="rh-details" data-testid="rh-details" data-host={alias} role="region" aria-label={`Details of ${name}`} onKeyDown={onKeyDown}>
      <div className="rh-details-head">
        <span className="rh-details-name">{name}</span>
        <SettingsButton variant="text" onClick={onClose} data-testid="rh-details-hide" aria-label={`Hide details of ${name}`}>Hide details</SettingsButton>
      </div>
      <Part id="status" title="Status" defaultOpen>
        {() => (
          <>
            {live
              ? <FleetVitals host={card!} now={now} system={system} />
              : <SystemOnly system={system ?? (card ? { text: systemLine(card) } : undefined)} />}
            {!card && <p className="rh-details-empty">Walnut has no reading of {name} yet: it reads a host once it connects.</p>}
            {card && <FleetProblems host={card} now={now} skip={skip} />}
            {failure}
            {card && <FleetFacts host={card} now={now} omit={omit} fit={live} />}
          </>
        )}
      </Part>
      <Part id="this-host" title="This host" summary="Session limit, tasks from other hosts, secrets" defaultOpen={false}>
        {() => (
          <HostThisPart
            host={host}
            name={name}
            // Any host the fleet reads takes a limit, the companion's box included (session_limits is
            // keyed by host; review: the old list offered it, this part did not).
            limitKey={local ? 'local' : alias}
            server={kind === 'ssh' || kind === 'net'}
            secrets={kind !== 'fleet'}
          />
        )}
      </Part>
      {profileBlock && (
        <Part id="knows" title="What Walnut knows" summary={profileSummary} defaultOpen={false} titleTestId={`host-profile-heading-${alias}`}>
          {profileBlock}
        </Part>
      )}
    </div>
  );
}
