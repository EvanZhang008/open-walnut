/**
 * Install a real (linkedom-backed) `window`/`document` before the markdown utils
 * load, so DOMPurify constructs a full instance (with `addHook` etc.) instead of
 * the bare-node stub that has no hooks at all and would throw at module init.
 *
 * ⚠️ DOMPurify still does NOT sanitize in this tier. linkedom has no
 * `document.implementation`, so `DOMPurify.isSupported` is falsy and `sanitize()`
 * returns its input unchanged (measured 2026-09-03: `isSupported === undefined`).
 * Assertions here can cover marked's output and our own pre/post passes, never
 * what DOMPurify strips or what its hooks add; those belong in a Playwright spec
 * (e.g. tests/e2e/browser/external-links-new-tab.spec.ts). Patching linkedom to
 * satisfy DOMPurify was tried and fails deeper in (element removal crashes).
 *
 * linkedom lives in the repo-ROOT node_modules (transitive dep). This config is
 * repo-root-rooted, so a bare import resolves fine.
 */
import { parseHTML } from 'linkedom';

const { window, document, DOMParser, Node } = parseHTML(
  '<!DOCTYPE html><html><head></head><body></body></html>',
);

// DOMPurify probes these globals at construction time (module load).
const g = globalThis as unknown as Record<string, unknown>;
if (!g.window) g.window = window;
if (!g.document) g.document = document;
if (!g.DOMParser) g.DOMParser = DOMParser;
if (!g.Node) g.Node = Node;
