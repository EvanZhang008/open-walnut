import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * What the web build leaves out of the packages it bundles. Rollup keeps every module's syntax
 * tree in memory for the whole build, so the build's heap grows with the code it reads, used or
 * not: the drawing editor's lazy Mermaid import alone (about 1,600 modules: every Mermaid diagram,
 * katex, cytoscape, langium) ran Node out of memory at a 2 GB heap, the default on a 7 GB CI
 * machine, and its chunks pushed the published package past its size limit.
 *
 * Each entry is code Walnut cannot reach, or the part of a library a dependency actually calls:
 *  - `@excalidraw/mermaid-to-excalidraw`: the editor's own Mermaid dialog and Mermaid paste. Walnut
 *    hides the dialog's entry and makes diagrams with its own server; see the stub's comment.
 *  - the editor's translations except English: Walnut never passes `langCode`, so the editor only
 *    ever loads English, and a missing string falls back to the English built into it anyway.
 *  - `echarts` as pptx-preview imports it (the whole library): slide charts use bar, line and pie
 *    series with a title, legend and tooltip, drawn as SVG; ECHARTS_SLIM registers exactly that.
 *
 * Guard: tests/web/bundle-trim.test.ts enumerates these from the installed packages.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const MERMAID_PACKAGE = '@excalidraw/mermaid-to-excalidraw';
export const MERMAID_STUB = path.join(here, 'src/components/drawing/mermaid-to-excalidraw-stub.ts');
export const ECHARTS_SLIM = path.join(here, 'src/components/common/echarts-slim.ts');
export const LOCALE_STUB = '\0walnut-excalidraw-locale-stub';

const EXCALIDRAW_DIST = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]/;
const PPTX_PREVIEW = /[\\/]pptx-preview[\\/]/;

/** The editor's translation files are `./locales/<code>-<hash>.js` next to its entry. */
export function isDroppedLocale(source: string, importer: string | undefined): boolean {
  if (!importer || !EXCALIDRAW_DIST.test(importer)) return false;
  const m = /^\.\.?\/locales\/([A-Za-z-]+?)-[A-Z0-9]{8}\.js$/.exec(source);
  return !!m && m[1] !== 'en';
}

/** Where the build sends an import instead, or null to resolve it as usual. */
export function trimTarget(source: string, importer: string | undefined): string | null {
  if (source === MERMAID_PACKAGE || source.startsWith(`${MERMAID_PACKAGE}/`)) return MERMAID_STUB;
  if (source === 'echarts' && importer && PPTX_PREVIEW.test(importer)) return ECHARTS_SLIM;
  if (isDroppedLocale(source, importer)) return LOCALE_STUB;
  return null;
}

export function bundleTrim(): Plugin {
  return {
    name: 'walnut-bundle-trim',
    enforce: 'pre',
    resolveId(source, importer) {
      return trimTarget(source, importer);
    },
    load(id) {
      // An empty translation: every string falls back to the editor's built-in English.
      return id === LOCALE_STUB ? 'export default {};' : null;
    },
  };
}
