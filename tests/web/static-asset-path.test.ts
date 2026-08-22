/**
 * The SPA fallback must not answer for FILE requests.
 *
 * A deploy re-hashes and wipes the assets directory, so tabs opened before it
 * keep asking for chunk names that are gone. Serving index.html for those
 * returned `200 text/html` where the browser expected a module — an error the
 * app could only experience as "this lazily-loaded feature silently does
 * nothing" (the real report: a .go file with no syntax colors).
 */
import { describe, it, expect } from 'vitest';
import { isStaticAssetPath } from '../../src/web/static-asset-path';

describe('isStaticAssetPath', () => {
  it('claims every build artifact under /assets/', () => {
    expect(isStaticAssetPath('/assets/index-jEbWu8KP.js')).toBe(true);
    expect(isStaticAssetPath('/assets/index-Bq1wIHkB.css')).toBe(true);
    // Grammar chunks are the ones a tab fetches LATE, long after the deploy.
    expect(isStaticAssetPath('/assets/go-B4CMkyY2.js')).toBe(true);
    // Even an extensionless file under /assets/ is a file, not a route.
    expect(isStaticAssetPath('/assets/LICENSE')).toBe(true);
  });

  it('claims file extensions served from the static root', () => {
    for (const p of ['/favicon.ico', '/logo.svg', '/manifest.json', '/sw.js', '/style.css', '/f.woff2', '/x.map', '/robots.txt']) {
      expect(isStaticAssetPath(p), p).toBe(true);
    }
  });

  it('leaves SPA deep links alone', () => {
    for (const p of ['/', '/tasks', '/sessions', '/notes/some-note', '/settings/providers', '/plugin-apps/demo']) {
      expect(isStaticAssetPath(p), p).toBe(false);
    }
  });
});
