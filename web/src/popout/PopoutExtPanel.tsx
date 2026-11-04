/**
 * Walnut in the browser's side panel. The Walnut extension's panel page frames this view and
 * tells it about the page the person is on (ext-panel-model.ts); the conversation is an ordinary
 * Ask Walnut session about that page (AskObjectDrawer), one per page, remembered for when the
 * person comes back to it. The page's text reaches Walnut only when a question is asked with
 * "Include this page" on, as a file the ask names. "Let Walnut act in this tab" is the person's
 * click: the extension makes the tab this ask's agent tab, framed and with Stop, like the tabs
 * agents open themselves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '@/api/client';
import { AskObjectDrawer, type AskObjectQuote } from '@/components/chat/AskObjectDrawer';
import { forgetAskSession } from '@/components/chat/ask-object-session';
import { GENERAL_AGENT_ID } from '@/components/chat/ask-walnut-slot-model';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { NotificationToaster } from '@/components/common/NotificationToaster';
import { OperationErrorBridge } from '@/components/common/OperationErrorBridge';
import { TransferDialogHost } from '@/components/transfer/TransferDialogHost';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider } from '@/contexts/FocusBarContext';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { log } from '@/utils/log';
import {
  CONTEXT_NAME, EXT_PANEL, actNote, hostOf, pageContextBlock, pageKey, readInbound, selectionQuote,
  type PanelContext,
} from './ext-panel-model';
import './ext-panel.css';

export function PopoutExtPanel() {
  return <TasksProvider><NotificationProvider><FocusBarProvider>
    <ExtPanel />
    <NotificationToaster />
    <OperationErrorBridge />
    <TransferDialogHost />
  </FocusBarProvider></NotificationProvider></TasksProvider>;
}

/** The extension page that framed this view, once it spoke: everything after goes to it alone. */
let parentOrigin = '';

function toParent(msg: Record<string, unknown>): void {
  // Before the extension's first word only `ready` goes out, and it carries nothing.
  if (!parentOrigin && msg.type !== 'ready') return;
  window.parent?.postMessage({ walnut: EXT_PANEL, ...msg }, parentOrigin || '*');
}

/** Long enough for the extension's first word; past it, this view was opened some other way. */
const HELLO_MS = 2500;
const TEXT_MS = 10_000;

function insertInto(sessionId: string, text: string): void {
  const detail: ComposerInsertDetail = { sessionId, text, mode: 'lead', handled: false };
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
}

function ExtPanel() {
  const [ctx, setCtx] = useState<PanelContext | null>(null);
  const [orphan, setOrphan] = useState(false);
  const [includePage, setIncludePage] = usePageView('ext-panel', 'includePage', true, isBoolean);
  const [record, setRecord] = useState<{ taskId: string; sessionId?: string } | null>(null);
  // The person's last click on "act", until the tab's owner agrees with it.
  const [actChoice, setActChoice] = useState<boolean | null>(null);
  const [actError, setActError] = useState('');
  const [chat, setChat] = useState(0);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const recordRef = useRef(record);
  recordRef.current = record;
  /** `<task>:<tab>` the extension was asked to hand over, so it is asked once. */
  const adoptedFor = useRef('');
  /** A selection the context menu asked about before this page's conversation was known. */
  const heldSelection = useRef('');
  const textWaits = useRef(new Map<string, (r: { url: string; text: string }) => void>());

  const page = ctx?.page ?? null;
  const tab = ctx?.tab;
  const key = page ? pageKey(page.url) : '';
  const scope = useMemo(() => ({ agentId: GENERAL_AGENT_ID, key }), [key]);
  const mine = record ? `task:${record.taskId}` : '';

  // Another page or tab is another conversation (its own, remembered), and nothing is asked for it yet.
  useEffect(() => { setRecord(null); setActChoice(null); setActError(''); adoptedFor.current = ''; heldSelection.current = ''; }, [key, chat, tab]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const fromParent = e.source === window.parent && window.parent !== window;
      if (parentOrigin && e.origin !== parentOrigin) return;
      const m = readInbound(e.data, e.origin, fromParent);
      if (!m) return;
      parentOrigin = e.origin;
      if (m.type === 'context') {
        setCtx({ page: m.page, ...(m.tab !== undefined ? { tab: m.tab } : {}), agents: m.agents, ...(m.owner ? { owner: m.owner } : {}) });
        setOrphan(false);
      } else if (m.type === 'ask-selection') {
        const sessionId = recordRef.current?.sessionId;
        // In a conversation already going, the selection leads the next message; before one is
        // known it waits for it; a new conversation has it in the context (the quote).
        if (sessionId) insertInto(sessionId, selectionQuote(m.text));
        else heldSelection.current = m.text;
      } else if (m.type === 'adopted') {
        if (!m.ok) { setActChoice(null); adoptedFor.current = ''; setActError(m.error ?? 'Walnut could not take this tab.'); }
      } else if (m.type === 'page-text') {
        textWaits.current.get(m.id)?.({ url: m.url, text: m.text });
      }
    };
    // Back in the panel to type: the selection made on the page meanwhile is read again.
    const refresh = () => toParent({ type: 'refresh' });
    window.addEventListener('message', on);
    window.addEventListener('focus', refresh);
    toParent({ type: 'ready' });
    const t = setTimeout(() => { if (!ctxRef.current) setOrphan(true); }, HELLO_MS);
    return () => { window.removeEventListener('message', on); window.removeEventListener('focus', refresh); clearTimeout(t); };
  }, []);

  useEffect(() => { document.title = page?.title ? `${page.title} · Walnut` : 'Walnut'; }, [page?.title]);

  // A held selection goes in once this page's conversation shows.
  useEffect(() => {
    if (record?.sessionId && heldSelection.current) {
      insertInto(record.sessionId, selectionQuote(heldSelection.current));
      heldSelection.current = '';
    }
  }, [record?.sessionId]);

  const owner = ctx?.owner;
  const otherOwner = !!owner && owner !== mine;
  const ownTab = !!owner && owner === mine;
  // Once the tab is as the person asked, its own state shows again (so Stop on the page shows too).
  useEffect(() => {
    setActChoice((c) => (c === ownTab ? null : c));
  }, [ownTab]);
  const actOn = actChoice ?? ownTab;
  const actWanted = actChoice === true;

  // The person turned acting on: the tab goes to this ask once its task exists.
  useEffect(() => {
    if (!actWanted || tab === undefined || !record?.taskId) return;
    const once = `${record.taskId}:${tab}`;
    if (adoptedFor.current === once) return;
    adoptedFor.current = once;
    toParent({ type: 'adopt', tab, task: record.taskId, who: 'Ask Walnut' });
  }, [actWanted, tab, record?.taskId]);

  const toggleAct = useCallback((on: boolean) => {
    setActError('');
    const t = ctxRef.current?.tab;
    if (t === undefined) return;
    if (!on) {
      setActChoice(false);
      adoptedFor.current = '';
      toParent({ type: 'release', tab: t });
      return;
    }
    // Asked again (after Stop on the page, say): the tab is handed over again.
    adoptedFor.current = '';
    setActChoice(true);
    // A conversation already going hears it with the person's next message.
    const sessionId = recordRef.current?.sessionId;
    if (sessionId) insertInto(sessionId, actNote(t));
  }, []);

  const takeBack = useCallback(() => {
    const t = ctxRef.current?.tab;
    if (t !== undefined) toParent({ type: 'release', tab: t });
  }, []);

  /** The page's text, asked of the extension only now that a question goes out. */
  const fetchText = useCallback((url: string): Promise<string> => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (text: string) => { textWaits.current.delete(id); clearTimeout(timer); resolve(text); };
    const timer = setTimeout(() => done(''), TEXT_MS);
    textWaits.current.set(id, (r) => done(r.url === url ? r.text : ''));
    toParent({ type: 'page-text', id });
  }), []);

  const prepareContext = useCallback(async (draft: { walnut?: boolean; host?: string | null }): Promise<string> => {
    const now = ctxRef.current;
    const p = now?.page;
    if (!p) return '';
    let file: string | undefined;
    let inline: string | undefined;
    if (includePage) {
      const text = await fetchText(p.url);
      if (text.trim()) {
        // A task on another machine cannot read this one's file: it gets the text itself.
        if (!draft.walnut && draft.host && draft.host !== '__local__') inline = text;
        else file = (await apiPost<{ file: string }>('/api/v1/browser/page', { url: p.url, title: p.title, text }, { timeoutMs: 20_000 })).file;
      }
    }
    const acting = actChoice === true && now?.tab !== undefined;
    log.info('ext-panel', 'asking about a page', { host: hostOf(p.url), withText: !!(file || inline), acting });
    return pageContextBlock(p, { ...(file ? { file } : {}), ...(inline ? { inline } : {}), ...(acting ? { tab: now!.tab } : {}) });
  }, [includePage, actChoice, fetchText]);

  const newChat = useCallback(() => {
    if (!key) return;
    forgetAskSession(scope);
    setChat((n) => n + 1);
  }, [key, scope]);

  if (!ctx) {
    return <div className="ext-panel ext-panel-empty" data-testid="ext-panel">
      {orphan
        ? <p>This is Walnut&apos;s browser side panel. Open it from the Walnut extension, next to a web page.</p>
        : <p className="muted"><span className="spinner" /> Connecting to the page…</p>}
    </div>;
  }

  if (!page) {
    return <div className="ext-panel ext-panel-empty" data-testid="ext-panel">
      <p>Open a web page to ask Walnut about it.</p>
      <p className="muted">Walnut cannot read the browser&apos;s own pages or Walnut itself.</p>
    </div>;
  }

  const quote: AskObjectQuote = {
    who: hostOf(page.url),
    when: '',
    where: page.title ?? '',
    preview: page.selection ?? (includePage ? 'The whole page' : 'Only the page\'s title and address'),
  };

  return <div className="ext-panel" data-testid="ext-panel" data-page-key={key}>
    <header className="ext-panel-head">
      <div className="ext-panel-page">
        <span className="ext-panel-title" title={page.title ?? page.url}>{page.title ?? hostOf(page.url)}</span>
        <span className="ext-panel-host">{hostOf(page.url)}</span>
      </div>
      <button type="button" className="btn btn-sm" data-testid="ext-panel-new" onClick={newChat} title="Start a new conversation about this page">New chat</button>
    </header>
    <div className="ext-panel-options">
      <label className="ext-panel-option">
        <input type="checkbox" data-testid="ext-panel-include" checked={includePage} onChange={(e) => setIncludePage(e.target.checked)} />
        Include this page
      </label>
      {tab !== undefined && !otherOwner && (
        <label className="ext-panel-option" title="Walnut reads and acts in this tab only while this is on. Stop on the page gives it back.">
          <input type="checkbox" data-testid="ext-panel-act" checked={actOn} onChange={(e) => toggleAct(e.target.checked)} />
          Let Walnut act in this tab
        </label>
      )}
    </div>
    {otherOwner && (
      <p className="ext-panel-note" data-testid="ext-panel-other-owner">
        Another Walnut conversation or task is acting in this tab.{' '}
        <button type="button" className="ext-panel-link" data-testid="ext-panel-take-back" onClick={takeBack}>Take it back</button>
      </p>
    )}
    {actOn && !ctx.agents && <p className="ext-panel-note">This also turns on Walnut agents in this browser (Settings in the extension turns them off).</p>}
    {actError && <p className="ext-panel-note ext-panel-error" role="alert">{actError}</p>}
    <div className="ext-panel-chat">
      <AskObjectDrawer
        key={`${key}:${chat}:${tab ?? ''}`}
        objectKey={key}
        title={`Ask Walnut about ${page.title ?? hostOf(page.url)}`}
        quote={quote}
        agentId={GENERAL_AGENT_ID}
        contextBlock=""
        contextName={CONTEXT_NAME}
        prepareContext={prepareContext}
        onRecord={setRecord}
        onClose={() => toParent({ type: 'close' })}
      />
    </div>
  </div>;
}
