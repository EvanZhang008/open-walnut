/**
 * useProjectActions — ONE definition of the two project actions that need a
 * dialog: Rename and Delete.
 *
 * They used to live inside `ProjectKebabMenu`, which made the kebab the only
 * surface that could offer them. The right-click menu on a project row wants the
 * exact same flows (same prompt copy, same local-claim vs provider-claim delete
 * semantics, same `?remote=1` cascade wording), and a copy of that reasoning
 * would drift the first time a provider changes what deletion means — so both
 * menus call this hook instead.
 *
 * The project is a PARAMETER, not a hook option: the kebab knows its project at
 * mount, but a context menu only learns it when the user right-clicks a row, and
 * a per-project hook instance would mean one hook per rendered row.
 */
import { useCallback, useState } from 'react';
import { useConfirm, useAlert, usePrompt } from '@/hooks/useConfirm';
import { fetchProjectDetail, renameProject, deleteProject } from '@/api/projects';

export interface ProjectActionsOptions {
  /** Fired after a successful rename/delete so hosts without the task:updated
   *  broadcast in view (the /tasks rail) can refresh their registry copy and
   *  fix a now-stale selection. */
  onChanged?: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
}

export interface ProjectActionsHandle {
  /** A dialog/request is in flight — hosts that own a trigger button disable it. */
  busy: boolean;
  rename: (project: string) => Promise<void>;
  remove: (project: string) => Promise<void>;
}

export function useProjectActions({ onChanged }: ProjectActionsOptions = {}): ProjectActionsHandle {
  const confirm = useConfirm();
  const alert = useAlert();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

  const rename = useCallback(async (project: string) => {
    const next = await prompt({
      title: `Rename project “${project}”`,
      message: 'Renaming onto an existing project merges them (case-insensitive).',
      defaultValue: project,
      confirmLabel: 'Rename',
    });
    const target = next?.trim();
    if (!target || target === project) return;
    setBusy(true);
    try {
      await renameProject(project, target);
      // Task rows refresh via the task:updated broadcast; onChanged covers
      // registry-driven hosts (rail selection, project list).
      onChanged?.('rename', project, target);
    } catch (err) {
      await alert({ title: 'Rename failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [prompt, alert, onChanged]);

  // Same semantics + copy as ProjectDetailPane.handleDelete: local claim = row
  // drop (tasks → Inbox); provider claim = ?remote=1 CASCADE, which deletes the
  // remote container itself (IRREVERSIBLE), so the confirm spells that out.
  // Source isn't threaded into the menus, so fetch the detail lazily here.
  const remove = useCallback(async (project: string) => {
    setBusy(true);
    let source = 'local';
    let total = 0;
    try {
      const detail = await fetchProjectDetail(project);
      source = detail.source;
      total = detail.counts.todo + detail.counts.active + detail.counts.done;
    } catch (err) {
      // Without the real source we can't pick the right confirm copy — a
      // provider-claimed project shown the harmless local copy would then hit
      // the route's 409 anyway. Abort instead of guessing.
      setBusy(false);
      await alert({ title: 'Delete unavailable', message: `Could not load project info: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    setBusy(false);
    const isClaimed = source !== 'local';
    const ok = await confirm({
      title: `Delete project “${project}”?`,
      message: isClaimed
        ? `This project is synced with ${source}. Deleting it ALSO DELETES the remote container (e.g. the MS To-Do list) — this cannot be undone. Local tasks are kept and move to the Inbox.`
        : `Its ${total} task${total === 1 ? '' : 's'} move to the Inbox (nothing is deleted).`,
      confirmLabel: isClaimed ? 'Delete here + remote' : 'Delete project',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteProject(project, isClaimed ? { remote: true } : undefined);
      onChanged?.('delete', project);
    } catch (err) {
      await alert({ title: 'Delete failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [confirm, alert, onChanged]);

  return { busy, rename, remove };
}
