/**
 * The Mail plugin's routers, on its page in Apps (2026-11-14, the user: this can be set in the
 * plugin's settings too, the router is something the plugin provides): every mailbox comes with a
 * router, and the folders that router watches are set here, the Inbox by default.
 *
 * One router can read several mailboxes, so each router is one block: its name and state, the
 * mailboxes it reads, and its folders. The folders are the router's own saved list, the same one
 * its Org settings edit (RouterFoldersField): Save here sends PATCH /api/v1/org/routers/:id with
 * `folders` only, and both pages read it back from GET /api/v1/router/areas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { apiPatch } from '@/api/client';
import { listMailAccounts, type MailAccountDto } from '@/api/mail';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { RouterFoldersField, folderList, sameFolders } from '@/components/org/RouterFoldersField';
import { areaIdWords } from '@/components/org/org-channels-model';
import {
  accountAreaKey, refreshRouterAreas, routerAccountAreas, routerAreaFolders, routerAreaRouters, useRouterAreaNames, useRouterAreasReadState,
} from '@/components/org/router-area-names';
import './mail-router-settings.css';

export interface MailRouterBlock {
  /** The router's task id ('' when the area has no router yet). */
  routerId: string;
  areaId: string;
  name: string;
  /** Paused or Ready from its task; Closed for a router that was completed; null while its task is not loaded. */
  state: 'Paused' | 'Ready' | 'Closed' | null;
  accounts: Array<{ accountId: string; label: string }>;
  /** The saved folders, as the field shows them ('' = the Inbox). */
  folders: string;
}

/** Each router that reads a mailbox, with its mailboxes, in the accounts' order; then the mailboxes no router reads. */
export function mailRouterBlocks(
  accounts: ReadonlyArray<Pick<MailAccountDto, 'accountId' | 'address' | 'displayName'>>,
  accountAreas: Readonly<Record<string, string>>,
  areaRouters: Readonly<Record<string, string>>,
  areaFolders: Readonly<Record<string, readonly string[]>>,
  areaNames: Readonly<Record<string, string>>,
  tasks: readonly Task[],
): { blocks: MailRouterBlock[]; unrouted: Array<{ accountId: string; label: string }> } {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const blocks = new Map<string, MailRouterBlock>();
  const unrouted: Array<{ accountId: string; label: string }> = [];
  for (const account of accounts) {
    const label = (account.address || account.displayName || account.accountId).trim();
    const areaId = accountAreas[accountAreaKey('mail', account.accountId)];
    const routerId = areaId ? areaRouters[areaId] ?? '' : '';
    if (!areaId || !routerId) { unrouted.push({ accountId: account.accountId, label }); continue; }
    let block = blocks.get(areaId);
    if (!block) {
      const task = byId.get(routerId);
      const area = areaNames[areaId] || areaIdWords(areaId);
      block = {
        routerId, areaId,
        name: (task && (task.org_name || task.title)) || `${area} router`,
        state: !task ? null : task.phase === 'COMPLETE' ? 'Closed' : task.router_paused !== false ? 'Paused' : 'Ready',
        accounts: [],
        folders: (areaFolders[areaId] ?? []).join(', '),
      };
      blocks.set(areaId, block);
    }
    block.accounts.push({ accountId: account.accountId, label });
  }
  return { blocks: [...blocks.values()], unrouted };
}

export function MailRouterSettings() {
  const tasks = useTasksContextSafe()?.tasks;
  const [accounts, setAccounts] = useState<MailAccountDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-renders on every areas read (the names hook hears each one); the read itself is asked for here.
  const areaNames = useRouterAreaNames([]);
  const areasRead = useRouterAreasReadState();
  useEffect(() => {
    let live = true;
    refreshRouterAreas();
    listMailAccounts()
      .then((r) => { if (live) setAccounts(r?.accounts ?? []); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const { blocks, unrouted } = useMemo(
    () => mailRouterBlocks(accounts ?? [], routerAccountAreas(), routerAreaRouters(), routerAreaFolders(), areaNames, tasks ?? []),
    // The module-level reads change together with the names, which this hook hears.
    [accounts, areaNames, tasks],
  );

  if (failed) return <p className="mail-router-empty" data-testid="mail-router-settings">Could not read the mailboxes. Reload the page to try again.</p>;
  // Until the routers are read, no mailbox is called unrouted.
  if (areasRead === 'failed' && !Object.keys(areaNames).length) return <p className="mail-router-empty" data-testid="mail-router-settings">Could not read the routers. Reload the page to try again.</p>;
  if (!accounts || areasRead === 'pending') return <p className="mail-router-empty" data-testid="mail-router-settings">Reading the mailboxes…</p>;
  return (
    <div className="mail-router-settings" data-testid="mail-router-settings">
      <p className="mail-router-lead">Each mailbox comes with a router. It reads the new mail in the folders below and hands each one to the task or VP that owns it.</p>
      {blocks.length === 0 && unrouted.length === 0 && <p className="mail-router-empty">No mailbox yet. Add one in Mail.</p>}
      {blocks.map((block) => <MailRouterBlockView key={block.routerId} block={block} />)}
      {unrouted.length > 0 && (
        <div className="mail-router-block is-unrouted" data-testid="mail-router-unrouted">
          <div className="mail-router-head"><span className="mail-router-name">No router yet</span></div>
          <ul className="mail-router-accounts">{unrouted.map((a) => <li key={a.accountId} data-account={a.accountId}>{a.label}</li>)}</ul>
          <p className="mail-router-hint">Its router is set up with its next new mail.</p>
        </div>
      )}
    </div>
  );
}

function OrgLink({ routerId }: { routerId: string }) {
  const routed = useInRouterContext();
  const to = `/org?node=${encodeURIComponent(`router:${routerId}`)}`;
  const props = { className: 'mail-router-open', 'data-testid': 'mail-router-open-org' };
  return routed ? <Link to={to} {...props}>Open in Org</Link> : <a href={to} {...props}>Open in Org</a>;
}

function MailRouterBlockView({ block }: { block: MailRouterBlock }) {
  const form = useDraftValue<string>(draftKey('mail-router-folders', block.routerId), block.folders);
  const value = form.value;
  const dirty = !sameFolders(block.folders, value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Set on every mount: React's development double mount runs the cleanup once before the real mount.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const save = async () => {
    if (busy || !dirty) return;
    const sentKey = form.key;
    const sentText = JSON.stringify(value);
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await apiPatch(`/api/v1/org/routers/${encodeURIComponent(block.routerId)}`, { folders: folderList(value) });
      // Read back first, so the cleared field shows the folders just saved, not the old ones.
      await refreshRouterAreas();
      form.clear(sentKey, sentText);
      if (live.current) setSaved(true);
    } catch (err) {
      if (live.current) setError(err instanceof Error ? err.message : 'The folders were not saved.');
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const fieldId = `mail-router-folders-${block.routerId}`;
  return (
    <form
      className="mail-router-block"
      data-testid="mail-router-block"
      data-router-id={block.routerId}
      aria-label={block.name}
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <div className="mail-router-head">
        <span className="mail-router-name">{block.name}</span>
        {block.state && <span className={`mail-router-state is-${block.state.toLowerCase()}`} data-testid="mail-router-state">{block.state}</span>}
        <OrgLink routerId={block.routerId} />
      </div>
      <ul className="mail-router-accounts" data-testid="mail-router-accounts">
        {block.accounts.map((a) => <li key={a.accountId} data-account={a.accountId}>{a.label}</li>)}
      </ul>
      <label className="mail-router-label" htmlFor={fieldId}>Watches folders</label>
      <RouterFoldersField
        inputId={fieldId}
        value={value}
        draftKey={form.key}
        testId="mail-router-folders"
        disabled={busy}
        note={block.accounts.length > 1 ? 'Applies to every mailbox above.' : null}
        onChange={(next) => { setSaved(false); form.setValue(next); }}
      />
      {error && <p className="mail-router-error" role="alert" data-testid="mail-router-error">{error}</p>}
      <div className="mail-router-actions" hidden={!dirty && !saved}>
        {dirty && <button type="submit" className="btn btn-sm btn-primary" data-testid="mail-router-save" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
        {dirty && <button type="button" className="btn btn-sm" data-testid="mail-router-discard" disabled={busy} onClick={() => { form.clear(); setError(''); }}>Discard</button>}
        {/* Always mounted, so a screen reader announces the word when it appears. */}
        <span className="mail-router-hint" role="status" aria-live="polite" data-testid="mail-router-saved">{!dirty && saved ? 'Saved.' : ''}</span>
      </div>
    </form>
  );
}
