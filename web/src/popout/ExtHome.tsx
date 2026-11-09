/**
 * The extension's first page, Chat on its side bar (design C, 2026-11-07): Home's own task panel
 * fills the page (tabs, search, Needs you, the rows), with the relay strip over it while an agent
 * acts in this tab, and New task is docked at the bottom like a chat composer: one line (the words,
 * the page as "This page", send) that grows into the full composer on focus (the page chip with its
 * ×, Act in this tab, Save as todo, the mic) and goes back to one line when left empty.
 *
 * Send makes a task and its session, as Home's New task draft does, with the page and the tab as
 * Walnut hints beside the words (never in them): the panel then shows its conversation
 * (`onLaunched`). With no folder chosen the task starts in its own directory (`ownTaskDir`): the
 * extension never opens a folder picker. In the toolbar popup, which closes as soon as focus
 * leaves it, the text goes to the side panel instead, which sends it (`preset`).
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { ImageAttachment } from '@/api/chat';
import { apiPost } from '@/api/client';
import { quickStartSession } from '@/api/sessions';
import { ICON_FILE } from '@/components/common/Icons';
import { createTask } from '@/api/tasks';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { useAskObjectDraft } from '@/components/chat/useAskObjectDraft';
import { objectContextHints, storeObjectContext } from '@/components/chat/ask-object-session';
import { discardDraft, readDraft, writeDraft } from '@/utils/drafts';
import { draftComposerKey } from '@/components/sessions/draft-column';
import { getEngineCatalog } from '@/hooks/useEngineCatalog';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { log } from '@/utils/log';
import { ExtComposerChips } from './ExtAskChrome';
import { toParent } from './ext-frame';
import { ACT_CONTEXT_NAME, CONTEXT_NAME, actLine, hostOf, pageContextBlock, type PanelPage } from './ext-panel-model';
import { HOME_PLACEHOLDER, homeLaunchBody, homeTodoInput } from './ext-home-model';
import type { HandedLaunch } from './ext-panel-model';
import type { Attached } from './ext-attached';
import type { OpenTask } from './ExtHomeTasks';
import { useHomeSnapshots } from './useHomeSnapshots';

const ExtHomeTasks = lazy(() => import('./ExtHomeTasks'));

/** One draft for the first page, in this browser: the words wait in the draft store across opens. */
const HOME_DRAFT_ID = 'ext-home';
const noop = () => { /* the first page has no folder, project or task fields */ };
const known = () => true;

/**
 * What a send made: the task, its session, and what went with the first message. `actTab` is the
 * tab the person turned Act in this tab on for when they pressed Send: only that tab may be handed
 * over, and only while it is still the one on show (review round 5, #1).
 */
export interface HomeLaunched { taskId: string; sessionId?: string; act: boolean; actTab?: number; question: string; attached: Attached; pageUrl: string }
/** A first message the popup handed over, sent once with the popup's choices. */
/** The composer's own pop-overs, drawn outside it: the model picker. */
const COMPOSER_LAYERS = '.model-picker';

export interface HomePreset { id: string; text: string; page: boolean; act: boolean; sel: string; launch?: HandedLaunch }

interface Props {
  surface: 'panel' | 'popup';
  /** Another page is on show (a conversation): this one stays, so the list keeps its scroll. */
  hidden: boolean;
  page: PanelPage | null;
  tab?: number;
  /** The tab may be offered to the task (a web page, no other agent acts in it). */
  canAct: boolean;
  header: ReactNode;
  approvals: ReactNode;
  strip: ReactNode;
  pageText: (p: { url: string; title?: string }, remote: boolean) => Promise<{ file?: string; inline?: string }>;
  onLaunched: (r: HomeLaunched) => void;
  onOpenTask: OpenTask;
  preset: HomePreset | null;
  onPresetTaken: (id: string) => void;
}

export function ExtHome(p: Props) {
  const draft = useAskObjectDraft(HOME_DRAFT_ID, { task: true });
  const rootRef = useRef<HTMLDivElement>(null);
  useHomeSnapshots(rootRef, !p.hidden);
  const page = p.page;
  const [pageOn, setPageOn] = useState(true);
  const [actOn, setActOn] = useState(false);
  // Another page: its chip is on again; another tab: the act switch is that tab's.
  useEffect(() => { setPageOn(true); }, [page?.url]);
  useEffect(() => { setActOn(false); }, [p.tab]);
  // The page's selection shows as a quote over the composer, with its own ×: what shows is what goes.
  const selection = page?.selection?.trim() ?? '';
  const [leftOut, setLeftOut] = useState('');
  useEffect(() => { if (!selection) setLeftOut(''); }, [selection]);
  const quote = selection && selection !== leftOut ? selection : '';
  const [starting, setStarting] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Task | null>(null);
  /** A Save as todo on its way: Save waits, and Send keeps its words (one lock with the launch). */
  const [saving, setSaving] = useState(false);
  /** Moves after a save as todo, so the composer starts empty again. */
  const [composerNo, setComposerNo] = useState(0);
  /** The composer grown (focus inside it, or words in it): else docked on one line (design C). */
  const [grown, setGrown] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const dockLater = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(dockLater.current), []);
  const onComposerFocus = useCallback(() => { clearTimeout(dockLater.current); setGrown(true); }, []);
  const onComposerBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (to && composerRef.current?.contains(to)) return;
    // Docked a moment later, never inside the press that moved focus: the list and the line over
    // the composer move when it docks, and the click must land where the pointer went down.
    clearTimeout(dockLater.current);
    const dockIfLeft = () => {
      if (composerRef.current?.contains(document.activeElement)) return;
      // The model picker is the composer's, in a layer of its own (portalled): while it is open the
      // composer stays grown, else its pill and so the picker's anchor would go (review 2026-11-09).
      if (document.querySelector(COMPOSER_LAYERS)) { dockLater.current = setTimeout(dockIfLeft, 250); return; }
      // Left with words in it, it stays grown: what is typed shows whole.
      const words = composerRef.current?.querySelector('textarea')?.value.trim() ?? '';
      if (!words) setGrown(false);
    };
    dockLater.current = setTimeout(dockIfLeft, 250);
  }, []);
  /** One write at a time from this composer: a launch or a save as todo (review round 5, #4). */
  const flight = useRef(false);

  const launch = useCallback(async (text: string, images: ImageAttachment[] | undefined, choice: { page: boolean; act: boolean; sel: string }, picked?: HandedLaunch): Promise<boolean> => {
    const question = text.trim();
    if (!question || flight.current) return false;
    flight.current = true;
    setStarting(question); setError(''); setSaved(null);
    try {
      const pg = page;
      // The tab on show when Send was pressed: the one the person allowed, whatever is on show later.
      const actTab = choice.act ? p.tab : undefined;
      const acting = actTab !== undefined;
      const sel = choice.sel.trim();
      const withPage = !!pg && choice.page;
      let block = '';
      let name = CONTEXT_NAME;
      if (pg && (withPage || sel)) {
        const body = withPage ? await p.pageText(pg, false).catch(() => ({})) : {};
        block = pageContextBlock({ url: pg.url, ...(pg.title ? { title: pg.title } : {}), ...(sel ? { selection: sel } : {}) },
          { ...body, ...(acting ? { tab: actTab } : {}), ...(withPage ? {} : { selectionOnly: true }) });
      } else if (acting) {
        block = actLine(actTab!);
        name = ACT_CONTEXT_NAME;
      }
      const contextId = await storeObjectContext(name, block, (path, b) => apiPost<{ id: string }>(path, b));
      // The popup's picks win over this panel's own draft: what the person saw there is what starts.
      const own = draft.draftRef.current;
      const launchDraft = picked ? { ...own, meta: { ...own.meta, ...picked, engine: (picked.engine ?? own.meta.engine) as typeof own.meta.engine } } : own;
      const body = homeLaunchBody({
        draft: launchDraft, message: question, ...(images?.length ? { images } : {}), tierKnown: draft.tierKnown, catalog: getEngineCatalog(),
        ...(contextId ? { hints: objectContextHints(contextId) } : {}),
      });
      const r = await quickStartSession(body);
      log.info('ext-home', 'task started from the panel', { taskId: r.taskId, sessionId: r.sessionId ?? null, withPage, acting, selChars: sel.length });
      const attached: Attached = { ...(withPage ? { page: { title: pg!.title ?? hostOf(pg!.url), host: hostOf(pg!.url) } } : {}), ...(sel ? { sel, ...(withPage ? {} : { from: pg?.title ?? hostOf(pg?.url ?? '') }) } : {}) };
      setStarting('');
      p.onLaunched({ taskId: r.taskId, ...(r.sessionId ? { sessionId: r.sessionId } : {}), act: acting, ...(acting ? { actTab } : {}), question, attached, pageUrl: withPage ? pg!.url : '' });
      if (sel) setLeftOut(sel);
      // The next task starts as a new one does: with this page, not acting, docked.
      setPageOn(true); setActOn(false); setGrown(false);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('ext-home', 'task not started', { error: message });
      setStarting('');
      setError(message);
      return false;
    } finally {
      flight.current = false;
    }
  }, [page, p, draft.draftRef, draft.tierKnown]);

  const onStart = useCallback(async (_id: string, text: string, images?: ImageAttachment[]): Promise<boolean> => {
    const choice = { page: !!page && pageOn, act: p.canAct && actOn, sel: quote };
    if (p.surface === 'popup') {
      // The popup closes as soon as focus leaves it: the side panel sends it, with these choices.
      const question = text.trim();
      if (!question) return false;
      // With the mode, model and engine picked here: the side panel starts it with them (review 2026-11-09).
      const m = draft.draftRef.current.meta;
      const picked = { ...(m.mode ? { mode: m.mode } : {}), ...(m.model ? { model: m.model } : {}), ...(m.engine ? { engine: m.engine } : {}) };
      toParent({ type: 'open-side-panel', ask: { text: question, page: choice.page, act: choice.act, ...(quote ? { sel: quote } : {}), task: true, ...(Object.keys(picked).length ? { launch: picked } : {}) } });
      return true;
    }
    return launch(text, images, choice);
  }, [launch, page, pageOn, actOn, quote, p.canAct, p.surface, draft.draftRef]);

  /**
   * Words that did not become a task go back into the composer, after anything typed there since,
   * with the page chip as they chose it: a popup's question the side panel could not start would
   * otherwise be gone, since the popup closed (review round 5, #2).
   */
  const giveBack = useCallback((text: string, withPage: boolean) => {
    const key = draftComposerKey(HOME_DRAFT_ID);
    const there = readDraft(key).trim();
    writeDraft(key, there && there !== text.trim() ? `${there}\n\n${text}` : text);
    setComposerNo((n) => n + 1);
    setPageOn(withPage);
    // Grown, so the words and the page as they chose it show whole.
    setGrown(true);
  }, []);

  // The popup's question, sent once, with the popup's choices; not started, its words come back.
  const { preset, onPresetTaken } = p;
  useEffect(() => {
    if (!preset || !page && preset.page) return;
    onPresetTaken(preset.id);
    const busy = flight.current;
    void launch(preset.text, undefined, { page: preset.page, act: preset.act && p.canAct, sel: preset.sel }, preset.launch).then((ok) => {
      if (ok) return;
      log.info('ext-home', 'handed question not started: back in the composer', { busy });
      if (busy) setError('another task was still starting. Your words are back in the box: send them again.');
      giveBack(preset.text, preset.page);
    });
  }, [preset, page, launch, onPresetTaken, p.canAct, giveBack]);

  const saveTodo = useCallback(async (_id: string, text: string) => {
    const input = homeTodoInput({ draft: draft.draftRef.current, text, page, withPage: !!page && pageOn, tierKnown: draft.tierKnown });
    if (!input || flight.current) return;
    flight.current = true;
    setSaving(true);
    setError('');
    try {
      const task = await createTask(input);
      log.info('ext-home', 'todo saved from the panel', { taskId: task.id });
      discardDraft(draftComposerKey(HOME_DRAFT_ID));
      setComposerNo((n) => n + 1);
      setPageOn(true); setActOn(false); setGrown(false);
      setSaved(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }, [draft.draftRef, draft.tierKnown, page, pageOn]);
  // The saved line goes after a while; Open on it opens the todo here.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 10_000);
    return () => clearTimeout(t);
  }, [saved]);

  // Under the words: the selection's quote and the page chip, each with its ×; in the bottom row the
  // Act in this tab switch (the mock's place for them, design option A).
  const quotePill = quote ? (
    <div className="ext-panel-selection" data-testid="ext-panel-selection">
      <span className="ext-panel-selection-text" title={quote}><span className="ext-panel-selection-label">Selected on the page:</span> {quote}</span>
      <button type="button" className="ext-panel-selection-drop" data-testid="ext-panel-selection-drop" aria-label="Leave the selection out" title="Leave the selection out of the task" onClick={() => setLeftOut(quote)}>&times;</button>
    </div>
  ) : null;
  const pills = quotePill || page ? (
    <div className="ext-home-pills">
      {quotePill}
      <ExtComposerChips page={page} pageOn={pageOn} onPage={setPageOn} />
    </div>
  ) : undefined;
  // Docked, the bar holds only the page, as one chip ("This page"): a click on it grows the box.
  const dockChip = page && pageOn ? (
    <span className="ext-home-dock-chip" data-testid="ext-home-dock-chip" title={`Walnut reads this page with your next message: ${page.title ?? hostOf(page.url)}`}>
      <span className="ext-chip-fav" aria-hidden="true">{ICON_FILE}</span>
      {quote ? 'This page + selection' : 'This page'}
    </span>
  ) : null;
  const actSwitch = p.canAct ? (
    <label className="ext-home-act" title="Let the task act in this tab: it opens pages, clicks and types here, framed, with Stop">
      <ToggleSwitch checked={actOn} onChange={setActOn} data-testid="ext-home-act" aria-label="Act in this tab" />
      <span>Act in this tab</span>
    </label>
  ) : undefined;

  const docked = !grown && !starting;
  const composer = (
    <div ref={composerRef} className={`ext-home-composer${docked ? ' is-docked' : ' is-grown'}`} data-testid="ext-home-composer" data-docked={docked ? 'true' : 'false'}
      aria-busy={!!starting || saving} onFocus={onComposerFocus} onBlur={onComposerBlur}>
        <DraftSessionPanel
          key={composerNo}
          draft={draft.draft}
          onStart={onStart}
          onSaveAsTask={saveTodo}
          onClose={noop}
          onPathChange={noop}
          onProjectChange={noop}
          onMetaChange={draft.onMetaChange}
          onModeChange={draft.onModeChange}
          isKnownProject={known}
          plainChat
          ownFolder
          saveBusy={saving || !!starting}
          placeholder={HOME_PLACEHOLDER}
          composerPill={docked ? undefined : pills}
          composerBar={docked ? dockChip : actSwitch}
        />
    </div>
  );

  return (
    <div ref={rootRef} className="ext-home is-c" data-testid="ext-home" hidden={p.hidden}>
      {/* Under another page only the task list stays (it keeps its place); the composer's words
          are kept by its draft, so the hidden page holds no second header, key or page chip. */}
      {!p.hidden && <>
      {p.header}
      {p.approvals}
      {p.strip}
      </>}
      <div className="ext-home-tasks" data-testid="ext-home-tasks">
        <Suspense fallback={<p className="ext-home-loading muted" role="status"><span className="spinner" /> Loading your tasks…</p>}>
          <ExtHomeTasks onOpen={p.onOpenTask} />
        </Suspense>
      </div>
      {!p.hidden && <>
      {/* Over the docked composer, in the page's own column. */}
      <div className="ext-home-notes">
        {saving && <p className="ext-home-note" role="status" data-testid="ext-home-saving"><span className="spinner" /> Saving as a todo…</p>}
        {starting && <p className="ext-home-note" role="status" data-testid="ext-home-starting"><span className="spinner" /> Starting the task…</p>}
        {error && <p className="ext-home-note ext-panel-error" role="alert" data-testid="ext-home-error">Walnut could not start it: {error}</p>}
        {saved && (
          <p className="ext-home-note" role="status" data-testid="ext-home-saved">
            Saved as a todo: {saved.title}{' '}
            <button type="button" className="ext-panel-link" data-testid="ext-home-saved-open" onClick={() => p.onOpenTask(saved, 'detail')}>Open</button>
          </p>
        )}
      </div>
      {composer}
      </>}
    </div>
  );
}
