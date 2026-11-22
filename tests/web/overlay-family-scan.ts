/**
 * What the overlay family (web/src/styles/overlay-family.css, standard.md "Overlays") calls a floating
 * surface off the family, counted per file. Used by overlay-family-ratchet.test.ts.
 *
 * 2026-11-21, the UI audit: 159 files portalled a menu, popover, hover card, tooltip or dialog to
 * <body>, with 7 radii, 42 shadow strings, 17 z-index values, 10 scrim alphas and four ways to
 * close (useOverlayLayer, useModalOverlay, useOutsidePress, about 98 hand-rolled Escape listeners).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walk, scanCss } from './css-scan';

export const WEB_SRC = path.join(__dirname, '../../web/src');

/** The family's own classes: one per kind of floating surface. */
export const FAMILY = ['wn-overlay', 'wn-menu', 'wn-dialog', 'wn-scrim', 'wn-tip'];
/** Families of their own, owned elsewhere: the notice card (NoticeCard) and the glass materials. */
const OTHER_FAMILIES = ['wn-notice', 'wn-glass', 'wn-glass-fill', 'wn-glass-frost'];

/**
 * Portals that are not a floating surface of this family, each with why. A new entry needs a reason
 * a reviewer accepts: it is never the way to skip the family.
 */
export const NOT_OVERLAY: Record<string, string> = {
  'components/chat/AskWalnutSlot.tsx': 'the Ask Walnut session slot, a page region moved into place',
  'components/common/corner-stack.tsx': 'the corner stack of notices (NoticeCard is their family)',
  'components/content/ContentActionsHost.tsx': 'a host that portals other components into place',
  'components/sessions/DraftPanelWarmup.tsx': 'an off-screen warm-up mount, never seen',
  'components/settings/settings-pane-context.tsx': 'portals a settings pane into its column',
  'components/settings/SettingsSection.tsx': 'portals a section\'s buttons into its header',
  'components/tasks/PhonePullToRefresh.tsx': 'the phone\'s pull-to-refresh spinner',
  'components/sessions/ThreadPanelToast.tsx': 'a toast (NoticeCard): the notice family',
  'components/quickbar/QuickBarHost.tsx': 'the quick bar, frosted glass of its own (qb-center in GLASS_OVERLAYS)',
  'components/common/StaleBuildPill.tsx': 'a status pill pinned to the window corner, not a popover',
  'components/common/UnpairedNotice.tsx': 'a full-window notice page, not a dialog',
  'components/layout/RailItemPill.tsx': 'the rail\'s drag pill (a drag ghost)',
  'components/layout/PhoneNotificationBell.tsx': 'the phone top bar\'s bell, portalled into the bar',
  'components/common/SelectionAskPill.tsx': 'a button pill at the selection (the button family)',
  'components/sessions/SessionPanel.tsx': 'portals the panel\'s own header controls into place',
  'components/sessions/SessionChatHistory.tsx': 'portals the empty state into the timeline',
  'components/sessions/SessionTerminalPane.tsx': 'portals the terminal strip into the pane',
  'components/common/PageFind.tsx': 'the find bar, docked to the page like a toolbar',
  'hooks/useFullscreen.tsx': 'the full-screen view of a pane, not a dialog',
  'components/tasks/HomeBoardSheet.tsx': 'the board as a full-screen view (useFullscreen), not a dialog',
  'components/common/PhoneConfirmSheet.tsx': 'a phone action sheet (phone-layout.css owns its look)',
  'components/tasks/PhonePhaseSheet.tsx': 'a phone action sheet (phone-layout.css owns its look)',
  'components/tasks/PhoneSearchLayer.tsx': 'the phone search page',
  'components/common/Lightbox.tsx': 'an image viewer: a dark stage of its own, not a dimming scrim (useModalOverlay closes it)',
  'components/notes/NoteZoom.tsx': 'an image viewer: a dark stage of its own, not a dimming scrim (useModalOverlay closes it)',
  'apps/mail/MailAttachmentViewer.tsx': 'an attachment viewer: a dark stage of its own (useModalOverlay closes it)',
  'components/common/FileContentView.tsx': 'the full-screen file view (the backdrop the user chose, 2026-11-02), like useFullscreen',
  'components/common/NotificationPanel.tsx': 'the inbox panel docked to the sidebar, full height, not a popover',
  'components/sessions/PromptCards.tsx': 'the phone plan layer (phone-layout.css owns its look)',
  'components/tasks/TodoPanel.tsx': 'the unpin drop zone shown while a pinned row is dragged (a drag target)',
};

export const rel = (file: string) => path.relative(WEB_SRC, file);

/** The words of one `className=` value: a string, or every quoted piece of a `{...}` expression
 *  (templates nest: `wn-menu${extra ? ` ${extra}` : ''}`). */
function classWords(text: string, at: number): string[] {
  let i = at;
  let raw = '';
  if (text[i] === '"') raw = text.slice(i + 1, text.indexOf('"', i + 1));
  else if (text[i] === '{') {
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    raw = [...text.slice(at + 1, i).matchAll(/(['"`])([^'"`]*)/g)].map((m) => m[2]).join(' ');
  }
  return raw.replace(/\$\{[^}]*\}?/g, ' ').split(/\s+/).filter((w) => /^[a-z][\w-]*$/.test(w));
}

/** The class names of the first two elements of each `createPortal(...)` in a file (its overlay). */
export function portalRoots(text: string): string[][] {
  const out: string[][] = [];
  for (const p of text.matchAll(new RegExp(`\\b${portalCall(text)}\\(\\s*(\\w+)?`, 'g'))) {
    const built = p[1] ? text.search(new RegExp(`(?:const|let)\\s+${p[1]}\\s*=`)) : -1;
    const from = built >= 0 ? built : p.index!;
    const after = text.slice(from);
    const names = [...after.matchAll(/className=/g)].slice(0, 2);
    out.push(names.flatMap((m) => classWords(after, m.index! + 'className='.length)));
  }
  return out;
}

const CLOSE_HOOK = /\buse(?:OverlayLayer|ModalOverlay)\(/;
/** Every way a hand-written Escape test is spelled: `e.key === 'Escape'`, `'Escape' === e.key`,
 *  `case 'Escape':`, `keyCode === 27`. */
export const ESCAPE_TEST = /key\s*[!=]==?\s*['"]Escape['"]|['"]Escape['"]\s*[!=]==?\s*[\w.]*key\b|case\s+['"]Escape['"]|keyCode\s*[!=]==?\s*27\b/g;
/** An inline numeric z-index on an overlay: the layer tokens own it. */
const INLINE_Z = /\bzIndex\s*:\s*\d/g;

/** `createPortal`, or the name it is imported as (`import { createPortal as portal }`). */
function portalCall(text: string): string {
  return text.match(/\bcreatePortal\s+as\s+(\w+)/)?.[1] ?? 'createPortal';
}

/** Source without comments, so a hook named in a comment is not taken for a call. The comments come
 *  from TypeScript's own parser (a `/*` inside a line comment, a `//` in a string or JSX text stay as
 *  they are: a regex pass swallowed 23 KB of SessionPathSelector at one such comment). Each comment
 *  becomes spaces, so offsets and line numbers hold. */
export function stripComments(text: string, fileName = 'x.tsx'): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const ranges = new Map<number, number>();
  const take = (rs: readonly ts.CommentRange[] | undefined) => { for (const r of rs ?? []) ranges.set(r.pos, r.end); };
  const visit = (node: ts.Node) => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(sf);
  take(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  let out = '';
  let at = 0;
  for (const [pos, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (pos < at) continue;
    out += text.slice(at, pos) + text.slice(pos, end).replace(/[^\n]/g, ' ');
    at = end;
  }
  return out + text.slice(at);
}

export interface Counts {
  /** Portals whose overlay carries no family class. */
  offFamily: Record<string, number>;
  /** Files that portal an overlay and close it with neither useOverlayLayer nor useModalOverlay. */
  noCloseHook: Record<string, number>;
  /** Hand-written Escape tests in files that portal an overlay (the layer's onEscape is the way). */
  handEscape: Record<string, number>;
  /** CSS declarations that give a family member its own background, border, radius, shadow or z-index. */
  ownFrame: Record<string, number>;
  /** Tooltips (role="tooltip") without wn-tip (or wn-overlay, for a hover card that reads as one). */
  offTip: Record<string, number>;
}

/** Classes written beside a family class in the TSX: the family's members. */
export function members(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/class(?:Name)?\s*=\s*\{?\s*[`'"]([^`'"]*)[`'"]/g)) {
      const words = m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
      if (!words.some((w) => FAMILY.includes(w))) continue;
      for (const w of words) if (/^[a-z][\w-]*$/.test(w) && !FAMILY.includes(w) && !OTHER_FAMILIES.includes(w)) out.add(w);
    }
  }
  return out;
}

/** The frame a family class owns. */
const FRAME = /^(background|background-color|border|border-radius|box-shadow|z-index|-webkit-backdrop-filter|backdrop-filter)$/;

/** The last compound of a selector, its pseudo-classes and attributes dropped; null for a pseudo-element. */
function lastCompound(selector: string): string | null {
  const last = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  if (/::/.test(last)) return null;
  return last.replace(/:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '');
}

export function countAll(): Counts {
  const out: Counts = { offFamily: {}, noCloseHook: {}, handEscape: {}, ownFrame: {}, offTip: {} };
  const bump = (m: Record<string, number>, f: string, n = 1) => { if (n) m[f] = (m[f] ?? 0) + n; };
  for (const file of walk(WEB_SRC, ['.tsx', '.ts']).sort()) {
    const r = rel(file);
    const text = stripComments(fs.readFileSync(file, 'utf8'), file);
    const tips = (text.match(/role(?:=|',\s*|",\s*)['"{]?tooltip/g) ?? []).length;
    if (tips && !/\bwn-(?:tip|overlay)\b/.test(text)) bump(out.offTip, r, tips);
    if (!new RegExp(`\\b${portalCall(text)}\\(`).test(text) || NOT_OVERLAY[r]) continue;
    const roots = portalRoots(text);
    bump(out.offFamily, r, roots.filter((cls) => !cls.some((c) => FAMILY.includes(c) || OTHER_FAMILIES.includes(c))).length);
    if (!CLOSE_HOOK.test(text)) bump(out.noCloseHook, r);
    bump(out.handEscape, r, (text.match(ESCAPE_TEST) ?? []).length);
    bump(out.ownFrame, r, (text.match(INLINE_Z) ?? []).length);
  }
  const member = members();
  for (const file of walk(WEB_SRC, ['.css']).sort()) {
    const r = rel(file);
    // The phone draws its own opaque sheets and menus (phone-layout.css and its fixes).
    if (/(^|\/)phone-[\w-]+\.css$/.test(r) || r === 'styles/overlay-family.css' || r === 'styles/overlay-glass.css') continue;
    let n = 0;
    for (const d of scanCss(r, fs.readFileSync(file, 'utf8'))) {
      if (!FRAME.test(d.prop)) continue;
      const hit = d.selectors.some((sel) => {
        // `html body .x` is the override convention over the family (a phone's full-screen dialog).
        if (/^\s*html\s+body\b/.test(sel)) return false;
        const last = lastCompound(sel);
        return !!last && [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].some((m) => member.has(m[1]));
      });
      if (hit) n += 1;
    }
    bump(out.ownFrame, r, n);
  }
  return out;
}
