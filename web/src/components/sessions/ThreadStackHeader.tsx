/**
 * The stack row (spec 5.2, 5.3, 5.7): ONE 36px row under the untouched session
 * header, plus a 20px subtitle line only when the panel is >= 600px, so the
 * stack's own chrome stays <= 56px at every depth (C70).
 *
 *   [back] [title, Naming...] [Archive | caret] [More] [Split]
 *
 * - back: `Main` or the parent title (max 34%, a short label under 560px, like an
 *   iOS back label), where a 500ms long press or a right click opens every
 *   ancestor, nearest first. The path itself is Tree Mode's path bar
 *   (ThreadPathBar), above the page.
 * - a half of Tree Mode's split screen (tree-half-context.ts) gets the half row
 *   instead: `[L|R] 6.1 Answered ... [Archive] [More] [close]`, the title being the
 *   path bar's; a wide single page keeps this row and adds Split.
 * - subtitle: the question, indented to the title block's left edge (N16).
 * - title: `Naming…` is a flex:none sibling OUTSIDE the ellipsis span, so a
 *   long title is cut and `Naming…` never is (C74). Double-click renames inline.
 * - Archive: open follow-ups ask `Also archive <N> follow-ups?` first (default
 *   focus `Only this one`, Esc cancels it); at depth >= 2 a split caret
 *   (or Alt+click) offers `Archive, back to start`. The word is never Done
 *   (2026-10-08, the user: "let's not have it done, just archived").
 */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useSubtitleIndent } from '@/hooks/useSubtitleIndent';
import type { ThreadStackHeaderProps } from '@/components/sessions/thread-ui-contract';
import { ThreadConfirm } from '@/components/sessions/ThreadConfirm';
import { ThreadArchiveIcon, ThreadChevronIcon, ThreadCloseIcon, ThreadReopenIcon } from '@/components/sessions/ThreadIcons';
import { ThreadInlineRename } from '@/components/sessions/ThreadInlineRename';
import { ThreadPathMenu, pathItems } from '@/components/sessions/ThreadStackCrumbs';
import { ThreadStatusWord } from '@/components/sessions/ThreadStatusWord';
import { useTreeHalf, type TreeHalf } from '@/components/sessions/tree-half-context';
import { ThreadStackMenu } from '@/components/sessions/ThreadStackMenu';
import { displayTitleOf, metaOf, pluralFollowUps, TITLE_MAX, viewStatusOf, type ThreadViewStatus } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { PENDING_ROW_LABEL } from '@/utils/thread-stack-state';
import '@/styles/thread-stack.css';

export const BACK_ICON_ONLY_WIDTH = 560;
/** The subtitle shows at every width (N7): 36px row + 20px line keeps C70's 56px. */
export const SUBTITLE_MIN_WIDTH = 0;
const LONG_PRESS_MS = 500;
type ThreadStackHeaderStatus = ThreadViewStatus;
export const alsoDoneTitle = (n: number): string => `Also archive ${pluralFollowUps(n)}?`;

type PathMenu = { kind: 'path' } | { kind: 'done' } | null;

export function ThreadStackHeader(p: ThreadStackHeaderProps) {
  const { path, pending, index, live, panelWidth, actions } = p;
  const node = pending ? undefined : path[path.length - 1];
  const parent = pending ? path[path.length - 1] : path[path.length - 2];
  const depth = pending ? path.length : path.length - 1;
  const narrow = panelWidth > 0 && panelWidth < BACK_ICON_ONLY_WIDTH;
  const half = useTreeHalf();
  const inHalf = half && half.side !== 'only' ? half as HalfOnScreen : null;
  const [renaming, setRenaming] = useState(false);
  const [confirmDone, setConfirmDone] = useState<number>(0);
  const [menu, setMenu] = useState<PathMenu>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const subPad = useSubtitleIndent(headerRef, titleRef);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });

  const renameSeen = useRef(p.renameNonce);
  useEffect(() => {
    if (renameSeen.current === p.renameNonce) return;
    renameSeen.current = p.renameNonce;
    if (node) setRenaming(true);
  }, [p.renameNonce, node]);
  useEffect(() => () => { if (press.current.timer) clearTimeout(press.current.timer); }, []);

  if (!parent) {
    return inHalf ? (
      <div className="thread-stack-header" data-depth={0} data-half={inHalf.side}>
        <HalfRow half={inHalf} label="Main conversation" />
      </div>
    ) : null;
  }
  const parentIsRoot = parent.key === ROOT_THREAD_KEY;
  const parentTitle = parentIsRoot ? 'Main conversation' : displayTitleOf(parent, index).title;
  const backText = parentIsRoot ? 'Main' : parentTitle;
  // A pending page's passage is already in its quote head right below: the row
  // says what the page is instead of printing the same sentence twice (N17).
  const shown = node ? displayTitleOf(node, index) : { title: PENDING_ROW_LABEL, naming: false };
  const meta = metaOf(node, index);
  const question = meta?.question ?? (node && !node.quote ? node.label : undefined);
  const status = node ? viewStatusOf(node, index, live) : 'pending';
  const key = node?.key;

  const runDone = (e?: MouseEvent) => {
    if (!key) return;
    if (e?.altKey && depth >= 2) { void actions.doneChain(key); return; }
    const n = actions.openBelowCount(key);
    if (n > 0) setConfirmDone(n);
    else void actions.done(key);
  };

  // Long press / right click on the back button (narrow): the ancestor menu.
  const onBackDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!narrow || e.button !== 0) return;
    press.current.fired = false;
    press.current.timer = setTimeout(() => { press.current.fired = true; setMenu({ kind: 'path' }); }, LONG_PRESS_MS);
  };
  const cancelPress = () => { if (press.current.timer) { clearTimeout(press.current.timer); press.current.timer = null; } };
  const onBackClick = () => {
    cancelPress();
    if (press.current.fired) { press.current.fired = false; return; }
    p.onBack();
  };
  const onBackContext = (e: MouseEvent) => {
    if (!narrow) return;
    e.preventDefault();
    setMenu({ kind: 'path' });
  };

  // `iconOnly`: the narrow verdict row, where `Archive` (longer than the old
  // `Done`) pushed More out of a 480px row; the word stays the name and tooltip.
  const doneButton = (label: string, iconOnly = false) => (
    <span className="thread-stack-done-split" data-split={depth >= 2 ? 'true' : undefined}>
      <button ref={doneRef} type="button" className="thread-stack-done" title="Archive and go back"
        aria-label={iconOnly ? label : undefined} data-icon-only={iconOnly ? 'true' : undefined} onClick={(e) => runDone(e)}>
        <ThreadArchiveIcon size={13} />
        {!iconOnly && <span className="thread-stack-done-label">{label}</span>}
      </button>
      {depth >= 2 && (
        <button ref={caretRef} type="button" className="thread-stack-done-caret" aria-haspopup="menu"
          aria-expanded={menu?.kind === 'done'} aria-label="Archive, back to start" title="Archive, back to start"
          onClick={() => setMenu(menu?.kind === 'done' ? null : { kind: 'done' })}>
          <ThreadChevronIcon size={10} className="thread-icon--down" />
        </button>
      )}
    </span>
  );

  let action = null;
  if (key && status === 'resolved') {
    action = (
      <button type="button" className="thread-stack-reopen" title="Unarchive this question" onClick={() => { void actions.reopen(key); }}>
        <ThreadReopenIcon size={13} />
        <span>Unarchive</span>
      </button>
    );
  } else if (key && status === 'suggested') {
    action = (
      <span className="thread-stack-suggested">
        {/* The same words for the same state everywhere (N42): drawer, Asked-from, here. */}
        <span className="thread-stack-suggested-label">Looks answered</span>
        {/* The verdict keeps its words (N42); narrow, the button is its icon
            so the row still fits 480px. */}
        {doneButton('Archive', narrow)}
        <button type="button" className="thread-stack-not-yet" onClick={() => { void actions.notYet(key); }}>Not yet</button>
      </span>
    );
  } else if (key) {
    action = doneButton('Archive');
  }

  // Narrow with the three verdict controls: the back label would be cut to one
  // letter (N42), so the chevron stands alone; its aria-label and tooltip name
  // the parent, and a long press or right click still opens the path.
  const backIconOnly = narrow && !!key && status === 'suggested';
  const subtitle = panelWidth >= SUBTITLE_MIN_WIDTH && question ? question.split('\n').find((l) => l.trim()) : undefined;
  const overlays = (
    <>
      {menu?.kind === 'path' && (
        <ThreadPathMenu anchorEl={backRef.current} label="Question path" items={pathItems(pending ? [...path, path[0]] : path, index).reverse()}
          onPick={p.onPopTo} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === 'done' && key && (
        <ThreadPathMenu anchorEl={caretRef.current} label="Archive options" items={[{ key: 'chain', label: 'Archive, back to start' }]}
          onPick={() => { void actions.doneChain(key); }} onClose={() => setMenu(null)} />
      )}
      {confirmDone > 0 && key && (
        <ThreadConfirm
          anchorEl={doneRef.current}
          title={alsoDoneTitle(confirmDone)}
          confirmLabel="Archive all"
          cancelLabel="Only this one"
          neutral
          onConfirm={() => { setConfirmDone(0); void actions.doneWithFollowUps(key); }}
          onCancel={() => { setConfirmDone(0); void actions.done(key); }}
          onDismiss={() => setConfirmDone(0)}
        />
      )}
    </>
  );
  const menuButton = key ? (
    <ThreadStackMenu
      variant="page" threadKey={key} visibleDescendants={actions.visibleDescendantCount(key)} hiddenCount={0}
      viewMode="stack" actions={actions} resolved={status === 'resolved'} onDone={() => runDone()}
      onShowInTree={p.onShowInTree} onShowAllInOrder={p.onShowAllInOrder}
      onBackToQuestions={() => {}} onShowHidden={() => {}} onRename={() => setRenaming(true)}
    />
  ) : null;
  if (inHalf) {
    // The half row: the title is the path bar's; it shows here only while renamed.
    const rename = renaming && key ? (
      <ThreadInlineRename initial={shown.title} max={TITLE_MAX} ariaLabel="Rename question" className="thread-stack-title-input"
        onSave={(t) => { setRenaming(false); void actions.rename(key, t); }} onCancel={() => setRenaming(false)} />
    ) : null;
    // An Archive that only shows its icon: the row stays one line in half a sheet.
    if (key && status !== 'resolved' && status !== 'suggested') action = doneButton('Archive', true);
    return (
      <div ref={headerRef} className="thread-stack-header" data-depth={depth} data-half={inHalf.side}>
        <HalfRow half={inHalf} label={node ? undefined : PENDING_ROW_LABEL} title={shown.title} question={question}
          status={node ? status : undefined} rename={rename}>
          {action}
          {menuButton}
        </HalfRow>
        {overlays}
      </div>
    );
  }
  return (
    <div ref={headerRef} className="thread-stack-header" data-depth={depth} data-narrow={narrow ? 'true' : undefined} data-subtitle={subtitle ? 'true' : undefined}>
      <div className="thread-stack-row">
        <button
          ref={backRef}
          type="button"
          className="thread-stack-back"
          data-icon-only={backIconOnly ? 'true' : undefined}
          data-narrow={narrow ? 'true' : undefined}
          aria-label={`Back to ${parentTitle}`}
          title={`Back to ${parentTitle} (Esc)`}
          onPointerDown={onBackDown}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onContextMenu={onBackContext}
          onClick={onBackClick}
        >
          <ThreadChevronIcon size={12} className="thread-icon--back" />
          {!backIconOnly && <span className="thread-stack-back-text">{backText}</span>}
        </button>
        <div ref={titleRef} className="thread-stack-title-block" title={question}>
          {renaming && key ? (
            <ThreadInlineRename initial={shown.title} max={TITLE_MAX} ariaLabel="Rename question" className="thread-stack-title-input"
              onSave={(t) => { setRenaming(false); void actions.rename(key, t); }} onCancel={() => setRenaming(false)} />
          ) : (
            <span className="thread-stack-title-line" onDoubleClick={() => { if (key) setRenaming(true); }}>
              <span className="thread-stack-title">{shown.title}</span>
              {shown.naming && <span className="thread-naming">Naming…</span>}
            </span>
          )}
        </div>
        {action}
        {menuButton}
        {half?.onSplit && (
          <button type="button" className="thread-half-split" title="Split: the question it was asked from beside it"
            aria-label="Split" onClick={half.onSplit}>
            <SplitIcon />
          </button>
        )}
        {half?.onShowSibling && (
          <button type="button" className="thread-half-split" title="Show the sibling question above"
            aria-label="Show the sibling question" onClick={half.onShowSibling}>
            <SiblingIcon />
          </button>
        )}
      </div>
      {subtitle && <div className="thread-stack-subtitle" title={question} style={subPad !== null ? { paddingLeft: subPad } : undefined}>{subtitle}</div>}
      {overlays}
    </div>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 2.5v10M2.5 10 5 12.5 7.5 10M11 13.5v-10M8.5 6 11 3.5 13.5 6" />
    </svg>
  );
}

function SiblingIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M2 6.5h12" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" /><path d="M8 3v10" />
    </svg>
  );
}

type HalfOnScreen = TreeHalf & { side: 'L' | 'M' | 'R' | 'S' };

const SIDE_NAME: Record<'L' | 'M' | 'R' | 'S', string> = { L: 'Left page', M: 'Middle page', R: 'Right page', S: 'Sibling page' };

/** `Previous · 1 of 2`: in a narrow column only the word stays (CSS); the whole is the tooltip. */
function WhereTag({ where }: { where: string }) {
  const at = where.indexOf(' \u00b7 ');
  if (at < 0) return <span className="thread-half-where">{where}</span>;
  return (
    <span className="thread-half-where" title={where}>
      {where.slice(0, at)}<span className="thread-half-where-pos">{where.slice(at)}</span>
    </span>
  );
}

/** One half's row: its badge, the question's label (or what the page is), its
 *  status word, the page's own actions, and a close button back to one pane. */
function HalfRow({ half, label, title, question, status, rename, children }: {
  half: HalfOnScreen;
  /** What the page is when it has no label: `Main conversation`, `New question`. */
  label?: string;
  title?: string;
  /** The question's own words: the row's tooltip, so a page whose question is
   *  scrolled out of sight (the sibling's third of the column) still says it. */
  question?: string;
  status?: ThreadStackHeaderStatus;
  rename?: ReactNode;
  children?: ReactNode;
}) {
  // Every page's row names it: its number, then its title (the composer below
  // writes to it, and the sibling page is on no segment of the path bar).
  const name = label ?? half.number ?? '';
  const shownTitle = !label && title && title !== name ? title : undefined;
  return (
    <div className="thread-stack-row thread-half-row" data-half={half.side}>
      {half.side === 'S' ? (
        <WhereTag where={half.where ?? ''} />
      ) : (
        <span className="thread-half-badge" title={SIDE_NAME[half.side]} aria-hidden="true">{half.side}</span>
      )}
      <span className="tree-sr-only">{SIDE_NAME[half.side]}: </span>
      {rename ?? (
        <>
          <span className="thread-half-name" title={question ?? title ?? name}>{name}</span>
          {shownTitle && <span className="thread-half-title" title={question ?? shownTitle}>{shownTitle}</span>}
        </>
      )}
      {status && <ThreadStatusWord status={status} className="thread-half-status" />}
      <span className="thread-half-gap" />
      {children}
      {half.onSwap && (
        <button type="button" className="thread-half-swap" title="Swap: open this question below, the one below comes up"
          aria-label="Swap with the page below" onClick={half.onSwap}>
          <SwapIcon /><span>Swap</span>
        </button>
      )}
      {half.onShowSibling && (
        <button type="button" className="thread-half-split" title="Show the sibling question above"
          aria-label="Show the sibling question" onClick={half.onShowSibling}>
          <SiblingIcon />
        </button>
      )}
      {half.onClose && (
        <button type="button" className="thread-half-close" title={half.side === 'M' ? 'Close this page and the one left of it' : 'Close this page'} aria-label={`Close the ${SIDE_NAME[half.side].toLowerCase()}`} onClick={half.onClose}>
          <ThreadCloseIcon size={12} />
        </button>
      )}
    </div>
  );
}
