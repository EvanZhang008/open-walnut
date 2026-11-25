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
/** A kind of floating surface owned elsewhere. The glass classes are a material, never a kind: a glass
 *  overlay still takes its kind's class for its corner and its layer (2026-11-22: the Voice Accuracy
 *  recording dialog carried only `wn-glass`, counted as on the family, and its scrim, with no layer,
 *  opened under the phone's top bar, which took the Close button's clicks). */
const OTHER_KINDS = ['wn-notice'];

/** Is a portal's overlay (the classes of its first two elements) off the family? A dialog panel
 *  needs its scrim too: the scrim carries the layer (`--z-modal`). */
export function offFamilyRoots(roots: readonly string[]): boolean {
  if (!roots.some((c) => FAMILY.includes(c) || OTHER_KINDS.includes(c))) return true;
  return roots.includes('wn-dialog') && !roots.includes('wn-scrim');
}

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
  'components/calendar/CalendarGridGhosts.tsx': 'the calendar\'s block being created (portalled into its day column) and its drag chip (a drag ghost)',
  'components/topics/TopicMention.tsx': 'portals each @Name chip into its slot in a message\'s words (the card it opens is MentionCard.tsx)',
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
  'components/common/DialogResizeEdges.tsx': 'the resize strips on the edges of the open dialog (a drag handle of that dialog, not a surface)',
  'components/tasks/TodoPanel.tsx': 'the unpin drop zone shown while a pinned row is dragged (a drag target)',
};

/**
 * Escape tests in an overlay's file that are not a close: the key does something else there (a drawing
 * tool cancels its stroke, a field inside a page clears). File -> how many, and why. A close always goes
 * through the layer (useOverlayLayer's onEscape / onClose('escape'), useModalOverlay): never list one here.
 */
export const ESCAPE_NOT_A_CLOSE: Record<string, [number, string]> = {
  'components/chat/ClassicDrawingPad.tsx': [1, 'Escape in the label box drops the label being typed (with none, the dialog closes through useModalOverlay)'],
  'components/tasks/TagEditor.tsx': [1, 'the tag field clears its hint or typed text first (its suggestions are a layer and take Escape before it)'],
  'components/tasks/TasksPageTable.tsx': [1, 'the inline add-a-task row in the table drops its typed title (a row, not an overlay)'],
  'components/inbox/LetterReader.tsx': [1, 'the embedded lens is the inbox column\'s reader, not an overlay: Escape there closes the letter in place (the overlay lens closes through useModalOverlay)'],
  'components/sessions/ModelPicker.tsx': [1, 'in place (a draft panel\'s picker, not a popout) the picker is part of the page: an Escape pressed inside it closes it, as its own x does (the popout closes through useOverlayLayer)'],
  'components/sessions/SessionFileExplorer.tsx': [1, 'the references panel is a side column of the explorer, not an overlay: Escape closes it (the path field and its list close through useOverlayLayer)'],
};

export const rel = (file: string) => path.relative(WEB_SRC, file);

/** The words of one `className=` value: a string, or every quoted piece of a `{...}` expression
 *  (templates nest: `wn-menu${extra ? ` ${extra}` : ''}`). */
function classWords(text: string, at: number): string[] {
  let i = at;
  let raw = '';
  if (text[i] === '"' || text[i] === "'" || text[i] === '`') raw = text.slice(i + 1, text.indexOf(text[i], i + 1));
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
 *  `e.code === 'Escape'`, the old `'Esc'`, `case 'Escape':`, `keyCode === 27`. */
export const ESCAPE_TEST = /\b(?:key|code)\s*[!=]==?\s*['"]Esc(?:ape)?['"]|['"]Esc(?:ape)?['"]\s*[!=]==?\s*[\w.]*\b(?:key|code)\b|case\s+['"]Esc(?:ape)?['"]|keyCode\s*[!=]==?\s*27\b/g;
/** An inline z-index, shadow or corner on an overlay (a number or a string): the family owns them. */
const INLINE_Z = /\bzIndex\s*:\s*['"`]?\d|\b(?:boxShadow|borderRadius)\s*:\s*['"`\d]/g;

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
  /** Floating surfaces drawn in place, not portalled (floatingClasses: an overlay's name, absolute or
   *  fixed, raised by a z-index or a shadow), whose className carries no family class. */
  inTree: Record<string, number>;
}

/** A class name that says "this floats": a menu, popover, dropdown, flyout, tooltip, popup, palette. */
const FLOATING_NAME = /-(?:menu|popover|dropdown|flyout|tooltip|tip|popup|palette|suggestions|autocomplete|hovercard|hover-card)$/;

/** Classes the stylesheets draw as a floating surface: a floating name on a rule of its own that is
 *  absolute or fixed and raised (a z-index or a shadow). Class -> the stylesheet. */
/** A box whose width and height are both set under 40px. */
function tiny(p: Record<string, string>): boolean {
  const px = (v: string | undefined) => (v && /^\d+(?:\.\d+)?px$/.test(v) ? parseFloat(v) : Infinity);
  return px(p.width) < 40 && px(p.height) < 40;
}

export function floatingClasses(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(WEB_SRC, ['.css'])) {
    const r = rel(file);
    if (/(^|\/)phone-[\w-]+\.css$/.test(r)) continue;
    const byClass = new Map<string, Record<string, string>>();
    for (const d of scanCss(r, fs.readFileSync(file, 'utf8'))) {
      if (d.atRules.length) continue;
      for (const sel of d.selectors) {
        const m = sel.trim().match(/^\.([A-Za-z0-9_-]+)$/);
        if (!m) continue;
        const props = byClass.get(m[1]) ?? {};
        props[d.prop] = d.value;
        byClass.set(m[1], props);
      }
    }
    for (const [cls, p] of byClass) {
      const raised = !!(p['z-index'] || p['box-shadow']);
      // A floating name, absolute or fixed and raised.
      if (FLOATING_NAME.test(cls) && /absolute|fixed/.test(p.position ?? '') && raised) out.set(cls, r);
      // Any name: a box fixed to the window, on a layer, with a frame of its own (2026-11-22 review:
      // the session search panel was a fixed popover named "-panel"). A full-window layer (inset: 0)
      // is a scrim or a page, not a floating surface; a box under 40px both ways is a marker or a
      // button pinned to the window (the passage comment marker), not a surface either.
      else if (/fixed/.test(p.position ?? '') && p['z-index'] && (p['box-shadow'] || /var\(--(?:bg|card)/.test(p.background ?? p['background-color'] ?? '')) && p.inset !== '0' && !tiny(p)) out.set(cls, r);
    }
  }
  return out;
}

/** `document.body.append(el)` / `appendChild(el)`: an overlay put on <body> by hand, a portal too. */
const BODY_APPEND = /\bdocument\.body\.(?:append|appendChild)\(/g;
/** What a helper appends and nobody sees: a copy buffer, a download link, a measuring mirror. */
const HELPER_NODE = /createElement\(\s*['"](?:textarea|a|input|iframe)['"]\s*\)|\.style\.(?:opacity\s*=\s*['"]0|left\s*=\s*['"]-\d|visibility\s*=\s*['"]hidden)/;

/** True when the file puts a visible surface on <body> by hand (a helper's hidden node does not count). */
function appendsSurface(text: string): boolean {
  for (const m of text.matchAll(BODY_APPEND)) {
    if (!HELPER_NODE.test(text.slice(Math.max(0, m.index! - 1500), m.index!))) return true;
  }
  return false;
}

/** Classes written beside a family class in the TSX: the family's members. Every quoted piece of a
 *  `className=` (a string, a template, a cx()/join call) counts, not only the first literal. */
export function members(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    // `className="..."` and `{...}` in JSX, and `el.className = '...'` in code.
    for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*(?=["'`{])/g)) {
      const words = classWords(text, m.index! + m[0].length);
      if (!words.some((w) => FAMILY.includes(w))) continue;
      for (const w of words) if (!FAMILY.includes(w) && !OTHER_FAMILIES.includes(w)) out.add(w);
    }
  }
  return out;
}

/** The frame a family class owns. */
const FRAME = /^(background|background-color|border(?:-(?:top|right|bottom|left))?(?:-(?:color|width|style))?|border-radius|box-shadow|z-index|-webkit-backdrop-filter|backdrop-filter)$/;
/** A filter is frame only when it draws a shadow. */
const FRAME_FILTER = /drop-shadow/;
/** Not a second look: taking a frame off (a member nested in another surface) or a layer token. */
const FRAME_OFF = /^(?:none|transparent|0|0px|var\(--z-[\w-]+\))$/;

/** The last compound of a selector, its pseudo-classes and attributes dropped; null for a pseudo-element. */
function lastCompound(selector: string): string | null {
  const last = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  if (/::/.test(last)) return null;
  return last.replace(/:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '');
}

export function countAll(): Counts {
  const out: Counts = { offFamily: {}, noCloseHook: {}, handEscape: {}, ownFrame: {}, offTip: {}, inTree: {} };
  const floating = floatingClasses();
  const bump = (m: Record<string, number>, f: string, n = 1) => { if (n) m[f] = (m[f] ?? 0) + n; };
  for (const file of walk(WEB_SRC, ['.tsx', '.ts']).sort()) {
    const r = rel(file);
    const text = stripComments(fs.readFileSync(file, 'utf8'), file);
    const tips = (text.match(/role(?:=|',\s*|",\s*)['"{]?tooltip/g) ?? []).length;
    if (tips && !/\bwn-(?:tip|overlay)\b/.test(text)) bump(out.offTip, r, tips);
    if (!NOT_OVERLAY[r] && file.endsWith('.tsx')) {
      for (const m of text.matchAll(/className=/g)) {
        const words = classWords(text, m.index! + 'className='.length);
        if (words.some((w) => floating.has(w)) && !words.some((w) => FAMILY.includes(w) || OTHER_FAMILIES.includes(w))) bump(out.inTree, r);
      }
    }
    const appended = appendsSurface(text);
    if ((!new RegExp(`\\b${portalCall(text)}\\(`).test(text) && !appended) || NOT_OVERLAY[r]) continue;
    const roots = portalRoots(text);
    bump(out.offFamily, r, roots.filter(offFamilyRoots).length);
    // A surface appended by hand: its classes are set in code, so the file must name a family class.
    if (appended && !roots.length && !FAMILY.some((c) => new RegExp(`\\b${c}\\b`).test(text))) bump(out.offFamily, r);
    // A tooltip closes when the pointer leaves: a file whose every surface is a wn-tip needs no close hook.
    const onlyTips = roots.length ? roots.every((cls) => cls.includes('wn-tip')) : /\bwn-tip\b/.test(text) && !FAMILY.some((c) => c !== 'wn-tip' && new RegExp(`\\b${c}\\b`).test(text));
    if (!CLOSE_HOOK.test(text) && !onlyTips) bump(out.noCloseHook, r);
    bump(out.handEscape, r, Math.max(0, (text.match(ESCAPE_TEST) ?? []).length - (ESCAPE_NOT_A_CLOSE[r]?.[0] ?? 0)));
    bump(out.ownFrame, r, (text.match(INLINE_Z) ?? []).length);
  }
  const member = members();
  for (const file of walk(WEB_SRC, ['.css']).sort()) {
    const r = rel(file);
    // The phone draws its own opaque sheets and menus (phone-layout.css and its fixes).
    if (/(^|\/)phone-[\w-]+\.css$/.test(r) || r === 'styles/overlay-family.css' || r === 'styles/overlay-glass.css') continue;
    let n = 0;
    for (const d of scanCss(r, fs.readFileSync(file, 'utf8'))) {
      if (!FRAME.test(d.prop) && !(d.prop === 'filter' && FRAME_FILTER.test(d.value))) continue;
      if (FRAME_OFF.test(d.value.trim())) continue;
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
