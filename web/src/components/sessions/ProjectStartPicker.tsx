/**
 * The draft's project picker (experiment `project_first_start`): a search box; the projects that
 * know where their code comes from first (name, what a start makes, the host with its dot); then
 * the ones that do not ("Set up source…" opens that project's settings), the Inbox among them;
 * and at the bottom "Choose a folder instead", today's folder picker.
 */
import { useMemo, useState, type RefObject } from 'react';
import { useProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import type { StartSource } from '@/api/projects';
import { projectDisplayName } from '@/utils/project-display';
import { openProjectSettings } from '@/utils/project-settings-open';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import { draftHostOf, sourceLine } from './draft-project-start';

export function ProjectStartPicker({ open, anchorRef, current, onPick, onChooseFolder, onClose }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** The draft's project ('' = Inbox, undefined = none picked). */
  current: string | undefined;
  onPick: (project: string) => void;
  onChooseFolder: () => void;
  onClose: () => void;
}) {
  const { rows, favoriteByName } = useProjectRegistry();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const { withSource, without } = useMemo(() => {
    const match = (r: ProjectRegistryRow) => !q || r.name.toLowerCase().includes(q) || projectDisplayName(r.name).toLowerCase().includes(q);
    const fav = (r: ProjectRegistryRow) => (favoriteByName.has(r.name.toLowerCase()) ? 0 : 1);
    const shown = rows.filter(match).sort((a, b) => fav(a) - fav(b) || a.name.localeCompare(b.name));
    return { withSource: shown.filter((r) => r.startSource), without: shown.filter((r) => !r.startSource) };
  }, [rows, favoriteByName, q]);
  const inboxShown = !q || 'inbox'.includes(q);
  const pick = (name: string) => { onPick(name); onClose(); };

  return (
    <ProjectStartFlyout open={open} anchorRef={anchorRef} onClose={onClose} label="Choose a project" className="project-start-picker" testId="project-start-picker" minHeight={220}>
      <div className="psp-head">
        <div className="psp-title">Choose a project</div>
        <div className="psp-sub">Its new task works in a fresh workspace from the project's code, removed when it is done.</div>
        <input
          className="psp-search"
          data-no-draft="search"
          data-testid="project-start-search"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = withSource[0];
            if (first) pick(first.name);
          }}
          autoFocus
        />
      </div>
      <div className="psp-list">
        {withSource.map((r) => (
          <SourceRow key={r.name} row={r} source={r.startSource!} active={current === r.name} onPick={() => pick(r.name)} />
        ))}
        {(without.length > 0 || inboxShown) && (
          <div className="psp-group" data-testid="project-start-no-source">No code source (starts in a folder)</div>
        )}
        {inboxShown && (
          <div className="psp-row psp-row-plain">
            <button type="button" className={`psp-pick${current === '' ? ' is-current' : ''}`} onClick={() => pick('')}>
              <span className="psp-name">Inbox</span>
            </button>
          </div>
        )}
        {without.map((r) => (
          <div key={r.name} className="psp-row psp-row-plain" data-testid={`project-start-row-${r.name}`}>
            <button type="button" className={`psp-pick${current === r.name ? ' is-current' : ''}`} onClick={() => pick(r.name)}
              title={r.defaultCwd ? `Starts in its folder, ${r.defaultCwd}` : 'Starts in a folder you pick'}>
              <span className="psp-name">{projectDisplayName(r.name)}</span>
              {r.defaultCwd && <span className="psp-line">Folder {r.defaultCwd}</span>}
            </button>
            <button type="button" className="psp-setup" data-testid="project-start-setup"
              title={`Say where ${projectDisplayName(r.name)}'s code comes from, in its settings`}
              onClick={() => { onClose(); openProjectSettings(r.name); }}>
              Set up source…
            </button>
          </div>
        ))}
        {q && withSource.length === 0 && without.length === 0 && !inboxShown && (
          <div className="psp-empty">No matching project</div>
        )}
      </div>
      <button type="button" className="psp-folder" data-testid="project-start-choose-folder" onClick={() => { onClose(); onChooseFolder(); }}>
        <span aria-hidden>↳</span> No project: <strong>choose a folder instead</strong>
      </button>
    </ProjectStartFlyout>
  );
}

function SourceRow({ row, source, active, onPick }: { row: ProjectRegistryRow; source: StartSource; active: boolean; onPick: () => void }) {
  const host = draftHostOf(source);
  // This machine reads "Local", as the folder pill and the host pill say it.
  const hostLabel = host ? source.host_label ?? host : LOCAL_HOST_LABEL;
  return (
    <div className="psp-row" data-testid={`project-start-row-${row.name}`}>
      <button type="button" className={`psp-pick${active ? ' is-current' : ''}`} onClick={onPick} title={`From ${source.anchor}`}>
        <span className="psp-name">{projectDisplayName(row.name)}</span>
        <span className="psp-line" data-testid="project-start-source-line">{sourceLine(source)}</span>
      </button>
      <span className="psp-host" title={host ? `Runs on ${hostLabel}` : 'Runs on this computer'}>
        {host && <HostStatusDot host={host} label={hostLabel} className="psp-host-dot" />}
        {hostLabel}
      </span>
    </div>
  );
}
