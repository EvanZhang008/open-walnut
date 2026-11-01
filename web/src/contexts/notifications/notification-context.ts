/**
 * The notifications context alone (NotificationProvider.tsx provides it): a component reads it
 * through here without loading the provider and everything it imports (a menu's unit test runs
 * without a DOM, where the provider's markdown renderer cannot load).
 */
import { createContext, useContext } from 'react';
import type { NotificationContextValue } from './NotificationProvider';

export const NotificationContext = createContext<NotificationContextValue | null>(null);

/** The notifications, or null outside a provider (a menu that may render where none is mounted). */
export function useOptionalNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext);
}
