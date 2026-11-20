/**
 * The draft's project-first pills (experiment `project_first_start`, model draft-project-start.ts):
 *   [Project: Marina] [Host: Big box ●] [⑂ New git worktree]
 * The Project pill leads the row and opens ProjectStartPicker. Once a project with a code source
 * is picked, the host pill (another host for this start only) and the source chip stand where
 * the folder pill was.
 */
import { useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { StartSource } from '@/api/projects';
import { useExperimental } from '@/hooks/useExperimental';
import { resolveProjectName, useProjectRegistry } from '@/hooks/useProjectRegistry';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { projectDisplayName } from '@/utils/project-display';
import { hostDisplayLabel, LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import { log } from '@/utils/log';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import { ProjectStartPicker } from './ProjectStartPicker';
import type { DraftColumn } from './draft-column';
import {
  AUTO_PROVIDER, chooseFolderInstead, draftProjectStart, pickProjectForStart, pickStartHost, sourceChipWords, startSourceOf, type DraftProjectStartState,
} from './draft-project-start';

/** A write on the draft row (MainPage applies it to the row with this id). */
export type DraftRowUpdate = (draftId: string, update: (d: DraftColumn) => DraftColumn) => void;

export interface DraftProjectStart extends DraftProjectStartState {
  /** A project pick (the picker, the project chip or More while `canPick`); its source is looked up here. */
  pick: (project: string) => void;
}

/** The draft's project-first shape (draftProjectStart, the same decision the Start reads) and its project pick. */
export function useDraftProjectStart(draft: DraftColumn, eligible: boolean, onUpdate: DraftRowUpdate | undefined): DraftProjectStart {
  const flagOn = useExperimental('project_first_start');
  const { rows, projectDefaults } = useProjectRegistry();
  const state = draftProjectStart(draft, { flagOn, eligible: eligible && !!onUpdate, rows, resolve: resolveProjectName });
  const draftId = draft.id;
  const pick = useLeanCallback((project: string) => {
    const found = startSourceOf(rows, project, resolveProjectName);
    const name = found.project || project;
    onUpdate?.(draftId, (d) => pickProjectForStart(d, name, found.source, name ? projectDefaults.get(name.toLowerCase()) : undefined));
    log.info('draft', 'project-first pick', { draftId, project: name, provider: found.source?.provider ?? 'none', host: found.source?.host });
  }, [onUpdate, draftId, rows, projectDefaults]);
  return { ...state, pick };
}

export function DraftProjectStartPill({ draft, project, onPick, onUpdate, onOpenFolderPicker }: {
  draft: DraftColumn;
  /** The draft's project by its current name (a rename followed). */
  project: string;
  onPick: DraftProjectStart['pick'];
  onUpdate: DraftRowUpdate;
  onOpenFolderPicker: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const has = draft.project !== undefined && (draft.project !== '' || draft.projectSource === 'user');
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`session-action-chip draft-project-start-pill${open ? ' session-action-chip-active' : ''}${has ? '' : ' is-empty'}`}
        data-testid="draft-project-start-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="The project this task belongs to: one with a code source gives the task a fresh workspace of its own"
        // WebKit blurs the composer on a button mousedown; the caret must stay put.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {has ? (
          <>
            <span className="draft-pill-key">Project:</span>{' '}
            <span className="draft-pill-name">{projectDisplayName(project)}</span>
          </>
        ) : 'Choose a project…'}
      </button>
      <ProjectStartPicker
        open={open}
        anchorRef={ref}
        current={has ? project : undefined}
        onPick={onPick}
        onChooseFolder={() => {
          onUpdate(draft.id, chooseFolderInstead);
          log.info('draft', 'project-first left for a folder', { draftId: draft.id });
          onOpenFolderPicker();
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Where this start runs: the project's host, changeable for this start only. */
export function DraftStartHostPill({ draft, onUpdate }: { draft: DraftColumn; onUpdate: DraftRowUpdate }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const statuses = useAllHostStatus();
  const live = statuses.find((s) => s.host === draft.host);
  const label = draft.host ? hostDisplayLabel(draft.host, live?.label, draft.hostLabel) : LOCAL_HOST_LABEL;
  const choose = (host: string | null, hostLabel?: string) => {
    onUpdate(draft.id, (d) => pickStartHost(d, host, hostLabel));
    setOpen(false);
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`session-action-chip draft-start-host-pill${open ? ' session-action-chip-active' : ''}`}
        data-testid="draft-start-host-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={draft.host ? `Runs on ${label}. Pick another host for this start` : 'Runs on this computer. Pick another host for this start'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="draft-pill-key">Host:</span>{' '}
        <span className="draft-pill-name">{label}</span>
        {draft.host && <HostStatusDot host={draft.host} label={label} className="draft-pill-dot" />}
      </button>
      <ProjectStartFlyout open={open} anchorRef={ref} onClose={() => setOpen(false)} label="Host for this start" className="project-start-hosts" testId="draft-start-host-list" minHeight={100}>
        <div className="psp-title psp-title-small">Run this start on</div>
        <button type="button" className={`psp-option${!draft.host ? ' is-current' : ''}`} onClick={() => choose(null)}>
          {LOCAL_HOST_LABEL} <span className="psp-option-meta">this computer</span>
        </button>
        {statuses.map((s) => (
          <button key={s.host} type="button" className={`psp-option${draft.host === s.host ? ' is-current' : ''}`}
            data-testid={`draft-start-host-${s.host}`} onClick={() => choose(s.host, s.label)}>
            <HostStatusDot host={s.host} label={s.label || s.host} className="psp-host-dot" />
            {hostDisplayLabel(s.host, s.label)}
          </button>
        ))}
      </ProjectStartFlyout>
    </>
  );
}

/** What a start from the source makes, said where the folder pill was; with no source seen, the server's own words come at Start. */
export function DraftSourceChip({ source }: { source: StartSource | null }) {
  const auto = !source || source.provider === AUTO_PROVIDER;
  const git = source?.provider === 'git-worktree';
  const words = sourceChipWords(source);
  const title = source
    ? `Each start makes a fresh ${auto ? 'isolated workspace' : words.replace(/^New /, '')} from ${source.anchor}; it is removed once the task is done and its work is merged`
    : 'Each start makes a fresh workspace from the project\'s code source';
  return (
    <span className="session-action-chip draft-project-source-chip" data-testid="draft-project-source-chip" title={title}>
      <span aria-hidden>{git || auto ? '⑂' : '▣'}</span> {words}
    </span>
  );
}
