/**
 * Walnut in the browser's side panel, and in the toolbar popup: Walnut's own Ask. The Walnut
 * extension's panel page frames this view and tells it about the page the person is on
 * (ext-panel-model.ts). The header is the Ask slot's (≡ for the drawer of asks, the ask's title over
 * "Ask Walnut ⌄", New chat), with the key button the extension draws its vault popover for; the
 * conversation is an ordinary Ask session (AskObjectDrawer), one per page, remembered for when the
 * person comes back to it, and an ask picked in the drawer becomes this page's conversation.
 *
 * The composer's page chip says the page goes with the next message (its text as a file the ask
 * names); × leaves it out. "Act in tab" is the person's click: the extension makes the tab this
 * ask's agent tab, framed and with Stop, like the tabs agents open themselves. In the popup
 * (`surface=popup`) the body is the asks to continue and a composer whose question goes to the side
 * panel (ExtPopupBody.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '@/api/client';
import { AskObjectDrawer, escapeBelongsToAnOverlay, type AskObjectQuote } from '@/components/chat/AskObjectDrawer';
import type { AskSessionLaunch } from '@/components/chat/ask-object-session';
import { ensureMainTask } from '@/api/org';
import { forgetAskSession, objectContextHints, readAskSession, storeObjectContext, writeAskSession } from '@/components/chat/ask-object-session';
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
import { usePageView } from '@/utils/view-memory';
import { taskPath } from '@/utils/task-path';
import { log } from '@/utils/log';
import {
  ACT_CONTEXT_NAME, CONTEXT_NAME, actLine, conversationKey, handedOf, hostOf, otherOwnerOf, pageChipOn, pageContextBlock, panelOptions,
  firstQuestionOf, panelAskTitle, rememberFirstQuestion, rememberHanded, rememberSent, rememberSentPage, sentOf, sentPageOf, selectionQuote,
  MAIN_OPEN, type HandedAsk, type PanelContext, type VaultState,
} from './ext-panel-model';
import { fromParent, toParent } from './ext-frame';
import { useFrameTheme } from './ext-theme';
import { useAskSnapshots } from './useAskSnapshots';
import { attachedView, type Attached } from './ext-attached';
import { ExtAskHeader, ExtAsksDrawer, ExtComposerChips } from './ExtAskChrome';
import { ContinueList, ExtPopupBody } from './ExtPopupBody';
import { sessionOfTask, useExtAsks } from './useExtAsks';
import { ExtAskApprovals, useExtApprovals } from './ExtApprovals';
import { keepAsks, keptAsks } from './ext-continue-kept';
import './ext-panel.css';
import '@/styles/walnut-agent.css';

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
/** The conversation of a tab that shows no web page (a new tab, the browser's own pages). */
const NO_PAGE_KEY = 'web:none';

const isAgentId = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,80}$/.test(v);

function insertInto(sessionId: string, text: string): void {
  const detail: ComposerInsertDetail = { sessionId, text, mode: 'lead', handled: false };
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
}

function blurComposer(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

function ExtPanel() {
  const opts = useMemo(() => panelOptions(window.location.search), []);
  useFrameTheme();
  const [ctx, setCtx] = useState<PanelContext | null>(null);
  const [orphan, setOrphan] = useState(false);
  const [agentId, setAgentId] = usePageView('ext-panel', 'agent', GENERAL_AGENT_ID, isAgentId);
  /** Moves when an ask's first question is noted, so its rows read it (panelAskTitle). */
  const [questionsRev, setQuestionsRev] = useState(0);
  const asks = useExtAsks(agentId, questionsRev);
  const approvals = useExtApprovals();
  // The Continue rows of the last open, shown while the board loads (ext-continue-kept.ts).
  const keptRows = useMemo(() => keptAsks(agentId), [agentId]);
  useEffect(() => { if (asks.rowsReady) keepAsks(agentId, asks.rows); }, [asks.rowsReady, asks.rows, agentId]);
  const agent = asks.agent;
  const [vault, setVault] = useState<VaultState | null>(null);
  const [keyPressed, setKeyPressed] = useState(false);
  /** The ≡ drawer, opened on its asks or with its agent list unfolded. A gesture, never kept. */
  const [asksDrawer, setAsksDrawer] = useState<false | 'asks' | 'agents'>(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [record, setRecord] = useState<{ taskId: string; sessionId?: string } | null>(null);
  // The person's last click on "act", until the tab's owner agrees with it.
  const [actChoice, setActChoice] = useState<boolean | null>(null);
  const [actError, setActError] = useState('');
  const [chat, setChat] = useState(0);
  const chatNo = useRef(chat);
  chatNo.current = chat;
  /** The chat (by its number) that is Main's composer: its first question goes to Main's own task. */
  const [mainChat, setMainChat] = useState<number | null>(null);
  const forMain = mainChat === chat;
  const forMainRef = useRef(forMain);
  forMainRef.current = forMain;
  /**
   * A question the popup handed over, sent once by the conversation it starts (`chat` is its
   * number) on the page it was asked about (`key`): moving to another page must not ask it again
   * there (2026-11-06: it was re-sent on every page the person moved to until a new chat).
   */
  const [preset, setPreset] = useState<{ chat: number; key: string; text: string } | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const recordRef = useRef(record);
  recordRef.current = record;
  /** `<task>:<tab>` the extension was asked to hand over, so it is asked once. */
  const adoptedFor = useRef('');
  /** A selection the context menu asked about before this page's conversation was known. */
  const heldSelection = useRef('');
  /** What the popup handed over before this view knew the page. */
  const heldHand = useRef<{ ask?: HandedAsk; open?: { taskId: string; sessionId?: string } } | null>(null);
  const textWaits = useRef(new Map<string, (r: { url: string; text: string }) => void>());
  /** The page's selection the person left out of their next message (×), and the one already sent. */
  const [leftOut, setLeftOut] = useState('');
  const [sentSelection, setSentSelection] = useState('');
  /** The page (its address) left out of the next message with the chip's ×, or put back with a click. */
  const [pageLeftOut, setPageLeftOut] = useState('');
  const [pageAdded, setPageAdded] = useState('');
  /**
   * A handed question's own choices, read by the launch it starts (the conversation's first effect,
   * before this view's run). Kept for that conversation (`chat`), not taken by the first read: the
   * drawer's open effect may start the launch twice (one joins the other after this context is
   * read), and a second read finding nothing sent the question without its quote (review F2).
   */
  const handChoice = useRef<{ chat: number; key: string; page: boolean; act: boolean; sel: string } | null>(null);
  /** The tab turned over in a conversation already going: its note rides the next message. */
  const actNote = useRef<number | undefined>(undefined);
  /** What each sent message attached from the page, by its context id (the bubble before it is saved). */
  const attachedById = useRef(new Map<string, Attached>());
  /** What a conversation's first question took, by its words: that bubble carries no hints. */
  const attachedByWords = useRef(new Map<string, Attached>());
  /** The page a first question took, noted for the ask once its task is known. */
  const firstPage = useRef('');
  /** The first question's words, noted for the ask once its task is known (its name until Walnut titles it). */
  const firstQuestion = useRef('');

  const page = ctx?.page ?? null;
  const tab = ctx?.tab;
  const owner = ctx?.owner;
  const handed = useMemo(() => handedOf(tab), [tab, owner]);
  const key = !ctx ? '' : page ? conversationKey(page.url, tab, owner, handed) : NO_PAGE_KEY;
  const keyRef = useRef(key);
  keyRef.current = key;
  /** New chat while this conversation acts in the tab: the new one gets the tab once it has a task. */
  const carryAct = useRef(false);
  const scope = useMemo(() => ({ agentId: agent.id, key }), [agent.id, key]);
  const mine = record ? `task:${record.taskId}` : '';

  // Another page or tab is another conversation (its own, remembered), and nothing is asked for it yet.
  useEffect(() => {
    setRecord(null); setActChoice(carryAct.current ? true : null); setActError(''); adoptedFor.current = ''; heldSelection.current = '';
    carryAct.current = false; actNote.current = undefined; attachedByWords.current.clear(); setLeftOut(''); setSentSelection(sentOf(key));
    setPageAdded(''); setPageLeftOut('');
  }, [key, chat, tab, agent.id]);

  // A record the task got its id for: the page its first question took is that ask's now.
  useEffect(() => {
    if (record?.taskId && firstPage.current) { rememberSentPage(record.taskId, firstPage.current); firstPage.current = ''; }
    if (record?.taskId && firstQuestion.current) {
      rememberFirstQuestion(record.taskId, firstQuestion.current);
      firstQuestion.current = '';
      setQuestionsRev((n) => n + 1);
    }
  }, [record?.taskId]);

  const mainIdRef = useRef(asks.mainTask?.id);
  mainIdRef.current = asks.mainTask?.id;
  /**
   * Main before its first message: its composer, as on Home, in this panel (never a Walnut tab:
   * the review of 2026-11-06 lost the page to the tab that opened). The question goes to Main's
   * own task (adjustLaunch).
   */
  const startMain = useCallback(() => {
    const k = keyRef.current;
    if (!k) return;
    forgetAskSession({ agentId: GENERAL_AGENT_ID, key: k });
    carryAct.current = false;
    handChoice.current = null;
    if (agent.id !== GENERAL_AGENT_ID) setAgentId(GENERAL_AGENT_ID);
    const next = chatNo.current + 1;
    setMainChat(next);
    setChat(next);
  }, [agent.id, setAgentId]);

  /** Show an ask (picked in the drawer, or handed over by the popup) as this page's conversation. */
  const pickAsk = useCallback((taskId: string, sessionId: string | undefined, forAgent?: string) => {
    if (!sessionId) {
      if (taskId === MAIN_OPEN || taskId === mainIdRef.current) { startMain(); return; }
      toParent({ type: 'open-walnut', path: taskPath(taskId) });
      return;
    }
    const k = keyRef.current;
    if (!k) return;
    writeAskSession({ agentId: forAgent ?? agent.id, key: k }, { taskId, sessionId, asked: [], at: Date.now() });
    carryAct.current = false;
    handChoice.current = null;
    if (forAgent && forAgent !== agent.id) setAgentId(forAgent);
    setChat((n) => n + 1);
  }, [agent.id, setAgentId, startMain]);

  const applyHand = useCallback((h: { ask?: HandedAsk; open?: { taskId: string; sessionId?: string } }) => {
    if (h.open) { pickAsk(h.open.taskId, h.open.sessionId); return; }
    if (!h.ask || !keyRef.current) return;
    forgetAskSession({ agentId: agent.id, key: keyRef.current });
    const next = chatNo.current + 1;
    handChoice.current = { chat: next, key: keyRef.current, page: h.ask.page, act: h.ask.act, sel: h.ask.sel ?? '' };
    log.info('ext-panel', 'question handed over', { page: h.ask.page, act: h.ask.act, selChars: h.ask.sel?.length ?? 0 });
    carryAct.current = h.ask.act;
    setPreset({ chat: next, key: keyRef.current, text: h.ask.text });
    setChat(next);
  }, [agent.id, pickAsk]);
  const applyHandRef = useRef(applyHand);
  applyHandRef.current = applyHand;

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
      } else if (m.type === 'vault-state') {
        setVault({ locked: m.locked, siteCount: m.siteCount, host: m.host });
      } else if (m.type === 'key-state') {
        setKeyPressed(m.open);
      } else if (m.type === 'hand') {
        const h = { ...(m.ask ? { ask: m.ask } : {}), ...(m.open ? { open: m.open } : {}) };
        if (keyRef.current) applyHandRef.current(h);
        else heldHand.current = h;
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

  // Main's composer is that page's: another page opens on its own conversation.
  useEffect(() => { setMainChat(null); }, [key]);

  // What the popup handed over before the page was known goes once it is.
  useEffect(() => {
    if (key && heldHand.current) { const h = heldHand.current; heldHand.current = null; applyHand(h); }
  }, [key, applyHand]);

  // The key popover is the extension page's: a press anywhere else here, or Escape, closes it.
  useEffect(() => {
    if (!keyPressed) return;
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-testid="ext-ask-key"]')) return;
      toParent({ type: 'frame-pointer' });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      toParent({ type: 'key-close' });
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [keyPressed]);

  // Escape closes the toolbar popup, never the side panel (the panel's Escape only leaves the
  // composer: AskObjectDrawer's onClose below). A key a menu, the drawer or the key popover takes
  // is theirs.
  useEffect(() => {
    if (opts.surface !== 'popup') return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (escapeBelongsToAnOverlay(e, document.body)) return;
      e.preventDefault();
      toParent({ type: 'close' });
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [opts.surface]);

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
  // Before the first question the selection shows as the quote over the composer, with its own ×,
  // apart from the page chip: what shows is what goes (review 2026-11-06).
  const draftQuote = !record?.taskId && !!selection && selection !== leftOut ? selection : '';
  const draftQuoteRef = useRef(draftQuote);
  draftQuoteRef.current = draftQuote;
  // The page chip: on before the first question, and in a conversation that has not had this page.
  const shown = useMemo(() => (key ? readAskSession(scope) : null), [scope, key, chat, record]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownTaskId = record?.taskId ?? shown?.taskId ?? '';
  const pageOn = pageChipOn({ url: page?.url ?? '', conversation: !!shownTaskId, sentPage: sentPageOf(shownTaskId), leftOut: pageLeftOut, added: pageAdded });
  const pageOnRef = useRef(pageOn);
  pageOnRef.current = pageOn;
  const setPageChip = useCallback((on: boolean) => {
    const url = ctxRef.current?.page?.url ?? '';
    if (on) { setPageAdded(url); setPageLeftOut(''); } else { setPageLeftOut(url); setPageAdded(''); }
  }, []);

  /** The page's text, asked of the extension only now that a question goes out. */
  const fetchText = useCallback((url: string): Promise<string> => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (text: string) => { textWaits.current.delete(id); clearTimeout(timer); resolve(text); };
    const timer = setTimeout(() => done(''), TEXT_MS);
    textWaits.current.set(id, (r) => done(r.url === url ? r.text : ''));
    toParent({ type: 'page-text', id });
  }), []);

  /** The page's text as the ask can read it: a file on this machine, or the text itself for one elsewhere. */
  const pageText = useCallback(async (p: { url: string; title?: string }, remote: boolean): Promise<{ file?: string; inline?: string }> => {
    const text = await fetchText(p.url);
    if (!text.trim()) return {};
    if (remote) return { inline: text };
    return { file: (await apiPost<{ file: string }>('/api/v1/browser/page', { url: p.url, title: p.title, text }, { timeoutMs: 20_000 })).file };
  }, [fetchText]);

  /** What the next message in a conversation already going takes along: the page, the selection, the tab note. */
  const nextHints = useCallback(async (message: string) => {
    const p = ctxRef.current?.page;
    const sel = attachRef.current;
    const withPage = pageOnRef.current;
    // The tab note only while acting is still on (Stop on the page or Take it back end it too).
    const tab = actOnRef.current ? actNote.current : undefined;
    if (!p || (!sel && !withPage && tab === undefined)) return undefined;
    let text: { file?: string; inline?: string } = {};
    if (withPage) text = await pageText(p, false).catch(() => ({}));
    const block = sel || withPage
      ? pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), ...(sel ? { selection: sel } : {}) }, { ...text, ...(tab !== undefined ? { tab } : {}), ...(withPage ? {} : { selectionOnly: true }) })
      : actLine(tab!);
    const id = await storeObjectContext(sel || withPage ? CONTEXT_NAME : ACT_CONTEXT_NAME, block, (path, b) => apiPost<{ id: string }>(path, b))
      .catch((err) => { log.warn('ext-panel', 'note for the next message not stored', { error: err instanceof Error ? err.message : String(err) }); return ''; });
    if (!id) return undefined;
    actNote.current = undefined;
    // The page chip in the bubble says the page went; a selection alone names its page in its quote.
    const att: Attached = { ...(withPage ? { page: { title: p.title ?? hostOf(p.url), host: hostOf(p.url) } } : {}), ...(sel ? { sel, from: p.title ?? hostOf(p.url) } : {}) };
    attachedById.current.set(id, att);
    if (message.trim()) attachedByWords.current.set(message.trim(), att);
    if (sel) { setSentSelection(sel); rememberSent(keyRef.current, sel); }
    if (withPage) {
      const taskId = recordRef.current?.taskId;
      if (taskId) rememberSentPage(taskId, p.url);
      setPageAdded(''); setPageLeftOut('');
    }
    return objectContextHints(id);
  }, [pageText]);
  useEffect(() => {
    const sid = record?.sessionId;
    if (!sid) return;
    setPendingHintsSource(sid, nextHints);
    return () => setPendingHintsSource(sid, null);
  }, [record?.sessionId, nextHints]);

  /** In the person's bubble: the page it went with, and the text it took from the page, quoted. */
  const attachmentsOf = useCallback((row: UserRowHints) => attachedView(row, attachedById.current, attachedByWords.current), []);

  const selectionPill = attach ? (
    <div className="ext-panel-selection" data-testid="ext-panel-selection">
      <span className="ext-panel-selection-text" title={attach}><span className="ext-panel-selection-label">Selected on the page:</span> {attach}</span>
      <button type="button" className="ext-panel-selection-drop" data-testid="ext-panel-selection-drop" aria-label="Leave the selection out" title="Leave the selection out of the next message" onClick={() => setLeftOut(attach)}>&times;</button>
    </div>
  ) : undefined;

  // What the view shows, for the panel page to draw the next time this view loads, and the word
  // that this view's own content is up (ext-snapshot.ts).
  const rootRef = useRef<HTMLDivElement>(null);
  useAskSnapshots(rootRef, page, key, opts.surface);

  const prepareContext = useCallback(async (draft: { walnut?: boolean; host?: string | null }, question: string): Promise<string> => {
    const now = ctxRef.current;
    const p = now?.page;
    // Main's composer goes to Main's own task, which has its name.
    firstQuestion.current = forMainRef.current ? '' : question;
    // A handed question carries the popup's choices: this launch runs before this view's effects do.
    const held = handChoice.current;
    const hand = held && held.chat === chatNo.current && held.key === keyRef.current ? held : null;
    const include = hand ? hand.page : pageOnRef.current;
    const acting = (hand ? hand.act : actChoice === true) && now?.tab !== undefined;
    if (!p) return acting ? actLine(now!.tab!) : '';
    // The first question takes the selection its quote shows over the composer (a question the
    // popup handed over, the one the popup's quote showed): its bubble shows it, and it is not
    // offered again. A selection no quote showed never goes (review 2026-11-06).
    const sel = (hand ? hand.sel : draftQuoteRef.current)?.trim();
    // Left out with the chip's ×: the selection alone, and the tab note when the ask may act there.
    if (!include) {
      if (!sel) return acting ? actLine(now!.tab!) : '';
      setSentSelection(sel); rememberSent(keyRef.current, sel);
      attachedByWords.current.set(question.trim(), { sel, from: p.title ?? hostOf(p.url) });
      return pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), selection: sel }, { selectionOnly: true, ...(acting ? { tab: now!.tab } : {}) });
    }
    if (sel) { setSentSelection(sel); rememberSent(keyRef.current, sel); }
    attachedByWords.current.set(question.trim(), { page: { title: p.title ?? hostOf(p.url), host: hostOf(p.url) }, ...(sel ? { sel } : {}) });
    // A task on another machine cannot read this one's file: it gets the text itself.
    const text = await pageText(p, !draft.walnut && !!draft.host && draft.host !== '__local__');
    firstPage.current = p.url;
    log.info('ext-panel', 'asking about a page', { host: hostOf(p.url), withText: !!(text.file || text.inline), acting });
    return pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), ...(sel ? { selection: sel } : {}) }, { ...text, ...(acting ? { tab: now!.tab } : {}) });
  }, [actChoice, pageText]);

  const dropQuote = useCallback(() => setLeftOut(ctxRef.current?.page?.selection?.trim() ?? ''), []);

  const newChat = useCallback(() => {
    if (!key) return;
    forgetAskSession(scope);
    carryAct.current = ownTab;
    handChoice.current = null;
    setChat((n) => n + 1);
  }, [key, scope, ownTab]);

  /**
   * A question asked here is a conversation, not work for the board: its task is not pinned (as
   * Main's composer launches on Home), so the panel's quick asks never fill Focus (review
   * 2026-11-06). Main's composer launches on Main's own task, made by the server on first use.
   */
  const adjustLaunch = useCallback(async (body: AskSessionLaunch): Promise<AskSessionLaunch> => {
    const unpinned: AskSessionLaunch = { ...body, taskMeta: { ...body.taskMeta, pinTier: null } };
    if (!forMainRef.current) return unpinned;
    const main = await ensureMainTask();
    return main ? { ...unpinned, taskId: main.id } : unpinned;
  }, []);

  const pickAgent = useCallback((id: string) => { setAgentId(id); }, [setAgentId]);
  const closeDrawer = useCallback(() => setAsksDrawer(false), []);
  const mainSession = sessionOfTask(asks.mainTask);
  const drawer = (
    <ExtAsksDrawer
      open={!!asksDrawer}
      onClose={closeDrawer}
      returnFocusRef={menuRef}
      asks={asks}
      agentsFirst={asksDrawer === 'agents'}
      onPickAgent={pickAgent}
      selectedTaskId={shownTaskId && shownTaskId !== asks.mainTask?.id ? shownTaskId : null}
      mainSelected={shownTaskId ? shownTaskId === asks.mainTask?.id : forMain}
      onPick={(id) => {
        const t = asks.rows.find((r) => r.id === id)?.task;
        const sid = sessionOfTask(t) ?? undefined;
        if (opts.surface === 'popup') toParent({ type: 'open-side-panel', open: { taskId: id, ...(sid ? { sessionId: sid } : {}) } });
        else pickAsk(id, sid);
      }}
      onPickMain={() => {
        const main = asks.mainTask;
        // Main's conversation, in the panel like any ask; before its first message, its composer.
        if (opts.surface === 'popup') toParent({ type: 'open-side-panel', open: main && mainSession ? { taskId: main.id, sessionId: mainSession } : { taskId: MAIN_OPEN } });
        else if (main && mainSession) pickAsk(main.id, mainSession, GENERAL_AGENT_ID);
        else startMain();
      }}
      onNew={() => { if (opts.surface === 'panel') newChat(); }}
      keyed={opts.keyed}
      settings={opts.settings}
      vault={vault}
      approvals={approvals.length}
      onView={(view) => (opts.surface === 'popup' && view === 'tasks' ? toParent({ type: 'open-side-panel', view }) : toParent({ type: 'open-view', view }))}
    />
  );
  const shownTask = shownTaskId ? asks.tasks.find((t) => t.id === shownTaskId) : undefined;
  // An ask with no title of its own yet shows the agent's name once (its switch), never twice.
  const named = shownTask ? panelAskTitle(shownTask, agent) : null;
  const headTitle = named
    ? (named.untitled ? '' : named.title)
    : shownTaskId ? (firstQuestionOf(shownTaskId) || page?.title || (page ? hostOf(page.url) : '')) : forMain ? 'CEO' : 'New chat';
  const header = (
    <ExtAskHeader
      surface={opts.surface}
      title={headTitle}
      agent={agent}
      canSwitch={asks.agents.length > 1}
      menuRef={menuRef}
      menuOn={!!asksDrawer}
      onMenu={() => setAsksDrawer((v) => (v ? false : 'asks'))}
      onAgents={() => setAsksDrawer('agents')}
      keyed={opts.keyed}
      vault={vault}
      keyPressed={keyPressed}
      onNew={newChat}
    />
  );

  if (!ctx) {
    return <div ref={rootRef} className="ext-panel ext-panel-empty" data-testid="ext-panel">
      {orphan
        ? <p>This is Walnut&apos;s browser side panel. Open it from the Walnut extension, next to a web page.</p>
        : <p className="muted"><span className="spinner" /> Connecting to the page…</p>}
    </div>;
  }

  const canAct = !!page && tab !== undefined && !otherOwner;
  const approvalsStrip = (
    <ExtAskApprovals list={approvals} taskId={shownTaskId}
      onMore={() => (opts.surface === 'popup' ? toParent({ type: 'open-side-panel', view: 'tasks' }) : toParent({ type: 'open-view', view: 'tasks' }))} />
  );
  if (opts.surface === 'popup') {
    return <div ref={rootRef} className="ext-panel ext-ask is-popup" data-testid="ext-panel" data-surface="popup" data-asks={asks.rowsReady || keptRows.length > 0 ? 'ready' : 'loading'}>
      {header}
      {approvalsStrip}
      <ExtPopupBody rows={asks.rows} kept={keptRows} page={page} canAct={canAct && !owner} loading={!asks.rowsReady} />
      {drawer}
    </div>;
  }

  const chips = (
    <ExtComposerChips page={page} pageOn={pageOn} onPage={setPageChip} {...(canAct ? { act: { on: actOn, onToggle: toggleAct } } : {})} />
  );
  const quote: AskObjectQuote = {
    who: page ? hostOf(page.url) : '',
    when: '',
    where: page?.title ?? '',
    preview: draftQuote,
  };
  const askPreset = preset && preset.chat === chat && preset.key === key ? preset.text : '';

  return <div ref={rootRef} className="ext-panel ext-ask" data-testid="ext-panel" data-page-key={key} data-asks={asks.rowsReady || keptRows.length > 0 ? 'ready' : 'loading'}>
    {header}
    {approvalsStrip}
    {otherOwner && (
      <p className="ext-panel-note" data-testid="ext-panel-other-owner">
        Another Walnut conversation or task is acting in this tab.{' '}
        <button type="button" className="ext-panel-link" data-testid="ext-panel-take-back" onClick={takeBack}>Take it back</button>
      </p>
    )}
    {actError && <p className="ext-panel-note ext-panel-error" role="alert">{actError}</p>}
    {/* A new chat opens as the popup does: the asks to continue over the composer. */}
    {!shownTaskId && !forMain && <ContinueList className="is-panel" rows={asks.rows} kept={keptRows} max={4} loading={!asks.rowsReady} onPick={(id, sid) => pickAsk(id, sid)} />}
    <div className="ext-panel-chat">
      <UserRowAttachmentsContext.Provider value={attachmentsOf}>
      <AskObjectDrawer
        key={`${agent.id}:${key}:${chat}:${tab ?? ''}`}
        objectKey={key}
        title={page ? `Ask Walnut about ${page.title ?? hostOf(page.url)}` : 'Ask Walnut'}
        quote={quote}
        agentId={agent.id}
        contextBlock=""
        contextName={CONTEXT_NAME}
        prepareContext={prepareContext}
        onRecord={setRecord}
        // Escape here never closes the side panel (it holds the conversation and the draft): it
        // only leaves the composer. The toolbar popup closes on Escape (above).
        onClose={blurComposer}
        adjustLaunch={adjustLaunch}
        plainChat
        noQuote={!draftQuote}
        onDropQuote={dropQuote}
        {...(askPreset ? { preset: askPreset, autoSend: true } : {})}
        composerPlaceholder={forMain ? 'Ask the CEO, or hand it something to do…' : page ? 'Ask Walnut, or ask it to do something here…' : 'Ask Walnut anything…'}
        composerPill={selectionPill}
        composerBar={chips}
      />
      </UserRowAttachmentsContext.Provider>
    </div>
    {drawer}
  </div>;
}
