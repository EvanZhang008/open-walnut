/**
 * The new task draft's Project + Where state and its writes (experiment `project_first_start`,
 * v6): one read for the row, the line under it, the Where and Host menus, the Recent chips and
 * the Start button's "why not". The rules are draft-work-in.ts's; this hook only gathers what
 * they read (the registry, the hosts, the folders Walnut recorded, the tasks' workspaces) and
 * turns a pick into a write on the draft row.
 *
 * Memory (a project pick restores its last place) is DERIVED from records Walnut keeps (the
 * working-dirs list: every folder a session ran in, its project and when; task workspaces), so no
 * new stored format. A change the person makes in this draft is kept for this draft only
 * (`localPlaces`, in memory), and wins over the derived place when he comes back to the project.
 */
import { useMemo, useReducer } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { WorkingDirEntry } from '@/api/sessions';
import { useExperimental } from '@/hooks/useExperimental';
import { resolveProjectName, useProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { projectDisplayName } from '@/utils/project-display';
import { hostDisplayLabel, thisMachineName } from '@/utils/host-display-label';
import { isHomeFolder, knownHomeOf, tildePath } from '@/utils/home-folder';
import { log } from '@/utils/log';
import { useWorkingDirs } from './path-selector/useWorkingDirs';
import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';
import { applyLaunchMemory, type DraftColumn } from './draft-column';
import {
  draftProjectStart, moveDraftHost, pickProjectForStart, pickStartHost, restoreFolderPlace, startReadsDraftWorkspace, startSourceOf,
  type DraftProjectStartState,
} from './draft-project-start';
import {
  autoOn, autoWhat, derivedPlace, detectProjectForFolder, draftHostFor, folderElsewhere, keepWorkInFolder, ownHostOf,
  parseWorkspaceRoots, placeFor, placeKey, whereHostKey, whereLine, workInSuggestion, workspaceRootsKey,
  type AutoVerdict, type DetectedProject, type WhereLine, type WherePlace, type WorkspaceRoot,
} from './draft-work-in';

/** A write on the draft row (MainPage applies it to the row with this id). */
export type DraftRowUpdate = (draftId: string, update: (d: DraftColumn) => DraftColumn) => void;

export interface DraftProjectStart extends DraftProjectStartState {
  /** A project pick; its source is looked up here. `toHome`: one without a source also brings its own default folder. */
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

/** A change the person made in a draft, per project (lowercased): it wins over the derived place. */
const localPlaces = new Map<string, Map<string, WherePlace>>();
/** The Last used note a project pick put up, per draft, until the place changes. */
const restoredNotes = new Map<string, { project: string; place: WherePlace; key: string }>();

/** The draft closed or started: its places and note go with it (MainPage's forgetDraft). */
export function forgetDraftWhere(draftId: string): void {
  localPlaces.delete(draftId);
  restoredNotes.delete(draftId);
}

export interface WhereHost { key: string; name: string; local: boolean; connected: boolean; title: string }

export interface DraftWhere {
  ps: DraftProjectStart;
  rows: readonly ProjectRegistryRow[];
  /** The draft project's registry row (none for the Inbox or a project Start will create). */
  row: ProjectRegistryRow | undefined;
  /** The draft's project by its current name ('' = none). */
  project: string;
  hostKey: string;
  hostName: (key: string) => string;
  hosts: WhereHost[];
  dirs: readonly WorkingDirEntry[];
  roots: readonly WorkspaceRoot[];
  /** Auto is the current choice (a start from the source, or the project's own folder or home). */
  autoCurrent: boolean;
  /** The draft's Isolated workspace choice is part of the start (startReadsDraftWorkspace): its row, chip and More item show. */
  readsWorkspace: boolean;
  /** A start from the project's source whose project this tab sees with no source (removed
   *  meanwhile): the field says so. Start still goes, and the server says why it cannot. */
  sourceGone: boolean;
  /** Can the current host make this project's Auto. */
  verdict: AutoVerdict;
  what: ReturnType<typeof autoWhat>;
  /** The draft's folder is known on another host only. */
  offHost: string | null;
  /** The project whose code the draft's folder is (a folder start). */
  detected: DetectedProject | null;
  line: WhereLine | null;
  /** Start cannot run as the row stands: why (said near the button). */
  blocked: string | null;
  pickProject: (project: string) => void;
  pickAuto: (hostKey?: string) => void;
  pickFolder: (cwd: string, hostKey: string, hostLabel?: string, lastLaunch?: WorkingDirEntry['lastLaunch']) => void;
  pickHost: (hostKey: string) => void;
  backToAuto: () => void;
  keepFolder: () => void;
  useFresh: () => void;
}

const LOCAL = '__local__';

export function useDraftWhere(draft: DraftColumn, opts: {
  onUpdate: DraftRowUpdate;
  /** A folder pick goes through the owner's folder pick (its project rule, launch memory). */
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta) => void;
}): DraftWhere {
  const { onUpdate, onPathChange } = opts;
  const ps = useDraftProjectStart(draft, true, onUpdate);
  const { rows, projectDefaults } = useProjectRegistry();
  const { dirs } = useWorkingDirs(true);
  const statuses = useAllHostStatus();
  const rootsKey = useTaskListSelect(({ tasks }) => workspaceRootsKey(tasks)) ?? '';
  const roots = useMemo(() => parseWorkspaceRoots(rootsKey), [rootsKey]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const project = ps.project;
  const row = project ? rows.find((r) => r.name.toLowerCase() === project.toLowerCase()) : undefined;
  const hostKey = whereHostKey(draft.host);
  const savedLabel = useLeanCallback((key: string) => dirs.find((d) => whereHostKey(d.host) === key && d.hostLabel)?.hostLabel, [dirs]);
  const hostName = useLeanCallback((key: string) => (key === LOCAL ? thisMachineName()
    : hostDisplayLabel(key, statuses.find((s) => s.host === key)?.label, savedLabel(key) ?? (key === hostKey ? draft.hostLabel : undefined))),
  [statuses, savedLabel, hostKey, draft.hostLabel]);
  const hosts = useMemo<WhereHost[]>(() => [
    { key: LOCAL, name: thisMachineName(), local: true, connected: true, title: thisMachineName() },
    ...statuses.map((s) => ({ key: s.host, name: hostName(s.host), local: false, connected: !!s.connected, title: s.hostname || s.host })),
  ], [statuses, hostName]);

  const home = knownHomeOf(draft.host);
  const what = autoWhat(row, row?.defaultCwd ? folderNameOf(row.defaultCwd) : undefined);
  const autoCurrent = !!project && (row?.startSource ? ps.mode === 'source' : ps.mode === 'source' || !draft.cwdPinned);
  const verdict = autoOn(row, hostKey, { hostName, knownDirs: dirs, projectName: projectDisplayName, folderName: what.kind === 'folder' ? what.words.replace(/^Its folder /, '') : undefined });
  const offHost = !autoCurrent && draft.cwd ? folderElsewhere(draft.cwd, draft.host, dirs, home) : null;
  const detected = !autoCurrent && draft.cwd ? detectProjectForFolder(draft.cwd, draft.host, rows, { home }) : null;
  const suggestion = workInSuggestion(draft, { mode: ps.mode, detected, rows });
  const currentPlace: Pick<WherePlace, 'auto' | 'host' | 'cwd'> = autoCurrent ? { auto: true, host: hostKey } : { auto: false, host: hostKey, cwd: draft.cwd };
  const note = restoredNotes.get(draft.id);
  const restored = note && project && note.project.toLowerCase() === project.toLowerCase() && note.key === placeKey(currentPlace)
    ? { project: projectDisplayName(note.project), place: note.place } : null;
  const own = ownHostOf(row);
  const cannot = autoCurrent && !verdict.ok && !verdict.noProject ? verdict.reason : null;
  const sourceGone = ps.mode === 'source' && !!row && !row.startSource;
  const line = whereLine({
    offHost, cannot, projectHost: own, restored,
    noSource: sourceGone ? `${projectDisplayName(project)} has no code source now. Pick a folder, or add a source in its settings.` : null,
    suggestion: suggestion ? { ...suggestion, project: projectDisplayName(suggestion.project) } : null,
    moved: autoCurrent && verdict.ok && verdict.moved,
  });
  const blocked = cannot ?? (offHost ? `This folder is on ${hostName(offHost)}, not on ${hostName(hostKey)}.` : null);

  const remember = (name: string, place: WherePlace) => {
    if (!name) return;
    let m = localPlaces.get(draft.id);
    if (!m) { m = new Map(); localPlaces.set(draft.id, m); }
    m.set(name.toLowerCase(), place);
  };
  const forget = () => { if (restoredNotes.delete(draft.id)) rerender(); };
  const labelOf = (key: string) => (key === LOCAL ? undefined : hostName(key));

  /** Auto on `key` for `name` (its row): the source on that host, or its own folder or home there. */
  const autoWrite = (d: DraftColumn, name: string, r: ProjectRegistryRow | undefined, key: string): DraftColumn => {
    const source = r?.startSource ?? null;
    const picked = pickProjectForStart(d, name, source, projectDefaults.get(name.toLowerCase()), { toHome: true });
    if (source) return key === ownHostOf(r) ? picked : pickStartHost(picked, draftHostFor(key), labelOf(key));
    // Its own folder is Auto: never a pin (a later folder pick is the person's).
    if (r?.defaultCwd) return { ...(key === ownHostOf(r) ? picked : moveDraftHost(picked, draftHostFor(key), labelOf(key), { home: false })), cwdPinned: false };
    return moveDraftHost(picked, draftHostFor(key), labelOf(key), { home: true });
  };

  const pickProject = (picked: string) => {
    const name = startSourceOf(rows, picked, resolveProjectName).project || picked;
    const r = rows.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!name) {
      onUpdate(draft.id, (d) => pickProjectForStart(d, '', null));
      forget();
      return;
    }
    const place = placeFor(r, localPlaces.get(draft.id)?.get(name.toLowerCase()), derivedPlace(name, dirs, roots));
    onUpdate(draft.id, (d) => (place.auto
      ? autoWrite(d, name, r, place.host)
      : restoreFolderPlace(pickProjectForStart(d, name, null), place.cwd ?? '', draftHostFor(place.host), place.hostLabel ?? labelOf(place.host))));
    restoredNotes.set(draft.id, { project: name, place, key: placeKey(place) });
    rerender();
    log.info('draft', 'where: project restores its place', { draftId: draft.id, project: name, auto: place.auto, host: place.host, first: !!place.first });
  };

  const pickAuto = (key: string = hostKey) => {
    if (!project) return;
    onUpdate(draft.id, (d) => autoWrite(d, project, row, key));
    remember(project, { auto: true, host: key, at: new Date().toISOString() });
    forget();
  };

  const pickFolder = (cwd: string, key: string, hostLabel?: string, lastLaunch?: WorkingDirEntry['lastLaunch']) => {
    const host = draftHostFor(key);
    onPathChange(draft.id, { cwd, host, ...(host && (hostLabel ?? labelOf(key)) ? { hostLabel: hostLabel ?? labelOf(key) } : {}) },
      draft.metaTouched ? draft.meta : applyLaunchMemory(draft.meta, lastLaunch));
    remember(project, { auto: false, host: key, cwd, at: new Date().toISOString() });
    forget();
  };

  const pickHost = (key: string) => {
    if (key === hostKey) return;
    if (autoCurrent && project) {
      onUpdate(draft.id, (d) => (ps.mode === 'source' ? pickStartHost(d, draftHostFor(key), labelOf(key)) : autoWrite(d, project, row, key)));
      remember(project, { auto: true, host: key, at: new Date().toISOString() });
    } else {
      const isHome = !!draft.cwd && (isHomeFolder(draft.cwd, home) || tildePath(draft.cwd, home) === '~');
      onUpdate(draft.id, (d) => moveDraftHost(d, draftHostFor(key), labelOf(key), { home: isHome }));
      remember(project, { auto: false, host: key, cwd: draft.cwd, at: new Date().toISOString() });
    }
    forget();
    log.info('draft', 'where: host changed', { draftId: draft.id, from: hostKey, to: key, auto: autoCurrent });
  };

  const backToAuto = () => pickAuto(autoOn(row, hostKey, { hostName, knownDirs: dirs }).ok ? hostKey : own);
  const keepFolder = () => { onUpdate(draft.id, keepWorkInFolder); log.info('draft', 'where: kept the folder', { draftId: draft.id }); };
  const useFresh = () => {
    if (!suggestion) return;
    ps.pick(suggestion.project);
    remember(suggestion.project, { auto: true, host: ownHostOf(rows.find((r) => r.name === suggestion.project)) });
    log.info('draft', 'where: fresh workspace instead of the folder', { draftId: draft.id, project: suggestion.project });
  };

  return {
    ps, rows, row, project, hostKey, hostName, hosts, dirs, roots, autoCurrent, readsWorkspace: startReadsDraftWorkspace(ps), sourceGone, verdict, what, offHost, detected, line, blocked,
    pickProject, pickAuto, pickFolder, pickHost, backToAuto, keepFolder, useFresh,
  };
}

function folderNameOf(cwd: string): string {
  const dir = cwd.replace(/\/+$/, '');
  return dir.slice(dir.lastIndexOf('/') + 1) || dir;
}
