/**
 * The draft's ONE "Work in" pill (experiment `project_first_start`, words in draft-work-in.ts):
 *   [Work in: Marina · fresh git worktree · Big box ●]   [Work in: open-walnut (Walnut)]
 * It answers "where does this task run" with a project or a folder, from one popover
 * (WorkInPicker: Projects | Folders). It stands where the folder pill, the host pill, the source
 * chip, the quick folders and the project chip stood. Under the row, after a folder of a project
 * with a code source, one quiet suggestion offers a fresh workspace instead (DraftWorkInSuggest).
 */
import { badge } from '@/components/common/badge';
import { useState, type RefObject } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { WorkingDirEntry } from '@/api/sessions';
import { useExperimental } from '@/hooks/useExperimental';
import { resolveProjectName, useProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { useHostStatus } from '@/hooks/useHostStatus';
import { projectDisplayName } from '@/utils/project-display';
import { hostDisplayLabel, LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import { knownHomeOf, shownFolderName } from '@/utils/home-folder';
import { log } from '@/utils/log';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { WorkInPicker } from './WorkInPicker';
import { WorkInKindIcon, workInKindOf } from './WorkInIcons';
import { useDraftWorkspace } from '@/components/workspaces/draft-workspace-store';
import { autoGivesWay } from '@/components/workspaces/draft-workspace-model';
import type { DraftColumn } from './draft-column';
import { draftProjectStart, pickProjectForStart, startSourceOf, type DraftProjectStartState } from './draft-project-start';
import {
  detectProjectForFolder, ISOLATED_WORDS, keepWorkInFolder, workInFace, workInSuggestion, workInWords,
  type DetectedProject, type WorkInFace, type WorkInSuggestion,
} from './draft-work-in';
import '@/styles/project-start.css';

/** A write on the draft row (MainPage applies it to the row with this id). */
export type DraftRowUpdate = (draftId: string, update: (d: DraftColumn) => DraftColumn) => void;

export interface DraftProjectStart extends DraftProjectStartState {
  /** A project pick (the Work in popover, More while `canPick`); its source is looked up here.
   *  `toHome`: a project without a source also brings its own default folder (the popover's rows). */
  pick: (project: string, opts?: { toHome?: boolean }) => void;
}

/** The draft's project-first shape (draftProjectStart, the same decision the Start reads) and its project pick. */
export function useDraftProjectStart(draft: DraftColumn, eligible: boolean, onUpdate: DraftRowUpdate | undefined): DraftProjectStart {
  const flagOn = useExperimental('project_first_start');
  const { rows, projectDefaults } = useProjectRegistry();
  const state = draftProjectStart(draft, { flagOn, eligible: eligible && !!onUpdate, rows, resolve: resolveProjectName });
  const draftId = draft.id;
  const pick = useLeanCallback((project: string, opts?: { toHome?: boolean }) => {
    const found = startSourceOf(rows, project, resolveProjectName);
    const name = found.project || project;
    onUpdate?.(draftId, (d) => pickProjectForStart(d, name, found.source, name ? projectDefaults.get(name.toLowerCase()) : undefined, opts));
    log.info('draft', 'project-first pick', { draftId, project: name, provider: found.source?.provider ?? 'none', host: found.source?.host });
  }, [onUpdate, draftId, rows, projectDefaults]);
  return { ...state, pick };
}

export interface WorkIn {
  face: WorkInFace;
  /** The project the draft's folder belongs to (none on a start from a source). */
  detected: DetectedProject | null;
  suggestion: WorkInSuggestion | null;
  rows: readonly ProjectRegistryRow[];
  /** The host's name when it is not this computer, else ''. */
  hostName: string;
}

/** The Work in pill's state, read once for the pill and the suggestion under the row. */
export function useWorkIn(draft: DraftColumn, ps: DraftProjectStart): WorkIn {
  const { rows } = useProjectRegistry();
  const status = useHostStatus(draft.host);
  const hostName = draft.host ? hostDisplayLabel(draft.host, status?.label, draft.hostLabel) : '';
  // A folder start isolates as it does without the pill (DraftWorkspaceRow applies the defaults,
  // More turns it on or off); a default still asking the host, or with nothing to make, says nothing.
  const ws = useDraftWorkspace(draft.id);
  const isolated = ws.enabled && !(ws.auto && ws.loading) && !autoGivesWay(ws);
  const detected = ps.canPick && draft.cwd && ps.mode !== 'source'
    ? detectProjectForFolder(draft.cwd, draft.host, rows, { home: knownHomeOf(draft.host) })
    : null;
  const face = workInFace(draft, {
    mode: ps.mode, project: ps.project, source: ps.source, detected, isolated,
    folderName: draft.cwd ? shownFolderName(draft.cwd, draft.host) : '',
  });
  return { face, detected, rows, hostName, suggestion: ps.canPick ? workInSuggestion(draft, { mode: ps.mode, detected, rows }) : null };
}

export function DraftWorkInPill({ draft, ps, work, pillRef, folders, onPickFolder, onBrowse, onUpdate }: {
  draft: DraftColumn;
  ps: DraftProjectStart;
  work: WorkIn;
  /** The pill: the full folder picker ("Browse or type a path…") pops from it. */
  pillRef: RefObject<HTMLButtonElement | null>;
  /** The Folders tab's recent and quick folders (quickDirsFor). */
  folders: readonly WorkingDirEntry[];
  onPickFolder: (d: WorkingDirEntry) => void;
  onBrowse: () => void;
  onUpdate: DraftRowUpdate;
}) {
  const [open, setOpen] = useState(false);
  const { face, hostName } = work;
  const tagIsNew = face.kind !== 'source' && !!face.tag && !work.rows.some((r) => r.name.toLowerCase() === face.tag!.toLowerCase());
  const kind = face.kind === 'source' ? workInKindOf(ps.source) : face.kind === 'folder' ? 'folder' : 'host';
  const title = face.kind === 'source'
    ? `Each start makes a fresh ${face.makes} from ${projectDisplayName(face.project)}'s code on ${hostName || `${LOCAL_HOST_LABEL} (this computer)`}; it is removed once the task is done and its work is merged`
    : face.kind === 'folder'
      ? `Folder: ${draft.cwd}\nHost: ${hostName || `${LOCAL_HOST_LABEL} (this computer)`}${face.tag ? `\nProject: ${projectDisplayName(face.tag)}` : ''}${face.isolated ? '\nThe task gets an isolated copy of this folder (More turns it off)' : ''}`
      : 'Where this task runs: a project (a fresh workspace from its code, or its own folder) or a folder of yours';
  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className={`btn btn-sm session-action-chip draft-work-in-pill${open ? ' session-action-chip-active' : ''}${face.kind === 'empty' ? ' is-empty' : ''}`}
        data-choice-exempt="opens the Work in picker; active only while the picker is open"
        data-testid="draft-work-in-pill"
        data-kind={face.kind}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={workInWords(face, hostName)}
        title={title}
        // WebKit blurs the composer on a button mousedown; the caret must stay put.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <WorkInKindIcon kind={kind} />
        <span className="draft-pill-key">Work in:</span>{' '}
        {face.kind === 'source' && (
          <>
            <span className="draft-pill-name btn-value">{projectDisplayName(face.project)}</span>{' '}
            <span className="draft-work-in-detail">· fresh {face.makes}</span>
          </>
        )}
        {face.kind === 'folder' && <span className="draft-pill-name btn-value">{face.folder}</span>}
        {face.kind !== 'source' && face.tag && (
          // A project Start will create (named after the folder) is drawn as new, as the project chip did.
          <span className={`${badge('accent', { paused: tagIsNew })} draft-work-in-project-tag${tagIsNew ? ' is-new' : ''}`} data-testid="draft-work-in-project-tag"
            title={tagIsNew ? `Starting creates a new project named ${face.tag}` : `Files under ${projectDisplayName(face.tag)}`}>
            <span>{projectDisplayName(face.tag)}</span>
          </span>
        )}
        {face.kind === 'empty' && <span className="draft-work-in-detail">{face.tag ? '· choose a folder…' : 'Choose a project or folder…'}</span>}
        {face.kind === 'folder' && face.isolated && (
          <>{' '}<span className="draft-work-in-detail" data-testid="draft-work-in-isolated">· {ISOLATED_WORDS}</span></>
        )}
        {draft.host && (
          <>
            {' '}<span className="draft-pill-host">· {hostName}</span>
            <HostStatusDot host={draft.host} label={hostName} className="draft-pill-dot" />
          </>
        )}
      </button>
      <WorkInPicker
        open={open}
        anchorRef={pillRef}
        draft={draft}
        ps={ps}
        rows={work.rows}
        folders={folders}
        onPickFolder={onPickFolder}
        onBrowse={onBrowse}
        onUpdate={onUpdate}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** "This is Marina's code. Start in a fresh git worktree instead?", under the row. */
export function DraftWorkInSuggest({ draft, ps, work, onUpdate }: { draft: DraftColumn; ps: DraftProjectStart; work: WorkIn; onUpdate: DraftRowUpdate }) {
  const s = work.suggestion;
  if (!s) return null;
  const source = work.rows.find((r) => r.name === s.project)?.startSource;
  return (
    <div className="draft-work-in-suggest" role="status" data-testid="work-in-suggest">
      <WorkInKindIcon kind={workInKindOf(source)} />
      <span className="draft-work-in-suggest-text">This is {projectDisplayName(s.project)}'s code. Start in a fresh {s.makes} instead?</span>
      <button type="button" className="draft-work-in-suggest-use" data-testid="work-in-suggest-use"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          ps.pick(s.project);
          log.info('draft', 'work-in suggestion taken', { draftId: draft.id, project: s.project });
        }}>
        Use fresh {s.makes}
      </button>
      <button type="button" className="draft-work-in-suggest-keep" data-testid="work-in-suggest-keep"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onUpdate(draft.id, keepWorkInFolder);
          log.info('draft', 'work-in suggestion declined', { draftId: draft.id, project: s.project });
        }}>
        Keep this folder
      </button>
    </div>
  );
}
