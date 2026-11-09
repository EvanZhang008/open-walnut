/**
 * What a session panel shows, kept per place (2026-11-02, the user: "it keep lost my state like
 * the open state of the session, like full screen, file, can we make it default feature in
 * walnut no matter where include plugin, remember the state, like full store, file tab, tab
 * location"): the split view open beside the chat (Changed, Files, Terminal, Inbox, Web, Code,
 * Board), the file a click opened in Files, the service open in Web, the letter open in Inbox,
 * whether the user hid the chat beside it, the terminal docked under Changed / Files / Web
 * (and its height), and Tree Mode's split (tree-split-state.ts). A panel
 * that mounts again (a plugin reloaded, a page reload, another page and back, the app
 * restarted) shows it as it was left. The file the
 * explorer shows after browsing, its tree and its history are the explorer's own
 * (utils/file-view-state.ts); full screen is the tab's one state (hooks/fullscreen-owner.ts).
 *
 * The place is `useSheetPlace(viewPlace, sessionId)`: the host and the session, plus the page
 * for a host off the home page, so the same session in two hosts keeps two views. Every host
 * names its place (`viewPlace` is a required prop of SessionPanel).
 */
import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import { usePageViewOf } from '@/utils/view-memory';
import type { SessionSplitView } from './sessionSplitView';
import type { WebViewRequest } from './SessionWebView';
import { NO_TREE_SPLIT, isTreeSplitRecord, sameTreeSplit, type TreeSplitRecord } from '@/utils/tree-split-state';

export const PANEL_VIEWS: readonly SessionSplitView[] = ['changed', 'files', 'terminal', 'code', 'inbox', 'web', 'board'];

/** A file a click opened in the Files view. */
export interface PanelFileTarget {
  path: string;
  line?: number;
  endLine?: number;
  term?: string;
  nonce: number;
  /** The file lives on another host than the session's (absent = the session's). */
  onHost?: { host?: string };
  /** No host has it; the tree shows the session's cwd with that one line. */
  missing?: string;
}

export interface PanelViewRecord {
  view: SessionSplitView | null;
  file?: PanelFileTarget | null;
  web?: WebViewRequest | null;
  letter?: string | null;
  chatHidden?: boolean;
  /** Tree Mode's split screen: split or single, and the path bar's levels (tree-split-state.ts). */
  tree?: TreeSplitRecord;
  /** The terminal shown under Changed / Files / Web, and its height in px (absent: not docked). */
  terminalDock?: TerminalDockRecord;
}

export interface TerminalDockRecord {
  on: boolean;
  px?: number;
}

/** The views the terminal can be docked under. */
export const TERMINAL_DOCK_VIEWS: readonly SessionSplitView[] = ['changed', 'files', 'web'];

function isTerminalDock(v: unknown): v is TerminalDockRecord {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.on === 'boolean' && optional(d.px, isNum);
}

const EMPTY: PanelViewRecord = { view: null };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optional = <T>(v: unknown, ok: (x: unknown) => x is T): boolean => v === undefined || ok(v);

function isFileTarget(v: unknown): v is PanelFileTarget {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  const host = t.onHost as Record<string, unknown> | undefined;
  return isStr(t.path) && isNum(t.nonce) && optional(t.line, isNum) && optional(t.endLine, isNum)
    && optional(t.term, isStr) && optional(t.missing, isStr)
    && (host === undefined || (typeof host === 'object' && host !== null && optional(host.host, isStr)));
}

function isWebRequest(v: unknown): v is WebViewRequest {
  return !!v && typeof v === 'object' && isStr((v as WebViewRequest).url) && isNum((v as WebViewRequest).nonce);
}

/** A record this build can show; anything else (a view a later build removed) reads as nothing kept. */
export function isPanelView(v: unknown): v is PanelViewRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (r.view === null || PANEL_VIEWS.includes(r.view as SessionSplitView))
    && (r.file === undefined || r.file === null || isFileTarget(r.file))
    && (r.web === undefined || r.web === null || isWebRequest(r.web))
    && (r.letter === undefined || r.letter === null || isStr(r.letter))
    && (r.chatHidden === undefined || typeof r.chatHidden === 'boolean')
    && (r.tree === undefined || isTreeSplitRecord(r.tree))
    && (r.terminalDock === undefined || isTerminalDock(r.terminalDock));
}

type Field = Exclude<keyof PanelViewRecord, 'chatHidden' | 'tree' | 'terminalDock'>;

/** One field's setter over the record, `useState` style (a value or an updater). */
function fieldSetter<K extends Field>(set: Dispatch<SetStateAction<PanelViewRecord>>, key: K): Dispatch<SetStateAction<NonNullable<PanelViewRecord[K]> | null>> {
  return (next) => set((prev) => {
    const cur = (prev[key] ?? null) as NonNullable<PanelViewRecord[K]> | null;
    const v = typeof next === 'function' ? (next as (p: typeof cur) => typeof cur)(cur) : next;
    return cur === v ? prev : { ...prev, [key]: v };
  });
}

/** The panel's view at `place`, and a setter per part. Nothing is written until one changes. */
export function usePanelView(place: string) {
  const [record, setRecord] = usePageViewOf<PanelViewRecord>('panel', 'view', place, EMPTY, isPanelView);
  const setters = useMemo(() => ({
    setActiveView: fieldSetter(setRecord, 'view') as Dispatch<SetStateAction<SessionSplitView | null>>,
    setFileViewTarget: fieldSetter(setRecord, 'file') as Dispatch<SetStateAction<PanelFileTarget | null>>,
    setWebRequest: fieldSetter(setRecord, 'web') as Dispatch<SetStateAction<WebViewRequest | null>>,
    setInboxLetterId: fieldSetter(setRecord, 'letter') as Dispatch<SetStateAction<string | null>>,
  }), [setRecord]);
  const setChatHidden = useCallback((hidden: boolean) => {
    setRecord((prev) => ((prev.chatHidden ?? false) === hidden ? prev : { ...prev, chatHidden: hidden }));
  }, [setRecord]);
  const setTreeSplit = useCallback((update: (prev: TreeSplitRecord) => TreeSplitRecord) => {
    setRecord((prev) => {
      const cur = prev.tree ?? NO_TREE_SPLIT;
      const next = update(cur);
      return sameTreeSplit(cur, next) ? prev : { ...prev, tree: next };
    });
  }, [setRecord]);
  const setTerminalDock = useCallback((update: (prev: TerminalDockRecord) => TerminalDockRecord) => {
    setRecord((prev) => {
      const cur = prev.terminalDock ?? { on: false };
      const next = update(cur);
      return next.on === cur.on && next.px === cur.px ? prev : { ...prev, terminalDock: next };
    });
  }, [setRecord]);
  return {
    activeView: record.view,
    terminalDock: record.terminalDock ?? { on: false },
    setTerminalDock,
    fileViewTarget: record.file ?? null,
    webRequest: record.web ?? null,
    inboxLetterId: record.letter ?? null,
    chatHidden: record.chatHidden === true,
    setChatHidden,
    treeSplit: record.tree ?? NO_TREE_SPLIT,
    setTreeSplit,
    ...setters,
  };
}
