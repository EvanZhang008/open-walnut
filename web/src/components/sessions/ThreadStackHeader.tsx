/**
 * The stack row (spec 5.2, 5.3, 5.7): ONE 36px row under the untouched session
 * header, plus a 20px subtitle line only when the panel is >= 600px, so the
 * stack's own chrome stays <= 56px at every depth (C70).
 *
 *   [back] [path at depth >= 2] [title · Naming…] [Done | caret] [More]
 *
 * - back: `Main` or the parent title (max 34%, a short label under 560px, like an
 *   iOS back label), where a 500ms long press or a right click opens every
 *   ancestor, nearest first. At depth >= 2 (wide) the path replaces the label.
 * - subtitle: the question, indented to the title block's left edge (N16).
 * - title: `Naming…` is a flex:none sibling OUTSIDE the ellipsis span, so a
 *   long title is cut and `Naming…` never is (C74). Double-click renames inline.
 * - Done: open follow-ups ask `Also mark <N> follow-ups done?` first (default
 *   focus `Only this one`, Esc cancels the Done); at depth >= 2 a split caret
 *   (or Alt+click) offers `Done, back to start`.
 */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useSubtitleIndent } from '@/hooks/useSubtitleIndent';
import type { ThreadStackHeaderProps } from '@/components/sessions/thread-ui-contract';
import { ThreadConfirm } from '@/components/sessions/ThreadConfirm';
import { ThreadCheckIcon, ThreadChevronIcon, ThreadReopenIcon } from '@/components/sessions/ThreadIcons';
import { ThreadInlineRename } from '@/components/sessions/ThreadInlineRename';
import { ThreadPathMenu, ThreadStackCrumbs, pathItems } from '@/components/sessions/ThreadStackCrumbs';
import { ThreadStackMenu } from '@/components/sessions/ThreadStackMenu';
import { displayTitleOf, metaOf, pluralFollowUps, TITLE_MAX, viewStatusOf } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { PENDING_ROW_LABEL } from '@/utils/thread-stack-state';
import '@/styles/thread-stack.css';

export const BACK_ICON_ONLY_WIDTH = 560;
/** The subtitle shows at every width (N7): 36px row + 20px line keeps C70's 56px. */
export const SUBTITLE_MIN_WIDTH = 0;
const LONG_PRESS_MS = 500;
export const alsoDoneTitle = (n: number): string => `Also mark ${pluralFollowUps(n)} done?`;

type PathMenu = { kind: 'path' } | { kind: 'done' } | null;

export function ThreadStackHeader(p: ThreadStackHeaderProps) {
  const { path, pending, index, live, panelWidth, actions } = p;
  const node = pending ? undefined : path[path.length - 1];
  const parent = pending ? path[path.length - 1] : path[path.length - 2];
  const depth = pending ? path.length : path.length - 1;
  const narrow = panelWidth > 0 && panelWidth < BACK_ICON_ONLY_WIDTH;
  const showCrumbs = depth >= 2 && !narrow;
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

  if (!parent) return null;
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

  const doneButton = (label: string) => (
    <span className="thread-stack-done-split" data-split={depth >= 2 ? 'true' : undefined}>
      <button ref={doneRef} type="button" className="thread-stack-done" title="Mark done and go back" onClick={(e) => runDone(e)}>
        <ThreadCheckIcon size={13} />
        <span className="thread-stack-done-label">{label}</span>
      </button>
      {depth >= 2 && (
        <button ref={caretRef} type="button" className="thread-stack-done-caret" aria-haspopup="menu"
          aria-expanded={menu?.kind === 'done'} aria-label="Done, back to start" title="Done, back to start"
          onClick={() => setMenu(menu?.kind === 'done' ? null : { kind: 'done' })}>
          <ThreadChevronIcon size={10} className="thread-icon--down" />
        </button>
      )}
    </span>
  );

  let action = null;
  if (key && status === 'resolved') {
    action = (
      <button type="button" className="thread-stack-reopen" title="Reopen this question" onClick={() => { void actions.reopen(key); }}>
        <ThreadReopenIcon size={13} />
        <span>Reopen</span>
      </button>
    );
  } else if (key && status === 'suggested') {
    action = (
      <span className="thread-stack-suggested">
        {/* The same words for the same state everywhere (N42): drawer, Asked-from, here. */}
        <span className="thread-stack-suggested-label">Looks answered</span>
        {/* Narrow: the verdict keeps its words, the button says `Done` like on
            any other page, so the row fits 480px (N42). */}
        {doneButton(narrow ? 'Done' : 'Mark done')}
        <button type="button" className="thread-stack-not-yet" onClick={() => { void actions.notYet(key); }}>Not yet</button>
      </span>
    );
  } else if (key) {
    action = doneButton('Done');
  }

  // Narrow with the three verdict controls: the back label would be cut to one
  // letter (N42), so the chevron stands alone; its aria-label and tooltip name
  // the parent, and a long press or right click still opens the path.
  const backIconOnly = showCrumbs || (narrow && !!key && status === 'suggested');
  const subtitle = panelWidth >= SUBTITLE_MIN_WIDTH && question ? question.split('\n').find((l) => l.trim()) : undefined;
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
        {showCrumbs && <ThreadStackCrumbs path={pending ? [...path, path[path.length - 1]] : path} index={index} panelWidth={panelWidth} onPopTo={p.onPopTo} />}
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
        {key && (
          <ThreadStackMenu
            variant="page" threadKey={key} visibleDescendants={actions.visibleDescendantCount(key)} hiddenCount={0}
            viewMode="stack" actions={actions} resolved={status === 'resolved'} onDone={() => runDone()}
            onShowInTree={p.onShowInTree} onShowAllInOrder={p.onShowAllInOrder}
            onBackToQuestions={() => {}} onShowHidden={() => {}} onRename={() => setRenaming(true)}
          />
        )}
      </div>
      {subtitle && <div className="thread-stack-subtitle" title={question} style={subPad !== null ? { paddingLeft: subPad } : undefined}>{subtitle}</div>}
      {menu?.kind === 'path' && (
        <ThreadPathMenu anchorEl={backRef.current} label="Question path" items={pathItems(pending ? [...path, path[0]] : path, index).reverse()}
          onPick={p.onPopTo} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === 'done' && key && (
        <ThreadPathMenu anchorEl={caretRef.current} label="Done options" items={[{ key: 'chain', label: 'Done, back to start' }]}
          onPick={() => { void actions.doneChain(key); }} onClose={() => setMenu(null)} />
      )}
      {confirmDone > 0 && key && (
        <ThreadConfirm
          anchorEl={doneRef.current}
          title={alsoDoneTitle(confirmDone)}
          confirmLabel="Mark all done"
          cancelLabel="Only this one"
          neutral
          onConfirm={() => { setConfirmDone(0); void actions.doneWithFollowUps(key); }}
          onCancel={() => { setConfirmDone(0); void actions.done(key); }}
          onDismiss={() => setConfirmDone(0)}
        />
      )}
    </div>
  );
}
