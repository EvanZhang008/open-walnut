import { createContext } from 'react';

/**
 * Whether this subtree renders inside a plugin App's or page's box (plugins/PluginBounds.tsx),
 * which nothing inside paints past. Walnut's own views a plugin embeds (a session panel) read it:
 * a sheet that would cover the window covers the box instead, and its parts stay inside the box
 * too, where they stack with it.
 */
export const PluginBoxContext = createContext(false);
