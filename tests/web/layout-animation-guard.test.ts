/**
 * Guard: no animation that makes the browser lay the page out again on every frame, and no
 * write of a custom property on <html> or <body> from a path that runs while the page moves.
 *
 * 2026-11-22, the user, in the Mac app: "the sidebar is extremely laggy when I open and
 * close it, and many animations feel laggy. Is there no way to do this well, or do we need
 * Electron?" Measured in the system WebKit (the Mac app's engine) on the pages he had open,
 * a 250 ms slide of the sidebar drew 3 frames, each over 100 ms. Two causes, both ours and
 * neither the engine's:
 *
 *  1. `.sidebar { transition: width }`. A transition on a property that moves other elements
 *     lays out everything beside it on each frame: 35 to 50 ms a frame on Org.
 *  2. The shell wrote `--fullscreen-left` on <html> from a ResizeObserver on each of those
 *     frames. A custom property on the root is inherited by every element, so one write
 *     restyles the whole document: 57 ms on Home, 96 ms on Org.
 *
 * The two classes, and what a new member does instead:
 *
 *  - A transition or @keyframes on a layout property (width, height, margins, padding,
 *    offsets, flex, grid tracks), or `transition: all`: change the layout once and move with
 *    `transform` or fade with `opacity` (web/src/utils/layout-slide.ts). The members listed
 *    below are small boxes whose change lays out only themselves (a progress fill, one row
 *    leaving a list, a label); a new one is listed only with that reason.
 *  - A `style.setProperty` on document.documentElement or document.body: put the variable on
 *    the element that reads it, or write it only while a reader is on screen
 *    (web/src/components/layout/fullscreen-area.ts). The members below run once at start or
 *    only on a phone.
 *
 * And the reader side of the second class: every stylesheet that reads `--fullscreen-left`
 * belongs to a component that retains the area while it shows, or its sheet would start at a
 * stale edge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

function files(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out.sort();
}
const rel = (path: string) => relative(WEB_SRC, path);

const LAYOUT_PROPERTY = /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|left|right|top|bottom|inset(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|flex(?:-[a-z-]+)?|grid-template(?:-[a-z-]+)?|gap|row-gap|column-gap|font-size|line-height|border(?:-[a-z]+)?-width|all)$/;

/** `a 1s ease, b 2s` -> ['a', 'b']: the property each item of a transition names. */
function transitionProperties(value: string): string[] {
  return value
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((item) => item.trim().split(/\s+/).find((word) => /^[a-z-]+$/.test(word) && !/^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|none|initial|inherit|unset|allow-discrete|normal)$/.test(word)) ?? '')
    .filter(Boolean);
}

/** The body of the block that opens at `open` (the index of its `{`), and where it ends. */
function block(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return { body: source.slice(open + 1), end: source.length };
}

/** Every transition or @keyframes in a stylesheet that animates a layout property. */
function layoutAnimations(file: string): string[] {
  let source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  const KEYFRAMES = /@(?:-webkit-)?keyframes\s/;
  for (let at = source.search(KEYFRAMES); at !== -1; at = source.search(KEYFRAMES)) {
    const open = source.indexOf('{', at);
    const name = source.slice(at, open).replace(KEYFRAMES, '').trim();
    const { body, end } = block(source, open);
    const properties = new Set<string>();
    for (const step of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const declaration of step[1].split(';')) {
        const property = declaration.split(':')[0].trim();
        if (LAYOUT_PROPERTY.test(property) && property !== 'all') properties.add(property);
      }
    }
    if (properties.size > 0) found.push(`${rel(file)} | @keyframes ${name} | ${[...properties].sort().join(', ')}`);
    source = source.slice(0, at) + source.slice(end);
  }
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    const properties = new Set<string>();
    for (const declaration of rule[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim();
      if (!/^(?:-webkit-)?transition(?:-property)?$/.test(property)) continue;
      for (const name of transitionProperties(declaration.slice(colon + 1))) {
        if (LAYOUT_PROPERTY.test(name)) properties.add(name);
      }
    }
    if (properties.size > 0) found.push(`${rel(file)} | ${selector} | ${[...properties].sort().join(', ')}`);
  }
  return found;
}

/**
 * Layout animations that stay, each a small box whose change lays out only itself and what
 * is inside it. A new entry needs that reason; a whole panel, column or page never qualifies.
 */
const FILL = 'a progress fill inside a track of fixed size';
const ROW = 'one row or card opening or closing: lays out its own list, not the page';
const CONTROL = '`all` on a small control whose box never changes size';
const BOX = 'one small box of its own (a label, a bar, a popover)';
const CONTENT = 'one card or one note growing where it is, a glide chosen for it: lays out its own content each frame, not measured here';
const SMALL_BOX: Record<string, string> = {
  'apps/mail/mail-groups.css | @keyframes mail-row-leave | max-height, padding-bottom, padding-top': ROW,
  'components/chat/camera/camera-dock.css | .camera-progress | width': FILL,
  'components/notes/notes-width.css | .notes-width-normal .notes-editor-content > *, .notes-width-full .notes-editor-content > * | max-width': CONTENT,
  'styles/attachments.css | .file-card-progress > span | width': FILL,
  'styles/attention-banner.css | .hpb-row | max-height': ROW,
  'styles/change-card.css | .change-card .change-card-seg | padding': BOX,
  'styles/globals.css | @keyframes todo-recently-done-out | border-width, margin-bottom, margin-top, max-height, padding-bottom, padding-top': ROW,
  'styles/globals.css | @keyframes filter-override-fade-out | margin, max-height, padding': ROW,
  'styles/globals.css | .mic-waveform-bar | height': BOX,
  'styles/globals.css | .stt-model-tab | all': CONTROL,
  'styles/globals.css | .stt-progress-bar-fill | width': FILL,
  'styles/globals.css | .vd-cat | all': CONTROL,
  'styles/globals.css | .todo-section-tab-label | max-width': BOX,
  'styles/globals.css | .todo-panel-tab | all': CONTROL,
  'styles/globals.css | .todo-panel-toggle-completed | all': CONTROL,
  'styles/globals.css | .filter-more-btn | all': CONTROL,
  'styles/globals.css | .cron-filter-tab | all': CONTROL,
  'styles/globals.css | .model-picker-rail | width': BOX,
  'styles/globals.css | .cmd-card-content | max-height': ROW,
  'styles/globals.css | .qp-option | all': CONTROL,
  'styles/human-inbox.css | .hib-card-expand | grid-template-rows': ROW,
  'styles/quick-sort.css | .quick-sort-progress i | width': FILL,
  'styles/quickbar.css | .qb-wave span | height': BOX,
  'styles/session-browser-card.css | .session-browser-replay-tick::before | all': CONTROL,
  'styles/settings-sections-configure.css | .settings-progress-fill | width': FILL,
  'styles/setup-progress.css | .setup-progress-fill | width': FILL,
  'styles/thread-card.css | .thread-card.is-sizing | left, max-height, width': CONTENT,
  'styles/thread-review.css | .thread-review-bar::before | width': BOX,
};

/** Writes on <html> or <body> that stay, and when each runs. */
const ROOT_WRITES: Record<string, string> = {
  'components/layout/fullscreen-area.ts x1': 'only while a full screen sheet that reads it is on screen',
  'components/layout/PhoneStatusRow.tsx x1': 'the phone layout only: its status row changing height',
  'hooks/useVisualViewportInset.ts x1': 'the phone layout only: the keyboard, once a frame at most',
  'utils/scrollbar-metrics.ts x1': 'once, when the app starts',
};

/** Each stylesheet that reads --fullscreen-left, and the component that retains the area for it. */
const FULLSCREEN_LEFT_READERS: Record<string, string[]> = {
  'styles/fullscreen-tab.css': ['hooks/useFullscreen.tsx', 'components/common/FileContentView.tsx'],
  'components/drawing/drawing-workspace.css': ['components/drawing/DrawingWorkspace.tsx'],
};

/** `x.style.setProperty(` where x is the root element or the body, by file. */
function rootWrites(file: string): number {
  const source = readFileSync(file, 'utf8');
  const roots = ['documentElement', 'document\\.body', 'doc\\.body'];
  for (const alias of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)?(?:documentElement|body)\b/g)) roots.push(alias[1]);
  const write = new RegExp(`(?:${roots.join('|')})\\s*\\.style\\s*\\.setProperty\\(`, 'g');
  return [...source.matchAll(write)].length;
}

describe('layout animation guard', () => {
  const stylesheets = files(WEB_SRC, (path) => path.endsWith('.css'));
  const sources = files(WEB_SRC, (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));

  it('finds the stylesheets and sources it reads', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
    expect(sources.length).toBeGreaterThan(500);
  });

  it('no stylesheet animates a layout property, except the listed small boxes', () => {
    const members = stylesheets.flatMap(layoutAnimations);
    const unlisted = members.filter((member) => !(member in SMALL_BOX));
    expect(unlisted, 'A new animation lays the page out on every frame. Change the layout once and animate transform or opacity (web/src/utils/layout-slide.ts), or list it in SMALL_BOX with why only its own box is laid out.').toEqual([]);
    const gone = Object.keys(SMALL_BOX).filter((member) => !members.includes(member));
    expect(gone, 'These entries match nothing now: remove them from SMALL_BOX.').toEqual([]);
  });

  it('the sidebar and the page columns never transition a layout property', () => {
    const members = stylesheets.flatMap(layoutAnimations);
    const big = members.filter((member) => /\|\s*[^|]*(?:\.sidebar(?![\w-])|\.main-content|\.app-content-area|\.app-shell|\.page-side-bar|\.main-page-session-column)[^|]*\|/.test(member));
    expect(big).toEqual([]);
  });

  it('no inline style transitions a layout property', () => {
    const inline = /(?:transition(?:Property)?\s*:|\.style\.transition(?:Property)?\s*=)\s*[`'"][^`'"]*(?<![\w-])(?:(?:min-|max-)?(?:width|height)|left|right|top|bottom|margin|padding|flex|gap|all)(?![\w-])/;
    const members = sources.filter((file) => inline.test(readFileSync(file, 'utf8'))).map(rel);
    expect(members, 'An inline transition on a layout property: animate transform or opacity instead.').toEqual([]);
  });

  it('nothing writes a custom property on <html> or <body>, except the listed writes', () => {
    const members = sources.map((file) => [rel(file), rootWrites(file)] as const).filter(([, count]) => count > 0);
    const found = Object.fromEntries(members.map(([file, count]) => [`${file} x${count}`, ROOT_WRITES[`${file} x${count}`] ?? '']));
    const unlisted = Object.keys(found).filter((member) => !(member in ROOT_WRITES));
    expect(unlisted, 'A write on the root restyles the whole document (57 to 96 ms in the Mac app). Put the variable on the element that reads it, or write it only while a reader is on screen (web/src/components/layout/fullscreen-area.ts); list it in ROOT_WRITES only when it runs once or never on a desktop.').toEqual([]);
    const gone = Object.keys(ROOT_WRITES).filter((member) => !(member in found));
    expect(gone, 'These entries match nothing now: remove them from ROOT_WRITES.').toEqual([]);
  });

  it('every stylesheet that reads --fullscreen-left has a component that retains the area', () => {
    const readers = stylesheets
      .filter((file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').includes('var(--fullscreen-left'))
      .map(rel);
    expect(readers.sort()).toEqual(Object.keys(FULLSCREEN_LEFT_READERS).sort());
    for (const components of Object.values(FULLSCREEN_LEFT_READERS)) {
      for (const component of components) {
        expect(readFileSync(join(WEB_SRC, component), 'utf8'), `${component} must call useFullscreenArea`).toMatch(/useFullscreenArea\(/);
      }
    }
  });
});
