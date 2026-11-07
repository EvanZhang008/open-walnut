/**
 * Walnut in the browser's side panel, and in the toolbar popup. The first page (design option A,
 * 2026-11-07, ExtHome.tsx) is a new task composer over Home's task panel, with the browser relay
 * in the header; a task opened there shows its conversation here, with Back to the list
 * (`mode: 'task'`), and the Ask conversations are a page of their own, from ≡ (`mode: 'ask'`).
 * The popup always opens on the first page and hands what it starts to the side panel.
 *
 * The Ask page: Walnut's own Ask. The Walnut extension's panel page frames this view and tells it about the page the person is on
 * (ext-panel-model.ts). The header is the Ask slot's (≡ for the drawer of asks, the ask's title over
 * "Ask Walnut ⌄", New chat), with the key button the extension draws its vault popover for; the
 * conversation is an ordinary Ask session (AskObjectDrawer). As on Home, the open conversation stays
 * until the person picks another ask or presses New chat: another page or tab only moves the page
 * chip, so the next message goes with that page (ext-panel-model.ts `currentConversation`).
 *
 * The composer's page chip says the page goes with the next message (its text as a file the ask
 * names); × leaves it out. "Act in tab" is the person's click: the extension makes the tab this
 * ask's agent tab, framed and with Stop, like the tabs agents open themselves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiPost } from '@/api/client';
import { AskObjectDrawer, escapeBelongsToAnOverlay, type AskObjectQuote } from '@/components/chat/AskObjectDrawer';
import type { AskSessionLaunch } from '@/components/chat/ask-object-session';
import { ensureMainTask } from '@/api/org';
import { objectContextHints, readAskSession, storeObjectContext, writeAskSession } from '@/components/chat/ask-object-session';
import { setPendingHintsSource } from '@/utils/pending-hints';
import { UserRowAttachmentsContext, type UserRowHints } from '@/components/sessions/user-row-attachments';
import { GENERAL_AGENT_ID } from '@/components/chat/ask-walnut-slot-model';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { NotificationToaster } from '@/components/common/NotificationToaster';
import { OperationErrorBridge } from '@/components/common/OperationErrorBridge';
import { TransferDialogHost } from '@/components/transfer/TransferDialogHost';
import { TasksProvider, useTasksContext } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider } from '@/contexts/FocusBarContext';
import { usePageView } from '@/utils/view-memory';
import { taskPath } from '@/utils/task-path';
import { log } from '@/utils/log';
import {
  ACT_CONTEXT_NAME, CONTEXT_NAME, actLine, composerPlaceholderOf, currentConversation, handedOf, hostOf, otherOwnerOf, pageChipOn, pageContextBlock, panelOptions,
  firstQuestionOf, selectionLeftOutOnSwitch, selectionOfferedTo, pageKey as pageKeyOf, panelAskTitle, rememberFirstQuestion, rememberHanded, rememberSent, forgetSent, rememberSentPage, sentOf, sentPageOf, selectionQuote,
  MAIN_OPEN, startConversation, type HandedAsk, type HandedOpen, type PanelContext, type VaultState,
} from './ext-panel-model';
import { fromParent, onParentKnown, toParent } from './ext-frame';
import { useFrameTheme } from './ext-theme';
import { useAskSnapshots } from './useAskSnapshots';
import { attachedView, type Attached } from './ext-attached';
import { ExtAskHeader, ExtAsksDrawer, ExtComposerChips } from './ExtAskChrome';
import { ContinueList } from './ExtContinueList';
import type { HomeLaunched, HomePreset } from './ExtHome';
import type { OpenTask } from './ExtHomeTasks';
import { ExtFirstPage, ExtTaskPageDetail, ExtTaskPageHead, taskNameOf, useRelayWord } from './ExtFirstPage';
import { ACT_TAB_MOVED, actCarriesTo, isPanelMode, type PanelMode } from './ext-home-model';
import { sessionOfTask, useExtAsks } from './useExtAsks';
import { ExtAskApprovals, useExtApprovals } from './ExtApprovals';
import { keepAsks, keptAsks } from './ext-continue-kept';
import { useVaultChangedRelay } from './vault-changed-relay';
import { markNotAPhone } from '@/hooks/usePhoneLayout';
import { markStatusLinesOn } from '@/components/tasks/useTaskStatusLines';
import { takeBrowserKey, useExtBrowserKey } from './ext-browser-key';
import { ExtControl } from './ExtControl';
import './ext-panel.css';
import '@/styles/walnut-agent.css';

// The panel is a desktop browser's, however narrow: Home's task panel acts as on a desktop here,
// and every row says what it needs (design C).
markNotAPhone();
markStatusLinesOn();

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
/** A tab that shows no web page (a new tab, the browser's own pages), for what is kept per page. */
const NO_PAGE_KEY = 'web:none';

const isAgentId = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,80}$/.test(v);
const isDetailId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{0,120}$/.test(v);
/**
 * The pointer to the conversation of a task opened from the first page, kept apart from every
 * agent's own (currentConversation): opening a task never replaces the ask the person left open.
 * Its records are the general agent's, under keys of their own.
 */
const TASK_POINTER = 'ext-first-page-task';

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
  const isPopup = opts.surface === 'popup';
  /**
   * The page on show, kept across opens like any view choice: the first page, an ask, or a task
   * opened from the list (`detailId`: one with no conversation, shown as its detail). The popup is
   * always the first page, and never writes it.
   */
  const [keptMode, setKeptMode] = usePageView('ext-panel', 'mode', 'home', isPanelMode);
  const [detailId, setDetailId] = usePageView('ext-panel', 'detail', '', isDetailId);
  const { tasks: allTasks } = useTasksContext();
  const relay = useRelayWord();
  /** A first message the popup handed over to the first page, sent once there. */
  const [homePreset, setHomePreset] = useState<HomePreset | null>(null);
  /** What a task started on the first page took from the page, for its first bubble. */
  const launchAttach = useRef<{ words: string; att: Attached } | null>(null);
  const [ctx, setCtx] = useState<PanelContext | null>(null);
  const [orphan, setOrphan] = useState(false);
  const [agentId, setAgentId] = usePageView('ext-panel', 'agent', GENERAL_AGENT_ID, isAgentId);
  /** Moves when an ask's first question is noted, so its rows read it (panelAskTitle). */
  const [questionsRev, setQuestionsRev] = useState(0);
  const asks = useExtAsks(agentId, questionsRev);
  const approvals = useExtApprovals();
  useVaultChangedRelay();
  // The Continue rows of the last open, shown while the board loads (ext-continue-kept.ts).
  const keptRows = useMemo(() => keptAsks(agentId), [agentId]);
  useEffect(() => { if (asks.rowsReady) keepAsks(agentId, asks.rows); }, [asks.rowsReady, asks.rows, agentId]);
  const agent = asks.agent;
  const [vault, setVault] = useState<VaultState | null>(null);
  // The frame shares the extension's unlock (its approval cards read the same as the key: ext-browser-key.ts).
  const browserKey = useExtBrowserKey(!!vault && !vault.locked);
  const browserKeyRef = useRef(browserKey);
  browserKeyRef.current = browserKey;
  /** The side bar's entry on show, as the extension says (it draws the bar and keeps the choice). */
  const [railEntry, setRailEntry] = useState<'chat' | 'control'>('chat');
  const [keyPressed, setKeyPressed] = useState(false);
  /** The ≡ drawer, opened on its asks or with its agent list unfolded. A gesture, never kept. */
  const [asksDrawer, setAsksDrawer] = useState<false | 'asks' | 'agents'>(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  /** The conversation's task and session, as its drawer reported them (`conv` says for which conversation). */
  const [reported, setReported] = useState<{ conv: string; taskId: string; sessionId?: string } | null>(null);
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
   * A question the popup handed over, sent once by the conversation it starts (`chat` is its number,
   * `key` its conversation): nothing else ever asks it again (2026-11-06: it was re-sent on every
   * page the person moved to until a new chat).
   */
  const [preset, setPreset] = useState<{ chat: number; key: string; text: string } | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  /** `<task>:<tab>` the extension was asked to hand over, so it is asked once. */
  const adoptedFor = useRef('');
  /** A selection the context menu asked about before the conversation's session was known. */
  const heldSelection = useRef('');
  /** What the popup handed over before this view knew the page. */
  const heldHand = useRef<{ ask?: HandedAsk; open?: HandedOpen } | null>(null);
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
  /**
   * The page and the words a first question took, noted for its ask once its task is known (the
   * words are its name until Walnut titles it). By the conversation that asked (`conv`): a launch
   * left behind by New chat or a pick must not name the ask shown next.
   */
  const firstAsked = useRef<{ conv: string; page: string; question: string } | null>(null);

  const page = ctx?.page ?? null;
  const tab = ctx?.tab;
  const owner = ctx?.owner;
  const handed = useMemo(() => handedOf(tab), [tab, owner]);
  /** The page, for what is kept per page (the selection a message already took). */
  const pageKey = !ctx ? '' : page ? pageKeyOf(page.url) : NO_PAGE_KEY;
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;
  /** Moves when another conversation starts, so the pointer is read again. */
  const [convRev, setConvRev] = useState(0);
  // A task opened from the first page has its own pointer (TASK_POINTER), its records the general agent's.
  const inTaskPage = !isPopup && keptMode === 'task';
  const pointer = inTaskPage ? TASK_POINTER : agent.id;
  const convAgentId = inTaskPage ? GENERAL_AGENT_ID : agent.id;
  // The open conversation, whatever page or tab (currentConversation); none before the page is known.
  const convKey = useMemo(() => currentConversation(pointer), [pointer, convRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = ctx ? convKey : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  /** Which conversation, and which drawer of it: a record reported for another one is not this one's. */
  const conv = `${pointer}:${key}:${chat}`;
  const convRef = useRef(conv);
  convRef.current = conv;
  const record = reported && reported.conv === conv ? reported : null;
  const recordRef = useRef(record);
  recordRef.current = record;
  const onRecord = useCallback((r: { taskId: string; sessionId?: string }) => setReported({ conv: convRef.current, ...r }), []);
  /** Start another conversation for this agent (New chat, a pick, a handed question): a key of its own. */
  const nextConversation = useCallback((forAgent: string): string => {
    const k = startConversation(forAgent);
    setConvRev((n) => n + 1);
    return k;
  }, []);
  /** New chat while this conversation acts in the tab: the new one gets the tab once it has a task. */
  const carryAct = useRef(false);
  /** A first-page task was allowed a tab the person had left by the time it started: say so there. */
  const actMoved = useRef(false);
  const scope = useMemo(() => ({ agentId: convAgentId, key }), [convAgentId, key]);
  const mine = record ? `task:${record.taskId}` : '';

  /** The agent the person picked last (agentId moves only on a pick; `agent` also while the list loads). */
  const pickedAgent = useRef(agentId);
  /** The page's selection and the agent picked when it was made: the one it is offered to. */
  const selectionOwner = useRef({ sel: '', agent: agentId });
  const liveSelection = ctx?.page?.selection?.trim() ?? '';
  if (liveSelection && selectionOwner.current.sel !== liveSelection) selectionOwner.current = { sel: liveSelection, agent: agentId };
  // Another conversation: nothing is asked for it yet, and acting is as New chat left it. Another
  // agent's conversation never takes the selection another agent was offered (review round 4, #4):
  // only a selection made after the switch shows there; back on the agent it was made for, it
  // shows again (round 4 code review, L5).
  useEffect(() => {
    setActChoice(carryAct.current ? true : null); setActError(actMoved.current ? ACT_TAB_MOVED : ''); adoptedFor.current = ''; heldSelection.current = '';
    carryAct.current = false; actMoved.current = false; actNote.current = undefined; attachedByWords.current.clear();
    // A task the first page started: its first bubble shows what it took from the page.
    if (launchAttach.current) { attachedByWords.current.set(launchAttach.current.words, launchAttach.current.att); launchAttach.current = null; }
    const sel = ctxRef.current?.page?.selection?.trim() ?? '';
    setLeftOut(selectionLeftOutOnSwitch(selectionOfferedTo(selectionOwner.current, sel, pickedAgent.current), agentId, sel));
    pickedAgent.current = agentId;
    setPageAdded(''); setPageLeftOut('');
  }, [key, chat, agent.id, agentId]);
  // Another page: the conversation stays; the page chip and the selection are the new page's.
  useEffect(() => {
    setSentSelection(sentOf(pageKey)); setLeftOut(''); setPageAdded(''); setPageLeftOut('');
  }, [pageKey]);
  // Another tab: the act switch is that tab's (a click for the tab left behind does not carry over).
  const seenTab = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (tab === undefined) return;
    const before = seenTab.current;
    seenTab.current = tab;
    if (before !== undefined && before !== tab) { setActChoice(null); setActError(''); }
  }, [tab]);

  // A record the task got its id for: the page its first question took is that ask's now.
  useEffect(() => {
    const asked = firstAsked.current;
    if (!record?.taskId || !asked || asked.conv !== conv) return;
    firstAsked.current = null;
    if (asked.page) rememberSentPage(record.taskId, asked.page);
    if (asked.question) { rememberFirstQuestion(record.taskId, asked.question); setQuestionsRev((n) => n + 1); }
  }, [record?.taskId, conv]);

  const mainIdRef = useRef(asks.mainTask?.id);
  mainIdRef.current = asks.mainTask?.id;
  /**
   * Main before its first message: its composer, as on Home, in this panel (never a Walnut tab:
   * the review of 2026-11-06 lost the page to the tab that opened). The question goes to Main's
   * own task (adjustLaunch).
   */
  const startMain = useCallback(() => {
    if (!keyRef.current) return;
    nextConversation(GENERAL_AGENT_ID);
    carryAct.current = false;
    handChoice.current = null;
    if (agent.id !== GENERAL_AGENT_ID) setAgentId(GENERAL_AGENT_ID);
    const next = chatNo.current + 1;
    setMainChat(next);
    setKeptMode('ask');
    setChat(next);
  }, [agent.id, setAgentId, nextConversation, setKeptMode]);

  /** Show an ask (picked in the drawer or Continue, or handed over by the popup) as the open conversation. */
  const pickAsk = useCallback((taskId: string, sessionId: string | undefined, forAgent?: string) => {
    if (!sessionId) {
      if (taskId === MAIN_OPEN || taskId === mainIdRef.current) { startMain(); return; }
      toParent({ type: 'open-walnut', path: taskPath(taskId) });
      return;
    }
    if (!keyRef.current) return;
    const to = forAgent ?? agent.id;
    writeAskSession({ agentId: to, key: nextConversation(to) }, { taskId, sessionId, asked: [], at: Date.now() });
    carryAct.current = false;
    handChoice.current = null;
    if (to !== agent.id) setAgentId(to);
    setKeptMode('ask');
    setChat((n) => n + 1);
  }, [agent.id, setAgentId, startMain, nextConversation, setKeptMode]);

  /**
   * A task from the first page in this frame: its conversation (one just started there, or a row's),
   * under the first page's own pointer, with Back to the list. `started` is what a launch on the
   * first page took along: acting in the tab, the first question, what it took from the page.
   */
  const openTask = useCallback((taskId: string, sessionId: string | undefined, started?: HomeLaunched) => {
    if (!keyRef.current) return;
    const k = nextConversation(TASK_POINTER);
    writeAskSession({ agentId: GENERAL_AGENT_ID, key: k }, { taskId, ...(sessionId ? { sessionId } : {}), asked: [], at: Date.now() });
    // Only the tab Send was pressed in, and only while it is still on show: never the act switch's
    // yes applied to a tab the person moved to meanwhile (review round 5, #1).
    const carry = actCarriesTo(started, ctxRef.current?.tab);
    carryAct.current = carry === 'carry';
    actMoved.current = carry === 'moved';
    if (carry === 'moved') log.info('ext-panel', 'act in this tab not carried: the tab changed while the task started', { taskId, actTab: started?.actTab ?? null, tab: ctxRef.current?.tab ?? null });
    handChoice.current = null;
    if (started) {
      if (started.question && (started.attached.page || started.attached.sel)) launchAttach.current = { words: started.question, att: started.attached };
      if (started.pageUrl) rememberSentPage(taskId, started.pageUrl);
      if (started.question) { rememberFirstQuestion(taskId, started.question); setQuestionsRev((n) => n + 1); }
    }
    setMainChat(null);
    setDetailId('');
    setKeptMode('task');
    setChat((n) => n + 1);
  }, [nextConversation, setKeptMode, setDetailId]);
  /** A task with no conversation yet: its detail in this frame, never a Walnut tab. */
  const openDetail = useCallback((taskId: string) => {
    setDetailId(taskId);
    setKeptMode('task');
  }, [setDetailId, setKeptMode]);
  /** Back to the first page, where the list kept its place (it stays mounted under the other pages). */
  const goHome = useCallback(() => {
    setDetailId('');
    setKeptMode('home');
  }, [setDetailId, setKeptMode]);
  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;

  const applyHand = useCallback((h: { ask?: HandedAsk; open?: HandedOpen }) => {
    if (h.open?.task) {
      if (h.open.sessionId) openTask(h.open.taskId, h.open.sessionId);
      else openDetail(h.open.taskId);
      return;
    }
    if (h.open) { pickAsk(h.open.taskId, h.open.sessionId); return; }
    if (h.ask?.task) {
      // The first page's question from the popup: the first page here sends it, with the popup's choices.
      const a = h.ask;
      setHomePreset({ id: Math.random().toString(36).slice(2), text: a.text, page: a.page, act: a.act, sel: a.sel ?? '' });
      goHome();
      return;
    }
    if (!h.ask || !keyRef.current) return;
    setKeptMode('ask');
    const k = nextConversation(agent.id);
    const next = chatNo.current + 1;
    handChoice.current = { chat: next, key: k, page: h.ask.page, act: h.ask.act, sel: h.ask.sel ?? '' };
    log.info('ext-panel', 'question handed over', { page: h.ask.page, act: h.ask.act, selChars: h.ask.sel?.length ?? 0 });
    carryAct.current = h.ask.act;
    setPreset({ chat: next, key: k, text: h.ask.text });
    setChat(next);
  }, [agent.id, pickAsk, nextConversation, openTask, openDetail, goHome, setKeptMode]);
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
      } else if (m.type === 'browser-key') {
        takeBrowserKey(m.key, browserKeyRef.current.askedWith());
      } else if (m.type === 'rail') {
        // Passwords and Settings are the extension's own views over this frame; Chat and Browser control are here.
        if (m.entry === 'chat' || m.entry === 'control') setRailEntry(m.entry);
        if (m.entry === 'chat' && m.home) goHomeRef.current();
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

  // A held selection goes in once the conversation's session shows.
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
    toParent({ type: 'adopt', tab, task: record.taskId, who: inTaskPage ? 'Walnut task' : 'Ask Walnut' });
  }, [actWanted, tab, record?.taskId, key, inTaskPage]);

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
  // Cleared on the page: the quote goes (it follows the page's live selection), and what was left
  // out with ×, on a switch, or sent was that selection's; the next one, the same words too, shows
  // (review round 4, L6: a sent selection kept the same words selected again out).
  const lastSelection = useRef('');
  useEffect(() => {
    const was = lastSelection.current;
    lastSelection.current = selection;
    if (selection) return;
    setLeftOut('');
    if (was) { setSentSelection(''); forgetSent(pageKeyRef.current); }
  }, [selection]);
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
    if (sel) { setSentSelection(sel); rememberSent(pageKeyRef.current, sel); }
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
  // The agent on show once it is the one picked, or the agent list says the pick is gone: before
  // that, the general agent stands in for a pick still loading (useExtAsks).
  const shownAgent = agent.id === agentId || asks.rowsReady ? agent.id : '';
  // A task page open with nothing to show (its conversation forgotten, no detail): the first page.
  const taskShownHere = !!detailId || !!shownTaskId;
  const mode: PanelMode = isPopup ? 'home' : keptMode === 'task' && !taskShownHere ? 'home' : keptMode;
  // The Ask page's own words and drawing; the first page sends its own (useHomeSnapshots). The
  // agent picked is told on every page (a pick in the popup's drawer names the panel's next Ask).
  useAskSnapshots(rootRef, page, key && mode === 'ask' ? conv : '', opts.surface, shownAgent, agent.project);

  // Which page the view shows (a task's, with its title), for the extension's drawing of the next
  // open (panel-look-home.ts): the drawing is the page the view opens on.
  const modeTaskId = mode === 'task' ? (detailId || shownTaskId) : '';
  const modeTitle = useMemo(() => {
    if (!modeTaskId) return '';
    return taskNameOf(allTasks.find((x) => x.id === modeTaskId), modeTaskId);
  }, [modeTaskId, allTasks, questionsRev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isPopup) return;
    const tell = () => toParent({ type: 'mode', mode, ...(modeTitle ? { title: modeTitle.slice(0, 200) } : {}) });
    tell();
    return onParentKnown(tell);
  }, [mode, modeTitle, isPopup]);

  const prepareContext = useCallback(async (draft: { walnut?: boolean; host?: string | null }, question: string): Promise<string> => {
    const now = ctxRef.current;
    const p = now?.page;
    // Main's composer goes to Main's own task, which has its name.
    const asked = { conv: convRef.current, page: '', question: forMainRef.current ? '' : question };
    firstAsked.current = asked;
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
      setSentSelection(sel); rememberSent(pageKeyRef.current, sel);
      attachedByWords.current.set(question.trim(), { sel, from: p.title ?? hostOf(p.url) });
      return pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), selection: sel }, { selectionOnly: true, ...(acting ? { tab: now!.tab } : {}) });
    }
    if (sel) { setSentSelection(sel); rememberSent(pageKeyRef.current, sel); }
    attachedByWords.current.set(question.trim(), { page: { title: p.title ?? hostOf(p.url), host: hostOf(p.url) }, ...(sel ? { sel } : {}) });
    // A task on another machine cannot read this one's file: it gets the text itself.
    const text = await pageText(p, !draft.walnut && !!draft.host && draft.host !== '__local__');
    asked.page = p.url;
    log.info('ext-panel', 'asking about a page', { host: hostOf(p.url), withText: !!(text.file || text.inline), acting });
    return pageContextBlock({ url: p.url, ...(p.title ? { title: p.title } : {}), ...(sel ? { selection: sel } : {}) }, { ...text, ...(acting ? { tab: now!.tab } : {}) });
  }, [actChoice, pageText]);

  const dropQuote = useCallback(() => setLeftOut(ctxRef.current?.page?.selection?.trim() ?? ''), []);

  const newChat = useCallback(() => {
    if (!key) return;
    nextConversation(agent.id);
    carryAct.current = ownTab;
    handChoice.current = null;
    setMainChat(null);
    setKeptMode('ask');
    setChat((n) => n + 1);
  }, [key, agent.id, ownTab, nextConversation, setKeptMode]);

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

  // Another agent shows its own open conversation; Main's composer is the general agent's.
  const pickAgent = useCallback((id: string) => { setMainChat(null); setAgentId(id); }, [setAgentId]);
  const closeDrawer = useCallback(() => setAsksDrawer(false), []);
  const mainSession = sessionOfTask(asks.mainTask);
  const onAsk = mode === 'ask';
  const drawer = (
    <ExtAsksDrawer
      open={!!asksDrawer}
      onClose={closeDrawer}
      returnFocusRef={menuRef}
      asks={asks}
      agentsFirst={asksDrawer === 'agents'}
      onPickAgent={pickAgent}
      selectedTaskId={onAsk && shownTaskId && shownTaskId !== asks.mainTask?.id ? shownTaskId : null}
      mainSelected={onAsk && (shownTaskId ? shownTaskId === asks.mainTask?.id : forMain)}
      onPick={(id) => {
        const t = asks.rows.find((r) => r.id === id)?.task;
        const sid = sessionOfTask(t) ?? undefined;
        if (isPopup) toParent({ type: 'open-side-panel', open: { taskId: id, ...(sid ? { sessionId: sid } : {}) } });
        else pickAsk(id, sid);
      }}
      onPickMain={() => {
        const main = asks.mainTask;
        // Main's conversation, in the panel like any ask; before its first message, its composer.
        if (isPopup) toParent({ type: 'open-side-panel', open: main && mainSession ? { taskId: main.id, sessionId: mainSession } : { taskId: MAIN_OPEN } });
        else if (main && mainSession) pickAsk(main.id, mainSession, GENERAL_AGENT_ID);
        else startMain();
      }}
      onNew={() => { if (!isPopup) newChat(); }}
      keyed={opts.keyed}
      settings={opts.settings}
      vault={vault}
      approvals={approvals.length}
      // Tasks is the first page (the popup is on it already); the others are the extension's own views.
      onView={(view) => { if (view === 'tasks') { if (!isPopup) goHome(); } else toParent({ type: 'open-view', view }); }}
    />
  );
  const shownTask = shownTaskId ? asks.tasks.find((t) => t.id === shownTaskId) : undefined;
  // An answer is read the way Home reads it: the person's first click or keystroke in the
  // conversation (SessionPanel markRead), never its being on screen. The drawer, Continue and the
  // Tasks badge then leave the ask out of what needs them (ext-tasks-model.ts readHere).
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
    <ExtAskApprovals list={approvals} taskId={onAsk ? shownTaskId : ''}
      onMore={() => (isPopup ? toParent({ type: 'open-side-panel', view: 'tasks' }) : toParent({ type: 'open-view', view: 'tasks' }))} />
  );

  const onOpenTask: OpenTask = (task: Task, how) => {
    if (isPopup) toParent({ type: 'open-side-panel', open: { taskId: task.id, ...(how !== 'detail' ? { sessionId: how.sessionId } : {}), task: true } });
    else if (how === 'detail') openDetail(task.id);
    else openTask(task.id, how.sessionId);
  };
  // Browser control, the side bar's third entry: what agents do in this browser, its few settings.
  const onControl = railEntry === 'control';
  // The first page: under its header the relay pill and its panel, the strip while an agent acts in this tab.
  const home = (
    <ExtFirstPage
      surface={opts.surface}
      hidden={mode !== 'home' || onControl}
      page={page}
      {...(tab !== undefined ? { tab } : {})}
      {...(owner ? { owner } : {})}
      agents={ctx.agents}
      relay={relay}
      tasks={allTasks}
      menuRef={menuRef}
      menuOn={!!asksDrawer && mode === 'home'}
      onMenu={() => setAsksDrawer((v) => (v ? false : 'asks'))}
      keyed={opts.keyed}
      vault={vault}
      keyPressed={keyPressed}
      settings={opts.settings}
      rail={opts.rail}
      approvals={mode === 'home' && !onControl ? approvalsStrip : null}
      pageText={pageText}
      onLaunched={(r) => openTask(r.taskId, r.sessionId, r)}
      onOpenTask={onOpenTask}
      preset={homePreset}
      onPresetTaken={(id) => setHomePreset((h) => (h?.id === id ? null : h))}
      onStop={takeBack}
    />
  );

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

  // A task opened from the first page: Back, its name and its state line; its detail when it has no conversation.
  const pageTaskId = mode === 'task' ? (detailId || shownTaskId) : '';
  const taskHeader = (
    <ExtTaskPageHead taskId={pageTaskId} tasks={allTasks} onBack={goHome} keyed={opts.keyed} vault={vault} keyPressed={keyPressed} />
  );

  // A new chat: the Continue list over the composer (ext-panel.css `.is-fresh`).
  const fresh = onAsk && !shownTaskId && !forMain;
  return <div ref={rootRef} className={`ext-panel ext-ask is-${onControl ? 'control' : mode}${isPopup ? ' is-popup' : ''}${fresh && !onControl ? ' is-fresh' : ''}`} data-testid="ext-panel"
    {...(isPopup ? { 'data-surface': 'popup' } : {})} data-mode={onControl ? 'control' : mode} data-page-key={pageKey} data-conversation={mode === 'home' ? '' : key}
    data-asks={asks.rowsReady || keptRows.length > 0 ? 'ready' : 'loading'}>
    {home}
    {onControl && (
      <ExtControl relay={relay} here={tab} tasks={allTasks} {...(owner ? { owner } : {})} agents={ctx.agents}
        keyed={opts.keyed} vault={vault} keyPressed={keyPressed} settings={opts.settings} />
    )}
    {/* Under Browser control the conversation stays mounted (its stream and draft), out of sight
        (ext-panel.css `.ext-panel.is-control`): never in a wrapper, the panel's rules are on its children. */}
    {mode !== 'home' && (mode === 'task' ? taskHeader : header)}
    {mode !== 'home' && approvalsStrip}
    {mode !== 'home' && otherOwner && (
      <p className="ext-panel-note" data-testid="ext-panel-other-owner">
        Another Walnut conversation or task is acting in this tab.{' '}
        <button type="button" className="ext-panel-link" data-testid="ext-panel-take-back" onClick={takeBack}>Take it back</button>
      </p>
    )}
    {mode !== 'home' && actError && <p className="ext-panel-note ext-panel-error" role="alert">{actError}</p>}
    {/* A new chat opens as the popup did: the asks to continue over the composer. */}
    {fresh && <ContinueList className="is-panel" rows={asks.rows} kept={keptRows} max={4} loading={!asks.rowsReady} onPick={(id, sid) => pickAsk(id, sid)} />}
    {mode === 'task' && detailId && <ExtTaskPageDetail taskId={detailId} tasks={allTasks} onOpenSession={openTask} onOpenTask={onOpenTask} onClose={goHome} />}
    {mode !== 'home' && !(mode === 'task' && detailId) && (
      <div className="ext-panel-chat">
        <UserRowAttachmentsContext.Provider value={attachmentsOf}>
        <AskObjectDrawer
          key={conv}
          objectKey={key}
          title={mode === 'task' ? modeTitle : page ? `Ask ${agent.name} about ${page.title ?? hostOf(page.url)}` : `Ask ${agent.name}`}
          quote={quote}
          agentId={convAgentId}
          contextBlock=""
          contextName={CONTEXT_NAME}
          prepareContext={prepareContext}
          onRecord={onRecord}
          // Escape here never closes the side panel (it holds the conversation and the draft): it
          // only leaves the composer. The toolbar popup closes on Escape (above).
          onClose={blurComposer}
          adjustLaunch={adjustLaunch}
          plainChat
          noQuote={!draftQuote}
          onDropQuote={dropQuote}
          {...(askPreset ? { preset: askPreset, autoSend: true } : {})}
          composerPlaceholder={mode === 'task' ? 'Ask a follow-up…' : forMain ? 'Ask the CEO, or hand it something to do…' : composerPlaceholderOf(agent.name, !!page)}
          composerPill={selectionPill}
          composerBar={chips}
        />
        </UserRowAttachmentsContext.Provider>
      </div>
    )}
    {drawer}
  </div>;
}
