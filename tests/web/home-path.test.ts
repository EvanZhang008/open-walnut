/**
 * Every route of App.tsx that only sends a link on to Home counts as Home
 * (web/src/utils/home-path.ts): a chat a deep link opens there reads its history at once,
 * not after the router's move to `/` (2026-11-17: 1.4 s late on a `/sessions?id=` link,
 * session-open-instant "a refetch before the first load lands still shows the cached copy
 * first"). A new redirect to Home that is missing from isHomePath fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isHomePath } from '../../web/src/utils/home-path';

const app = fs.readFileSync(path.join(__dirname, '../../web/src/App.tsx'), 'utf8');
/** Components App.tsx defines that end on Home (they navigate to `/`, or open the task there). */
const HOME_REDIRECT_COMPONENTS = ['SessionsRedirect', 'TaskRedirect'];

function routes(): Array<{ path: string; element: string }> {
  return [...app.matchAll(/<Route\s+(?:key=\{[^}]*\}\s+)?path="([^"]+)"\s+element=\{(.*?)\}\s*\/>/g)].map((m) => ({ path: m[1], element: m[2] }));
}
const sample = (p: string) => p.replace(/:[A-Za-z]+/g, 'x1').replace(/\/\*$/, '/a');

describe('the paths that show Home', () => {
  it('every route that goes to Home counts as Home; the pages of their own do not', () => {
    // `*` (an unknown path) waits for the plugins and is no path of its own: not a Home path.
    const all = routes().filter((r) => r.path !== '*');
    const toHome = all.filter((r) => /<Navigate\s+to="\/"/.test(r.element) || HOME_REDIRECT_COMPONENTS.some((c) => r.element.includes(`<${c}`)));
    expect(toHome.map((r) => r.path).sort()).toEqual(expect.arrayContaining(['/chat', '/search', '/sessions', '/tasks/:id']));
    for (const r of toHome) expect(isHomePath(sample(r.path)), r.path).toBe(true);
    const pages = all.filter((r) => r.path !== '/' && !toHome.includes(r));
    expect(pages.length).toBeGreaterThan(5);
    for (const r of pages) expect(isHomePath(sample(r.path)), r.path).toBe(false);
  });

  it('a redirect component of App.tsx really ends on Home', () => {
    for (const c of HOME_REDIRECT_COMPONENTS) {
      const body = app.slice(app.indexOf(`function ${c}(`), app.indexOf('\n}\n', app.indexOf(`function ${c}(`)));
      expect(body, c).toMatch(/openSessionOnHome|openTaskHere|navigate\('\/'/);
    }
    expect(isHomePath('/')).toBe(true);
    expect(isHomePath('/sessions')).toBe(true);
    expect(isHomePath('/org')).toBe(false);
    expect(isHomePath('/tasks')).toBe(false);
    expect(isHomePath('/sessions/extra')).toBe(false);
  });
});
