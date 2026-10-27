import { createContext } from 'react';

/**
 * Whether the page this subtree belongs to is on show. App.tsx keeps the home
 * page mounted behind every other route and hides it, so its panels stay alive
 * while the person is elsewhere; inside it this is false off Home. Everything
 * else is always on show (the default).
 */
export const RouteShownContext = createContext(true);
