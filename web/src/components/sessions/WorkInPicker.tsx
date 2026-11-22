/**
 * The Work in pill's popover (experiment `project_first_start`): a search box, then two tabs.
 *   Projects  every project (favourites, then with a code source, then the rest; the Inbox last),
 *             each with ONE line saying what a pick gives ("Fresh git worktree on Big box",
 *             "Works in its folder notes · Local"); a row without a source has one small "Set up
 *             source…" action; at the bottom, on a start from a source, "Runs on <host> ▾".
 *   Folders   the recent and quick folders, each with its path, host and the project it belongs
 *             to (detectProjectForFolder); "Browse or type a path…" opens the full folder picker.
 * The tab is a view choice, kept (usePageView). Placed by ProjectStartFlyout (useMenuPlacement).
 */
import { useRef, useState, type RefObject } from 'react';
import type { WorkingDirEntry } from '@/api/sessions';
import { useProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { projectDisplayName } from '@/utils/project-display';
import { openProjectSettings } from '@/utils/project-settings-open';
import { hostDisplayLabel, LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import { knownHomeOf, shownFolderName, tildePath } from '@/utils/home-folder';
import { usePageView } from '@/utils/view-memory';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import { WorkInCheckIcon, WorkInKindIcon, WorkInSetupIcon, workInKindOf } from './WorkInIcons';
import type { DraftProjectStart, DraftRowUpdate } from './DraftWorkInPill';
import type { DraftColumn } from './draft-column';
import { draftHostOf, pickStartHost } from './draft-project-start';
import { detectProjectForFolder, workInFolderKey, workInProjectLine, workInProjectOrder } from './draft-work-in';
import { isInboxProject } from '@open-walnut/core';
import { Tabs, type TabItem } from '@/components/controls';

const WORK_IN_TABS: ReadonlyArray<TabItem<Tab>> = [
  { value: 'projects', label: 'Projects', className: 'wip-tab', testId: 'work-in-tab-projects' },
  { value: 'folders', label: 'Folders', className: 'wip-tab', testId: 'work-in-tab-folders' },
];

type Tab = 'projects' | 'folders';
const isTab = (v: unknown): v is Tab => v === 'projects' || v === 'folders';

interface Props {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  draft: DraftColumn;
  ps: DraftProjectStart;
  rows: readonly ProjectRegistryRow[];
  folders: readonly WorkingDirEntry[];
  onPickFolder: (d: WorkingDirEntry) => void;
  onBrowse: () => void;
  onUpdate: DraftRowUpdate;
  onClose: () => void;
}

export function WorkInPicker(props: Props) {
  return (
    <ProjectStartFlyout open={props.open} anchorRef={props.anchorRef} onClose={props.onClose} label="Work in"
      className="work-in-picker" testId="work-in-picker" minHeight={260}>
      {/* Mounted per open, so the typed search starts empty each time. */}
      <WorkInBody {...props} />
    </ProjectStartFlyout>
  );
}

function WorkInBody({ draft, ps, rows, folders, onPickFolder, onBrowse, onUpdate, onClose }: Props) {
  const [tab, setTab] = usePageView<Tab>('draft', 'workIn.tab', 'projects', isTab);
  const [query, setQuery] = useState('');
  const { favoriteByName } = useProjectRegistry();
  const statuses = useAllHostStatus();
  const liveLabel = (host: string | null | undefined) => (host ? statuses.find((s) => s.host === host)?.label : undefined);
  const hostLabelOf = (host: string | null | undefined, saved?: string) => hostDisplayLabel(host, liveLabel(host), saved);

  const q = query.trim().toLowerCase();
  const projects = workInProjectOrder(rows, (n) => favoriteByName.has(n.toLowerCase()), query, projectDisplayName);
  const inboxShown = !q || 'inbox'.includes(q);
  // The Inbox row is ticked while the draft names no other project ('' or `Inbox` alike).
  const inboxCurrent = isInboxProject(ps.project) && isInboxProject(draft.project);
  const pickProject = (name: string) => { ps.pick(name, { toHome: true }); onClose(); };

  // The draft's own folder first (not on a start from a source: its folder is the source's).
  const own: WorkingDirEntry | null = draft.cwd && ps.mode !== 'source'
    ? { cwd: draft.cwd, host: draft.host ?? null, ...(draft.hostLabel ? { hostLabel: draft.hostLabel } : {}), project: '', count: 0, lastUsed: '' }
    : null;
  const ownKey = own ? workInFolderKey(own) : '';
  const allFolders = [...(own ? [own] : []), ...folders.filter((d) => workInFolderKey(d) !== ownKey)];
  const shownFolders = allFolders.filter((d) => !q || d.cwd.toLowerCase().includes(q) || shownFolderName(d.cwd, d.host).toLowerCase().includes(q));
  const pickFolder = (d: WorkingDirEntry) => {
    onClose();
    if (workInFolderKey(d) !== ownKey) onPickFolder(d);
  };

  return (
    <>
      <div className="wip-head">
        <input
          className="psp-search is-sm"
          data-no-draft="search"
          data-testid="work-in-search"
          placeholder="Search projects and folders…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (tab === 'projects') {
              const first = projects[0]?.name ?? (inboxShown ? '' : undefined);
              if (first !== undefined) pickProject(first);
            } else if (shownFolders[0]) pickFolder(shownFolders[0]);
          }}
          autoFocus
        />
        <Tabs className="wip-tabs" aria-label="Work in" value={tab} onChange={setTab} items={WORK_IN_TABS} />
      </div>
      {tab === 'projects' ? (
        <div className="wip-list" role="tabpanel">
          {projects.map((r) => {
            const source = r.startSource;
            const host = source ? draftHostOf(source) : r.defaultHost || null;
            const line = workInProjectLine(r, {
              hostLabel: source ? hostLabelOf(host, source.host_label) : hostLabelOf(host),
              folderName: r.defaultCwd ? shownFolderName(r.defaultCwd, host) : undefined,
            });
            // A check only where a pick changes nothing: this start from its source, or the project of a folder start.
            const current = r.name === ps.project && (ps.mode === 'source' ? !!source : !source && !!draft.project);
            return (
              <div key={r.name} className={`wip-row${current ? ' is-current' : ''}`} data-testid={`work-in-project-${r.name}`}>
                <button type="button" className="wip-pick" onClick={() => pickProject(r.name)} title={source ? `From ${source.anchor}` : r.defaultCwd ?? undefined}>
                  <span className={`wip-ico is-${workInKindOf(source)}`}><WorkInKindIcon kind={workInKindOf(source)} /></span>
                  <span className="wip-text">
                    <span className="wip-name">{projectDisplayName(r.name)}</span>
                    <span className="wip-line" data-testid="work-in-line">{line}</span>
                  </span>
                  {current && <WorkInCheckIcon />}
                </button>
                {!source && (
                  <button type="button" className="wip-setup" data-testid={`work-in-setup-${r.name}`}
                    title="Set up source…" aria-label={`Set up ${projectDisplayName(r.name)}'s code source`}
                    onClick={() => { onClose(); openProjectSettings(r.name); }}>
                    <WorkInSetupIcon />
                  </button>
                )}
              </div>
            );
          })}
          {inboxShown && (
            // No project ('' or none yet) is what Start sends either way: no project, so the Inbox.
            <div className={`wip-row${inboxCurrent ? ' is-current' : ''}`} data-testid="work-in-project-inbox">
              <button type="button" className="wip-pick" onClick={() => pickProject('')}>
                <span className="wip-ico is-folder"><WorkInKindIcon kind="folder" /></span>
                <span className="wip-text">
                  <span className="wip-name">Inbox</span>
                  <span className="wip-line">No project · works in a folder you pick</span>
                </span>
                {inboxCurrent && <WorkInCheckIcon />}
              </button>
            </div>
          )}
          {!projects.length && !inboxShown && <div className="psp-empty">No matching project</div>}
          {ps.mode === 'source' && <StartHostChooser draft={draft} onUpdate={onUpdate} />}
        </div>
      ) : (
        <div className="wip-list" role="tabpanel">
          {shownFolders.map((d, i) => {
            const detected = detectProjectForFolder(d.cwd, d.host, rows, { home: knownHomeOf(d.host) });
            const isOwn = workInFolderKey(d) === ownKey;
            return (
              <div key={workInFolderKey(d)} className={`wip-row${isOwn ? ' is-current' : ''}`} data-testid={`work-in-folder-${i}`}>
                <button type="button" className="wip-pick" onClick={() => pickFolder(d)} title={d.cwd}>
                  <span className="wip-ico is-folder"><WorkInKindIcon kind="folder" /></span>
                  <span className="wip-text">
                    <span className="wip-name">{shownFolderName(d.cwd, d.host)}</span>
                    <span className="wip-line">
                      {tildePath(d.cwd, knownHomeOf(d.host))} · {d.host ? hostLabelOf(d.host, d.hostLabel) : LOCAL_HOST_LABEL}
                    </span>
                  </span>
                  {detected && (
                    <span className={`draft-work-in-project-tag${detected.hasSource ? ' has-source' : ''}`} data-testid="work-in-folder-project">
                      {projectDisplayName(detected.project)}
                    </span>
                  )}
                  {isOwn && <WorkInCheckIcon />}
                </button>
              </div>
            );
          })}
          {!shownFolders.length && <div className="psp-empty">{q ? 'No matching folder' : 'No recent folders yet'}</div>}
          <button type="button" className="wip-browse" data-testid="work-in-browse" onClick={() => { onClose(); onBrowse(); }}>
            Browse or type a path…
          </button>
        </div>
      )}
    </>
  );
}

/** "Runs on <host> ▾": another host for this start only (the project's own host by default). */
function StartHostChooser({ draft, onUpdate }: { draft: DraftColumn; onUpdate: DraftRowUpdate }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hostFlyoutOpen, setHostFlyoutOpen] = useState(false);
  const statuses = useAllHostStatus();
  const live = statuses.find((s) => s.host === draft.host);
  const label = draft.host ? hostDisplayLabel(draft.host, live?.label, draft.hostLabel) : LOCAL_HOST_LABEL;
  const choose = (host: string | null, hostLabel?: string) => {
    onUpdate(draft.id, (d) => pickStartHost(d, host, hostLabel));
    setHostFlyoutOpen(false);
  };
  return (
    <>
      <button ref={ref} type="button" className="wip-host" data-testid="work-in-host" aria-haspopup="dialog" aria-expanded={hostFlyoutOpen}
        title={draft.host ? `Runs on ${label}. Pick another host for this start` : 'Runs on this computer. Pick another host for this start'}
        onClick={() => setHostFlyoutOpen((o) => !o)}>
        Runs on <strong>{label}</strong>
        {draft.host && <HostStatusDot host={draft.host} label={label} className="psp-host-dot" />}
        <span aria-hidden className="wip-caret">▾</span>
      </button>
      <ProjectStartFlyout open={hostFlyoutOpen} anchorRef={ref} onClose={() => setHostFlyoutOpen(false)} label="Host for this start"
        className="project-start-hosts" testId="draft-start-host-list" minHeight={100}>
        <div className="psp-title-small">Run this start on</div>
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
