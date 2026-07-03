/**
 * Install a real (linkedom-backed) `window`/`document` before the markdown utils
 * load, so DOMPurify initializes against a spec-faithful DOM and actually
 * sanitizes (in a bare node env DOMPurify.isSupported is false → it no-ops).
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
