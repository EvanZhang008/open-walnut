/**
 * A router's settings in their own dialog (2026-11-14, the user: a popup window, not a drawer): the
 * one form for a router, opened from its Org node and from Apps › Mail. Centered over the page,
 * closed by its close button, Escape or a click outside (useModalOverlay); what was typed stays a
 * draft, so closing loses nothing. The form itself is RouterSettingsBody.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { apiPatch } from '@/api/client';
import { listMailAccounts } from '@/api/mail';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { refreshRouterAreas, routerAreaSources } from './router-area-names';
import { folderList, sameFolders } from './RouterFolderPicker';
import '@/styles/router-settings.css';
import { routerStateWord } from './org-channels-model';
import {
  RouterSettingsBody, editRouterValue, isOpenVp, mailAccountNames, routerFormProblem, routerLinkRows, routerPatch,
  shownRouterValue, useRouterSaved, type RouterSettingsValue,
} from './OrgRouterSettings';

interface Props {
  router: Task;
  tasks: readonly Task[];
  tasksLoading?: boolean;
  onClose: () => void;
}

export function RouterSettingsDialog({ router, tasks, tasksLoading = false, onClose }: Props) {
  const modalOwner = useModalOverlay(onClose);
  /** The router as the last save here answered it, until the task list catches up. */
  const [saved, setSaved] = useState<Task | null>(null);
  const fresh = saved && saved.id === router.id && (saved.updated_at ?? '') >= (router.updated_at ?? '') ? saved : router;
  const id = fresh.id;
  /** The folders just saved, shown until the areas read brings them back (or if that read fails). */
  const [savedFolders, setSavedFolders] = useState<string[] | null>(null);
  const read = useRouterSaved(fresh, tasks, tasksLoading);
  const { area, areaLabel } = read;
  const caughtUp = !savedFolders || sameFolders(savedFolders, folderList(read.baseline.folders ?? []));
  const baseline = useMemo(() => (caughtUp ? read.baseline : { ...read.baseline, folders: savedFolders! }), [caughtUp, read.baseline, savedFolders]);
  useEffect(() => { if (savedFolders && caughtUp) setSavedFolders(null); }, [savedFolders, caughtUp]);
  const form = useDraftValue<RouterSettingsValue>(draftKey('org-router-settings', id), baseline);
  const value = shownRouterValue(form.value, baseline);
  const [vpQuery, setVpQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [justSavedAt, setJustSavedAt] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Focus moves into the dialog when it opens and back to what opened it when it closes.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const patch = routerPatch(baseline, value);
  const problem = routerFormProblem(value);
  const leads = useMemo(() => tasks.filter(isOpenVp), [tasks]);
  // Links that no longer name an open VP: the saved ones, and any still checked in the draft. While
  // the list loads, a link not found yet is not called removed.
  const stale = routerLinkRows([...baseline.links, ...value.links], tasks)
    .filter((r) => r.state !== 'open' && !(tasksLoading && r.state === 'missing'));
  const edit = (next: (v: RouterSettingsValue) => RouterSettingsValue) => { setJustSavedAt(0); form.setValue((v) => editRouterValue(v, baseline, next)); };
  const toggleLink = (linkId: string) => edit((v) => ({ ...v, links: v.links.includes(linkId) ? v.links.filter((x) => x !== linkId) : [...v.links, linkId] }));

  // Opening reads the areas again (a mailbox bound since the last read shows), and the mail
  // accounts' addresses, so "Reads from" and the folder groups name each mailbox the way Mail does.
  const [mailNames, setMailNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void refreshRouterAreas();
    listMailAccounts()
      .then((r) => { if (live.current) setMailNames(mailAccountNames(r?.accounts ?? [])); })
      .catch(() => { /* the id stays */ });
  }, [id]);

  const save = async () => {
    if (busy || !patch || problem) return;
    const sentKey = form.key;
    const sentText = JSON.stringify(form.value);
    setBusy(true);
    setError('');
    try {
      const res = await apiPatch<{ task?: Task }>(`/api/v1/org/routers/${encodeURIComponent(id)}`, patch);
      // New folders are read back first, so the cleared form shows them, not the old ones.
      if (patch.folders) {
        const sent = folderList(patch.folders);
        if (live.current) setSavedFolders(sent);
        await refreshRouterAreas().catch(() => { /* the saved folders stay shown */ });
      } else if (patch.filters) {
        await refreshRouterAreas().catch(() => { /* the next read shows them */ });
      }
      // Only this router's draft, and only as it was sent (useDraft's sentKey rule).
      form.clear(sentKey, sentText);
      if (!live.current) return;
      if (res?.task && res.task.id === id) setSaved(res.task);
      setJustSavedAt(Date.now());
    } catch (err) {
      if (live.current) setError(err instanceof Error ? err.message : 'The router settings were not saved.');
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const titleId = `router-settings-title-${id}`;
  return createPortal(
    <ModalOverlayOwner.Provider value={modalOwner}>
      <div className="app-modal-overlay router-settings-overlay" onMouseDown={onClose}>
        <div
          className="app-modal router-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="router-settings-dialog"
          data-router-id={id}
          ref={box}
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="router-settings-dialog-head">
            <div className="router-settings-dialog-titles">
              <h2 className="router-settings-dialog-title" id={titleId}>{value.name.trim() || fresh.org_name || fresh.title}</h2>
              <span className="router-settings-dialog-sub">Router · {areaLabel || 'Area not configured'} · {routerStateWord(baseline.paused)}</span>
            </div>
            <button type="button" className="router-settings-dialog-close" aria-label="Close" data-testid="router-settings-close" onClick={onClose}>×</button>
          </header>
          <div className="router-settings-dialog-body">
            <RouterSettingsBody
              id={`org-router-settings-${id}`} draftKey={form.key} area={areaLabel} sources={routerAreaSources()[area] ?? []} sourceNames={mailNames}
              value={value} leads={leads} stale={stale} busy={busy} error={error} problem={problem} dirty={!!patch}
              justSaved={justSavedAt > 0 && !patch} tasksLoading={tasksLoading} linkFilter={vpQuery} onLinkFilter={setVpQuery}
              onEdit={edit} onToggleLink={toggleLink} onSave={() => { void save(); }} onDiscard={() => { form.clear(); setError(''); }}
            />
          </div>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}
