/**
 * Walnut in the browser's side panel. The Walnut extension's panel page frames this view and
 * tells it about the page the person is on (ext-panel-model.ts); the conversation is an ordinary
 * Ask Walnut session about that page (AskObjectDrawer), one per page, remembered for when the
 * person comes back to it. The page's text reaches Walnut only when a question is asked with
 * "Include this page" on, as a file the ask names. "Let Walnut act in this tab" is the person's
 * click: the extension makes the tab this ask's agent tab, framed and with Stop, like the tabs
 * agents open themselves.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiPost } from '@/api/client';
import { AskObjectDrawer, type AskObjectQuote } from '@/components/chat/AskObjectDrawer';
import { OBJECT_CONTEXT_HINT, forgetAskSession, objectContextHints, storeObjectContext } from '@/components/chat/ask-object-session';
import { setPendingHintsSource } from '@/utils/pending-hints';
import { UserRowAttachmentsContext, type UserRowHints } from '@/components/sessions/user-row-attachments';
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
  ACT_CONTEXT_NAME, CONTEXT_NAME, actLine, conversationKey, handedOf, hostOf, otherOwnerOf, pageContextBlock, rememberHanded, rememberSent, selectionOfContext, sentOf, selectionQuote,
  type PanelContext,
} from './ext-panel-model';
import { fromParent, toParent } from './ext-frame';
import { askSnapOf, snapKeyOf } from './ext-snapshot';
import { flushHistoryWrites } from '@/cache/history-idb';
import './ext-panel.css';

export function PopoutExtPanel() {
  return <TasksProvider><NotificationProvider><FocusBarProvider>
    <ExtPanel />
    <NotificationToaster />
    <OperationErrorBridge />
    <TransferDialogHost />
  </FocusBarProvider></NotificationProvider></TasksProvider>;
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
  /** The page's selection the person left out of their next message (×), and the one already sent. */
  const [leftOut, setLeftOut] = useState('');
  const [sentSelection, setSentSelection] = useState('');
  /** The tab turned over in a conversation already going: its note rides the next message. */
  const actNote = useRef<number | undefined>(undefined);
  /** What each sent message attached from the page, by its context id (the bubble before it is saved). */
  const attachedById = useRef(new Map<string, string>());
  /** The selection a conversation's first question took, by its words: that bubble carries no hints. */
  const attachedByWords = useRef(new Map<string, string>());

  const page = ctx?.page ?? null;
  const tab = ctx?.tab;
  const owner = ctx?.owner;
  const handed = useMemo(() => handedOf(tab), [tab, owner]);
  const key = page ? conversationKey(page.url, tab, owner, handed) : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  /** New chat while this conversation acts in the tab: the new one gets the tab once it has a task. */
  const carryAct = useRef(false);
  const scope = useMemo(() => ({ agentId: GENERAL_AGENT_ID, key }), [key]);
  const mine = record ? `task:${record.taskId}` : '';

  // Another page or tab is another conversation (its own, remembered), and nothing is asked for it yet.
  useEffect(() => {
    setRecord(null); setActChoice(carryAct.current ? true : null); setActError(''); adoptedFor.current = ''; heldSelection.current = '';
    carryAct.current = false; actNote.current = undefined; attachedByWords.current.clear(); setLeftOut(''); setSentSelection(sentOf(key));
  }, [key, chat, tab]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = fromParent(e);
      if (!m) return;
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
        // A hand-over the person already took back ends refused ("Taken back."): that is no error to show.
        if (!m.ok && actOnRef.current) { setActChoice(null); adoptedFor.current = ''; setActError(m.error ?? 'Walnut could not take this tab.'); }
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

  const otherOwner = otherOwnerOf(owner, mine, handed, actChoice === true);
  const ownTab = !!owner && owner === mine;
  // Once the tab is as the person asked, its own state shows again (so Stop on the page shows too).
  useEffect(() => {
    setActChoice((c) => (c === ownTab ? null : c));
  }, [ownTab]);
  const actOn = actChoice ?? ownTab;
  const actOnRef = useRef(actOn);
  actOnRef.current = actOn;
  const actWanted = actChoice === true;

  // The person turned acting on: the tab goes to this ask once its task exists.
  useEffect(() => {
    if (!actWanted || tab === undefined || !record?.taskId) return;
    const once = `${record.taskId}:${tab}`;
    if (adoptedFor.current === once) return;
    adoptedFor.current = once;
    rememberHanded(tab, key, record.taskId);
    toParent({ type: 'adopt', tab, task: record.taskId, who: 'Ask Walnut' });
  }, [actWanted, tab, record?.taskId, key]);

  const toggleAct = useCallback((on: boolean) => {
    setActError('');
    const t = ctxRef.current?.tab;
    if (t === undefined) return;
    if (!on) {
      setActChoice(false);
      adoptedFor.current = '';
      // Taken back before the next message: it must not tell the ask it may act there.
      actNote.current = undefined;
      toParent({ type: 'release', tab: t });
      return;
    }
    // Asked again (after Stop on the page, say): the tab is handed over again.
    adoptedFor.current = '';
    setActChoice(true);
    // A conversation already going hears it with the person's next message, as a Walnut hint
    // beside their words (never typed into them: it is not what they wrote): nextHints below.
    if (recordRef.current?.sessionId) actNote.current = t;
  }, []);

  const takeBack = useCallback(() => {
    const t = ctxRef.current?.tab;
    if (t !== undefined) toParent({ type: 'release', tab: t });
  }, []);

  // The selection on the page goes with the person's next message in a conversation already
  // going, shown in its composer until it is sent or left out.
  const selection = page?.selection?.trim() ?? '';
  const attach = !!record?.sessionId && !!selection && selection !== leftOut && selection !== sentSelection ? selection : '';
  const attachRef = useRef(attach);
  attachRef.current = attach;

  /** What the next message in a conversation already going takes along: the selection and the tab note. */
  const nextHints = useCallback(async (message: string) => {
    const p = ctxRef.current?.page;
    const sel = attachRef.current;
    // The tab note only while acting is still on (Stop on the page or Take it back end it too).
    const tab = actOnRef.current ? actNote.current : undefined;
    if (!p || (!sel && tab === undefined)) return undefined;
    const block = sel ? pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), selection: sel }, tab !== undefined ? { tab } : {}) : actLine(tab!);
    const id = await storeObjectContext(sel ? CONTEXT_NAME : ACT_CONTEXT_NAME, block, (path, b) => apiPost<{ id: string }>(path, b))
      .catch((err) => { log.warn('ext-panel', 'note for the next message not stored', { error: err instanceof Error ? err.message : String(err) }); return ''; });
    if (!id) return undefined;
    actNote.current = undefined;
    if (sel) {
      attachedById.current.set(id, sel);
      if (message.trim()) attachedByWords.current.set(message.trim(), sel);
      setSentSelection(sel);
      rememberSent(keyRef.current, sel);
    }
    return objectContextHints(id);
  }, []);
  useEffect(() => {
    const sid = record?.sessionId;
    if (!sid) return;
    setPendingHintsSource(sid, nextHints);
    return () => setPendingHintsSource(sid, null);
  }, [record?.sessionId, nextHints]);

  /** Under the person's bubble: the text it took from the page, as a small quote. */
  const attachmentsOf = useCallback((row: UserRowHints): ReactNode => {
    const id = row.requestedHints?.[OBJECT_CONTEXT_HINT]?.arg;
    const text = (id ? attachedById.current.get(id) : undefined)
      || (!id && !row.hints?.length && row.text ? attachedByWords.current.get(row.text.trim()) : undefined)
      || selectionOfContext(row.hints?.find((h) => h.kind === OBJECT_CONTEXT_HINT)?.text);
    if (!text) return null;
    return <figure className="ext-panel-attached" data-testid="ext-panel-attached">
      <figcaption>From the page</figcaption>
      <blockquote>{text}</blockquote>
    </figure>;
  }, []);

  const selectionPill = attach ? (
    <div className="ext-panel-selection" data-testid="ext-panel-selection">
      <span className="ext-panel-selection-text" title={attach}><span className="ext-panel-selection-label">Selected on the page:</span> {attach}</span>
      <button type="button" className="ext-panel-selection-drop" data-testid="ext-panel-selection-drop" aria-label="Leave the selection out" title="Leave the selection out of the next message" onClick={() => setLeftOut(attach)}>&times;</button>
    </div>
  ) : undefined;

  // What the chat shows, for the panel page to draw the next time this view loads (ext-snapshot.ts),
  // and the word that this view's own content is up, so that drawing goes.
  const chatRef = useRef<HTMLDivElement>(null);
  const shownTold = useRef(false);
  const pageUrl = page?.url ?? '';
  const pageTitle = page?.title;
  useEffect(() => {
    const el = chatRef.current;
    if (!el || !pageUrl) return;
    const tellShown = () => { if (!shownTold.current) { shownTold.current = true; toParent({ type: 'shown' }); } };
    const viewOf = () => el.querySelector('[data-testid="ask-object-drawer"]')?.getAttribute('data-view');
    const check = () => {
      const v = viewOf();
      if (v === 'compose' || (v === 'session' && el.querySelector('.session-msg'))) tellShown();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snap = () => {
      const v = viewOf();
      if (v !== 'compose' && v !== 'session') return;
      const s = askSnapOf(el, { url: pageUrl, ...(pageTitle ? { title: pageTitle } : {}) }, hostOf(pageUrl));
      // A conversation whose messages have not loaded yet says nothing new: it must not replace
      // the drawing of last time with an empty chat.
      if (v === 'session' && s.messages.length === 0) return;
      toParent({ type: 'snapshot', view: 'ask', key: snapKeyOf(pageUrl), snap: s });
    };
    const obs = new MutationObserver(() => { check(); clearTimeout(timer); timer = setTimeout(snap, 500); });
    obs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-view'] });
    check();
    timer = setTimeout(snap, 500);
    // A view that never draws a message (a conversation still starting) lets the drawing go anyway.
    const fallback = setTimeout(tellShown, 4000);
    // Closing the panel ends this page: what it holds goes to the browser's cache now, not after its debounce.
    const hide = () => { snap(); flushHistoryWrites(); };
    window.addEventListener('pagehide', hide);
    return () => { obs.disconnect(); clearTimeout(timer); clearTimeout(fallback); window.removeEventListener('pagehide', hide); };
  }, [pageUrl, pageTitle, key]);

  /** The page's text, asked of the extension only now that a question goes out. */
  const fetchText = useCallback((url: string): Promise<string> => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (text: string) => { textWaits.current.delete(id); clearTimeout(timer); resolve(text); };
    const timer = setTimeout(() => done(''), TEXT_MS);
    textWaits.current.set(id, (r) => done(r.url === url ? r.text : ''));
    toParent({ type: 'page-text', id });
  }), []);

  const prepareContext = useCallback(async (draft: { walnut?: boolean; host?: string | null }, question: string): Promise<string> => {
    const now = ctxRef.current;
    const p = now?.page;
    if (!p) return '';
    // The first question takes the selection along: its bubble shows it, and it is not offered again.
    const sel = p.selection?.trim();
    if (sel) { attachedByWords.current.set(question.trim(), sel); setSentSelection(sel); rememberSent(keyRef.current, sel); }
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
    carryAct.current = ownTab;
    setChat((n) => n + 1);
  }, [key, scope, ownTab]);

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
    {actOn && <p className="ext-panel-note" data-testid="ext-panel-act-note">Walnut's agents may act in this tab only, until you take it back.</p>}
    {actError && <p className="ext-panel-note ext-panel-error" role="alert">{actError}</p>}
    <div className="ext-panel-chat" ref={chatRef}>
      <UserRowAttachmentsContext.Provider value={attachmentsOf}>
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
        plainChat
        composerPlaceholder="Ask about this page…"
        composerPill={selectionPill}
      />
      </UserRowAttachmentsContext.Provider>
    </div>
  </div>;
}
