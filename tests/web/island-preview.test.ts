/**
 * The live preview of a streaming html-app block (web/src/components/chat/
 * island-preview.ts): the frame document lets only its own script run, and the
 * messages between it and the page are read strictly. What the frame draws, and
 * that no model script runs in it, is pinned in a real browser by
 * tests/e2e/browser/rich-island-live.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  islandPreviewDoc, isIslandDocument, isPreviewReady, previewUpdate, readPreviewHeight,
  PREVIEW_HEIGHT_MSG, PREVIEW_READY_MSG, PREVIEW_MSG,
} from '../../web/src/components/chat/island-preview';

describe('island preview', () => {
  it('allows only its own script by nonce, never inline scripts or the network', () => {
    const doc = islandPreviewDoc('k1', 'n0nce');
    const csp = /content="([^"]+)"/.exec(doc)![1];
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("default-src 'none'");
    expect(doc.match(/<script/g)).toHaveLength(1);
    expect(doc).toContain('<script nonce="n0nce">');
    expect(doc).toContain('<body></body>');
  });

  it('tells a document from a fragment, also while its first characters arrive', () => {
    expect(isIslandDocument('<!doctype html><html>')).toBe(true);
    expect(isIslandDocument('  <HTML lang="en">')).toBe(true);
    expect(isIslandDocument('<div>x</div>')).toBe(false);
    expect(isIslandDocument('<!do')).toBe(false);
    expect(isIslandDocument('<!do', true)).toBe(true);
    expect(isIslandDocument('<ht', true)).toBe(true);
    expect(isIslandDocument('', true)).toBe(true);
    expect(isIslandDocument('<div', true)).toBe(false);
    expect(isIslandDocument('<style>', true)).toBe(false);
  });

  it('builds an update for its own frame only', () => {
    expect(previewUpdate('k1', '<p>a</p>')).toEqual({ t: PREVIEW_MSG, k: 'k1', html: '<p>a</p>', fragment: true });
    expect(previewUpdate('k1', '<!doctype html><p>a').fragment).toBe(false);
  });

  it('reads height and ready messages strictly', () => {
    expect(readPreviewHeight({ t: PREVIEW_HEIGHT_MSG, k: 'k1', h: 120.4, filled: true }, 'k1')).toEqual({ h: 120.4, filled: true });
    expect(readPreviewHeight({ t: PREVIEW_HEIGHT_MSG, k: 'k1', h: 50 }, 'k1')).toEqual({ h: 50, filled: false });
    expect(readPreviewHeight({ t: PREVIEW_HEIGHT_MSG, k: 'other', h: 50 }, 'k1')).toBeNull();
    expect(readPreviewHeight({ t: PREVIEW_HEIGHT_MSG, k: 'k1', h: Infinity }, 'k1')).toBeNull();
    expect(readPreviewHeight({ t: PREVIEW_HEIGHT_MSG, k: 'k1', h: '50' }, 'k1')).toBeNull();
    expect(readPreviewHeight(null, 'k1')).toBeNull();
    expect(isPreviewReady({ t: PREVIEW_READY_MSG, k: 'k1' }, 'k1')).toBe(true);
    expect(isPreviewReady({ t: PREVIEW_READY_MSG, k: 'k2' }, 'k1')).toBe(false);
    expect(isPreviewReady('wn-pv-ready', 'k1')).toBe(false);
  });
});
