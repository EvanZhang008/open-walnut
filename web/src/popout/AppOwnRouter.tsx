import type { ContextType, ReactNode } from 'react';
import { MemoryRouter, UNSAFE_LocationContext } from 'react-router-dom';

// React Router refuses a router inside another, and it decides that by this context alone,
// so the app's own router starts with none above it.
const NO_OUTER_ROUTER = null as unknown as ContextType<typeof UNSAFE_LocationContext>;

/**
 * A router of an app's own, inside the window's router (PopoutAppView.tsx): what the app reads
 * and moves is this one, kept in memory, so the window's address never changes. Hooks above it
 * keep reading and moving the window's router.
 */
export function AppOwnRouter({ start, children }: { start: string; children: ReactNode }) {
  return (
    <UNSAFE_LocationContext.Provider value={NO_OUTER_ROUTER}>
      <MemoryRouter initialEntries={[start]}>{children}</MemoryRouter>
    </UNSAFE_LocationContext.Provider>
  );
}
