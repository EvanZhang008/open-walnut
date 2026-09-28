/**
 * The drawer's one draft row and the edits the draft panel reports (see ask-object-draft.ts).
 *
 * The same transitions a Home draft column applies (MainPage's draft handlers), over one row instead
 * of a column list: the Start Task / Ask Walnut tab, a folder pick (the project follows the folder),
 * a project pick, the model pill, and the More menu's task fields. No background parse: the object's
 * context already says what the task is about.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import type { DraftColumn } from '@/components/sessions/draft-column';
import { clearAiFields, refreshFolderProject } from '@/components/sessions/draft-column';
import {
  applyDraftPathPick, applyDraftTaskFieldEdit, enterWalnutDraft, leaveWalnutDraft, makeTierKnown,
  returnFieldToWalnut,
} from '@/components/sessions/draft-ownership';
import type { DraftTaskField, DraftTaskFieldPatch } from '@/components/sessions/draft-column';
import type { QuickStartPath, QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { initialAskDraft, type TierKnown } from './ask-object-draft';

export interface AskObjectDraft {
  draft: DraftColumn;
  /** The row as of now, for callbacks that run after a render (a launch, a save). */
  draftRef: { readonly current: DraftColumn };
  tierKnown: TierKnown;
  /** Ask for the folder picker (a Start Task with no folder). */
  requestFolder: () => void;
  onWalnutToggle: (draftId: string, walnut: boolean) => void;
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta, openedMeta?: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  onMetaChange: (draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  onTaskFieldChange: (draftId: string, patch: DraftTaskFieldPatch) => void;
  onReturnFieldToWalnut: (draftId: string, field: DraftTaskField) => void;
  isKnownProject: (name: string) => boolean;
}

export function useAskObjectDraft(draftId: string): AskObjectDraft {
  const [draft, setDraft] = useState<DraftColumn>(() => initialAskDraft(draftId));
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const registry = useProjectRegistry();
  // Which registry project owns a folder, and which names are taken, read live
  // by the []-dep folder handler.
  const projectForDirRef = useRef<(cwd: string) => string>(() => '');
  projectForDirRef.current = (cwd: string) => registry.projectByCwd.get(cwd.replace(/\/+$/, '')) ?? '';
  const projectTakenRef = useRef<(name: string) => boolean>(() => false);
  projectTakenRef.current = registry.isKnownProject;
  // A folder-set project follows the registry, so the pill says what Start does.
  // Not before the registry loaded: an empty one would rename every owned folder's pill.
  useEffect(() => {
    if (!registry.loaded) return;
    setDraft((d) => refreshFolderProject(d, projectForDirRef.current, registry.isKnownProject));
  }, [registry.projectByCwd, registry.isKnownProject, registry.loaded]);
  const isKnownProject = useCallback(
    (name: string) => !registry.loaded || registry.isKnownProject(name),
    [registry.loaded, registry.isKnownProject],
  );

  const focusBar = useFocusBarContextSafe();
  const tierKnown = useMemo(
    () => makeTierKnown(focusBar?.customTiers ?? [], focusBar?.customTiersLoaded ?? false),
    [focusBar?.customTiers, focusBar?.customTiersLoaded],
  );

  const requestFolder = useCallback(() => {
    setDraft((d) => ({ ...d, openPickerNonce: (d.openPickerNonce ?? 0) + 1 }));
  }, []);
  const onWalnutToggle = useCallback((_id: string, walnut: boolean) => {
    setDraft((d) => (walnut ? enterWalnutDraft(d) : leaveWalnutDraft(d)));
  }, []);
  const onPathChange = useCallback((
    _id: string, path: QuickStartPath, meta: QuickStartTaskMeta, openedMeta?: QuickStartTaskMeta,
  ) => {
    setDraft((d) => applyDraftPathPick(d, path, meta, openedMeta, projectForDirRef.current, projectTakenRef.current));
  }, []);
  const onProjectChange = useCallback((_id: string, project: string) => {
    setDraft((d) => ({ ...clearAiFields(d, ['project']), project, projectSource: 'user' as const, userTouched: true }));
  }, []);
  const onMetaChange = useCallback((_id: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => {
    setDraft((d) => ({ ...d, meta: updater(d.meta), metaTouched: true, userTouched: true }));
  }, []);
  const onTaskFieldChange = useCallback((_id: string, patch: DraftTaskFieldPatch) => {
    setDraft((d) => applyDraftTaskFieldEdit(d, patch));
  }, []);
  const onReturnFieldToWalnut = useCallback((_id: string, field: DraftTaskField) => {
    setDraft((d) => returnFieldToWalnut(d, field));
  }, []);

  return {
    draft, draftRef, tierKnown, requestFolder, onWalnutToggle, onPathChange, onProjectChange, onMetaChange,
    onTaskFieldChange, onReturnFieldToWalnut, isKnownProject,
  };
}
