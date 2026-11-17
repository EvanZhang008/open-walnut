/**
 * The paths that show the home page: `/`, and the routes that only send a link on to it
 * (App.tsx: `/sessions?id=`, `/tasks/:id`, `/search`, `/chat`). They render nothing of
 * their own, so Home counts as shown on them: a chat a deep link opens there reads its
 * history at once, instead of waiting for the router's move to `/`, which renders the
 * whole home page first (2026-11-17: 1.4 s on a `/sessions?id=` link, so the chat's full
 * read and its saved copy came that much later). tests/web/home-path.test.ts fails on a
 * route of App.tsx that goes to Home and is missing here.
 */
const HOME_REDIRECTS = /^\/(?:sessions|search|chat|tasks\/[^/]+)\/?$/;

export function isHomePath(pathname: string): boolean {
  return pathname === '/' || HOME_REDIRECTS.test(pathname);
}
